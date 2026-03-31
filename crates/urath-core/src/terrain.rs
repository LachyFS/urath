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
        let config = TerrainConfig::default();
        let area = config.chunk_size * config.chunk_size;
        Self {
            config,
            height_cache: vec![0i32; area],
            biome_cache: vec![Biome::Plains; area],
        }
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

                    // Cave system: overlapping 3D noise for tunnels + caverns
                    if wy > 0 && wy < height - 1 {
                        let wxf = wx as f32;
                        let wyf = wy as f32;
                        let wzf = wz as f32;

                        // Spaghetti caves: two noise fields, carved where both near 0
                        let cave_a = noise::fbm3d(
                            wxf * 0.04 + 100.0,
                            wyf * 0.06 + 100.0,
                            wzf * 0.04 + 100.0,
                            3,
                        ) - 0.5;
                        let cave_b = noise::fbm3d(
                            wxf * 0.04 - 200.0,
                            wyf * 0.06 - 200.0,
                            wzf * 0.04 + 300.0,
                            3,
                        ) - 0.5;
                        let spaghetti = cave_a * cave_a + cave_b * cave_b;

                        // Large caverns at low Y
                        let cavern = noise::fbm3d(wxf * 0.015, wyf * 0.025, wzf * 0.015, 2);
                        let depth_factor = 1.0 - (wyf / height as f32).clamp(0.0, 1.0);
                        let cavern_threshold = 0.7 - depth_factor * 0.15;

                        // Surface ravines: narrow vertical cuts
                        let ravine = noise::fbm2d(wxf * 0.01, wzf * 0.01, 3);
                        let ravine_detail = noise::noise2d(wxf * 0.05, wzf * 0.05);
                        let ravine_cut = (ravine - 0.5).abs() < 0.015 + ravine_detail * 0.008
                            && wyf > (height as f32 - 20.0)
                            && wyf < (height as f32 - 1.0);

                        if spaghetti < 0.006 || cavern > cavern_threshold || ravine_cut {
                            continue;
                        }
                    }

                    let block_id = select_block(biome, wy, height, self.config.sea_level);
                    chunk.set(lx, ly, lz, block_id);
                }
            }
        }

        // === Second pass: surface boulders (mountain biome) ===
        for lz in 1..size - 1 {
            for lx in 1..size - 1 {
                let idx = lx + lz * size;
                let biome = self.biome_cache[idx];
                if biome != Biome::Mountain {
                    continue;
                }
                let height = self.height_cache[idx];
                let wx = ox + lx as i32;
                let wz = oz + lz as i32;
                let bh = noise::hash2(
                    wx.wrapping_mul(31).wrapping_add(555),
                    wz.wrapping_mul(37).wrapping_add(777),
                );
                if bh > 0.006 {
                    continue;
                }
                // Place a small boulder (2-3 blocks tall)
                let boulder_h = 2 + (bh * 500.0) as i32;
                for dy in 0..boulder_h {
                    let by = height + dy - oy;
                    if by >= 0 && by < size as i32 {
                        chunk.set(lx, by as usize, lz, block::STONE);
                    }
                }
            }
        }

        // === Third pass: trees ===
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
                        &TreeContext {
                            lx,
                            lz,
                            wx,
                            wz,
                            biome,
                            height,
                            oy,
                            size,
                            sea_level: self.config.sea_level,
                        },
                    );
                }
            }
        }

        Ok(chunk)
    }
}

