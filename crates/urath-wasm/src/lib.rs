use wasm_bindgen::prelude::*;

use urath::{
    BlockRegistry, ChunkNeighbors, Face, GreedyMesher, MeshOutput, Mesher, SurfaceNetsMesher,
    TerrainConfig, TerrainGenerator,
};

/// WASM-exposed chunk that holds voxel data.
#[wasm_bindgen]
pub struct WasmChunk {
    inner: urath::Chunk,
}

#[wasm_bindgen]
impl WasmChunk {
    /// Create a new chunk filled with air.
    #[wasm_bindgen(constructor)]
    pub fn new(size: usize) -> Result<WasmChunk, JsError> {
        let inner = urath::Chunk::new(size).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Self { inner })
    }

    /// Create a default 32x32x32 chunk.
    pub fn new_default() -> WasmChunk {
        Self {
            inner: urath::Chunk::new_default(),
        }
    }

    /// Set a block at (x, y, z).
    pub fn set_block(&mut self, x: usize, y: usize, z: usize, block_id: u16) {
        self.inner.set(x, y, z, block_id);
    }

    /// Get the block at (x, y, z).
    pub fn get_block(&self, x: usize, y: usize, z: usize) -> u16 {
        self.inner.get(x, y, z)
    }

    /// Chunk edge length.
    pub fn size(&self) -> usize {
        self.inner.size()
    }

    /// Set multiple blocks in one call.
    ///
    /// `edits` is a flat Uint32Array where every 4 consecutive values form
    /// one edit: `[x, y, z, block_id, x, y, z, block_id, ...]`.
    /// Out-of-bounds entries are silently skipped. Returns the count of blocks written.
    pub fn set_blocks(&mut self, edits: &[u32]) -> u32 {
        self.inner.set_blocks(edits)
    }

    /// Fill a column from y=0 to y=height-1 with a block ID.
    pub fn fill_column(&mut self, x: usize, z: usize, height: usize, block_id: u16) {
        let max = height.min(self.inner.size());
        for y in 0..max {
            self.inner.set(x, y, z, block_id);
        }
    }

    /// Copy all block data into a new Uint16Array.
    pub fn get_blocks(&self) -> js_sys::Uint16Array {
        js_sys::Uint16Array::from(self.inner.blocks())
    }

    /// Replace all blocks from a flat Uint16Array (must be size³ elements).
    pub fn set_all_blocks(&mut self, data: &[u16]) -> Result<(), JsError> {
        self.inner
            .replace_blocks(data)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Extract the border slice for a given face direction.
    /// Returns a Uint16Array of size² elements.
    pub fn extract_border(&self, face: u8) -> js_sys::Uint16Array {
        let f = match face {
            0 => Face::PosX,
            1 => Face::NegX,
            2 => Face::PosY,
            3 => Face::NegY,
            4 => Face::PosZ,
            5 => Face::NegZ,
            _ => return js_sys::Uint16Array::new_with_length(0),
        };
        let border = self.inner.extract_border(f);
        js_sys::Uint16Array::from(&border[..])
    }

    /// True if all blocks are air. O(1).
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
}

/// Neighbor data for cross-chunk face culling and AO.
#[wasm_bindgen]
pub struct WasmChunkNeighbors {
    inner: ChunkNeighbors,
}

#[wasm_bindgen]
impl WasmChunkNeighbors {
    /// Create empty neighbors (all faces treated as air).
    #[wasm_bindgen(constructor)]
    pub fn new(size: usize) -> WasmChunkNeighbors {
        Self {
            inner: ChunkNeighbors::empty(size),
        }
    }

