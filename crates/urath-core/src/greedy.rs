use crate::ao::{AO_SCALE, vertex_ao};
use crate::block::BlockRegistry;
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
/// Produces separate opaque and transparent geometry so the renderer can draw
/// them in the correct order (opaque first, then transparent with alpha test).
///
/// Reference: <https://0fps.net/2012/06/30/meshing-in-a-block-world/>
pub struct GreedyMesher {
    /// Scratch buffer for the face mask of one slice.
    /// Entry is the block_id of the voxel contributing this face, or 0 for no face.
    mask: Vec<u16>,
    /// Scratch buffer for AO values per face in one slice.
    /// Stored as `[u8; 4]` (0–3 per vertex) for exact equality comparison during merge.
    ao_mask: Vec<[u8; 4]>,
    /// Padded (size+2)³ block ID buffer for face culling.
    /// Stores actual block IDs so transparent-vs-opaque decisions can be made per-block.
    padded_blocks: Vec<u16>,
    /// Padded (size+2)³ opacity buffer for AO computation.
    /// Only opaque blocks are marked (1); transparent blocks do not occlude.
    ao_opaque: Vec<u8>,
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
        let pvol = ps * ps * ps;
        Self {
            mask: vec![0u16; area],
            ao_mask: vec![[0u8; 4]; area],
            padded_blocks: vec![0u16; pvol],
            ao_opaque: vec![0u8; pvol],
            chunk_size: size,
        }
    }

    /// Build the padded block ID and AO opacity buffers from chunk data and
    /// neighbor borders. Returns `true` if the chunk contains any transparent
    /// blocks (so the caller can skip the transparent sweep when there are none).
    fn build_padded(
        &mut self,
        chunk: &Chunk,
        neighbors: &ChunkNeighbors,
        registry: &BlockRegistry,
    ) -> bool {
        let s = self.chunk_size;
        let ps = s + 2;
        let ps2 = ps * ps;

        self.padded_blocks.fill(0);
        self.ao_opaque.fill(0);

        let mut has_transparent = false;

        // Fill interior from chunk blocks
        let blocks = chunk.blocks();
        for z in 0..s {
            for y in 0..s {
                let chunk_row = y * s + z * s * s;
                let pad_row = (y + 1) * ps + (z + 1) * ps2;
                for x in 0..s {
                    let block = blocks[chunk_row + x];
                    if block != 0 {
                        let pi = pad_row + x + 1;
                        self.padded_blocks[pi] = block;
                        if registry.is_opaque(block) {
                            self.ao_opaque[pi] = 1;
                        } else {
                            has_transparent = true;
                        }
                    }
                }
            }
        }

        // Fill borders from neighbors.
        for &face in &Face::ALL {
            if let Some(data) = neighbors.border_slice(face) {
                load_border(
                    &mut self.padded_blocks,
                    &mut self.ao_opaque,
                    face,
                    data,
                    s,
                    registry,
                );
            }
        }

        has_transparent
    }

    /// Sweep all 6 face directions and emit greedy-merged quads for one pass.
    ///
    /// When `TRANSPARENT` is false (opaque pass):
    /// - Only processes opaque blocks.
    /// - A face is visible when the neighbor is not opaque (air or transparent).
    ///
    /// When `TRANSPARENT` is true (transparent pass):
    /// - Only processes transparent blocks.
    /// - A face is visible when the neighbor is not opaque AND differs in block ID.
    ///   This means same-type transparent neighbours cull their shared face
    ///   (e.g. leaf-to-leaf), while different types keep both faces visible.
    fn sweep_faces<const TRANSPARENT: bool>(
        &mut self,
        blocks: &[u16],
        registry: &BlockRegistry,
        size: usize,
        output: &mut MeshOutput,
    ) {
        let ps = size + 2;
        let ps2 = ps * ps;

        let chunk_strides: [usize; 3] = [1, size, size * size];
        let pad_strides: [usize; 3] = [1, ps, ps2];
        let pad_origin = 1 + ps + ps2;

        for &face in &Face::ALL {
            let (u_axis, v_axis) = face.tangent_axes();
            let n_axis = face.normal_axis();
            let normal_f32 = face.normal_f32();
            let is_positive = face.is_positive();
            let swap_uv = u_axis == 1;

            let u_cstride = chunk_strides[u_axis];
            let v_cstride = chunk_strides[v_axis];
            let n_cstride = chunk_strides[n_axis];

            let u_pstride = pad_strides[u_axis];
            let v_pstride = pad_strides[v_axis];
            let n_pstride = pad_strides[n_axis];

            let n_poffset: isize = if is_positive {
                n_pstride as isize
            } else {
                -(n_pstride as isize)
            };

            let depth_add: f32 = if is_positive { 1.0 } else { 0.0 };

            for d in 0..size {
                // === Build face mask for this slice ===
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

                        // Block selection: only process blocks matching this pass
                        if TRANSPARENT {
                            if registry.is_opaque(block) {
                                continue;
                            }
                        } else if !registry.is_opaque(block) {
                            continue;
                        }

                        let pad_idx = dv_pad + u * u_pstride;
                        let neighbor_block =
                            self.padded_blocks[(pad_idx as isize + n_poffset) as usize];

                        // Face visibility
                        let face_visible = if TRANSPARENT {
                            // Visible unless neighbour is opaque or same transparent type
                            !registry.is_opaque(neighbor_block) && neighbor_block != block
                        } else {
                            // Visible when neighbour is not opaque (air or transparent)
                            !registry.is_opaque(neighbor_block)
                        };

                        if !face_visible {
                            continue;
                        }

                        let mask_idx = u + v * size;
                        self.mask[mask_idx] = block;

                        // AO: 8 lookups from ao_opaque (only opaque blocks occlude)
                        let center = (pad_idx as isize + n_poffset) as usize;
                        let s_neg_u = self.ao_opaque[center - u_pstride] != 0;
                        let s_pos_u = self.ao_opaque[center + u_pstride] != 0;
                        let s_neg_v = self.ao_opaque[center - v_pstride] != 0;
                        let s_pos_v = self.ao_opaque[center + v_pstride] != 0;
                        let s_nu_nv = self.ao_opaque[center - u_pstride - v_pstride] != 0;
                        let s_pu_nv = self.ao_opaque[center + u_pstride - v_pstride] != 0;
                        let s_pu_pv = self.ao_opaque[center + u_pstride + v_pstride] != 0;
                        let s_nu_pv = self.ao_opaque[center - u_pstride + v_pstride] != 0;

                        self.ao_mask[mask_idx] = [
                            vertex_ao(s_neg_u, s_neg_v, s_nu_nv),
                            vertex_ao(s_pos_u, s_neg_v, s_pu_nv),
                            vertex_ao(s_pos_u, s_pos_v, s_pu_pv),
                            vertex_ao(s_neg_u, s_pos_v, s_nu_pv),
                        ];
                    }
                }

                // === Greedy merge ===
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
    }
}

