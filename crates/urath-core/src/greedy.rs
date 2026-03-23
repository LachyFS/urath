use crate::ao::{face_ao, sample_block_opaque};
use crate::chunk::{Chunk, ChunkNeighbors, Face};
use crate::error::MeshError;
use crate::mesh_output::MeshOutput;
use crate::mesher::Mesher;

/// Greedy block mesher using Mikola Lysenko's algorithm.
///
/// For each face direction, sweeps through slices perpendicular to the face
/// normal. Within each slice, builds a 2D mask of visible faces, then greedily
/// merges adjacent faces with matching block IDs and AO values into larger quads.
///
/// Reference: <https://0fps.net/2012/06/30/meshing-in-a-block-world/>
pub struct GreedyMesher {
    /// Scratch buffer for the face mask of one slice.
    /// Entry is the block_id of the voxel contributing this face, or 0 for no face.
    mask: Vec<u16>,
    /// Scratch buffer for AO values per face in one slice.
    /// Stored as `[u8; 4]` (0–3 per vertex) for exact equality comparison during merge.
    ao_mask: Vec<[u8; 4]>,
    /// The chunk size this mesher is configured for.
    chunk_size: usize,
}

impl GreedyMesher {
    /// Create a new greedy mesher for the default chunk size (32).
    pub fn new() -> Self {
        Self::with_chunk_size(32)
    }

    /// Create a new greedy mesher for a specific chunk size.
    pub fn with_chunk_size(size: usize) -> Self {
        let area = size * size;
        Self {
            mask: vec![0u16; area],
            ao_mask: vec![[0u8; 4]; area],
            chunk_size: size,
        }
    }
}

impl Default for GreedyMesher {
    fn default() -> Self {
        Self::new()
    }
}

impl Mesher for GreedyMesher {
    fn mesh(
        &mut self,
        chunk: &Chunk,
        neighbors: &ChunkNeighbors,
        output: &mut MeshOutput,
    ) -> Result<(), MeshError> {
        let size = chunk.size();
        debug_assert_eq!(size, self.chunk_size, "chunk size mismatch with mesher");

        for &face in &Face::ALL {
            let normal = face.normal();

            for d in 0..size {
                // === Pass 1: Build face mask for this slice ===
                self.clear_mask();

                for v in 0..size {
                    for u in 0..size {
                        let pos = compose_coords(u, v, d, face, size);
                        let block = chunk.get(pos[0], pos[1], pos[2]);
                        if block == 0 {
                            continue;
                        }

                        // Check the neighbor in the face's normal direction
                        let nx = pos[0] as i32 + normal[0];
                        let ny = pos[1] as i32 + normal[1];
                        let nz = pos[2] as i32 + normal[2];

                        let neighbor_opaque = sample_block_opaque(chunk, neighbors, nx, ny, nz);

                        if !neighbor_opaque {
                            let idx = u + v * size;
                            self.mask[idx] = block;

                            // Compute AO as u8 values (0–3) for exact comparison
                            let ao = face_ao(
                                chunk,
                                neighbors,
                                pos[0] as i32,
                                pos[1] as i32,
                                pos[2] as i32,
                                face,
                            );
                            self.ao_mask[idx] = [
                                (ao[0] * 3.0).round() as u8,
                                (ao[1] * 3.0).round() as u8,
                                (ao[2] * 3.0).round() as u8,
                                (ao[3] * 3.0).round() as u8,
                            ];
                        }
                    }
                }

                // === Pass 2: Greedy merge ===
                for v in 0..size {
                    let mut u = 0;
                    while u < size {
                        let idx = u + v * size;
                        let block_id = self.mask[idx];
                        if block_id == 0 {
                            u += 1;
                            continue;
                        }

                        let ao_val = self.ao_mask[idx];

                        // Expand width (along u axis)
                        let mut w = 1;
                        while u + w < size {
                            let next_idx = (u + w) + v * size;
                            if self.mask[next_idx] != block_id || self.ao_mask[next_idx] != ao_val {
                                break;
                            }
                            w += 1;
                        }

                        // Expand height (along v axis)
                        let mut h = 1;
                        'expand_h: while v + h < size {
                            for du in 0..w {
                                let next_idx = (u + du) + (v + h) * size;
                                if self.mask[next_idx] != block_id
                                    || self.ao_mask[next_idx] != ao_val
                                {
                                    break 'expand_h;
                                }
                            }
                            h += 1;
                        }

                        // Compute quad positions
                        let positions = quad_positions(u, v, d, w, h, face);

                        // Tiling UVs: a W×H merged quad tiles the texture W×H times.
                        // For side faces where u_axis is Y (PosX, NegZ), swap UV
                        // so texture horizontal maps to a horizontal world axis
                        // and texture vertical maps to Y (world up).
                        let wf = w as f32;
                        let hf = h as f32;
                        let (u_axis, _) = face.tangent_axes();
                        let uvs = if u_axis == 1 {
                            // u_axis is Y — swap so tex_v tracks Y
                            [
                                [0.0, 0.0], // v0
                                [0.0, wf],  // v1: moved along Y → tex V
                                [hf, wf],   // v2
                                [hf, 0.0],  // v3: moved along horiz → tex U
                            ]
                        } else {
                            [
                                [0.0, 0.0], // v0
                                [wf, 0.0],  // v1
                                [wf, hf],   // v2
                                [0.0, hf],  // v3
                            ]
                        };

                        // Convert AO from u8 (0–3) back to f32 (0.0–1.0)
                        let ao_f32 = [
                            ao_val[0] as f32 / 3.0,
                            ao_val[1] as f32 / 3.0,
                            ao_val[2] as f32 / 3.0,
                            ao_val[3] as f32 / 3.0,
                        ];

                        output.push_quad(&positions, face.normal_f32(), ao_f32, block_id, &uvs);

                        // Zero out the merged region in the mask
                        for dv in 0..h {
                            for du in 0..w {
                                let clear_idx = (u + du) + (v + dv) * size;
                                self.mask[clear_idx] = 0;
                            }
                        }

                        u += w;
                    }
                }
            }
        }

