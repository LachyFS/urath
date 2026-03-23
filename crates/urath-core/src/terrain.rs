use crate::block;
use crate::chunk::Chunk;
use crate::error::MeshError;
use crate::noise;

/// Biome classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Biome {
    Desert = 0,
    Mountain = 1,
    Forest = 2,
    Plains = 3,
}

/// Configuration for terrain generation.
#[derive(Debug, Clone)]
pub struct TerrainConfig {
    pub seed: u32,
    pub sea_level: i32,
    pub world_height_blocks: i32,
    pub chunk_size: usize,
}

impl Default for TerrainConfig {
    fn default() -> Self {
        Self {
            seed: 0,
            sea_level: 24,
            world_height_blocks: 256,
            chunk_size: 32,
        }
    }
}

/// Reusable terrain generator.
///
/// Holds scratch buffers for per-column caching within a single `generate()` call.
/// For thread safety, create one per thread (they are cheap to construct).
pub struct TerrainGenerator {
    config: TerrainConfig,
    height_cache: Vec<i32>,
    biome_cache: Vec<Biome>,
}

impl TerrainGenerator {
    /// Create a terrain generator with the given config.
    pub fn new(config: TerrainConfig) -> Result<Self, MeshError> {
        if config.chunk_size > crate::chunk::MAX_CHUNK_SIZE {
            return Err(MeshError::ChunkTooLarge(
                config.chunk_size,
                crate::chunk::MAX_CHUNK_SIZE,
            ));
        }
        let area = config.chunk_size * config.chunk_size;
        Ok(Self {
            config,
            height_cache: vec![0i32; area],
            biome_cache: vec![Biome::Plains; area],
        })
    }

    /// Create a terrain generator with default settings.
    pub fn with_defaults() -> Self {
        Self::new(TerrainConfig::default()).expect("default config is valid")
    }

    /// Generate terrain data for chunk at `(cx, cy, cz)`.
    pub fn generate(&mut self, cx: i32, cy: i32, cz: i32) -> Result<Chunk, MeshError> {
        let size = self.config.chunk_size;
        let mut chunk = Chunk::new(size)?;

        let ox = cx * size as i32;
        let oy = cy * size as i32;
        let oz = cz * size as i32;
        let seed_offset = self.config.seed as f32 * 1000.0;
        let max_h = self.config.world_height_blocks - 1;

        // === Column cache pass ===
        for lz in 0..size {
            for lx in 0..size {
                let wx = ox + lx as i32;
                let wz = oz + lz as i32;
                let (biome, height) = get_biome(wx, wz, self.config.sea_level, max_h, seed_offset);
                let idx = lx + lz * size;
                self.height_cache[idx] = height;
                self.biome_cache[idx] = biome;
            }
        }

        // === First pass: terrain + caves + water ===
        for lz in 0..size {
            for lx in 0..size {
                let idx = lx + lz * size;
                let height = self.height_cache[idx];
                let biome = self.biome_cache[idx];
                let wx = ox + lx as i32;
                let wz = oz + lz as i32;

                for ly in 0..size {
                    let wy = oy + ly as i32;

                    if wy >= height {
                        // Above surface — water or air
                        if wy < self.config.sea_level {
                            chunk.set(lx, ly, lz, block::WATER);
                        }
                        continue;
                    }

                    // Cave carving
                    if wy > 0 && wy < height - 1 {
                        let cave =
                            noise::fbm3d(wx as f32 * 0.05, wy as f32 * 0.07, wz as f32 * 0.05, 3);
                        if cave > 0.62 {
                            continue;
                        }
                    }

                    let block_id = select_block(biome, wy, height, self.config.sea_level);
                    chunk.set(lx, ly, lz, block_id);
                }
            }
        }

        // === Second pass: trees ===
        if size > 4 {
            for lz in 2..size - 2 {
                for lx in 2..size - 2 {
                    let idx = lx + lz * size;
                    let biome = self.biome_cache[idx];
                    let height = self.height_cache[idx];
                    let wx = ox + lx as i32;
                    let wz = oz + lz as i32;

                    place_tree(
                        &mut chunk,
                        lx,
                        lz,
                        wx,
                        wz,
                        biome,
                        height,
                        oy,
                        size,
                        self.config.sea_level,
                    );
                }
            }
        }

        Ok(chunk)
    }
}

