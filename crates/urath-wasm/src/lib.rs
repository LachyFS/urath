use wasm_bindgen::prelude::*;

use urath_core::{ChunkNeighbors, Face, GreedyMesher, MeshOutput, Mesher};

/// WASM-exposed chunk that holds voxel data.
#[wasm_bindgen]
pub struct WasmChunk {
    inner: urath_core::Chunk,
}

#[wasm_bindgen]
impl WasmChunk {
    /// Create a new chunk filled with air.
    #[wasm_bindgen(constructor)]
    pub fn new(size: usize) -> Result<WasmChunk, JsError> {
        let inner = urath_core::Chunk::new(size).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Self { inner })
    }

    /// Create a default 32x32x32 chunk.
    pub fn new_default() -> WasmChunk {
        Self {
            inner: urath_core::Chunk::new_default(),
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
    pub fn set_neighbor(&mut self, face: u8, neighbor_chunk: &WasmChunk) {
        let face = match face {
            0 => Face::PosX,
            1 => Face::NegX,
            2 => Face::PosY,
            3 => Face::NegY,
            4 => Face::PosZ,
            5 => Face::NegZ,
            _ => return,
        };
        let border = neighbor_chunk.inner.extract_border(face.opposite());
        self.inner.set_face(face, border);
    }
}

/// Result of a meshing operation, holding the raw buffer data.
#[wasm_bindgen]
pub struct WasmMeshResult {
    output: MeshOutput,
}

#[wasm_bindgen]
impl WasmMeshResult {
    /// Number of vertices.
    pub fn vertex_count(&self) -> u32 {
        self.output.vertex_count()
    }

    /// Number of indices.
    pub fn index_count(&self) -> u32 {
        self.output.index_count()
    }

    /// Whether the mesh is empty.
    pub fn is_empty(&self) -> bool {
        self.output.is_empty()
    }

    /// Copy positions into a new Float32Array.
    pub fn positions(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.output.positions[..])
    }

    /// Copy normals into a new Float32Array.
    pub fn normals(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.output.normals[..])
    }

    /// Copy AO values into a new Float32Array.
    pub fn ao(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(&self.output.ao[..])
    }

    /// Copy block IDs into a new Float32Array (cast from u16 for use as vertex attribute).
    pub fn block_ids(&self) -> js_sys::Float32Array {
        let floats: Vec<f32> = self.output.block_ids.iter().map(|&id| id as f32).collect();
        js_sys::Float32Array::from(&floats[..])
    }

    /// Copy indices into a new Uint32Array.
    pub fn indices(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(&self.output.indices[..])
    }
}

/// WASM-exposed greedy mesher.
#[wasm_bindgen]
pub struct WasmGreedyMesher {
    inner: GreedyMesher,
}

#[wasm_bindgen]
impl WasmGreedyMesher {
    /// Create a new greedy mesher for a given chunk size.
    #[wasm_bindgen(constructor)]
    pub fn new(chunk_size: usize) -> WasmGreedyMesher {
        Self {
            inner: GreedyMesher::with_chunk_size(chunk_size),
        }
    }

    /// Mesh a chunk without neighbor data (all borders treated as air).
    pub fn mesh(&mut self, chunk: &WasmChunk) -> Result<WasmMeshResult, JsError> {
        let neighbors = ChunkNeighbors::empty(chunk.inner.size());
        let mut output = MeshOutput::with_capacity(4096);
        self.inner
            .mesh(&chunk.inner, &neighbors, &mut output)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(WasmMeshResult { output })
    }

    /// Mesh a chunk with neighbor data for cross-chunk face culling.
    pub fn mesh_with_neighbors(
        &mut self,
        chunk: &WasmChunk,
        neighbors: &WasmChunkNeighbors,
    ) -> Result<WasmMeshResult, JsError> {
        let mut output = MeshOutput::with_capacity(4096);
        self.inner
            .mesh(&chunk.inner, &neighbors.inner, &mut output)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(WasmMeshResult { output })
    }
}