        Ok(())
    }
}

impl GreedyMesher {
    fn clear_mask(&mut self) {
        for v in self.mask.iter_mut() {
            *v = 0;
        }
        // ao_mask doesn't need clearing — only read where mask is nonzero
    }
}

/// Map face-local 2D coordinates (u, v) and slice depth d to 3D chunk coordinates.
#[inline]
fn compose_coords(u: usize, v: usize, d: usize, face: Face, _size: usize) -> [usize; 3] {
    let (u_axis, v_axis) = face.tangent_axes();
    let n_axis = face.normal_axis();
    let mut pos = [0usize; 3];
    pos[u_axis] = u;
    pos[v_axis] = v;
    pos[n_axis] = d;
    pos
}

/// Compute the 4 corner positions of a merged quad.
///
/// The quad spans from `(u, v)` to `(u+w, v+h)` in face-local coordinates,
/// at depth `d`. The quad is offset by +1 in the normal direction for positive
/// faces (so it sits on the outside surface of the block).
///
/// Vertex ordering:
/// - v0: (u, v)       — bottom-left
/// - v1: (u+w, v)     — bottom-right
/// - v2: (u+w, v+h)   — top-right
/// - v3: (u, v+h)     — top-left
#[inline]
fn quad_positions(u: usize, v: usize, d: usize, w: usize, h: usize, face: Face) -> [[f32; 3]; 4] {
    let (u_axis, v_axis) = face.tangent_axes();
    let n_axis = face.normal_axis();
    // Depth offset: positive faces get d+1, negative faces stay at d
    let depth = if face.is_positive() {
        (d + 1) as f32
    } else {
        d as f32
    };

    let u0 = u as f32;
    let v0 = v as f32;
    let u1 = (u + w) as f32;
    let v1 = (v + h) as f32;

    let mut positions = [[0.0f32; 3]; 4];

    // v0: (u0, v0)
    positions[0][u_axis] = u0;
    positions[0][v_axis] = v0;
    positions[0][n_axis] = depth;

    // v1: (u1, v0)
    positions[1][u_axis] = u1;
    positions[1][v_axis] = v0;
    positions[1][n_axis] = depth;

    // v2: (u1, v1)
    positions[2][u_axis] = u1;
    positions[2][v_axis] = v1;
    positions[2][n_axis] = depth;

    // v3: (u0, v1)
    positions[3][u_axis] = u0;
    positions[3][v_axis] = v1;
    positions[3][n_axis] = depth;

    positions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::CHUNK_SIZE;

    fn mesh_chunk(chunk: &Chunk, neighbors: &ChunkNeighbors) -> MeshOutput {
        let mut mesher = GreedyMesher::with_chunk_size(chunk.size());
        let mut output = MeshOutput::new();
        mesher.mesh(chunk, neighbors, &mut output).unwrap();
        output
    }

    #[test]
    fn empty_chunk() {
        let chunk = Chunk::new_default();
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let output = mesh_chunk(&chunk, &neighbors);
        assert!(output.is_empty());
    }

    #[test]
    fn solid_chunk() {
        let mut chunk = Chunk::new_default();
        for z in 0..CHUNK_SIZE {
            for y in 0..CHUNK_SIZE {
                for x in 0..CHUNK_SIZE {
                    chunk.set(x, y, z, 1);
                }
            }
        }
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let output = mesh_chunk(&chunk, &neighbors);

        // A solid chunk with air neighbors has 6 faces, each fully merged into 1 quad
        assert_eq!(output.vertex_count(), 24); // 6 faces × 4 vertices
        assert_eq!(output.index_count(), 36); // 6 faces × 6 indices
    }

    #[test]
    fn single_block() {
        let mut chunk = Chunk::new_default();
        chunk.set(16, 16, 16, 1);
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let output = mesh_chunk(&chunk, &neighbors);

        // Single block exposed on all 6 faces
        assert_eq!(output.vertex_count(), 24); // 6 × 4
        assert_eq!(output.index_count(), 36); // 6 × 6
    }

    #[test]
    fn two_adjacent_blocks_cull_shared_face() {
        let mut chunk = Chunk::new_default();
        chunk.set(0, 0, 0, 1);
        chunk.set(1, 0, 0, 1);
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let output = mesh_chunk(&chunk, &neighbors);

        // Two adjacent blocks along X: the shared face (+X of block0 / -X of block1) is culled.
        // Remaining: 10 faces. Some will merge (e.g., top, bottom, front, back are 2x1).
        // After greedy merge:
        // - PosX: 1 quad (1x1 on block at x=1)
        // - NegX: 1 quad (1x1 on block at x=0)
        // - PosY: 1 quad (2x1 merged)
        // - NegY: 1 quad (2x1 merged)
        // - PosZ: 1 quad (2x1 merged)
        // - NegZ: 1 quad (2x1 merged)
        // Total: 6 quads (some faces merge, some don't, but all 10 faces reduce to 6 quads
        // because the 4 side faces each merge the 2 blocks into 1 quad)
        // Wait — the blocks are adjacent along X. For PosY face:
        //   face tangent_axes = (X, Z). Both blocks at (0,0,0) and (1,0,0) have +Y exposed.
        //   They are adjacent in u (X) direction, same block_id, same AO → merge into 1 quad.
        // Similarly for NegY, PosZ, NegZ.
        // PosX: only block at x=1 has +X exposed → 1 quad
        // NegX: only block at x=0 has -X exposed → 1 quad
        // Total: 6 quads
        assert_eq!(output.vertex_count(), 24);
        assert_eq!(output.index_count(), 36);
    }

    #[test]
    fn different_block_ids_dont_merge() {
        let mut chunk = Chunk::new_default();
        chunk.set(0, 0, 0, 1);
        chunk.set(1, 0, 0, 2); // Different block ID
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let output = mesh_chunk(&chunk, &neighbors);

        // The shared face is still culled (both are solid).
        // But top/bottom/front/back faces can NOT merge across different block IDs.
        // PosX: 1 quad (block 2)
        // NegX: 1 quad (block 1)
        // PosY: 2 quads (block 1 and block 2 can't merge)
        // NegY: 2 quads
        // PosZ: 2 quads
        // NegZ: 2 quads
        // Total: 10 quads
        assert_eq!(output.vertex_count(), 40); // 10 × 4
        assert_eq!(output.index_count(), 60); // 10 × 6
    }

    #[test]
    fn cross_chunk_boundary_culling() {
        let mut chunk = Chunk::new_default();
        chunk.set(31, 0, 0, 1); // Block at the +X boundary

        // Set up a neighbor on the +X face with a solid block adjacent
        let mut neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let mut pos_x_border = vec![0u16; CHUNK_SIZE * CHUNK_SIZE];
        pos_x_border[0 + 0 * CHUNK_SIZE] = 1; // Block at (z=0, y=0) on neighbor border
        neighbors.set_face(Face::PosX, pos_x_border);

        let output = mesh_chunk(&chunk, &neighbors);

        // The +X face of our block should be culled by the neighbor.
        // Remaining: 5 faces × 1 quad each
        assert_eq!(output.vertex_count(), 20); // 5 × 4
        assert_eq!(output.index_count(), 30); // 5 × 6
    }

    #[test]
    fn checkerboard_no_merge() {
        // 4x4x1 slab with checkerboard pattern (alternating fill)
        let mut chunk = Chunk::new(4).unwrap();
        let mut expected_faces = 0u32;
        for z in 0..4 {
            for y in 0..4 {
                for x in 0..4 {
                    if (x + y + z) % 2 == 0 {
                        chunk.set(x, y, z, 1);
                        // Count exposed faces for this block
                        for face in &Face::ALL {
                            let n = face.normal();
                            let nx = x as i32 + n[0];
                            let ny = y as i32 + n[1];
                            let nz = z as i32 + n[2];
                            // In a 3D checkerboard, all neighbors are air
                            if nx < 0 || nx >= 4 || ny < 0 || ny >= 4 || nz < 0 || nz >= 4 {
                                expected_faces += 1;
                            } else if (nx + ny + nz) % 2 != 0 {
                                expected_faces += 1;
                            }
                        }
                    }
                }
            }
        }

        let neighbors = ChunkNeighbors::empty(4);
        let mut mesher = GreedyMesher::with_chunk_size(4);
        let mut output = MeshOutput::new();
        mesher.mesh(&chunk, &neighbors, &mut output).unwrap();

        // Each face is 1x1, no merging possible in a checkerboard
        // (neighbors in the face plane always differ or have different AO)
        // The vertex count should be expected_faces * 4
        assert_eq!(output.vertex_count(), expected_faces * 4);
    }

    #[test]
    fn mesh_output_reuse() {
        let mut chunk = Chunk::new_default();
        chunk.set(10, 10, 10, 1);
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let mut mesher = GreedyMesher::new();
        let mut output = MeshOutput::with_capacity(100);

        // First mesh
        mesher.mesh(&chunk, &neighbors, &mut output).unwrap();
        let first_vertex_count = output.vertex_count();
        let first_index_count = output.index_count();
        assert!(!output.is_empty());

        // Clear and mesh again
        output.clear();
        mesher.mesh(&chunk, &neighbors, &mut output).unwrap();

        assert_eq!(output.vertex_count(), first_vertex_count);
        assert_eq!(output.index_count(), first_index_count);
    }

    #[test]
    fn small_chunk_surface() {
        // 4x4x4 chunk, solid below y=2
        let mut chunk = Chunk::new(4).unwrap();
        for z in 0..4 {
            for y in 0..2 {
                for x in 0..4 {
                    chunk.set(x, y, z, 1);
                }
            }
        }
        let neighbors = ChunkNeighbors::empty(4);
        let mut mesher = GreedyMesher::with_chunk_size(4);
        let mut output = MeshOutput::new();
        mesher.mesh(&chunk, &neighbors, &mut output).unwrap();

        // Should have geometry (not empty)
        assert!(!output.is_empty());

        // After greedy merge:
        // +Y: 1 quad (4x4 at y=2)
        // -Y: 1 quad (4x4 at y=0)
        // +X: 1 quad (4x2 at x=4)  — actually x boundary, 4 wide in Z, 2 tall in Y
        // -X: 1 quad (4x2 at x=0)
        // +Z: 1 quad (4x2 at z=4)
        // -Z: 1 quad (4x2 at z=0)
        // Total: 6 quads
        assert_eq!(output.vertex_count(), 24);
        assert_eq!(output.index_count(), 36);
    }

    #[test]
    fn compose_coords_roundtrip() {
        // Verify compose_coords produces valid coordinates for all faces
        let size = 8;
        for face in &Face::ALL {
            for d in 0..size {
                for v in 0..size {
                    for u in 0..size {
                        let pos = compose_coords(u, v, d, *face, size);
                        assert!(pos[0] < size);
                        assert!(pos[1] < size);
                        assert!(pos[2] < size);
                    }
                }
            }
        }
    }

    #[test]
    fn quad_positions_positive_face() {
        // PosX face at d=5, u=2, v=3, w=4, h=2
        // PosX: u_axis=1(Y), v_axis=2(Z), n_axis=0(X)
        let positions = quad_positions(2, 3, 5, 4, 2, Face::PosX);

        // Depth should be d+1 = 6 (positive face)
        assert_eq!(positions[0][0], 6.0); // X = depth
        assert_eq!(positions[0][1], 2.0); // Y = u
        assert_eq!(positions[0][2], 3.0); // Z = v

        assert_eq!(positions[2][1], 6.0); // Y = u + w
        assert_eq!(positions[2][2], 5.0); // Z = v + h
    }

    #[test]
    fn quad_positions_negative_face() {
        // NegX face at d=5
        let positions = quad_positions(0, 0, 5, 1, 1, Face::NegX);

        // Depth should be d = 5 (negative face, no +1 offset)
        assert_eq!(positions[0][0], 5.0);
    }
}
