use crate::error::MeshError;

/// Default chunk edge length.
pub const CHUNK_SIZE: usize = 32;

/// Maximum allowed chunk edge length.
pub const MAX_CHUNK_SIZE: usize = 64;

/// Number of faces on a cube.
const NUM_FACES: usize = 6;

/// Axis-aligned face direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Face {
    PosX = 0, // +X (right)
    NegX = 1, // -X (left)
    PosY = 2, // +Y (up)
    NegY = 3, // -Y (down)
    PosZ = 4, // +Z (front)
    NegZ = 5, // -Z (back)
}

impl Face {
    /// All six faces in order.
    pub const ALL: [Face; NUM_FACES] = [
        Face::PosX,
        Face::NegX,
        Face::PosY,
        Face::NegY,
        Face::PosZ,
        Face::NegZ,
    ];

    /// Integer normal vector for this face.
    #[inline]
    pub fn normal(self) -> [i32; 3] {
        match self {
            Face::PosX => [1, 0, 0],
            Face::NegX => [-1, 0, 0],
            Face::PosY => [0, 1, 0],
            Face::NegY => [0, -1, 0],
            Face::PosZ => [0, 0, 1],
            Face::NegZ => [0, 0, -1],
        }
    }

    /// Float normal vector for this face.
    #[inline]
    pub fn normal_f32(self) -> [f32; 3] {
        let n = self.normal();
        [n[0] as f32, n[1] as f32, n[2] as f32]
    }

    /// The axis index (0=X, 1=Y, 2=Z) perpendicular to this face.
    #[inline]
    pub fn normal_axis(self) -> usize {
        match self {
            Face::PosX | Face::NegX => 0,
            Face::PosY | Face::NegY => 1,
            Face::PosZ | Face::NegZ => 2,
        }
    }

    /// The two tangent axis indices that form the face plane.
    /// Returns (u_axis, v_axis) where u is the "width" and v is the "height"
    /// when sweeping across the face.
    ///
    /// The ordering is chosen so that `e_u × e_v` points in the same direction
    /// as the face normal, producing correct front-face winding for rendering.
    #[inline]
    pub fn tangent_axes(self) -> (usize, usize) {
        match self {
            Face::PosX => (1, 2), // (Y, Z) → e_Y × e_Z = +X ✓
            Face::NegX => (2, 1), // (Z, Y) → e_Z × e_Y = -X ✓
            Face::PosY => (2, 0), // (Z, X) → e_Z × e_X = +Y ✓
            Face::NegY => (0, 2), // (X, Z) → e_X × e_Z = -Y ✓
            Face::PosZ => (0, 1), // (X, Y) → e_X × e_Y = +Z ✓
            Face::NegZ => (1, 0), // (Y, X) → e_Y × e_X = -Z ✓
        }
    }

    /// Whether this face points in the positive direction along its axis.
    #[inline]
    pub fn is_positive(self) -> bool {
        matches!(self, Face::PosX | Face::PosY | Face::PosZ)
    }

    /// The opposite face direction.
    #[inline]
    pub fn opposite(self) -> Face {
        match self {
            Face::PosX => Face::NegX,
            Face::NegX => Face::PosX,
            Face::PosY => Face::NegY,
            Face::NegY => Face::PosY,
            Face::PosZ => Face::NegZ,
            Face::NegZ => Face::PosZ,
        }
    }
}

/// A cubic chunk of voxel block IDs.
///
/// Blocks are stored in a flat `Vec<u16>` with layout:
/// `blocks[x + y * size + z * size * size]` (X varies fastest).
/// Block ID 0 means air (empty).
pub struct Chunk {
    blocks: Vec<u16>,
    size: usize,
}

impl Chunk {
    /// Create a new chunk filled with air.
    pub fn new(size: usize) -> Result<Self, MeshError> {
        if size > MAX_CHUNK_SIZE {
            return Err(MeshError::ChunkTooLarge(size, MAX_CHUNK_SIZE));
        }
        Ok(Self {
            blocks: vec![0u16; size * size * size],
            size,
        })
    }

