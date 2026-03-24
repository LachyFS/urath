use crate::ao::vertex_ao;
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
    /// Padded (size+2)³ opacity buffer for branchless neighbor lookups.
    /// Built once per mesh() call from chunk data + neighbor borders.
    opaque: Vec<u8>,
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
        let ps = size + 2;
        Self {
            mask: vec![0u16; area],
            ao_mask: vec![[0u8; 4]; area],
            opaque: vec![0u8; ps * ps * ps],
            chunk_size: size,
        }
    }

    /// Build the padded opacity buffer from chunk data and neighbor borders.
    /// The buffer has 1-cell padding on all sides so that all neighbor lookups
    /// (including AO diagonal samples) are simple array accesses with no bounds checks.
    fn build_opaque(&mut self, chunk: &Chunk, neighbors: &ChunkNeighbors) {
        let s = self.chunk_size;
        let ps = s + 2;
        let ps2 = ps * ps;

        self.opaque.fill(0);

        // Fill interior from chunk blocks
        let blocks = chunk.blocks();
        for z in 0..s {
            for y in 0..s {
                let chunk_row = y * s + z * s * s;
                let pad_row = (y + 1) * ps + (z + 1) * ps2;
                for x in 0..s {
                    if blocks[chunk_row + x] != 0 {
                        self.opaque[pad_row + x + 1] = 1;
                    }
                }
            }
        }

        // Fill borders from neighbors.
        // Border indexing conventions match extract_border/get_border_block:
        //   PosX/NegX: [z + y * s]
        //   PosY/NegY: [x + z * s]
        //   PosZ/NegZ: [x + y * s]

        if let Some(data) = neighbors.border_slice(Face::NegX) {
            for y in 0..s {
                for z in 0..s {
                    if data[z + y * s] != 0 {
                        self.opaque[(y + 1) * ps + (z + 1) * ps2] = 1;
                    }
                }
            }
        }
        if let Some(data) = neighbors.border_slice(Face::PosX) {
            for y in 0..s {
                for z in 0..s {
                    if data[z + y * s] != 0 {
                        self.opaque[(s + 1) + (y + 1) * ps + (z + 1) * ps2] = 1;
                    }
                }
            }
        }
        if let Some(data) = neighbors.border_slice(Face::NegY) {
            for z in 0..s {
                for x in 0..s {
                    if data[x + z * s] != 0 {
                        self.opaque[(x + 1) + (z + 1) * ps2] = 1;
                    }
                }
            }
        }
        if let Some(data) = neighbors.border_slice(Face::PosY) {
            for z in 0..s {
                for x in 0..s {
                    if data[x + z * s] != 0 {
                        self.opaque[(x + 1) + (s + 1) * ps + (z + 1) * ps2] = 1;
                    }
                }
            }
        }
        if let Some(data) = neighbors.border_slice(Face::NegZ) {
            for y in 0..s {
                for x in 0..s {
                    if data[x + y * s] != 0 {
                        self.opaque[(x + 1) + (y + 1) * ps] = 1;
                    }
                }
            }
        }
        if let Some(data) = neighbors.border_slice(Face::PosZ) {
            for y in 0..s {
                for x in 0..s {
                    if data[x + y * s] != 0 {
                        self.opaque[(x + 1) + (y + 1) * ps + (s + 1) * ps2] = 1;
                    }
                }
            }
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

        // Skip entirely empty chunks (no non-air blocks → no faces to emit)
        if chunk.is_empty() {
            return Ok(());
        }

        // Skip fully solid chunks where all neighbors are also solid
        // (no air boundary → no visible faces)
        if chunk.is_solid() && neighbors.all_borders_opaque() {
            return Ok(());
        }

        // Build padded opacity buffer once for the entire mesh
        self.build_opaque(chunk, neighbors);

        let blocks = chunk.blocks();
        let ps = size + 2;
        let ps2 = ps * ps;

        // Pre-computed strides for chunk and padded buffer indexing
        let chunk_strides: [usize; 3] = [1, size, size * size];
        let pad_strides: [usize; 3] = [1, ps, ps2];
        // Padded index of chunk coordinate (0,0,0)
        let pad_origin = 1 + ps + ps2;

        for &face in &Face::ALL {
            // Pre-compute all per-face values (hoisted out of O(n³) inner loops)
            let (u_axis, v_axis) = face.tangent_axes();
            let n_axis = face.normal_axis();
            let normal_f32 = face.normal_f32();
            let is_positive = face.is_positive();
            let swap_uv = u_axis == 1;

            // Chunk buffer strides for face-local (u, v, d) iteration
            let u_cstride = chunk_strides[u_axis];
            let v_cstride = chunk_strides[v_axis];
            let n_cstride = chunk_strides[n_axis];

            // Padded buffer strides
            let u_pstride = pad_strides[u_axis];
            let v_pstride = pad_strides[v_axis];
            let n_pstride = pad_strides[n_axis];

            // Signed normal offset in padded buffer
            let n_poffset: isize = if is_positive {
                n_pstride as isize
            } else {
                -(n_pstride as isize)
            };

            let depth_add: f32 = if is_positive { 1.0 } else { 0.0 };

            for d in 0..size {
                // === Pass 1: Build face mask for this slice ===
                self.mask.fill(0);

                let d_chunk_base = d * n_cstride;
                let d_pad_base = pad_origin + d * n_pstride;

                for v in 0..size {
                    let dv_chunk = d_chunk_base + v * v_cstride;
                    let dv_pad = d_pad_base + v * v_pstride;

                    for u in 0..size {
                        let chunk_idx = dv_chunk + u * u_cstride;
                        let block = blocks[chunk_idx];
                        if block == 0 {
                            continue;
                        }

                        // Face culling: single array lookup (no branches!)
                        let pad_idx = dv_pad + u * u_pstride;
                        let neighbor_opaque =
                            self.opaque[(pad_idx as isize + n_poffset) as usize] != 0;

                        if !neighbor_opaque {
                            let mask_idx = u + v * size;
                            self.mask[mask_idx] = block;

                            // AO: 8 direct array lookups (no function calls, no branches)
                            let center = (pad_idx as isize + n_poffset) as usize;
                            let s_neg_u = self.opaque[center - u_pstride] != 0;
                            let s_pos_u = self.opaque[center + u_pstride] != 0;
                            let s_neg_v = self.opaque[center - v_pstride] != 0;
                            let s_pos_v = self.opaque[center + v_pstride] != 0;
                            let s_nu_nv = self.opaque[center - u_pstride - v_pstride] != 0;
                            let s_pu_nv = self.opaque[center + u_pstride - v_pstride] != 0;
                            let s_pu_pv = self.opaque[center + u_pstride + v_pstride] != 0;
                            let s_nu_pv = self.opaque[center - u_pstride + v_pstride] != 0;

                            self.ao_mask[mask_idx] = [
                                vertex_ao(s_neg_u, s_neg_v, s_nu_nv),
                                vertex_ao(s_pos_u, s_neg_v, s_pu_nv),
                                vertex_ao(s_pos_u, s_pos_v, s_pu_pv),
                                vertex_ao(s_neg_u, s_pos_v, s_nu_pv),
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

                        // Compute quad positions using pre-computed axes
                        let depth = d as f32 + depth_add;
                        let u0 = u as f32;
                        let v0 = v as f32;
                        let u1 = (u + w) as f32;
                        let v1 = (v + h) as f32;

                        let mut positions = [[0.0f32; 3]; 4];
                        positions[0][u_axis] = u0;
                        positions[0][v_axis] = v0;
                        positions[0][n_axis] = depth;
                        positions[1][u_axis] = u1;
                        positions[1][v_axis] = v0;
                        positions[1][n_axis] = depth;
                        positions[2][u_axis] = u1;
                        positions[2][v_axis] = v1;
                        positions[2][n_axis] = depth;
                        positions[3][u_axis] = u0;
                        positions[3][v_axis] = v1;
                        positions[3][n_axis] = depth;

                        // Tiling UVs
                        let wf = w as f32;
                        let hf = h as f32;
                        let uvs = if swap_uv {
                            [[0.0, 0.0], [0.0, wf], [hf, wf], [hf, 0.0]]
                        } else {
                            [[0.0, 0.0], [wf, 0.0], [wf, hf], [0.0, hf]]
                        };

                        // Convert AO from u8 (0–3) to f32 (0.0–1.0)
                        const AO_SCALE: f32 = 1.0 / 3.0;
                        let ao_f32 = [
                            ao_val[0] as f32 * AO_SCALE,
                            ao_val[1] as f32 * AO_SCALE,
                            ao_val[2] as f32 * AO_SCALE,
                            ao_val[3] as f32 * AO_SCALE,
                        ];

                        output.push_quad(&positions, normal_f32, ao_f32, block_id, &uvs);

                        // Zero out the merged region in the mask
                        for dv in 0..h {
                            for du in 0..w {
                                self.mask[(u + du) + (v + dv) * size] = 0;
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

/// Map face-local 2D coordinates (u, v) and slice depth d to 3D chunk coordinates.
#[cfg(test)]
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
#[cfg(test)]
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

        // 10 quads (shared face culled but can't merge across different IDs)
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

        assert!(!output.is_empty());
        assert_eq!(output.vertex_count(), 24);
        assert_eq!(output.index_count(), 36);
    }

    #[test]
    fn compose_coords_roundtrip() {
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
        let positions = quad_positions(2, 3, 5, 4, 2, Face::PosX);
        assert_eq!(positions[0][0], 6.0); // X = depth
        assert_eq!(positions[0][1], 2.0); // Y = u
        assert_eq!(positions[0][2], 3.0); // Z = v
        assert_eq!(positions[2][1], 6.0); // Y = u + w
        assert_eq!(positions[2][2], 5.0); // Z = v + h
    }

    #[test]
    fn quad_positions_negative_face() {
        let positions = quad_positions(0, 0, 5, 1, 1, Face::NegX);
        assert_eq!(positions[0][0], 5.0);
    }
}
