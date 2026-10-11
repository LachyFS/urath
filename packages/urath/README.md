# @urath/threejs

Voxel surface meshing, direct voxel traversal, and scalar volume rendering for Three.js. Developer preview; tested with Three.js r172, WebGL2, and module workers.

- **Material grids:** Rust/WASM greedy meshing, ambient occlusion, per-chunk frustum culling, palette colours, and incremental regional edits.
- **Dense material grids:** exact GPU traversal with one draw call, empty-brick skipping, real hit depth, and regional texture uploads.
- **Scalar fields:** GPU volume rendering with a colour/opacity transfer function, conservative empty-brick skipping, regional uploads, clipping, and a ray-marched isosurface mode.
- **Bounded work:** no unbounded queue of chunk snapshots; retained worker buffers, transferred results, stale-result rejection, explicit memory estimates, and disposal.

The package artifact includes WASM, module workers, JavaScript, and TypeScript declarations. Consumers do not need Rust. This repository's preview is distributed as a local `.tgz` until a registry release is published.

## Install the preview

```sh
npm install /path/to/urath-threejs-0.1.0.tgz three@0.172.0
npm install -D @types/three@0.172.0
```

Vite resolves the worker and WASM assets automatically, including deployments under a URL subpath. The production build is tested in an independent project installing the packed archive. Other bundlers are not yet certified. Optional `workerUrl` and `wasmUrl` let applications provide their own asset locations.

## Choose a rendering path

| API                                     | Good fit                                                            | Main cost                                               |
| --------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| `createSurface(options)`                | Editable worlds, exposed surfaces, chunk culling, ambient occlusion | Exposed geometry and chunk draw calls                   |
| `createVoxelRaycast(renderer, options)` | Dense scans, material grids, highly fragmented/noisy occupancy      | Visible pixels and traversal to the first occupied cell |
| `createVolume(renderer, options)`       | Scalar density, opacity integration, scalar isosurfaces             | Visible pixels and contributing ray samples             |

The direct path handles fragmented opaque data without creating a triangle for each exposed face. It traverses voxel cells exactly; it does not use the volume renderer's sampling-quality limit. All paths accept caller-owned Three.js scenes, cameras, and render loops.

## Surface data

```ts
import * as THREE from "three";
import { createSurface } from "@urath/threejs";

const scene = new THREE.Scene(); // Use your existing scene and render loop.
const data = new Uint16Array(32 * 32 * 32);
data.fill(1);

const surface = await createSurface({
  data,
  dimensions: [32, 32, 32],
  spacing: [1, 1, 1],
  origin: [0, 0, 0],
  palette: ["#000000", "#79d5b0"],
  chunkSize: 16,
  workers: 2,
  maxMemoryBytes: 256 * 1024 * 1024,
});
scene.add(surface);

await surface.updateRegion({
  offset: [10, 10, 10],
  dimensions: [4, 4, 4],
  data: new Uint16Array(4 * 4 * 4), // Carve out a cavity.
});
console.log(surface.stats);

// When removing the dataset:
surface.dispose(); // Removes itself; terminates workers; releases owned resources.
```

The array is X-fastest: `x + width * (y + height * z)`. Dimensions may be non-cubic or not divisible by the chunk size. Voxel `(0,0,0)` occupies the first cell starting at `origin`; spacing is in world units. All nonzero material IDs are opaque, including IDs 5 and 9. ID 0 is empty. Palette entries are indexed by ID, wrapping if the ID exceeds the palette length. This surface API does not interpret material IDs as density.

`createSurface` returns a `Promise<VoxelSurface>`, a Three.js `Group`, after initial meshing. It copies the input once; subsequent caller mutations do not affect it. Regional updates copy their inputs and remesh only the intersecting chunks and their one-voxel neighbourhood. Geometry merges across colour boundaries. Visible multicolour chunks use compact integer material textures; single-colour chunks use a uniform ID. Packed positions, normals, AO and face bounds reduce vertex bandwidth; 16-bit indices are used when possible. Empty and fully enclosed chunks bypass meshing.

