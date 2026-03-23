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
}
