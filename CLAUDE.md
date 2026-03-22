# CLAUDE.md

## Project: voxel-mesh

Rust/WASM voxel meshing library for Three.js. Monorepo with Rust workspace + TypeScript npm package.

### Build Commands

- `cd crates/voxel-mesh-core && cargo test` — run Rust unit tests
- `cd crates/voxel-mesh-core && cargo bench` — run Criterion benchmarks
- `cd crates/voxel-mesh-wasm && wasm-pack build --target web --out-dir ../../packages/voxel-mesh/wasm` — build WASM
- `cd packages/voxel-mesh && npm run build` — build TypeScript package
- `cd packages/voxel-mesh && npm run typecheck` — type check only

### Architecture

- `crates/voxel-mesh-core/` — Pure Rust. Meshing algorithms, chunk data structures, output buffers. No WASM deps here.
- `crates/voxel-mesh-wasm/` — Thin wasm-bindgen wrapper over core. Handles JS ↔ WASM buffer marshalling.
- `packages/voxel-mesh/` — TypeScript npm package. Wraps WASM, adds Three.js integration, worker pool, materials.

### Conventions

- Rust: `cargo fmt` + `cargo clippy` before committing. No `unwrap()` in library code — use `Result`.
- TypeScript: strict mode, no `any`. Use `interface` over `type` for public API surfaces.
- Chunk coordinates: `(cx, cy, cz)` integers. World coordinates: `(x, y, z)` integers for blocks, floats for positions.
- All meshers implement the `Mesher` trait (Rust) / `Mesher` interface (TS). Output is always `MeshOutput`.
- Buffer sizes: pre-allocate for worst case (every voxel exposed on all 6 faces), reuse across calls.
- Three.js is a peer dependency — never import it in the WASM crate or core Rust crate.

### Performance Rules

- Zero allocations in meshing hot path. Reuse buffers via `MeshOutput.clear()`.
- No `Vec::push` in tight loops — pre-allocate and write by index.
- Worker pool transfers ArrayBuffers, never copies (use `postMessage` transferables).
- Benchmark any mesher change with `cargo bench` before merging.
