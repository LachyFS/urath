use crate::chunk::{Chunk, ChunkNeighbors};
use crate::error::MeshError;
use crate::mesh_output::MeshOutput;

/// Trait implemented by all voxel meshing algorithms.
///
/// Meshers take a chunk and its neighbors, and write geometry into a
/// reusable `MeshOutput` buffer. The caller should call `output.clear()`
/// before each call if reusing the buffer.
///
/// `&mut self` allows implementations to reuse internal scratch buffers
/// without interior mutability. For thread safety, create one mesher
/// per thread (they are cheap to construct).
pub trait Mesher: Send + Sync {
    fn mesh(
        &mut self,
        chunk: &Chunk,
        neighbors: &ChunkNeighbors,
        output: &mut MeshOutput,
    ) -> Result<(), MeshError>;
}