impl Default for GreedyMesher {
    fn default() -> Self {
        Self::new()
    }
}

/// Load a single neighbor border slice into the padded block and AO buffers.
///
/// Each face maps its 2D border coordinates `(u, v)` — stored as `data[u + v * s]` —
/// to a different padded 3D index depending on which face the border belongs to.
fn load_border(
    padded_blocks: &mut [u16],
    ao_opaque: &mut [u8],
    face: Face,
    data: &[u16],
    s: usize,
    registry: &BlockRegistry,
) {
    let ps = s + 2;
    let ps2 = ps * ps;
    for v in 0..s {
        for u in 0..s {
            let block = data[u + v * s];
            if block == 0 {
                continue;
            }
            let pi = match face {
                Face::NegX => (v + 1) * ps + (u + 1) * ps2,
                Face::PosX => (s + 1) + (v + 1) * ps + (u + 1) * ps2,
                Face::NegY => (u + 1) + (v + 1) * ps2,
                Face::PosY => (u + 1) + (s + 1) * ps + (v + 1) * ps2,
                Face::NegZ => (u + 1) + (v + 1) * ps,
                Face::PosZ => (u + 1) + (v + 1) * ps + (s + 1) * ps2,
            };
            padded_blocks[pi] = block;
            if registry.is_opaque(block) {
                ao_opaque[pi] = 1;
            }
        }
    }
}