    /// Create a default 32x32x32 chunk filled with air.
    pub fn new_default() -> Self {
        Self {
            blocks: vec![0u16; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE],
            size: CHUNK_SIZE,
        }
    }

    /// Chunk edge length.
    #[inline]
    pub fn size(&self) -> usize {
        self.size
    }

    /// Flat index from 3D coordinates.
    #[inline]
    fn index(&self, x: usize, y: usize, z: usize) -> usize {
        x + y * self.size + z * self.size * self.size
    }

    /// Get the block ID at (x, y, z).
    #[inline]
    pub fn get(&self, x: usize, y: usize, z: usize) -> u16 {
        debug_assert!(x < self.size && y < self.size && z < self.size);
        self.blocks[self.index(x, y, z)]
    }

    /// Set the block ID at (x, y, z).
    #[inline]
    pub fn set(&mut self, x: usize, y: usize, z: usize, block_id: u16) {
        debug_assert!(x < self.size && y < self.size && z < self.size);
        let idx = self.index(x, y, z);
        self.blocks[idx] = block_id;
    }

    /// Set multiple blocks at once from a flat slice of (x, y, z, block_id) tuples.
    ///
    /// `edits` must have length divisible by 4. Each group of 4 values is
    /// interpreted as `[x, y, z, block_id]`. Out-of-bounds entries are silently
    /// skipped. Returns the number of blocks actually written.
    pub fn set_blocks(&mut self, edits: &[u32]) -> u32 {
        let s = self.size;
        let mut count = 0u32;
        let mut i = 0;
        while i + 3 < edits.len() {
            let x = edits[i] as usize;
            let y = edits[i + 1] as usize;
            let z = edits[i + 2] as usize;
            let block_id = edits[i + 3] as u16;
            i += 4;
            if x < s && y < s && z < s {
                let idx = self.index(x, y, z);
                self.blocks[idx] = block_id;
                count += 1;
            }
        }
        count
    }

    /// Check if (x, y, z) is air (block ID 0).
    #[inline]
    pub fn is_air(&self, x: usize, y: usize, z: usize) -> bool {
        self.get(x, y, z) == 0
    }

    /// Direct slice access to the underlying block data.
    #[inline]
    pub fn blocks(&self) -> &[u16] {
        &self.blocks
    }

    /// Extract the border slice for the given face direction.
    ///
    /// Returns a flat `size × size` array of block IDs from this chunk's
    /// boundary, using the same indexing convention as `sample_block_opaque`:
    /// - PosX (x=size-1) / NegX (x=0): indexed as `[z + y * size]`
    /// - PosY (y=size-1) / NegY (y=0): indexed as `[x + z * size]`
    /// - PosZ (z=size-1) / NegZ (z=0): indexed as `[x + y * size]`
    pub fn extract_border(&self, face: Face) -> Vec<u16> {
        let s = self.size;
        let mut border = vec![0u16; s * s];
        match face {
            Face::PosX => {
                for y in 0..s {
                    for z in 0..s {
                        border[z + y * s] = self.get(s - 1, y, z);
                    }
                }
            }
            Face::NegX => {
                for y in 0..s {
                    for z in 0..s {
                        border[z + y * s] = self.get(0, y, z);
                    }
                }
            }
            Face::PosY => {
                for z in 0..s {
                    for x in 0..s {
                        border[x + z * s] = self.get(x, s - 1, z);
                    }
                }
            }
            Face::NegY => {
                for z in 0..s {
                    for x in 0..s {
                        border[x + z * s] = self.get(x, 0, z);
                    }
                }
            }
            Face::PosZ => {
                for y in 0..s {
                    for x in 0..s {
                        border[x + y * s] = self.get(x, y, s - 1);
                    }
                }
            }
            Face::NegZ => {
                for y in 0..s {
                    for x in 0..s {
                        border[x + y * s] = self.get(x, y, 0);
                    }
                }
            }
        }
        border
    }
}

