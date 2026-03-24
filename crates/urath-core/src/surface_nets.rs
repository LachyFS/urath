use crate::chunk::{Chunk, ChunkNeighbors, Face};
use crate::error::MeshError;
use crate::mesh_output::MeshOutput;
use crate::mesher::Mesher;

/// Surface Nets mesher for smooth voxel terrain.
///
/// Implements Naive Surface Nets: for each cell containing a sign change,
/// places a vertex at the average of edge crossings, then connects
/// adjacent active cells with quads.
pub struct SurfaceNetsMesher {
    /// Padded density: (size+2)³. Negative = solid, positive = air.
    density: Vec<f32>,
    /// Scratch buffer for density smoothing pass.
    density_scratch: Vec<f32>,
    /// Padded materials: (size+2)³.
    materials: Vec<u16>,
    /// Vertex index per cell: size³. `u32::MAX` = no vertex.
    vertex_indices: Vec<u32>,
    chunk_size: usize,
}

const NO_VERTEX: u32 = u32::MAX;

/// The 12 edges of a unit cube, as pairs of corner indices.
const EDGES: [[usize; 2]; 12] = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7], // X-aligned
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7], // Y-aligned
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7], // Z-aligned
];

/// Corner positions relative to cell origin.
const CORNERS: [[f32; 3]; 8] = [
    [0.0, 0.0, 0.0],
    [1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [1.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
    [1.0, 0.0, 1.0],
    [0.0, 1.0, 1.0],
    [1.0, 1.0, 1.0],
];

impl SurfaceNetsMesher {
    pub fn new() -> Self {
        Self::with_chunk_size(32)
    }

    pub fn with_chunk_size(size: usize) -> Self {
        let ps = size + 2;
        Self {
            density: vec![1.0; ps * ps * ps],
            density_scratch: vec![1.0; ps * ps * ps],
            materials: vec![0u16; ps * ps * ps],
            // (size+1)³ grid: covers cell positions -1..size-1 with +1 offset
            vertex_indices: vec![NO_VERTEX; (size + 1) * (size + 1) * (size + 1)],
            chunk_size: size,
        }
    }

    /// Build padded density field from chunk block data + neighbor borders.
    /// Solid blocks → -1.0, air → 1.0.
    fn build_density(&mut self, chunk: &Chunk, neighbors: &ChunkNeighbors) {
        let s = self.chunk_size;
        let ps = s + 2;
        let ps2 = ps * ps;

        // Default: air (positive density)
        self.density.fill(1.0);
        self.materials.fill(0);

        // Interior from chunk blocks
        let blocks = chunk.blocks();
        for z in 0..s {
            for y in 0..s {
                let chunk_row = y * s + z * s * s;
                let pad_row = (y + 1) * ps + (z + 1) * ps2;
                for x in 0..s {
                    let block = blocks[chunk_row + x];
                    if block != 0 {
                        self.density[pad_row + x + 1] = -1.0;
                        self.materials[pad_row + x + 1] = block;
                    }
                }
            }
        }

        // Borders from neighbors
        if let Some(data) = neighbors.border_slice(Face::NegX) {
            for y in 0..s {
                for z in 0..s {
                    let block = data[z + y * s];
                    if block != 0 {
                        let pi = (y + 1) * ps + (z + 1) * ps2;
                        self.density[pi] = -1.0;
                        self.materials[pi] = block;
                    }
                }
            }
        }
        if let Some(data) = neighbors.border_slice(Face::PosX) {
            for y in 0..s {
                for z in 0..s {
                    let block = data[z + y * s];
                    if block != 0 {
                        let pi = (s + 1) + (y + 1) * ps + (z + 1) * ps2;
                        self.density[pi] = -1.0;
                        self.materials[pi] = block;
                    }
                }
            }
        }
        if let Some(data) = neighbors.border_slice(Face::NegY) {
            for z in 0..s {
                for x in 0..s {
                    let block = data[x + z * s];
                    if block != 0 {
                        let pi = (x + 1) + (z + 1) * ps2;
                        self.density[pi] = -1.0;
                        self.materials[pi] = block;
                    }
                }
            }
        }
        if let Some(data) = neighbors.border_slice(Face::PosY) {
            for z in 0..s {
                for x in 0..s {
                    let block = data[x + z * s];
                    if block != 0 {
                        let pi = (x + 1) + (s + 1) * ps + (z + 1) * ps2;
                        self.density[pi] = -1.0;
                        self.materials[pi] = block;
                    }
                }
            }
        }
        if let Some(data) = neighbors.border_slice(Face::NegZ) {
            for y in 0..s {
                for x in 0..s {
                    let block = data[x + y * s];
                    if block != 0 {
                        let pi = (x + 1) + (y + 1) * ps;
                        self.density[pi] = -1.0;
                        self.materials[pi] = block;
                    }
                }
            }
        }
        if let Some(data) = neighbors.border_slice(Face::PosZ) {
            for y in 0..s {
                for x in 0..s {
                    let block = data[x + y * s];
                    if block != 0 {
                        let pi = (x + 1) + (y + 1) * ps + (s + 1) * ps2;
                        self.density[pi] = -1.0;
                        self.materials[pi] = block;
                    }
                }
            }
        }

        // Smooth the binary density field to produce gradients at the surface.
        // 2 passes of 6-neighbor averaging turns the sharp -1/+1 step into a
        // smooth transition, giving Surface Nets continuous edge crossings.
        // Ping-pong between buffers: one copy instead of two.
        self.density_scratch.copy_from_slice(&self.density);

        // Pass 1: read density_scratch → write density
        for z in 1..ps - 1 {
            for y in 1..ps - 1 {
                for x in 1..ps - 1 {
                    let pi = x + y * ps + z * ps2;
                    self.density[pi] = (self.density_scratch[pi] * 2.0
                        + self.density_scratch[pi - 1]
                        + self.density_scratch[pi + 1]
                        + self.density_scratch[pi - ps]
                        + self.density_scratch[pi + ps]
                        + self.density_scratch[pi - ps2]
                        + self.density_scratch[pi + ps2])
                        / 8.0;
                }
            }
        }

        // Pass 2: read density → write density_scratch
        for z in 1..ps - 1 {
            for y in 1..ps - 1 {
                for x in 1..ps - 1 {
                    let pi = x + y * ps + z * ps2;
                    self.density_scratch[pi] = (self.density[pi] * 2.0
                        + self.density[pi - 1]
                        + self.density[pi + 1]
                        + self.density[pi - ps]
                        + self.density[pi + ps]
                        + self.density[pi - ps2]
                        + self.density[pi + ps2])
                        / 8.0;
                }
            }
        }

        // Final result is in density_scratch; swap so density has the result
        std::mem::swap(&mut self.density, &mut self.density_scratch);

        // Blend smoothed density back to binary near chunk boundaries.
        // Both the padding layer (position -1/size) AND the first/last chunk
        // positions (0/size-1) are forced fully binary so neighboring chunks
        // agree on density at their shared boundary. The blend then ramps
        // from binary to smoothed over ~4 voxels inward.
        let blend_dist = 4.0f32;
        for z in 0..ps {
            for y in 0..ps {
                for x in 0..ps {
                    // Distance from the second padded layer inward.
                    // Padded 0,1 and ps-2,ps-1 all get d=0 (fully binary).
                    let dx = 0i32.max((x as i32 - 1).min(ps as i32 - 2 - x as i32));
                    let dy = 0i32.max((y as i32 - 1).min(ps as i32 - 2 - y as i32));
                    let dz = 0i32.max((z as i32 - 1).min(ps as i32 - 2 - z as i32));
                    let d = dx.min(dy).min(dz) as f32;
                    if d >= blend_dist {
                        continue;
                    }
                    let t = d / blend_dist;
                    let pi = x + y * ps + z * ps2;
                    let binary: f32 = if self.materials[pi] != 0 { -1.0 } else { 1.0 };
                    self.density[pi] = binary + (self.density[pi] - binary) * t;
                }
            }
        }
    }

    /// Compute gradient (normal) and AO from a single pass over the 3x3x3 neighborhood.
    /// Clamped to the valid interior of the padded buffer so boundary cells
    /// get values from the nearest interior position.
    #[inline]
    fn gradient_and_ao_at_cell(
        &self,
        cx: isize,
        cy: isize,
        cz: isize,
        ps: usize,
    ) -> ([f32; 3], f32) {
        let ps2 = ps * ps;
        let px = (cx + 1).clamp(1, ps as isize - 2) as usize;
        let py = (cy + 1).clamp(1, ps as isize - 2) as usize;
        let pz = (cz + 1).clamp(1, ps as isize - 2) as usize;
        let pi = px + py * ps + pz * ps2;

        // Read 6 axis-aligned neighbors (used for both gradient and AO)
        let d_nx = self.density[pi - 1];
        let d_px = self.density[pi + 1];
        let d_ny = self.density[pi - ps];
        let d_py = self.density[pi + ps];
        let d_nz = self.density[pi - ps2];
        let d_pz = self.density[pi + ps2];

        // Gradient from central differences
        let gx = d_px - d_nx;
        let gy = d_py - d_ny;
        let gz = d_pz - d_nz;
        let len = (gx * gx + gy * gy + gz * gz).sqrt();
        let normal = if len > 0.0 {
            [gx / len, gy / len, gz / len]
        } else {
            [0.0, 1.0, 0.0]
        };

        // AO: count solid in 3x3x3 neighborhood (26 neighbors).
        // Start with the 6 axis-aligned neighbors already loaded.
        let mut solid = (d_nx < 0.0) as u32
            + (d_px < 0.0) as u32
            + (d_ny < 0.0) as u32
            + (d_py < 0.0) as u32
            + (d_nz < 0.0) as u32
            + (d_pz < 0.0) as u32;

        // 12 edge neighbors
        let psi = ps as isize;
        let ps2i = ps2 as isize;
        solid += (self.density[(pi as isize - 1 - psi) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize + 1 - psi) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize - 1 + psi) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize + 1 + psi) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize - 1 - ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize + 1 - ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize - 1 + ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize + 1 + ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize - psi - ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize + psi - ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize - psi + ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize + psi + ps2i) as usize] < 0.0) as u32;

        // 8 corner neighbors
        solid += (self.density[(pi as isize - 1 - psi - ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize + 1 - psi - ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize - 1 + psi - ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize + 1 + psi - ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize - 1 - psi + ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize + 1 - psi + ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize - 1 + psi + ps2i) as usize] < 0.0) as u32;
        solid += (self.density[(pi as isize + 1 + psi + ps2i) as usize] < 0.0) as u32;

        let ao = 1.0 - (solid as f32 / 26.0) * 0.6;
        (normal, ao)
    }
}