`onProgress(stats)` reports meshing progress; do not throw from the callback. `signal` accepts an `AbortSignal` for the surface's lifetime. `flush()` resolves when pending work is complete. Simultaneous updates coalesce; their promises resolve after the queue settles. Version checks discard outdated results. Worker initialization, runtime, timeout, budget, and disposal failures reject pending operations. A fatal failure disposes the surface instead of leaving a partially valid dataset.

`chunkSize` is 8, 16 (default), or 32; `workers` is 1–8, defaulting to up to two workers that fit the budget. Smaller chunks reduce worst-case geometry and update size; larger chunks can merge more faces and reduce draw calls. Each worker owns a reusable Rust meshing session. Neighbor border storage and mesh output capacity are reused. Snapshot buffers make a round trip through the worker; mesh getters copy from WASM, then the worker packs attributes into transferable JS buffers. The whole pipeline is not zero-copy or allocation-free.

Surface statistics include input bytes, geometry/material-texture/GPU byte estimates, conservative worker reservations, peak managed-byte estimates, pending/active jobs, completed chunks, triangle count, worker CPU time, and discarded jobs. Workers never receive more than one job each; pending work stores only chunk keys. Input and worker reservations are checked before allocation; geometry is checked before being retained, including material textures and replacement overlap. `maxMemoryBytes` limits this accounting model, not total browser process memory or driver allocation. Caller-owned inputs, GC timing, browser overhead, and driver overhead are outside it. Highly fragmented data can reach the budget quickly.

## Direct opaque voxels

```ts
import { createVoxelRaycast } from "@urath/threejs";

const voxels = createVoxelRaycast(renderer, {
  data: materialIds, // Uint16Array; 0 is empty
  dimensions: [256, 256, 256],
  palette: ["black", "#79d5b0", "#78a5df"],
  maxMemoryBytes: 256 * 1024 * 1024,
});
scene.add(voxels);
voxels.updateRegion({
  offset: [12, 12, 12],
  dimensions: [2, 2, 2],
  data: new Uint16Array(8),
});
// Render normally with your own camera; perspective and orthographic are supported.
console.log(voxels.stats);
voxels.dispose();
```

`createVoxelRaycast` returns a `VoxelRaycast` mesh synchronously. It copies the input and retains an R16UI texture plus a hierarchical occupancy index over 8³ bricks. A 256³ field uses about 64.3 MiB of managed buffers regardless of exposed-face complexity. GPU dimension limits and the budget are checked before allocating the grid. Spacing and origin use the same conventions as surfaces. The shader writes the first occupied cell's depth, so opaque objects in front and behind compose correctly. It uses directional shading; the greedy mesh path also provides ambient occlusion.

Regional edits copy their data immediately and queue texture regions for the next render. Adjacent edits merge when their bounding box does not increase transfer volume; distant edits stay separate. The queue is capped at 32 boxes, merging the least expensive pair at the cap. Multiple edits rebuild the small skip hierarchy once per render. Initial rendering and context restoration upload the full owned array. Statistics distinguish full uploads, regional uploads and scalar/material bytes uploaded; the small acceleration texture is accounted in memory separately. Dispose when finished. Surface streaming, a mesh for collision/raycast queries, and transparent material IDs are not provided by this direct path.

## Scalar data

```ts
import { createVolume } from "@urath/threejs";

// `renderer` is your THREE.WebGLRenderer; `density` is your scalar array.
const volume = createVolume(renderer, {
  data: density, // Float32Array, Uint8Array, or Uint16Array
  dimensions: [128, 128, 64],
  spacing: [1, 1, 2],
  range: [0, 1],
  mode: "volume", // or 'isosurface'
  maxSteps: 512,
  opacity: 0.08,
  maxMemoryBytes: 256 * 1024 * 1024,
});
scene.add(volume);

volume.setClip([0, 0, 0], [1, 1, 0.6]);
volume.setRange([0.1, 0.9]);
volume.setMode("isosurface");
volume.setThreshold(0.45);
volume.dispose();
```