/// Determine biome type and terrain height for a world column.
fn get_biome(wx: i32, wz: i32, sea_level: i32, max_height: i32, seed_offset: f32) -> (Biome, i32) {
    let wxf = wx as f32 + seed_offset;
    let wzf = wz as f32 + seed_offset;

    let temp = noise::fbm2d(wxf * 0.004 + 100.0, wzf * 0.004 + 100.0, 4);
    let moisture = noise::fbm2d(wxf * 0.005 - 200.0, wzf * 0.005 + 300.0, 4);
    let continent = noise::fbm2d(wxf * 0.006, wzf * 0.006, 5);
    let detail = noise::fbm2d(wxf * 0.03, wzf * 0.03, 3);

    if temp > 0.6 && moisture < 0.35 {
        let h = sea_level + 1 + (continent * 8.0 + detail * 4.0) as i32;
        return (Biome::Desert, h.min(max_height));
    }

    if temp < 0.3 {
        let ridge = (noise::noise2d(wxf * 0.012 + 500.0, wzf * 0.012 + 500.0) - 0.5).abs() * 2.0;
        let h = sea_level + 8 + (continent * 24.0 + ridge * 30.0 + detail * 8.0) as i32;
        return (Biome::Mountain, h.min(max_height));
    }

    if moisture > 0.55 {
        let h = sea_level + 4 + (continent * 16.0 + detail * 8.0) as i32;
        return (Biome::Forest, h.min(max_height));
    }

    let h = sea_level + 2 + (continent * 12.0 + detail * 6.0) as i32;
    (Biome::Plains, h.min(max_height))
}

/// Select block type based on biome and depth from surface.
#[inline]
fn select_block(biome: Biome, wy: i32, height: i32, sea_level: i32) -> u16 {
    match biome {
        Biome::Desert => {
            if wy < height - 4 {
                block::STONE
            } else {
                block::SAND
            }
        }
        Biome::Mountain => {
            if wy < height - 2 {
                block::STONE
            } else if height > 55 {
                block::SNOW
            } else if height > 45 {
                block::GRAVEL
            } else {
                block::STONE
            }
        }
        Biome::Forest | Biome::Plains => {
            if wy < height - 3 {
                block::STONE
            } else if wy < height - 1 {
                block::DIRT
            } else if height <= sea_level + 2 {
                block::SAND
            } else {
                block::GRASS
            }
        }
    }
}

