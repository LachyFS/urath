/// Block ID constants.
///
/// Block IDs are `u16` to match `Chunk` storage. ID 0 is always air (empty).
pub const AIR: u16 = 0;
pub const STONE: u16 = 1;
pub const DIRT: u16 = 2;
pub const GRASS: u16 = 3;
pub const SAND: u16 = 4;
pub const WATER: u16 = 5;
pub const SNOW: u16 = 6;
pub const GRAVEL: u16 = 7;
pub const LOG: u16 = 8;
pub const LEAVES: u16 = 9;

/// Registry mapping block IDs to rendering properties.
///
/// Controls how the mesher handles face culling for different block types:
/// - **Opaque** blocks fully occlude the face behind them (stone, dirt, etc.).
/// - **Transparent** blocks allow neighbouring faces to render (leaves, water).
///   Same-type transparent blocks cull their shared face (leaf-to-leaf).
///
/// By default, all non-air blocks are opaque except `LEAVES` and `WATER`.
pub struct BlockRegistry {
    /// Per-block opacity. Index = block_id. `true` = opaque.
    opaque: Vec<bool>,
}

impl BlockRegistry {
    /// Create a registry with default properties.
    pub fn new() -> Self {
        let mut opaque = vec![true; 256];
        opaque[AIR as usize] = false;
        opaque[WATER as usize] = false;
        opaque[LEAVES as usize] = false;
        Self { opaque }
    }

    /// Mark a block ID as transparent (non-opaque).
    pub fn set_transparent(&mut self, block_id: u16) {
        let id = block_id as usize;
        if id >= self.opaque.len() {
            self.opaque.resize(id + 1, true);
        }
        self.opaque[id] = false;
    }

    /// Mark a block ID as opaque.
    pub fn set_opaque(&mut self, block_id: u16) {
        let id = block_id as usize;
        if id >= self.opaque.len() {
            self.opaque.resize(id + 1, true);
        }
        self.opaque[id] = true;
    }

    /// Returns `true` if the block fully occludes the face behind it.
    /// Air (0) is never opaque.
    #[inline]
    pub fn is_opaque(&self, block_id: u16) -> bool {
        let id = block_id as usize;
        if id < self.opaque.len() {
            self.opaque[id]
        } else {
            block_id != 0
        }
    }

    /// Returns `true` if the block is non-air and non-opaque.
    #[inline]
    pub fn is_transparent(&self, block_id: u16) -> bool {
        block_id != 0 && !self.is_opaque(block_id)
    }
}

impl Default for BlockRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn air_is_zero() {
        assert_eq!(AIR, 0);
    }

    #[test]
    fn block_ids_are_sequential() {
        assert_eq!(STONE, 1);
        assert_eq!(DIRT, 2);
        assert_eq!(GRASS, 3);
        assert_eq!(SAND, 4);
        assert_eq!(WATER, 5);
        assert_eq!(SNOW, 6);
        assert_eq!(GRAVEL, 7);
        assert_eq!(LOG, 8);
        assert_eq!(LEAVES, 9);
    }

    #[test]
    fn default_registry_opaque() {
        let reg = BlockRegistry::new();
        assert!(!reg.is_opaque(AIR));
        assert!(reg.is_opaque(STONE));
        assert!(reg.is_opaque(DIRT));
        assert!(reg.is_opaque(GRASS));
        assert!(reg.is_opaque(LOG));
        assert!(!reg.is_opaque(WATER));
        assert!(!reg.is_opaque(LEAVES));
    }

    #[test]
    fn default_registry_transparent() {
        let reg = BlockRegistry::new();
        assert!(!reg.is_transparent(AIR));
        assert!(!reg.is_transparent(STONE));
        assert!(reg.is_transparent(WATER));
        assert!(reg.is_transparent(LEAVES));
    }

    #[test]
    fn custom_transparent() {
        let mut reg = BlockRegistry::new();
        assert!(reg.is_opaque(STONE));
        reg.set_transparent(STONE);
        assert!(!reg.is_opaque(STONE));
        assert!(reg.is_transparent(STONE));
        reg.set_opaque(STONE);
        assert!(reg.is_opaque(STONE));
    }

    #[test]
    fn unknown_block_defaults_opaque() {
        let reg = BlockRegistry::new();
        assert!(reg.is_opaque(1000));
        assert!(!reg.is_transparent(0));
    }
}