Scalar values are copied into owned storage without changing their numeric units. By default, `Uint8Array` and `Uint16Array` inputs retain their exact integer representation on the CPU and GPU; `Float32Array` remains Float32. Set `storage: "float32"` to reserve floating-point storage up front, for example when fractional edits are expected. All samples must be finite. The default range is the sample minimum and maximum (expanded by 1 for a constant field). `setRange([min,max])` changes the display window. `setTransferFunction(table)` accepts 256 RGBA `Uint8` entries; colours are linear RGB and alpha controls attenuation. `setOpacity(0…10)` adjusts attenuation per voxel step. Clipping bounds are normalised to `[0,1]`; min must be strictly below max. Both perspective and orthographic cameras are supported.

`setQuality(maxSteps)` accepts 16–2048 samples per ray. Rays cover the full clipped volume within that limit, so reducing it trades detail for work. Isosurface mode displays the first sampled value at or above the threshold and writes its depth; it does not export a triangle mesh. Scalar storage, spacing, and transformations are separate from material IDs.

The renderer keeps one scalar 3D texture (R8UI, R16UI or R32F) and an 8³-brick min/max index. Explicit integer texel coordinates keep nearest-neighbour sample selection consistent across these formats. It classifies bricks whose scalar range cannot contribute under the current transfer function or threshold, including non-monotonic transfer functions, then records the largest empty aligned ancestor in each brick’s byte. Rays jump across those larger regions using the same single index texture. Dense fields with no empty bricks bypass the skip logic. The sample lattice and quality limit are unchanged. Range, transfer, opacity and threshold changes reclassify the small index without rescanning the volume. `emptySpaceSkipping: false` provides a reference path for comparisons.

`updateRegion({ offset, dimensions, data })` accepts `Uint8Array`, `Uint16Array`, or `Float32Array`, updates the CPU region and affected brick bounds, then uses the same bounded regional upload queue as direct material rendering on the next render. Updates widen integer storage to Uint16 or Float32 when necessary; values are never truncated to fit. Widening triggers a full upload and checks the temporary overlap against the memory budget before changing any samples. CPU and GPU scalar storage together require 2, 4 or 8 bytes per voxel, plus about 10 bytes per brick. GPU texture dimensions and managed-memory budgets are checked before allocating. Upload counters distinguish initial/full uploads from regional copies. Dispose when finished; setters after disposal throw.

Volume sampling is nearest-neighbour. The dataset must fit in resident memory: paging and depth-texture compositing with opaque geometry inside a translucent volume remain unsupported.

### Optional transfer-index cache

`transferCache: true` precomputes the current transfer-table lookup index into a GPU-only R8 texture. It costs one additional GPU byte per voxel and a preparation pass. It can improve dense translucent close-ups by reducing scalar texture traffic; benchmark it on the target device and camera views. It is off by default because startup time, memory use, and benefits vary by workload.

The original scalar values remain intact. Direct rendering and cache preparation use the same explicit table-index calculation and integer voxel coordinates. Isosurfaces always read raw values. Changing the range rebuilds the cache on the next volume render; changing the transfer table itself does not. Regional edits redraw only queued regions. Context restoration rebuilds the cache from the retained source.

Statistics expose `storage`, `transferCacheBytes`, `transferCacheBuilds` and `transferCacheUpdatedVoxels`, alongside scalar upload counters. Cache generation occurs on the GPU and is not counted as a CPU texture upload. The scalar renderer releases old GPU handles on context loss while retaining CPU data. Applications should also manage the lifecycle of their own render targets.

## Scope

Performance depends on occupancy complexity, view, resolution, quality, and hardware. Material colours no longer split greedy topology. Use the performance lab and exported measurements for your data. There is no universal FPS or voxel-count guarantee. The existing mesher receives six face neighbours; ambient occlusion at diagonal chunk corners is not a full 26-neighbour halo solution. Volume streaming, adaptive level of detail, arbitrary file-format readers, and WebGPU are not implemented in this preview.

MIT license. The Rust crates are dual licensed MIT OR Apache-2.0.