impl Default for SurfaceNetsMesher {
    fn default() -> Self {
        Self::new()
    }
}

impl Mesher for SurfaceNetsMesher {
    fn mesh(
        &mut self,
        chunk: &Chunk,
        neighbors: &ChunkNeighbors,
        output: &mut MeshOutput,
    ) -> Result<(), MeshError> {
        let size = chunk.size();
        debug_assert_eq!(size, self.chunk_size);

        // Skip if no solid blocks anywhere in the padded volume
        if chunk.is_empty() && !neighbors.has_any_face() {
            return Ok(());
        }

        self.build_density(chunk, neighbors);
        self.vertex_indices.fill(NO_VERTEX);

        let ps = size + 2;
        let ps2 = ps * ps;

        // Vertex grid: (size+1)³ covers cell positions -1..size-1.
        // Cell position p maps to grid index (p+1) + (p+1)*gs + (p+1)*gs².
        let gs = size + 1;
        let gs2 = gs * gs;
        let size_i = size as isize;

        // === Pass 1: Place vertices at active cells ===
        // Cells from -1 to size-1 (includes boundary layer from padded density).
        for cz in -1..size_i {
            for cy in -1..size_i {
                for cx in -1..size_i {
                    // Padded index of corner 0 at density position (cx, cy, cz)
                    // → padded (cx+1, cy+1, cz+1)
                    let px = (cx + 1) as usize;
                    let py = (cy + 1) as usize;
                    let pz = (cz + 1) as usize;
                    let p0 = px + py * ps + pz * ps2;

                    // Read 8 corner densities
                    let d = [
                        self.density[p0],
                        self.density[p0 + 1],
                        self.density[p0 + ps],
                        self.density[p0 + 1 + ps],
                        self.density[p0 + ps2],
                        self.density[p0 + 1 + ps2],
                        self.density[p0 + ps + ps2],
                        self.density[p0 + 1 + ps + ps2],
                    ];

                    // Corner sign mask
                    let mut mask = 0u8;
                    for (i, &di) in d.iter().enumerate() {
                        if di < 0.0 {
                            mask |= 1 << i;
                        }
                    }

                    if mask == 0 || mask == 0xFF {
                        continue;
                    }

                    // Average edge crossing points
                    let mut avg = [0.0f32; 3];
                    let mut count = 0u32;

                    for &[a, b] in &EDGES {
                        if ((mask >> a) & 1) != ((mask >> b) & 1) {
                            let t = d[a] / (d[a] - d[b]);
                            avg[0] += CORNERS[a][0] + t * (CORNERS[b][0] - CORNERS[a][0]);
                            avg[1] += CORNERS[a][1] + t * (CORNERS[b][1] - CORNERS[a][1]);
                            avg[2] += CORNERS[a][2] + t * (CORNERS[b][2] - CORNERS[a][2]);
                            count += 1;
                        }
                    }

                    if count == 0 {
                        continue;
                    }

                    let inv = 1.0 / count as f32;
                    let vx = cx as f32 + avg[0] * inv;
                    let vy = cy as f32 + avg[1] * inv;
                    let vz = cz as f32 + avg[2] * inv;

                    let (normal, ao) = self.gradient_and_ao_at_cell(cx, cy, cz, ps);

                    // Material: first solid corner's block ID (O(1) via trailing_zeros)
                    let first_solid = mask.trailing_zeros() as usize;
                    let corner_offsets = [0, 1, ps, 1 + ps, ps2, 1 + ps2, ps + ps2, 1 + ps + ps2];
                    let material = self.materials[p0 + corner_offsets[first_solid]];

                    let uv = [vx, vz];
                    let vi = output.push_vertex([vx, vy, vz], normal, ao, material, uv);

                    // Grid index with +1 offset
                    let gx = (cx + 1) as usize;
                    let gy = (cy + 1) as usize;
                    let gz = (cz + 1) as usize;
                    self.vertex_indices[gx + gy * gs + gz * gs2] = vi;
                }
            }
        }

        // === Pass 2: Emit quads for each crossing edge ===
        // Combined single pass over all 3 edge directions.
        // Reads d0 once per cell and checks X/Y/Z neighbors.
        // Uses precomputed vertex grid offsets instead of per-call arithmetic.
        let vi = &self.vertex_indices;

        for z in 0..size {
            for y in 0..size {
                let pi_row = (y + 1) * ps + (z + 1) * ps2;
                let gi_row = (y + 1) * gs + (z + 1) * gs2;

                for x in 0..size {
                    let pi = (x + 1) + pi_row;
                    let d0 = self.density[pi];
                    let d0_neg = d0 < 0.0;
                    let gi = (x + 1) + gi_row;

                    // X-edge: (x,y,z) → (x+1,y,z)
                    // Quad cells: (x, y-1, z-1), (x, y, z-1), (x, y-1, z), (x, y, z)
                    if d0_neg != (self.density[pi + 1] < 0.0) {
                        let c0 = vi[gi - gs - gs2];
                        let c1 = vi[gi - gs2];
                        let c2 = vi[gi - gs];
                        let c3 = vi[gi];
                        if c0 != NO_VERTEX && c1 != NO_VERTEX && c2 != NO_VERTEX && c3 != NO_VERTEX
                        {
                            if d0_neg {
                                output.push_triangle(c0, c2, c3);
                                output.push_triangle(c0, c3, c1);
                            } else {
                                output.push_triangle(c0, c3, c2);
                                output.push_triangle(c0, c1, c3);
                            }
                        }
                    }

                    // Y-edge: (x,y,z) → (x,y+1,z)
                    // Quad cells: (x-1, y, z-1), (x, y, z-1), (x-1, y, z), (x, y, z)
                    if d0_neg != (self.density[pi + ps] < 0.0) {
                        let c0 = vi[gi - 1 - gs2];
                        let c1 = vi[gi - gs2];
                        let c2 = vi[gi - 1];
                        let c3 = vi[gi];
                        if c0 != NO_VERTEX && c1 != NO_VERTEX && c2 != NO_VERTEX && c3 != NO_VERTEX
                        {
                            if d0_neg {
                                output.push_triangle(c0, c1, c3);
                                output.push_triangle(c0, c3, c2);
                            } else {
                                output.push_triangle(c0, c3, c1);
                                output.push_triangle(c0, c2, c3);
                            }
                        }
                    }

                    // Z-edge: (x,y,z) → (x,y,z+1)
                    // Quad cells: (x-1, y-1, z), (x, y-1, z), (x-1, y, z), (x, y, z)
                    if d0_neg != (self.density[pi + ps2] < 0.0) {
                        let c0 = vi[gi - 1 - gs];
                        let c1 = vi[gi - gs];
                        let c2 = vi[gi - 1];
                        let c3 = vi[gi];
                        if c0 != NO_VERTEX && c1 != NO_VERTEX && c2 != NO_VERTEX && c3 != NO_VERTEX
                        {
                            if d0_neg {
                                output.push_triangle(c0, c2, c3);
                                output.push_triangle(c0, c3, c1);
                            } else {
                                output.push_triangle(c0, c3, c2);
                                output.push_triangle(c0, c1, c3);
                            }
                        }
                    }
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::CHUNK_SIZE;

    fn mesh_chunk(chunk: &Chunk, neighbors: &ChunkNeighbors) -> MeshOutput {
        let mut mesher = SurfaceNetsMesher::with_chunk_size(chunk.size());
        let mut output = MeshOutput::new();
        mesher.mesh(chunk, neighbors, &mut output).unwrap();
        output
    }

    #[test]
    fn empty_chunk_produces_no_geometry() {
        let chunk = Chunk::new_default();
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let output = mesh_chunk(&chunk, &neighbors);
        assert!(output.is_empty());
    }

    #[test]
    fn small_cluster_produces_geometry() {
        // A 3x3x3 cluster survives smoothing and produces surface geometry
        let mut chunk = Chunk::new_default();
        for z in 15..18 {
            for y in 15..18 {
                for x in 15..18 {
                    chunk.set(x, y, z, 1);
                }
            }
        }
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let output = mesh_chunk(&chunk, &neighbors);
        assert!(!output.is_empty());
        assert!(output.vertex_count() > 0);
        assert!(output.index_count() > 0);
    }

    #[test]
    fn solid_chunk_produces_geometry() {
        let mut chunk = Chunk::new(4).unwrap();
        for z in 0..4 {
            for y in 0..4 {
                for x in 0..4 {
                    chunk.set(x, y, z, 1);
                }
            }
        }
        let neighbors = ChunkNeighbors::empty(4);
        let output = mesh_chunk(&chunk, &neighbors);
        // Surface should exist at the chunk boundary
        assert!(!output.is_empty());
    }

    #[test]
    fn half_filled_produces_surface() {
        let mut chunk = Chunk::new(8).unwrap();
        // Fill bottom half (y < 4)
        for z in 0..8 {
            for y in 0..4 {
                for x in 0..8 {
                    chunk.set(x, y, z, 1);
                }
            }
        }
        let neighbors = ChunkNeighbors::empty(8);
        let output = mesh_chunk(&chunk, &neighbors);

        assert!(!output.is_empty());
        // Should have a reasonable number of vertices for a surface
        assert!(output.vertex_count() > 10);
    }

    #[test]
    fn output_reuse() {
        let mut chunk = Chunk::new_default();
        for z in 10..13 {
            for y in 10..13 {
                for x in 10..13 {
                    chunk.set(x, y, z, 1);
                }
            }
        }
        let neighbors = ChunkNeighbors::empty(CHUNK_SIZE);
        let mut mesher = SurfaceNetsMesher::new();
        let mut output = MeshOutput::new();

        mesher.mesh(&chunk, &neighbors, &mut output).unwrap();
        let v1 = output.vertex_count();
        assert!(v1 > 0);

        output.clear();
        mesher.mesh(&chunk, &neighbors, &mut output).unwrap();
        assert_eq!(output.vertex_count(), v1);
    }
}
