use crate::chunk::{Chunk, ChunkNeighbors, Face};

/// Compute ambient occlusion for a single vertex of a face.
///
/// `side1` and `side2` are true if the adjacent blocks along the two tangent
/// directions are opaque. `corner` is true if the diagonal block is opaque.
///
/// Returns 0–3 where 3 = fully lit (no occlusion), 0 = maximum occlusion.
/// If both sides are opaque, the corner is irrelevant (returns 0).
#[inline]
pub fn vertex_ao(side1: bool, side2: bool, corner: bool) -> u8 {
    if side1 && side2 {
        return 0;
    }
    3 - (side1 as u8 + side2 as u8 + corner as u8)
}

/// Sample whether a block at signed coordinates is opaque (non-air).
///
/// Handles coordinates outside the chunk bounds by reading from `neighbors`.
/// Coordinates outside both the chunk and neighbor range return false (air).
#[inline]
pub fn sample_block_opaque(
    chunk: &Chunk,
    neighbors: &ChunkNeighbors,
    x: i32,
    y: i32,
    z: i32,
) -> bool {
    let size = chunk.size() as i32;

    // Within chunk bounds
    if x >= 0 && x < size && y >= 0 && y < size && z >= 0 && z < size {
        return chunk.get(x as usize, y as usize, z as usize) != 0;
    }

    // Outside chunk — check neighbors
    // For simplicity, only handle the case where exactly one axis is out of bounds
    // (corner/edge neighbors are treated as air)
    if x < 0 && y >= 0 && y < size && z >= 0 && z < size {
        return neighbors.get_border_block(Face::NegX, z as usize, y as usize) != 0;
    }
    if x >= size && y >= 0 && y < size && z >= 0 && z < size {
        return neighbors.get_border_block(Face::PosX, z as usize, y as usize) != 0;
    }
    if y < 0 && x >= 0 && x < size && z >= 0 && z < size {
        return neighbors.get_border_block(Face::NegY, x as usize, z as usize) != 0;
    }
    if y >= size && x >= 0 && x < size && z >= 0 && z < size {
        return neighbors.get_border_block(Face::PosY, x as usize, z as usize) != 0;
    }
    if z < 0 && x >= 0 && x < size && y >= 0 && y < size {
        return neighbors.get_border_block(Face::NegZ, x as usize, y as usize) != 0;
    }
    if z >= size && x >= 0 && x < size && y >= 0 && y < size {
        return neighbors.get_border_block(Face::PosZ, x as usize, y as usize) != 0;
    }

    // Edge/corner neighbor — treat as air
    false
}