/// Place a tree at the given column if conditions are met.
#[allow(clippy::too_many_arguments)]
fn place_tree(
    chunk: &mut Chunk,
    lx: usize,
    lz: usize,
    wx: i32,
    wz: i32,
    biome: Biome,
    height: i32,
    oy: i32,
    size: usize,
    sea_level: i32,
) {
    if height <= sea_level + 2 {
        return;
    }

    let tree_chance = match biome {
        Biome::Forest => 0.01,
        Biome::Plains => 0.002,
        _ => return,
    };

    if noise::hash2(
        wx.wrapping_mul(7).wrapping_add(1337),
        wz.wrapping_mul(13).wrapping_add(7331),
    ) > tree_chance
    {
        return;
    }

    // Surface must be in this chunk's Y range
    let surface_ly = height - 1 - oy;
    if surface_ly < 0 || surface_ly >= size as i32 {
        return;
    }
    let surface_ly = surface_ly as usize;

    if chunk.get(lx, surface_ly, lz) != block::GRASS {
        return;
    }

    let trunk_h = 4 + (noise::hash2(wx.wrapping_add(42), wz.wrapping_add(99)) * 3.0).floor() as i32;
    let top_y = height + trunk_h;

    // Trunk
    for ty in height..top_y {
        let tly = ty - oy;
        if tly < 0 || tly >= size as i32 {
            continue;
        }
        chunk.set(lx, tly as usize, lz, block::LOG);
    }

    // Leaf canopy
    let leaf_r: i32 = 2;
    for dy in -1..=2 {
        let wy = top_y + dy;
        let lly = wy - oy;
        if lly < 0 || lly >= size as i32 {
            continue;
        }
        let lly = lly as usize;
        let r = if dy == 2 { 1 } else { leaf_r };
        for dxx in -r..=r {
            for dzz in -r..=r {
                if dxx * dxx + dzz * dzz > r * r + 1 {
                    continue;
                }
                let fx = lx as i32 + dxx;
                let fz = lz as i32 + dzz;
                if fx < 0 || fx >= size as i32 || fz < 0 || fz >= size as i32 {
                    continue;
                }
                if chunk.get(fx as usize, lly, fz as usize) == block::AIR {
                    chunk.set(fx as usize, lly, fz as usize, block::LEAVES);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config() {
        let config = TerrainConfig::default();
        assert_eq!(config.seed, 0);
        assert_eq!(config.sea_level, 24);
        assert_eq!(config.world_height_blocks, 256);
        assert_eq!(config.chunk_size, 32);
    }

    #[test]
    fn generate_surface_chunk_has_blocks() {
        let mut generator = TerrainGenerator::with_defaults();
        let chunk = generator.generate(0, 0, 0).unwrap();
        // Surface chunk should have terrain blocks
        let mut solid = 0u32;
        for z in 0..chunk.size() {
            for y in 0..chunk.size() {
                for x in 0..chunk.size() {
                    if chunk.get(x, y, z) != block::AIR {
                        solid += 1;
                    }
                }
            }
        }
        assert!(solid > 0, "surface chunk should have blocks");
    }

    #[test]
    fn generate_sky_chunk_is_empty() {
        let mut generator = TerrainGenerator::with_defaults();
        // cy=7 → world Y starts at 224, well above any terrain
        let chunk = generator.generate(0, 7, 0).unwrap();
        for z in 0..chunk.size() {
            for y in 0..chunk.size() {
                for x in 0..chunk.size() {
                    assert_eq!(
                        chunk.get(x, y, z),
                        block::AIR,
                        "sky chunk should be all air at ({x},{y},{z})"
                    );
                }
            }
        }
    }

    #[test]
    fn generate_is_deterministic() {
        let mut generator = TerrainGenerator::with_defaults();
        let chunk1 = generator.generate(3, 0, -2).unwrap();
        let chunk2 = generator.generate(3, 0, -2).unwrap();
        assert_eq!(chunk1.blocks(), chunk2.blocks());
    }

    #[test]
    fn different_seeds_produce_different_terrain() {
        let config1 = TerrainConfig {
            seed: 0,
            ..Default::default()
        };
        let config2 = TerrainConfig {
            seed: 42,
            ..Default::default()
        };
        let mut generator1 = TerrainGenerator::new(config1).unwrap();
        let mut generator2 = TerrainGenerator::new(config2).unwrap();
        let chunk1 = generator1.generate(0, 0, 0).unwrap();
        let chunk2 = generator2.generate(0, 0, 0).unwrap();
        assert_ne!(chunk1.blocks(), chunk2.blocks());
    }

    #[test]
    fn biome_determinism() {
        let (b1, h1) = get_biome(100, 200, 24, 255, 0.0);
        let (b2, h2) = get_biome(100, 200, 24, 255, 0.0);
        assert_eq!(b1, b2);
        assert_eq!(h1, h2);
    }

    #[test]
    fn select_block_desert() {
        assert_eq!(select_block(Biome::Desert, 5, 20, 24), block::STONE);
        assert_eq!(select_block(Biome::Desert, 18, 20, 24), block::SAND);
    }

    #[test]
    fn select_block_plains_grass() {
        // Surface block above sea level should be grass
        assert_eq!(select_block(Biome::Plains, 29, 30, 24), block::GRASS);
    }

    #[test]
    fn select_block_plains_beach() {
        // Surface at or below sea level + 2 should be sand
        assert_eq!(select_block(Biome::Plains, 25, 26, 24), block::SAND);
    }
}
