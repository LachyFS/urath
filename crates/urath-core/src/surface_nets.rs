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
    /// Padded materials: (size+2)³.
    materials: Vec<u16>,
    /// Vertex index per cell: size³. `u32::MAX` = no vertex.
    vertex_indices: Vec<u32>,
    chunk_size: usize,
}

const NO_VERTEX: u32 = u32::MAX;

/// The 12 edges of a unit cube, as pairs of corner indices.
const EDGES: [[usize; 2]; 12] = [
    [0, 1], [2, 3], [4, 5], [6, 7], // X-aligned
    [0, 2], [1, 3], [4, 6], [5, 7], // Y-aligned
    [0, 4], [1, 5], [2, 6], [3, 7], // Z-aligned
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
            density: vec![0.0; ps * ps * ps],
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
    }

    /// Compute smooth normal from density gradient at padded cell center.
    /// Uses the center of the cell (offset by 0.5 in each axis from corner 0)
    /// approximated by sampling at the padded corner position, clamped to valid range.
    #[inline]
    fn gradient(&self, pi: usize, ps: usize) -> [f32; 3] {
        let ps2 = ps * ps;
        // Use forward differences at edges of the padded buffer
        let max_idx = self.density.len() - 1;
        let nx = if pi >= 1 && pi + 1 <= max_idx {
            self.density[pi + 1] - self.density[pi - 1]
        } else {
            0.0
        };
        let ny = if pi >= ps && pi + ps <= max_idx {
            self.density[pi + ps] - self.density[pi - ps]
        } else {
            0.0
        };
        let nz = if pi >= ps2 && pi + ps2 <= max_idx {
            self.density[pi + ps2] - self.density[pi - ps2]
        } else {
            0.0
        };
        let len = (nx * nx + ny * ny + nz * nz).sqrt();
        if len > 0.0 {
            [nx / len, ny / len, nz / len]
        } else {
            [0.0, 1.0, 0.0]
        }
    }

    /// Compute AO by counting solid neighbors in 3x3x3 neighborhood.
    #[inline]
    fn compute_ao(&self, pi: usize, ps: usize) -> f32 {
        let ps2 = ps * ps;
        let max_idx = self.density.len() - 1;
        // Skip AO computation if too close to buffer edges
        if pi < ps2 + ps + 1 || pi + ps2 + ps + 1 > max_idx {
            return 1.0;
        }
        let mut solid = 0u32;
        for dz in [-(ps2 as isize), 0, ps2 as isize] {
            for dy in [-(ps as isize), 0, ps as isize] {
                for dx in [-1isize, 0, 1] {
                    if dx == 0 && dy == 0 && dz == 0 {
                        continue;
                    }
                    let idx = (pi as isize + dx + dy + dz) as usize;
                    if self.density[idx] < 0.0 {
                        solid += 1;
                    }
                }
            }
        }
        1.0 - (solid as f32 / 26.0) * 0.6
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

                    let normal = self.gradient(p0, ps);
                    let ao = self.compute_ao(p0, ps);

                    // Material: first solid corner's block ID
                    let mut material = 0u16;
                    let corner_offsets =
                        [0, 1, ps, 1 + ps, ps2, 1 + ps2, ps + ps2, 1 + ps + ps2];
                    for (i, &off) in corner_offsets.iter().enumerate() {
                        if (mask >> i) & 1 != 0 {
                            material = self.materials[p0 + off];
                            break;
                        }
                    }

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
        // With the extended grid, all density edges within [0, size-1] can form
        // complete quads (cells at -1 are now in the vertex grid).

        // Helper to look up a cell vertex from signed cell position.
        let cell_vi = |cx: isize, cy: isize, cz: isize| -> u32 {
            let gx = (cx + 1) as usize;
            let gy = (cy + 1) as usize;
            let gz = (cz + 1) as usize;
            self.vertex_indices[gx + gy * gs + gz * gs2]
        };

        // X-edges: density (x,y,z) to (x+1,y,z)
        // 4 cells: (x, y-1, z-1), (x, y, z-1), (x, y-1, z), (x, y, z)
        for z in 0..size {
            for y in 0..size {
                for x in 0..size {
                    let pi = (x + 1) + (y + 1) * ps + (z + 1) * ps2;
                    let d0 = self.density[pi];
                    let d1 = self.density[pi + 1];
                    if (d0 < 0.0) == (d1 < 0.0) {
                        continue;
                    }

                    let xi = x as isize;
                    let yi = y as isize;
                    let zi = z as isize;
                    let c0 = cell_vi(xi, yi - 1, zi - 1);
                    let c1 = cell_vi(xi, yi, zi - 1);
                    let c2 = cell_vi(xi, yi - 1, zi);
                    let c3 = cell_vi(xi, yi, zi);

                    if c0 == NO_VERTEX || c1 == NO_VERTEX || c2 == NO_VERTEX || c3 == NO_VERTEX
                    {
                        continue;
                    }

                    if d0 < 0.0 {
                        output.push_triangle(c0, c2, c3);
                        output.push_triangle(c0, c3, c1);
                    } else {
                        output.push_triangle(c0, c3, c2);
                        output.push_triangle(c0, c1, c3);
                    }
                }
            }
        }

        // Y-edges: density (x,y,z) to (x,y+1,z)
        // 4 cells: (x-1, y, z-1), (x, y, z-1), (x-1, y, z), (x, y, z)
        for z in 0..size {
            for y in 0..size {
                for x in 0..size {
                    let pi = (x + 1) + (y + 1) * ps + (z + 1) * ps2;
                    let d0 = self.density[pi];
                    let d1 = self.density[pi + ps];
                    if (d0 < 0.0) == (d1 < 0.0) {
                        continue;
                    }

                    let xi = x as isize;
                    let yi = y as isize;
                    let zi = z as isize;
                    let c0 = cell_vi(xi - 1, yi, zi - 1);
                    let c1 = cell_vi(xi, yi, zi - 1);
                    let c2 = cell_vi(xi - 1, yi, zi);
                    let c3 = cell_vi(xi, yi, zi);

                    if c0 == NO_VERTEX || c1 == NO_VERTEX || c2 == NO_VERTEX || c3 == NO_VERTEX
                    {
                        continue;
                    }

                    if d0 < 0.0 {
                        output.push_triangle(c0, c1, c3);
                        output.push_triangle(c0, c3, c2);
                    } else {
                        output.push_triangle(c0, c3, c1);
                        output.push_triangle(c0, c2, c3);
                    }
                }
            }
        }

        // Z-edges: density (x,y,z) to (x,y,z+1)
        // 4 cells: (x-1, y-1, z), (x, y-1, z), (x-1, y, z), (x, y, z)
        for z in 0..size {
            for y in 0..size {
                for x in 0..size {
                    let pi = (x + 1) + (y + 1) * ps + (z + 1) * ps2;
                    let d0 = self.density[pi];
                    let d1 = self.density[pi + ps2];
                    if (d0 < 0.0) == (d1 < 0.0) {
                        continue;
                    }

                    let xi = x as isize;
                    let yi = y as isize;
                    let zi = z as isize;
                    let c0 = cell_vi(xi - 1, yi - 1, zi);
                    let c1 = cell_vi(xi, yi - 1, zi);
                    let c2 = cell_vi(xi - 1, yi, zi);
                    let c3 = cell_vi(xi, yi, zi);

                    if c0 == NO_VERTEX || c1 == NO_VERTEX || c2 == NO_VERTEX || c3 == NO_VERTEX
                    {
                        continue;
                    }

                    if d0 < 0.0 {
                        output.push_triangle(c0, c2, c3);
                        output.push_triangle(c0, c3, c1);
                    } else {
                        output.push_triangle(c0, c3, c2);
                        output.push_triangle(c0, c1, c3);
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
    fn single_block_produces_geometry() {
        let mut chunk = Chunk::new_default();
        chunk.set(16, 16, 16, 1);
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
        chunk.set(10, 10, 10, 1);
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