/// Compute AO values for all 4 vertices of a face quad.
///
/// The face is at position `(x, y, z)` in chunk coordinates, facing `face`.
/// Returns `[ao0, ao1, ao2, ao3]` as f32 in [0.0, 1.0] where 1.0 = no occlusion.
///
/// Vertex ordering matches the quad vertex order used by the greedy mesher:
/// - v0: (u=0, v=0) corner
/// - v1: (u=1, v=0) corner
/// - v2: (u=1, v=1) corner
/// - v3: (u=0, v=1) corner
///
/// For each vertex, we sample 3 blocks in the plane one step outward from
/// the face in the normal direction: two "side" neighbors and one "corner" neighbor.
pub fn face_ao(
    chunk: &Chunk,
    neighbors: &ChunkNeighbors,
    x: i32,
    y: i32,
    z: i32,
    face: Face,
) -> [f32; 4] {
    let n = face.normal();
    let (u_axis, v_axis) = face.tangent_axes();

    // Position one step outward from the face
    let ox = x + n[0];
    let oy = y + n[1];
    let oz = z + n[2];

    // Build direction vectors for the tangent axes
    let mut u_dir = [0i32; 3];
    let mut v_dir = [0i32; 3];
    u_dir[u_axis] = 1;
    v_dir[v_axis] = 1;

    // Sample the 8 neighbors in the 3x3 grid (excluding center) on the plane
    // perpendicular to the face normal, offset by 1 in the normal direction.
    //
    // Grid layout (u horizontal, v vertical):
    //   (-1,+1) (0,+1) (+1,+1)
    //   (-1, 0) center (+1, 0)
    //   (-1,-1) (0,-1) (+1,-1)

    let sample = |du: i32, dv: i32| -> bool {
        sample_block_opaque(
            chunk,
            neighbors,
            ox + u_dir[0] * du + v_dir[0] * dv,
            oy + u_dir[1] * du + v_dir[1] * dv,
            oz + u_dir[2] * du + v_dir[2] * dv,
        )
    };

    // Cache the 8 neighbor samples
    let neg_u = sample(-1, 0);
    let pos_u = sample(1, 0);
    let neg_v = sample(0, -1);
    let pos_v = sample(0, 1);
    let neg_u_neg_v = sample(-1, -1);
    let pos_u_neg_v = sample(1, -1);
    let pos_u_pos_v = sample(1, 1);
    let neg_u_pos_v = sample(-1, 1);

    // Vertex AO: each vertex checks its two adjacent sides and the corner
    // v0 (u=0, v=0): sides = neg_u, neg_v; corner = neg_u_neg_v
    let ao0 = vertex_ao(neg_u, neg_v, neg_u_neg_v);
    // v1 (u=1, v=0): sides = pos_u, neg_v; corner = pos_u_neg_v
    let ao1 = vertex_ao(pos_u, neg_v, pos_u_neg_v);
    // v2 (u=1, v=1): sides = pos_u, pos_v; corner = pos_u_pos_v
    let ao2 = vertex_ao(pos_u, pos_v, pos_u_pos_v);
    // v3 (u=0, v=1): sides = neg_u, pos_v; corner = neg_u_pos_v
    let ao3 = vertex_ao(neg_u, pos_v, neg_u_pos_v);

    // Normalize from 0..3 to 0.0..1.0
    const SCALE: f32 = 1.0 / 3.0;
    [
        ao0 as f32 * SCALE,
        ao1 as f32 * SCALE,
        ao2 as f32 * SCALE,
        ao3 as f32 * SCALE,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vertex_ao_no_occlusion() {
        assert_eq!(vertex_ao(false, false, false), 3);
    }

    #[test]
    fn vertex_ao_one_side() {
        assert_eq!(vertex_ao(true, false, false), 2);
        assert_eq!(vertex_ao(false, true, false), 2);
    }

    #[test]
    fn vertex_ao_corner_only() {
        assert_eq!(vertex_ao(false, false, true), 2);
    }

    #[test]
    fn vertex_ao_one_side_and_corner() {
        assert_eq!(vertex_ao(true, false, true), 1);
        assert_eq!(vertex_ao(false, true, true), 1);
    }

    #[test]
    fn vertex_ao_both_sides() {
        // Both sides occluded = full occlusion regardless of corner
        assert_eq!(vertex_ao(true, true, false), 0);
        assert_eq!(vertex_ao(true, true, true), 0);
    }

    #[test]
    fn face_ao_no_neighbors() {
        let mut chunk = Chunk::new_default();
        chunk.set(5, 5, 5, 1);
        let neighbors = ChunkNeighbors::empty(32);

        // Face with no adjacent blocks should be fully lit
        let ao = face_ao(&chunk, &neighbors, 5, 5, 5, Face::PosY);
        assert_eq!(ao, [1.0, 1.0, 1.0, 1.0]);
    }

    #[test]
    fn face_ao_with_adjacent_blocks() {
        let mut chunk = Chunk::new_default();
        // Place a block and surround it on the +Y face plane
        chunk.set(5, 5, 5, 1);
        // Place blocks adjacent in -X and -Z from the +Y face
        chunk.set(4, 6, 5, 1); // -U direction for PosY (u_axis=0, so x-1, one step up)
        chunk.set(5, 6, 4, 1); // -V direction for PosY (v_axis=2, so z-1, one step up)
        chunk.set(4, 6, 4, 1); // corner (-U, -V)

        let neighbors = ChunkNeighbors::empty(32);
        let ao = face_ao(&chunk, &neighbors, 5, 5, 5, Face::PosY);

        // v0 (u=0,v=0) has both sides and corner occupied → AO = 0
        assert_eq!(ao[0], 0.0);
        // v1, v2, v3 should have higher AO (less occlusion)
        assert!(ao[1] > 0.0);
        assert!(ao[2] > 0.0);
        assert!(ao[3] > 0.0);
    }
}