    /// Set neighbor data for a face direction by extracting the border from a neighbor chunk.
    ///
    /// `face`: 0=PosX, 1=NegX, 2=PosY, 3=NegY, 4=PosZ, 5=NegZ.
    ///
    /// The opposite face's border is automatically extracted from the neighbor chunk.
    /// E.g., calling `set_neighbor(0, neighborChunk)` extracts the NegX (x=0) border
    /// from `neighborChunk` and uses it as the PosX neighbor data.
    pub fn set_neighbor(&mut self, face: u8, neighbor_chunk: &WasmChunk) -> Result<(), JsError> {
        let face = match face {
            0 => Face::PosX,
            1 => Face::NegX,
            2 => Face::PosY,
            3 => Face::NegY,
            4 => Face::PosZ,
            5 => Face::NegZ,
            _ => return Ok(()),
        };
        let border = neighbor_chunk.inner.extract_border(face.opposite());
        self.inner
            .set_face(face, border)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Set neighbor border data directly from a Uint16Array (size² elements).
    /// Used by workers that don't have the neighbor WasmChunk.
    pub fn set_neighbor_border(&mut self, face: u8, data: &[u16]) -> Result<(), JsError> {
        let face = match face {
            0 => Face::PosX,
            1 => Face::NegX,
            2 => Face::PosY,
            3 => Face::NegY,
            4 => Face::PosZ,
            5 => Face::NegZ,
            _ => return Ok(()),
        };
        self.inner
            .set_face(face, data.to_vec())
            .map_err(|e| JsError::new(&e.to_string()))
    }
}

/// Result of a meshing operation, holding both opaque and transparent geometry.
///
/// The primary accessors (`positions`, `normals`, etc.) return the opaque mesh.
/// Transparent geometry (leaves, water) is available via `transparent_*` accessors.
/// Render opaque first, then transparent with alpha test/blend.
#[wasm_bindgen]
pub struct WasmMeshResult {
    opaque: MeshOutput,
    transparent: MeshOutput,
}

#[wasm_bindgen]
impl WasmMeshResult {
    // --- Opaque mesh accessors (backward compatible) ---

    /// Number of opaque vertices.
    pub fn vertex_count(&self) -> u32 {
        self.opaque.vertex_count()
    }

    /// Number of opaque indices.
    pub fn index_count(&self) -> u32 {
        self.opaque.index_count()
    }

    /// Whether the opaque mesh is empty.
    pub fn is_empty(&self) -> bool {
        self.opaque.is_empty()
    }

    /// Opaque positions (Float32Array, 3 floats per vertex).
    pub fn positions(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.opaque.positions())
    }

    /// Opaque normals (Float32Array, 3 floats per vertex).
    pub fn normals(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.opaque.normals())
    }

    /// Opaque AO values (Float32Array, 1 float per vertex).
    pub fn ao(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.opaque.ao())
    }

    /// Opaque block IDs (Float32Array, cast from u16).
    pub fn block_ids(&self) -> js_sys::Float32Array {
        let f32_vec: Vec<f32> = self
            .opaque
            .block_ids()
            .iter()
            .map(|&id| id as f32)
            .collect();
        js_sys::Float32Array::from(&f32_vec[..])
    }

    /// Opaque UV coordinates (Float32Array, 2 floats per vertex).
    pub fn uvs(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.opaque.uvs())
    }

    /// Opaque indices (Uint32Array).
    pub fn indices(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.opaque.indices())
    }

    // --- Transparent mesh accessors ---

    /// Whether there is any transparent geometry.
    pub fn has_transparent(&self) -> bool {
        !self.transparent.is_empty()
    }

    /// Number of transparent vertices.
    pub fn transparent_vertex_count(&self) -> u32 {
        self.transparent.vertex_count()
    }

    /// Number of transparent indices.
    pub fn transparent_index_count(&self) -> u32 {
        self.transparent.index_count()
    }

    /// Transparent positions (Float32Array, 3 floats per vertex).
    pub fn transparent_positions(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.transparent.positions())
    }

    /// Transparent normals (Float32Array, 3 floats per vertex).
    pub fn transparent_normals(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.transparent.normals())
    }

    /// Transparent AO values (Float32Array, 1 float per vertex).
    pub fn transparent_ao(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.transparent.ao())
    }

    /// Transparent block IDs (Float32Array, cast from u16).
    pub fn transparent_block_ids(&self) -> js_sys::Float32Array {
        let f32_vec: Vec<f32> = self
            .transparent
            .block_ids()
            .iter()
            .map(|&id| id as f32)
            .collect();
        js_sys::Float32Array::from(&f32_vec[..])
    }

    /// Transparent UV coordinates (Float32Array, 2 floats per vertex).
    pub fn transparent_uvs(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.transparent.uvs())
    }

    /// Transparent indices (Uint32Array).
    pub fn transparent_indices(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.transparent.indices())
    }
}

/// WASM-exposed greedy mesher.
///
/// Stores a block registry that controls which blocks are transparent.
/// By default, LEAVES and WATER are transparent; all other non-air blocks are opaque.
/// Use `set_transparent` / `set_opaque` to customize.
#[wasm_bindgen]
pub struct WasmGreedyMesher {
    inner: GreedyMesher,
    registry: BlockRegistry,
}

#[wasm_bindgen]
impl WasmGreedyMesher {
    /// Create a new greedy mesher for a given chunk size.
    #[wasm_bindgen(constructor)]
    pub fn new(chunk_size: usize) -> WasmGreedyMesher {
        Self {
            inner: GreedyMesher::with_chunk_size(chunk_size),
            registry: BlockRegistry::new(),
        }
    }