impl Mesher for GreedyMesher {
    fn mesh(
        &mut self,
        chunk: &Chunk,
        neighbors: &ChunkNeighbors,
        registry: &BlockRegistry,
        output: &mut MeshOutput,
        transparent_output: &mut MeshOutput,
    ) -> Result<(), MeshError> {
        let size = chunk.size();
        if size != self.chunk_size {
            return Err(MeshError::ChunkSizeMismatch {
                chunk: size,
                mesher: self.chunk_size,
            });
        }

        // Skip entirely empty chunks (no non-air blocks → no faces to emit)
        if chunk.is_empty() {
            return Ok(());
        }

        // Build padded block ID + AO buffers once for the entire mesh
        let has_transparent = self.build_padded(chunk, neighbors, registry);

        let blocks = chunk.blocks();

        // Opaque pass
        self.sweep_faces::<false>(blocks, registry, size, output);

        // Transparent pass (skip if no transparent blocks in chunk)
        if has_transparent {
            self.sweep_faces::<true>(blocks, registry, size, transparent_output);
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
    use crate::block;
    use crate::chunk::CHUNK_SIZE;

    fn mesh_chunk(chunk: &Chunk, neighbors: &ChunkNeighbors) -> (MeshOutput, MeshOutput) {
        let registry = BlockRegistry::new();
        mesh_chunk_with_registry(chunk, neighbors, &registry)
    }

    fn mesh_chunk_with_registry(
        chunk: &Chunk,
        neighbors: &ChunkNeighbors,
        registry: &BlockRegistry,
    ) -> (MeshOutput, MeshOutput) {
        let mut mesher = GreedyMesher::with_chunk_size(chunk.size());
        let mut output = MeshOutput::new();
        let mut transparent = MeshOutput::new();
        mesher
            .mesh(chunk, neighbors, registry, &mut output, &mut transparent)
            .unwrap();
        (output, transparent)
    }

    #[test]
    fn empty_chunk() {
        let chunk = Chunk::new_default();
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let (output, transparent) = mesh_chunk(&chunk, &neighbors);
        assert!(output.is_empty());
        assert!(transparent.is_empty());
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
        let (output, transparent) = mesh_chunk(&chunk, &neighbors);

        // A solid chunk with air neighbors has 6 faces, each fully merged into 1 quad
        assert_eq!(output.vertex_count(), 24); // 6 faces × 4 vertices
        assert_eq!(output.index_count(), 36); // 6 faces × 6 indices
        assert!(transparent.is_empty());
    }

    #[test]
    fn single_block() {
        let mut chunk = Chunk::new_default();
        chunk.set(16, 16, 16, 1);
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let (output, _) = mesh_chunk(&chunk, &neighbors);

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
        let (output, _) = mesh_chunk(&chunk, &neighbors);

        assert_eq!(output.vertex_count(), 24);
        assert_eq!(output.index_count(), 36);
    }

    #[test]
    fn different_block_ids_dont_merge() {
        let mut chunk = Chunk::new_default();
        chunk.set(0, 0, 0, 1);
        chunk.set(1, 0, 0, 2); // Different block ID
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let (output, _) = mesh_chunk(&chunk, &neighbors);

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
        pos_x_border[0] = 1; // Block at (z=0, y=0) on neighbor border
        neighbors.set_face(Face::PosX, pos_x_border).unwrap();

        let (output, _) = mesh_chunk(&chunk, &neighbors);

        // The +X face of our block should be culled by the neighbor.
        // Remaining: 5 faces × 1 quad each
        assert_eq!(output.vertex_count(), 20); // 5 × 4
        assert_eq!(output.index_count(), 30); // 5 × 6
    }

    #[test]
    fn checkerboard_no_merge() {
        // 4x4x4 chunk with checkerboard pattern (alternating fill)
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
                            let oob = !(0..4).contains(&nx)
                                || !(0..4).contains(&ny)
                                || !(0..4).contains(&nz);
                            if oob || (nx + ny + nz) % 2 != 0 {
                                expected_faces += 1;
                            }
                        }
                    }
                }
            }
        }

        let neighbors = ChunkNeighbors::empty(4);
        let mut mesher = GreedyMesher::with_chunk_size(4);
        let registry = BlockRegistry::new();
        let mut output = MeshOutput::new();
        let mut transparent = MeshOutput::new();
        mesher
            .mesh(&chunk, &neighbors, &registry, &mut output, &mut transparent)
            .unwrap();

        // Each face is 1x1, no merging possible in a checkerboard
        assert_eq!(output.vertex_count(), expected_faces * 4);
    }

    #[test]
    fn mesh_output_reuse() {
        let mut chunk = Chunk::new_default();
        chunk.set(10, 10, 10, 1);
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let registry = BlockRegistry::new();
        let mut mesher = GreedyMesher::new();
        let mut output = MeshOutput::with_capacity(100);
        let mut transparent = MeshOutput::new();

        // First mesh
        mesher
            .mesh(&chunk, &neighbors, &registry, &mut output, &mut transparent)
            .unwrap();
        let first_vertex_count = output.vertex_count();
        let first_index_count = output.index_count();
        assert!(!output.is_empty());

        // Clear and mesh again
        output.clear();
        transparent.clear();
        mesher
            .mesh(&chunk, &neighbors, &registry, &mut output, &mut transparent)
            .unwrap();

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
        let registry = BlockRegistry::new();
        let mut output = MeshOutput::new();
        let mut transparent = MeshOutput::new();
        mesher
            .mesh(&chunk, &neighbors, &registry, &mut output, &mut transparent)
            .unwrap();

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

    // --- Transparent block tests ---

    #[test]
    fn single_transparent_block() {
        let mut chunk = Chunk::new(4).unwrap();
        chunk.set(2, 2, 2, block::LEAVES);
        let neighbors = ChunkNeighbors::empty(4);
        let (output, transparent) = mesh_chunk(&chunk, &neighbors);

        // Opaque output should be empty
        assert!(output.is_empty());
        // Transparent should have 6 faces
        assert_eq!(transparent.vertex_count(), 24);
        assert_eq!(transparent.index_count(), 36);
    }

    #[test]
    fn transparent_blocks_self_cull() {
        // Two adjacent leaves blocks should cull their shared face
        let mut chunk = Chunk::new(4).unwrap();
        chunk.set(1, 1, 1, block::LEAVES);
        chunk.set(2, 1, 1, block::LEAVES);
        let neighbors = ChunkNeighbors::empty(4);
        let (output, transparent) = mesh_chunk(&chunk, &neighbors);

        assert!(output.is_empty());
        // 2 blocks × 6 faces - 2 culled shared faces = 10 quads
        // But greedy merge joins the 4 co-planar same-ID faces → fewer quads
        // Each merged face still needs correct vertex/index count
        // 10 individual faces, some merge → total vertices ≤ 40
        assert!(transparent.vertex_count() <= 40);
        assert!(transparent.vertex_count() > 0);
    }

    #[test]
    fn opaque_next_to_transparent_shows_opaque_face() {
        // Stone next to leaves: the stone face touching leaves must be visible
        let mut chunk = Chunk::new(4).unwrap();
        chunk.set(1, 1, 1, block::STONE);
        chunk.set(2, 1, 1, block::LEAVES);
        let neighbors = ChunkNeighbors::empty(4);
        let (output, transparent) = mesh_chunk(&chunk, &neighbors);

        // Stone has 6 visible faces (leaves neighbor is transparent, so face shows)
        assert_eq!(output.vertex_count(), 24);
        // Leaves: 5 visible faces (face touching stone is hidden by the opaque block)
        assert_eq!(transparent.vertex_count(), 20);
    }

    #[test]
    fn different_transparent_types_dont_cull() {
        // Leaves next to water: both faces should be visible
        let mut chunk = Chunk::new(4).unwrap();
        chunk.set(1, 1, 1, block::LEAVES);
        chunk.set(2, 1, 1, block::WATER);
        let neighbors = ChunkNeighbors::empty(4);
        let (output, transparent) = mesh_chunk(&chunk, &neighbors);

        assert!(output.is_empty());
        // Both blocks have all 6 faces visible (different transparent types don't cull)
        assert_eq!(transparent.vertex_count(), 48); // 12 quads × 4 vertices
    }

    #[test]
    fn transparent_does_not_contribute_ao() {
        // An opaque block surrounded by leaves should have no AO darkening
        let mut chunk = Chunk::new(8).unwrap();
        chunk.set(4, 4, 4, block::STONE);
        // Place leaves around the +Y face
        chunk.set(3, 5, 4, block::LEAVES);
        chunk.set(4, 5, 3, block::LEAVES);
        chunk.set(3, 5, 3, block::LEAVES);

        let neighbors = ChunkNeighbors::empty(8);
        let (output, _) = mesh_chunk(&chunk, &neighbors);

        // Check that all AO values are 1.0 (fully lit) since leaves don't occlude
        for &val in output.ao.iter() {
            assert_eq!(val, 1.0, "transparent blocks should not contribute to AO");
        }
    }

    #[test]
    fn all_opaque_registry_treats_leaves_as_opaque() {
        // Custom registry where leaves are opaque
        let mut registry = BlockRegistry::new();
        registry.set_opaque(block::LEAVES);

        let mut chunk = Chunk::new(4).unwrap();
        chunk.set(1, 1, 1, block::STONE);
        chunk.set(2, 1, 1, block::LEAVES);
        let neighbors = ChunkNeighbors::empty(4);
        let (output, transparent) = mesh_chunk_with_registry(&chunk, &neighbors, &registry);

        // Both blocks are opaque now, shared face culled
        // 10 quads total in opaque output
        assert_eq!(output.vertex_count(), 40);
        assert!(transparent.is_empty());
    }
}
