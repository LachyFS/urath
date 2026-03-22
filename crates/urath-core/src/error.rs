use thiserror::Error;

#[derive(Debug, Error)]
pub enum MeshError {
    #[error("chunk size {0} exceeds maximum {1}")]
    ChunkTooLarge(usize, usize),

    #[error("coordinates ({0}, {1}, {2}) out of bounds for chunk of size {3}")]
    OutOfBounds(usize, usize, usize, usize),
}