/// Smooth ramp from 0 to 1 centered at `edge` with transition `width`.
///
/// Returns 0 when `val <= edge - width/2`, 1 when `val >= edge + width/2`,
/// with C1-continuous smoothstep interpolation between.
#[inline]
fn smooth_ramp(val: f32, edge: f32, width: f32) -> f32 {
    let t = ((val - edge) / width + 0.5).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Determine biome type and terrain height for a world column.
///
/// Computes smooth weights for each biome based on climate values and blends
/// their height contributions to eliminate hard boundaries. Returns the
/// dominant biome (highest weight) for block selection.
fn get_biome(wx: i32, wz: i32, sea_level: i32, max_height: i32, seed_offset: f32) -> (Biome, i32) {
    let wxf = wx as f32 + seed_offset;
    let wzf = wz as f32 + seed_offset;

    // Climate
    let temp = noise::fbm2d(wxf * 0.003 + 100.0, wzf * 0.003 + 100.0, 4);
    let moisture = noise::fbm2d(wxf * 0.004 - 200.0, wzf * 0.004 + 300.0, 4);

    // Large-scale continent shape with domain warping for organic coastlines
    let warp_x = noise::fbm2d(wxf * 0.003 + 700.0, wzf * 0.003 + 800.0, 3) * 40.0;
    let warp_z = noise::fbm2d(wxf * 0.003 + 900.0, wzf * 0.003 + 100.0, 3) * 40.0;
    let continent = noise::fbm2d((wxf + warp_x) * 0.004, (wzf + warp_z) * 0.004, 5);

    // Multi-scale detail
    let detail = noise::fbm2d(wxf * 0.025, wzf * 0.025, 4);
    let micro = noise::fbm2d(wxf * 0.08, wzf * 0.08, 2);

    // Ridge noise for mountains (folded FBM)
    let ridge1 =
        1.0 - (noise::fbm2d(wxf * 0.008 + 500.0, wzf * 0.008 + 500.0, 4) - 0.5).abs() * 2.0;
    let ridge2 =
        1.0 - (noise::fbm2d(wxf * 0.015 + 300.0, wzf * 0.015 + 200.0, 3) - 0.5).abs() * 2.0;
    let ridges = ridge1 * ridge1 * 0.7 + ridge2 * ridge2 * 0.3;

    // Terrace noise for plateaus
    let plateau_raw = noise::fbm2d(wxf * 0.006 - 400.0, wzf * 0.006 + 600.0, 3);
    let plateau_steps = (plateau_raw * 5.0).floor() / 5.0;
    let plateau = plateau_steps * 0.6 + plateau_raw * 0.4;

    // === Biome weights (smooth transitions in climate space) ===
    let bw = 0.1; // blend width

    // Desert: hot and dry
    let desert_w = smooth_ramp(temp, 0.6, bw) * smooth_ramp(-moisture, -0.35, bw);
    // Mountain: cold
    let mountain_w = smooth_ramp(-temp, -0.3, bw);
    // Forest: wet, reduced where desert/mountain dominate
    let forest_w = smooth_ramp(moisture, 0.55, bw) * (1.0 - desert_w) * (1.0 - mountain_w);
    // Plains: remainder, with a floor to avoid zero-weight gaps
    let plains_w = (1.0 - desert_w - mountain_w - forest_w).max(0.01);

    let total = desert_w + mountain_w + forest_w + plains_w;
    let dw = desert_w / total;
    let mw = mountain_w / total;
    let fw = forest_w / total;
    let pw = plains_w / total;

    // === Per-biome heights ===
    let sl = sea_level as f32;

    // Desert: flat dunes with gentle rolling
    let dune = noise::fbm2d(wxf * 0.02 + 50.0, wzf * 0.02 + 50.0, 3);
    let desert_h = sl + 1.0 + continent * 6.0 + dune * 6.0 + micro * 2.0;

    // Mountain: dramatic ridges with elevation boost near extreme cold
    let mountain_base = continent * 20.0 + ridges * 55.0 + detail * 12.0 + micro * 3.0;
    let cold_boost = ((0.3 - temp) * 5.0).clamp(0.0, 1.0);
    let mountain_h = sl + 6.0 + mountain_base * (1.0 + cold_boost * 0.5);

    // Forest: rolling hills with plateau features
    let forest_h = sl + 3.0 + continent * 14.0 + plateau * 8.0 + detail * 10.0 + micro * 3.0;

    // Plains: gentle undulation with occasional hills
    let hill_factor = noise::fbm2d(wxf * 0.01 + 150.0, wzf * 0.01 + 250.0, 3);
    let hill_boost = if hill_factor > 0.65 {
        (hill_factor - 0.65) * 80.0
    } else {
        0.0
    };
    let plains_h = sl + 2.0 + continent * 10.0 + detail * 6.0 + micro * 2.0 + hill_boost;

    // === Blend height ===
    let blended_h = dw * desert_h + mw * mountain_h + fw * forest_h + pw * plains_h;
    let h = (blended_h as i32).clamp(1, max_height);

    // === Dominant biome for block/tree selection ===
    let biome = if dw >= mw && dw >= fw && dw >= pw {
        Biome::Desert
    } else if mw >= fw && mw >= pw {
        Biome::Mountain
    } else if fw >= pw {
        Biome::Forest
    } else {
        Biome::Plains
    };

    (biome, h)
}

/// Select block type based on biome and depth from surface.
#[inline]
fn select_block(biome: Biome, wy: i32, height: i32, sea_level: i32) -> u16 {
    let depth = height - wy; // distance below surface (1 = top block)
    match biome {
        Biome::Desert => {
            if depth > 8 {
                block::STONE
            } else if depth > 4 {
                // Mix sand and sandstone (gravel as sandstone stand-in)
                block::GRAVEL
            } else {
                block::SAND
            }
        }
        Biome::Mountain => {
            if depth > 2 {
                block::STONE
            } else if height > 70 {
                block::SNOW
            } else if height > 55 {
                // Sparse snow patches using hash
                if noise::hash2(wy.wrapping_mul(3), height.wrapping_mul(7)) > 0.5 {
                    block::SNOW
                } else {
                    block::STONE
                }
            } else if height > 40 {
                block::GRAVEL
            } else {
                block::STONE
            }
        }
        Biome::Forest => {
            if depth > 5 {
                block::STONE
            } else if depth > 1 {
                block::DIRT
            } else if height <= sea_level + 2 {
                block::SAND
            } else {
                block::GRASS
            }
        }
        Biome::Plains => {
            if depth > 4 {
                block::STONE
            } else if depth > 1 {
                block::DIRT
            } else if height <= sea_level + 2 {
                block::SAND
            } else {
                block::GRASS
            }
        }
    }
}

struct TreeContext {
    lx: usize,
    lz: usize,
    wx: i32,
    wz: i32,
    biome: Biome,
    height: i32,
    oy: i32,
    size: usize,
    sea_level: i32,
}

/// Place a tree at the given column if conditions are met.
fn place_tree(chunk: &mut Chunk, ctx: &TreeContext) {
    let TreeContext {
        lx,
        lz,
        wx,
        wz,
        biome,
        height,
        oy,
        size,
        sea_level,
    } = *ctx;
    if height <= sea_level + 2 {
        return;
    }

    let tree_hash = noise::hash2(
        wx.wrapping_mul(7).wrapping_add(1337),
        wz.wrapping_mul(13).wrapping_add(7331),
    );

    let tree_chance = match biome {
        Biome::Forest => 0.025,
        Biome::Plains => 0.003,
        _ => return,
    };

    if tree_hash > tree_chance {
        return;
    }

    let surface_ly = height - 1 - oy;
    if surface_ly < 0 || surface_ly >= size as i32 {
        return;
    }
    let surface_ly = surface_ly as usize;

    if chunk.get(lx, surface_ly, lz) != block::GRASS {
        return;
    }

    // Tree variety based on hash
    let variety = noise::hash2(wx.wrapping_add(42), wz.wrapping_add(99));
    let is_giant = biome == Biome::Forest && variety < 0.08;

    let (trunk_h, leaf_r, canopy_h) = if is_giant {
        // Giant tree: tall trunk, wide canopy
        let h = 8 + (variety * 40.0) as i32;
        (h, 4i32, 4i32)
    } else {
        // Normal tree
        let h = 4 + (variety * 3.0) as i32;
        (h, 2i32, 3i32)
    };

    let top_y = height + trunk_h;

    // Trunk
    for ty in height..top_y {
        let tly = ty - oy;
        if tly < 0 || tly >= size as i32 {
            continue;
        }
        chunk.set(lx, tly as usize, lz, block::LOG);
    }

    // Leaf canopy — layered sphere
    for dy in -1..canopy_h {
        let wy = top_y + dy;
        let lly = wy - oy;
        if lly < 0 || lly >= size as i32 {
            continue;
        }
        let lly = lly as usize;
        // Radius tapers at top and bottom
        let t = (dy + 1) as f32 / (canopy_h + 1) as f32;
        let r = if t < 0.3 {
            leaf_r - 1
        } else if t > 0.85 {
            (leaf_r - 1).max(1)
        } else {
            leaf_r
        };
        for dxx in -r..=r {
            for dzz in -r..=r {
                let dist2 = dxx * dxx + dzz * dzz;
                if dist2 > r * r + 1 {
                    continue;
                }
                // Random leaf gaps for organic look
                if dist2 == r * r + 1 {
                    let lh =
                        noise::hash2(wx.wrapping_add(dxx), wz.wrapping_add(dzz).wrapping_add(dy));
                    if lh > 0.6 {
                        continue;
                    }
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
