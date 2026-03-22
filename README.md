# urath

High-performance voxel meshing library built in Rust, compiled to WebAssembly, designed for Three.js.

Greedy meshing with per-vertex ambient occlusion, zero allocations in the hot path, and cross-chunk boundary handling — all running at native speed in the browser.

## Features

- **Greedy meshing** — merges adjacent faces into larger quads, drastically reducing vertex count
- **Ambient occlusion** — per-vertex AO computed from neighboring block opacity with anisotropy-correct triangulation
- **Cross-chunk boundaries** — seamless meshing across chunk edges via neighbor border data
- **Zero-alloc hot path** — pre-allocated scratch buffers reused across mesh calls
- **Three.js ready** — outputs `Float32Array` / `Uint32Array` buffers directly compatible with `BufferGeometry`

## Architecture

```
crates/urath-core/     Pure Rust. Meshing algorithms, chunk data, output buffers.
crates/urath-wasm/     Thin wasm-bindgen wrapper. JS ↔ WASM buffer marshalling.
packages/urath/        TypeScript npm package. WASM bindings + Three.js integration.
examples/demo/         Interactive Three.js demo with block placement.
```

## Quick Start

### Build

```bash
# Build WASM
cd crates/urath-wasm && wasm-pack build --target web --out-dir ../../packages/urath/wasm

# Build TypeScript package
cd packages/urath && npm run build
```

### Usage

```js
import init, {
  WasmChunk,
  WasmChunkNeighbors,
  WasmGreedyMesher,
} from "urath/wasm/urath_wasm.js";

await init();

// Create a 32x32x32 chunk
const chunk = WasmChunk.new_default();

// Set some blocks (block ID 0 = air)
chunk.set_block(0, 0, 0, 1);
chunk.set_block(1, 0, 0, 1);
chunk.set_block(0, 1, 0, 2);

// Or batch set: [x, y, z, id, x, y, z, id, ...]
chunk.set_blocks(new Uint32Array([2, 0, 0, 1, 3, 0, 0, 1]));

// Mesh it
const mesher = new WasmGreedyMesher(32);
const result = mesher.mesh(chunk);

// Use with Three.js BufferGeometry
const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.BufferAttribute(result.positions(), 3));
geometry.setAttribute("normal", new THREE.BufferAttribute(result.normals(), 3));
geometry.setAttribute("ao", new THREE.BufferAttribute(result.ao(), 1));
geometry.setIndex(new THREE.BufferAttribute(result.indices(), 1));
```

### Cross-Chunk Boundaries

For seamless meshing between adjacent chunks, provide neighbor border data:

```js
const neighbors = new WasmChunkNeighbors(32);

// Faces: 0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z
neighbors.set_neighbor(0, adjacentChunkPosX);
neighbors.set_neighbor(1, adjacentChunkNegX);

const result = mesher.mesh_with_neighbors(chunk, neighbors);
```

## Rust API

The core crate can be used directly in Rust without WASM:

```rust
use urath_core::{Chunk, ChunkNeighbors, GreedyMesher, Mesher, MeshOutput};

let mut chunk = Chunk::new_default()?;
chunk.set(0, 0, 0, 1);
chunk.set(1, 0, 0, 1);

let neighbors = ChunkNeighbors::empty(chunk.size());
let mut output = MeshOutput::with_capacity(1024);
let mut mesher = GreedyMesher::new();

mesher.mesh(&chunk, &neighbors, &mut output)?;

// Reuse buffers for next chunk
output.clear();
```

## Benchmarks

```bash
cd crates/urath-core && cargo bench
```

Benchmarks cover empty, solid, surface, and noisy terrain chunk configurations.

## Tests

```bash
cd crates/urath-core && cargo test
```

## License

MIT OR Apache-2.0
