/// Mesh output buffers in struct-of-arrays layout.
///
/// Each array corresponds to a `THREE.BufferGeometry` attribute.
/// Designed for reuse: call `clear()` between meshing calls to reset
/// without deallocating.
pub struct MeshOutput {
    /// Vertex positions — 3 floats (x, y, z) per vertex.
    pub positions: Vec<f32>,
    /// Vertex normals — 3 floats (nx, ny, nz) per vertex.
    pub normals: Vec<f32>,
    /// Ambient occlusion — 1 float per vertex, range [0.0, 1.0] where 1.0 = fully lit.
    pub ao: Vec<f32>,
    /// Block ID per vertex — used for texture lookup.
    pub block_ids: Vec<u16>,
    /// Texture coordinates — 2 floats (u, v) per vertex.
    /// For greedy-merged quads, UVs tile: a W×H quad gets UVs spanning [0,W]×[0,H].
    pub uvs: Vec<f32>,
    /// Triangle indices.
    pub indices: Vec<u32>,
    /// Current number of vertices.
    vertex_count: u32,
}

impl MeshOutput {
    /// Create an empty mesh output with no pre-allocation.
    pub fn new() -> Self {
        Self {
            positions: Vec::new(),
            normals: Vec::new(),
            ao: Vec::new(),
            block_ids: Vec::new(),
            uvs: Vec::new(),
            indices: Vec::new(),
            vertex_count: 0,
        }
    }

    /// Create a mesh output pre-allocated for `estimated_quads` quads.
    /// Each quad = 4 vertices + 6 indices (two triangles).
    pub fn with_capacity(estimated_quads: usize) -> Self {
        let verts = estimated_quads * 4;
        let idxs = estimated_quads * 6;
        Self {
            positions: Vec::with_capacity(verts * 3),
            normals: Vec::with_capacity(verts * 3),
            ao: Vec::with_capacity(verts),
            block_ids: Vec::with_capacity(verts),
            uvs: Vec::with_capacity(verts * 2),
            indices: Vec::with_capacity(idxs),
            vertex_count: 0,
        }
    }

    /// Reset all buffers to empty without deallocating.
    pub fn clear(&mut self) {
        self.positions.clear();
        self.normals.clear();
        self.ao.clear();
        self.block_ids.clear();
        self.uvs.clear();
        self.indices.clear();
        self.vertex_count = 0;
    }

    /// Number of vertices currently in the output.
    #[inline]
    pub fn vertex_count(&self) -> u32 {
        self.vertex_count
    }

    /// Number of indices currently in the output.
    #[inline]
    pub fn index_count(&self) -> u32 {
        self.indices.len() as u32
    }

