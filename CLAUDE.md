# CLAUDE.md

## Project: urath

Voxel surface and scalar-volume library for Three.js. Monorepo with Rust workspace + TypeScript npm package.

### Build Commands

- `npm ci && npm run build` — build WASM, package, and performance viewer from the repository root
- `npm test && npm run test:browser && npm run test:package` — data tests, production-browser tests, and independent packed-consumer test (install Playwright Chromium first)
- `npm run benchmark` — export browser workload measurements (software renderer by default)
- `cd crates/urath-core && cargo test` — run Rust unit tests
- `cd crates/urath-core && cargo bench` — run Criterion benchmarks
- `cd crates/urath-wasm && wasm-pack build --target web --out-dir ../../packages/urath/wasm` — build WASM
- `cd packages/urath && npm run build` — build TypeScript package
- `cd packages/urath && npm run typecheck` — type check only

### Architecture

- `crates/urath-core/` — Pure Rust. Meshing algorithms, chunk data structures, output buffers. No WASM deps here.
- `crates/urath-wasm/` — Thin wasm-bindgen wrapper over core. Handles JS ↔ WASM buffer marshalling.
- `packages/urath/` — TypeScript npm package. Wraps WASM, adds Three.js integration, worker pool, materials.
- `examples/demo/` — Performance lab. Uses the public package API for both rendering paths.
- `scripts/test-package.mjs` — Tests the actual archive in a separate TypeScript/Vite project under a URL subpath.

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