/// Provides access to the 1-voxel border of each of the 6 neighboring chunks.
/// Used for cross-chunk face culling and AO computation.
///
/// Each face stores a flat 2D slice of block IDs (`size x size`).
/// `None` means treat that neighbor as all air.
pub struct ChunkNeighbors {
    faces: [Option<Vec<u16>>; NUM_FACES],
    size: usize,
}

impl ChunkNeighbors {
    /// Create neighbors with all faces treated as air.
    pub fn empty(size: usize) -> Self {
        Self {
            faces: [const { None }; NUM_FACES],
            size,
        }
    }

    /// Set the border data for a neighboring face.
    /// `data` should be a flat `size x size` array of block IDs from the
    /// neighbor chunk's border layer.
    pub fn set_face(&mut self, face: Face, data: Vec<u16>) {
        self.faces[face as usize] = Some(data);
    }

    /// Get a block from the neighbor's border.
    /// `u` and `v` are in the face's tangent coordinate system.
    /// Returns 0 (air) if no neighbor data is set for this face.
    #[inline]
    pub fn get_border_block(&self, face: Face, u: usize, v: usize) -> u16 {
        match &self.faces[face as usize] {
            Some(data) => data[u + v * self.size],
            None => 0,
        }
    }

    /// Check if a neighbor face has data set.
    #[inline]
    pub fn has_face(&self, face: Face) -> bool {
        self.faces[face as usize].is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_new_default() {
        let chunk = Chunk::new_default();
        assert_eq!(chunk.size(), CHUNK_SIZE);
        assert!(chunk.is_air(0, 0, 0));
        assert!(chunk.is_air(31, 31, 31));
    }

    #[test]
    fn chunk_set_get() {
        let mut chunk = Chunk::new_default();
        chunk.set(5, 10, 15, 42);
        assert_eq!(chunk.get(5, 10, 15), 42);
        assert!(!chunk.is_air(5, 10, 15));
        assert!(chunk.is_air(0, 0, 0));
    }

    #[test]
    fn set_blocks_batch() {
        let mut chunk = Chunk::new_default();
        // 3 edits packed as [x, y, z, block_id, ...]
        let edits: Vec<u32> = vec![
            0, 0, 0, 1, 5, 10, 15, 42, 31, 31, 31, 7,
            // out of bounds — should be skipped
            32, 0, 0, 99,
        ];
        let written = chunk.set_blocks(&edits);
        assert_eq!(written, 3);
        assert_eq!(chunk.get(0, 0, 0), 1);
        assert_eq!(chunk.get(5, 10, 15), 42);
        assert_eq!(chunk.get(31, 31, 31), 7);
    }

    #[test]
    fn chunk_too_large() {
        let result = Chunk::new(65);
        assert!(result.is_err());
    }

    #[test]
    fn chunk_custom_size() {
        let chunk = Chunk::new(16).unwrap();
        assert_eq!(chunk.size(), 16);
    }

    #[test]
    fn face_normals() {
        assert_eq!(Face::PosX.normal(), [1, 0, 0]);
        assert_eq!(Face::NegY.normal(), [0, -1, 0]);
        assert_eq!(Face::PosZ.normal(), [0, 0, 1]);
    }

    #[test]
    fn face_axes() {
        assert_eq!(Face::PosX.normal_axis(), 0);
        assert_eq!(Face::PosY.normal_axis(), 1);
        assert_eq!(Face::PosZ.normal_axis(), 2);
    }

    #[test]
    fn chunk_neighbors_empty() {
        let neighbors = ChunkNeighbors::empty(32);
        assert_eq!(neighbors.get_border_block(Face::PosX, 0, 0), 0);
        assert!(!neighbors.has_face(Face::PosX));
    }

    #[test]
    fn chunk_neighbors_with_data() {
        let mut neighbors = ChunkNeighbors::empty(32);
        let mut data = vec![0u16; 32 * 32];
        data[5 + 10 * 32] = 7;
        neighbors.set_face(Face::PosX, data);
        assert!(neighbors.has_face(Face::PosX));
        assert_eq!(neighbors.get_border_block(Face::PosX, 5, 10), 7);
        assert_eq!(neighbors.get_border_block(Face::PosX, 0, 0), 0);
    }
}