    /// Whether the output contains no geometry.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.vertex_count == 0
    }

    /// Append a quad (4 vertices, 6 indices / 2 triangles).
    ///
    /// Vertices are ordered: `[v0, v1, v2, v3]` forming a quad where
    /// v0-v1-v2-v3 go around the face. The diagonal is chosen based on
    /// AO values to avoid the anisotropy artifact:
    /// - If `ao[0] + ao[2] > ao[1] + ao[3]`: triangles (0,1,2) and (0,2,3)
    /// - Otherwise: triangles (1,2,3) and (1,3,0)
    pub fn push_quad(
        &mut self,
        positions: &[[f32; 3]; 4],
        normal: [f32; 3],
        ao_values: [f32; 4],
        block_id: u16,
        uvs: &[[f32; 2]; 4],
    ) {
        let base = self.vertex_count;

        // Batch-write 4 vertices using extend_from_slice to avoid per-push capacity checks
        self.positions.extend_from_slice(&[
            positions[0][0],
            positions[0][1],
            positions[0][2],
            positions[1][0],
            positions[1][1],
            positions[1][2],
            positions[2][0],
            positions[2][1],
            positions[2][2],
            positions[3][0],
            positions[3][1],
            positions[3][2],
        ]);

        self.normals.extend_from_slice(&[
            normal[0], normal[1], normal[2], normal[0], normal[1], normal[2], normal[0], normal[1],
            normal[2], normal[0], normal[1], normal[2],
        ]);

        self.ao.extend_from_slice(&ao_values);
        self.block_ids
            .extend_from_slice(&[block_id, block_id, block_id, block_id]);

        self.uvs.extend_from_slice(&[
            uvs[0][0], uvs[0][1], uvs[1][0], uvs[1][1], uvs[2][0], uvs[2][1], uvs[3][0], uvs[3][1],
        ]);

        // AO-aware triangulation to fix anisotropy artifacts.
        // See: https://0fps.net/2013/07/03/ambient-occlusion-for-minecraft-like-worlds/
        if ao_values[0] + ao_values[2] > ao_values[1] + ao_values[3] {
            // Diagonal 0-2
            self.indices
                .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        } else {
            // Diagonal 1-3
            self.indices.extend_from_slice(&[
                base + 1,
                base + 2,
                base + 3,
                base + 1,
                base + 3,
                base,
            ]);
        }

        self.vertex_count += 4;
    }

    /// Append a single vertex and return its index.
    /// Used by meshers that share vertices between faces (e.g., Surface Nets).
    #[inline]
    pub fn push_vertex(
        &mut self,
        position: [f32; 3],
        normal: [f32; 3],
        ao_value: f32,
        block_id: u16,
        uv: [f32; 2],
    ) -> u32 {
        let idx = self.vertex_count;
        self.positions.extend_from_slice(&position);
        self.normals.extend_from_slice(&normal);
        self.ao.push(ao_value);
        self.block_ids.push(block_id);
        self.uvs.extend_from_slice(&uv);
        self.vertex_count += 1;
        idx
    }

    /// Append a triangle from 3 pre-existing vertex indices.
    #[inline]
    pub fn push_triangle(&mut self, a: u32, b: u32, c: u32) {
        self.indices.extend_from_slice(&[a, b, c]);
    }
}

impl Default for MeshOutput {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_is_empty() {
        let output = MeshOutput::new();
        assert!(output.is_empty());
        assert_eq!(output.vertex_count(), 0);
        assert_eq!(output.index_count(), 0);
    }

    #[test]
    fn push_quad_adds_geometry() {
        let mut output = MeshOutput::new();
        let positions = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
        ];
        let uvs = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        output.push_quad(&positions, [0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0], 1, &uvs);
        assert_eq!(output.vertex_count(), 4);
        assert_eq!(output.index_count(), 6);
        assert_eq!(output.positions.len(), 12);
        assert_eq!(output.normals.len(), 12);
        assert_eq!(output.ao.len(), 4);
        assert_eq!(output.block_ids.len(), 4);
        assert_eq!(output.uvs.len(), 8);
    }

    #[test]
    fn clear_preserves_capacity() {
        let mut output = MeshOutput::with_capacity(100);
        let positions = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
        ];
        let uvs = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        output.push_quad(&positions, [0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0], 1, &uvs);

        let cap_before = output.positions.capacity();
        output.clear();

        assert!(output.is_empty());
        assert_eq!(output.vertex_count(), 0);
        assert!(output.positions.capacity() >= cap_before);
    }

    #[test]
    fn ao_triangle_flip() {
        let mut output = MeshOutput::new();
        let positions = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
        ];
        let uvs = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];

        // Equal AO: uses 1-3 diagonal
        output.push_quad(&positions, [0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0], 1, &uvs);
        // ao[0]+ao[2] == ao[1]+ao[3], so we take the else branch: (1,2,3), (1,3,0)
        assert_eq!(output.indices[0], 1);
        assert_eq!(output.indices[3], 1);

        output.clear();

        // Unequal AO favoring 0-2 diagonal: ao[0]+ao[2] > ao[1]+ao[3]
        output.push_quad(&positions, [0.0, 0.0, 1.0], [1.0, 0.0, 1.0, 0.0], 1, &uvs);
        // (0,1,2), (0,2,3)
        assert_eq!(output.indices[0], 0);
        assert_eq!(output.indices[3], 0);
    }
}