    /// Mark a block ID as transparent.
    pub fn set_transparent(&mut self, block_id: u16) {
        self.registry.set_transparent(block_id);
    }

    /// Mark a block ID as opaque.
    pub fn set_opaque(&mut self, block_id: u16) {
        self.registry.set_opaque(block_id);
    }

    /// Mesh a chunk without neighbor data (all borders treated as air).
    pub fn mesh(&mut self, chunk: &WasmChunk) -> Result<WasmMeshResult, JsError> {
        let neighbors = ChunkNeighbors::empty(chunk.inner.size());
        let mut opaque = MeshOutput::with_capacity(4096);
        let mut transparent = MeshOutput::with_capacity(1024);
        self.inner
            .mesh(
                &chunk.inner,
                &neighbors,
                &self.registry,
                &mut opaque,
                &mut transparent,
            )
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(WasmMeshResult {
            opaque,
            transparent,
        })
    }

    /// Mesh a chunk with neighbor data for cross-chunk face culling.
    pub fn mesh_with_neighbors(
        &mut self,
        chunk: &WasmChunk,
        neighbors: &WasmChunkNeighbors,
    ) -> Result<WasmMeshResult, JsError> {
        let mut opaque = MeshOutput::with_capacity(4096);
        let mut transparent = MeshOutput::with_capacity(1024);
        self.inner
            .mesh(
                &chunk.inner,
                &neighbors.inner,
                &self.registry,
                &mut opaque,
                &mut transparent,
            )
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(WasmMeshResult {
            opaque,
            transparent,
        })
    }
}

/// WASM-exposed Surface Nets mesher for smooth terrain.
#[wasm_bindgen]
pub struct WasmSurfaceNetsMesher {
    inner: SurfaceNetsMesher,
    registry: BlockRegistry,
}

#[wasm_bindgen]
impl WasmSurfaceNetsMesher {
    /// Create a new Surface Nets mesher for a given chunk size.
    #[wasm_bindgen(constructor)]
    pub fn new(chunk_size: usize) -> WasmSurfaceNetsMesher {
        Self {
            inner: SurfaceNetsMesher::with_chunk_size(chunk_size),
            registry: BlockRegistry::new(),
        }
    }

    /// Mesh a chunk without neighbor data.
    pub fn mesh(&mut self, chunk: &WasmChunk) -> Result<WasmMeshResult, JsError> {
        let neighbors = ChunkNeighbors::empty(chunk.inner.size());
        let mut opaque = MeshOutput::with_capacity(4096);
        let mut transparent = MeshOutput::new();
        self.inner
            .mesh(
                &chunk.inner,
                &neighbors,
                &self.registry,
                &mut opaque,
                &mut transparent,
            )
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(WasmMeshResult {
            opaque,
            transparent,
        })
    }

    /// Mesh a chunk with neighbor data for cross-chunk surface continuity.
    pub fn mesh_with_neighbors(
        &mut self,
        chunk: &WasmChunk,
        neighbors: &WasmChunkNeighbors,
    ) -> Result<WasmMeshResult, JsError> {
        let mut opaque = MeshOutput::with_capacity(4096);
        let mut transparent = MeshOutput::new();
        self.inner
            .mesh(
                &chunk.inner,
                &neighbors.inner,
                &self.registry,
                &mut opaque,
                &mut transparent,
            )
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(WasmMeshResult {
            opaque,
            transparent,
        })
    }
}

/// WASM-exposed terrain generator.
#[wasm_bindgen]
pub struct WasmTerrainGenerator {
    inner: TerrainGenerator,
}

impl Default for WasmTerrainGenerator {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl WasmTerrainGenerator {
    /// Create a terrain generator with default settings.
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmTerrainGenerator {
        Self {
            inner: TerrainGenerator::with_defaults(),
        }
    }

    /// Create a terrain generator with a custom seed.
    pub fn with_seed(seed: u32) -> Result<WasmTerrainGenerator, JsError> {
        let config = TerrainConfig {
            seed,
            ..Default::default()
        };
        TerrainGenerator::new(config)
            .map(|inner| WasmTerrainGenerator { inner })
            .map_err(|e| JsError::new(&e.to_string()))
    }

    /// Generate terrain for a chunk at (cx, cy, cz). Returns a WasmChunk.
    pub fn generate(&mut self, cx: i32, cy: i32, cz: i32) -> Result<WasmChunk, JsError> {
        let chunk = self
            .inner
            .generate(cx, cy, cz)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(WasmChunk { inner: chunk })
    }
}
