use crate::block::BlockRegistry;
use crate::chunk::{Chunk, ChunkNeighbors};
use crate::error::MeshError;
use crate::mesh_output::MeshOutput;

/// Trait implemented by all voxel meshing algorithms.
///
/// Meshers take a chunk, its neighbors, and a block registry, and write
/// geometry into reusable `MeshOutput` buffers. Opaque and transparent
/// geometry are written to separate buffers so the renderer can draw them
/// in the correct order (opaque first, then transparent with alpha test).
///
/// The caller should call `output.clear()` / `transparent_output.clear()`
/// before each call if reusing the buffers.
///
/// `&mut self` allows implementations to reuse internal scratch buffers
/// without interior mutability. For thread safety, create one mesher
/// per thread (they are cheap to construct).
pub trait Mesher: Send + Sync {
    fn mesh(
        &mut self,
        chunk: &Chunk,
        neighbors: &ChunkNeighbors,
        registry: &BlockRegistry,
        output: &mut MeshOutput,
        transparent_output: &mut MeshOutput,
    ) -> Result<(), MeshError>;
}
