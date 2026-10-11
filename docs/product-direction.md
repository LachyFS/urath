# Urath: dense voxel rendering for the browser

Review date: 2026-10-10. Source reviewed: `50ffd43` on `main`.

This is the historical baseline review. The first implementation is now described in the [package guide](../packages/urath/README.md) and [repository README](../README.md); the findings below describe the reviewed commit.

## Product direction

Build a developer library that makes large voxel datasets practical to display and update in browser applications. The intended scope includes material/colour voxels, terrain, scans, and scalar volumes. Developers should be able to bring their own data and integrate the result with their existing Three.js scene.

The proposed promise is: **load voxel data, choose how to view it, and keep interaction responsive within a stated memory budget.** This is a product goal; the current repository does not establish a browser performance guarantee.

Support multiple data meanings explicitly. A material ID is a category; density is a scalar measurement. Neither should silently be interpreted as the other. Share dimensions, spacing, transforms, brick addressing, loading, updates, resource ownership, and disposal across rendering paths.

## What is already useful

- Pure Rust greedy meshing, per-vertex ambient occlusion, cross-chunk face handling, and opaque/transparent mesh outputs.
- A Surface Nets implementation and procedural terrain generation.
- A demo containing a worker pool, streamed terrain columns, editing, materials, and rendering.
- 74 passing native Rust unit tests. Workspace formatting and Clippy with warnings denied also pass.

These are substantial building blocks. The current public JavaScript package is still a placeholder.

## Verified adoption and performance gaps

| Finding | Evidence | Consequence |
| --- | --- | --- |
| No usable TypeScript entry point | `packages/urath/src/index.ts` contains `export {}` | A developer cannot integrate the promised toolkit through its package API. |
| Incomplete distribution | `package.json` includes only `dist`; `npm pack --dry-run` lists five files and no WASM | Building WASM in the release job does not put it into the npm artifact. The public registry lookup also returned 404 for `@urath/threejs`. |
| Broken fresh production demo | Vite builds successfully, but the output contains only HTML and the main JS bundle | Requests for textures, the worker, and WASM glue return HTML fallback. Headless Chromium reaches “ERROR — CHECK CONSOLE” with no canvas. |
| Stale getting-started instructions | README imports `urath/wasm/...`, while the package is named `@urath/threejs`; Rust sample uses an outdated crate name and method signature | Copying the documented examples does not establish a working integration. |
| Browser path allocates and copies | WASM meshing methods allocate fresh output vectors; accessors copy to JS arrays; the worker copies most of those arrays again and combines chunk meshes | The broad “zero allocations” claim does not describe the browser pipeline. Measure and document boundaries before making performance claims. |
| Rendering and scheduling are demo code | Worker pool and chunk manager are inside the 2,017-line demo HTML | Integrators would have to extract infrastructure themselves. Worker rejection, cancellation, bounded queues, and stale-result handling need explicit contracts. |
| Updates replace whole column geometry | `_remeshColumnAsync` remeshes a column and recreates geometry | Local edits can cause substantial CPU work and GPU uploads. Profile this against updates to individual bricks. |
| Scalar volume data is not exposed | Chunks contain `u16` material IDs; Surface Nets derives a smoothed binary density field from occupancy | Existing smooth meshes do not provide arbitrary scalar input or volume rendering. |
| Browser measurements do not isolate the full pipeline | Flythrough records synchronous work within a frame callback; worker timings include queue/round-trip latency | Separate frame intervals, CPU submission, GPU time where available, generation, meshing, transfer, and upload measurements. |

The existing terrain demo also deletes edited block data when unloading a column. A general library should define caller ownership and persistence hooks before advertising reusable editing/streaming support.

## Geometry experiment

Ran the existing native greedy mesher on single 32³ chunks with empty neighbours and the default registry. Each input array is 65,536 bytes. This experiment measures output sizes, **not rendering speed, GPU allocation overhead, or peak process memory**.

| Input pattern | Occupied voxels | Triangles | Rust output bytes | Demo attribute/index bytes |
| --- | ---: | ---: | ---: | ---: |
| One solid material | 32,768 | 12 | 1,056 | 1,104 |
| Fully solid, alternating four opaque materials | 32,768 | 12,288 | 1,081,344 | 1,130,496 |
| Radius-14 sphere centred at (15.5, 15.5, 15.5) | 11,536 | 5,052 | 444,576 | 464,784 |
| Occupied/empty checkerboard | 16,384 | 196,608 | 17,301,504 | 18,087,936 |
| Deterministic approximately 50% occupied noise | 16,346 | 97,350 | 8,566,800 | 8,956,200 |

Materials in the second row are `1 + ((x + y + z) % 4)`; checkerboard occupancy is `(x + y + z) % 2 == 0`. Noise uses xorshift32 with seed 123456789 and shifts 13, 17, 5, choosing even results as occupied. Rust output totals count 38 bytes per vertex plus 4 bytes per index; demo totals count 40 bytes per vertex because the worker converts block IDs to Float32.

Two fully occupied grids can generate dramatically different geometry. Voxel count and occupancy alone are insufficient performance claims. Material boundaries, exposed surface complexity, view, transparency, and update frequency all belong in the benchmark specification.

## Rendering architecture

Keep a shared data and resource layer with distinct, explicit rendering modes:

| Mode | Intended use | Starting point |
| --- | --- | --- |
| Block surfaces | Material/colour voxels, terrain, voxel models | Existing greedy mesher and Three.js geometry integration. Add measured culling, update, and detail-management improvements. |
| Isosurfaces | A selected threshold in a scalar field | Extend input semantics and validate an actual scalar-field mesher. Existing binary Surface Nets is a starting point. |
| Volume | Density throughout a dataset, translucent interior structure | A separate GPU volume renderer with colour/opacity mapping, clipping/slicing, and a controllable quality budget. |

For solid datasets with highly complex surfaces, compare a direct voxel ray-casting prototype against meshing. Do not assume either wins universally. WebGPU, sparse hierarchies, compression, and level of detail are candidate tools to evaluate against specific workloads, rather than performance outcomes by themselves.

Allow dense typed-array input and, subsequently, incremental brick providers. A 512³ Uint16 dataset already occupies 256 MiB before any copies or geometry. Bound in-flight work, staging buffers, CPU residency, and GPU residency; make buffer ownership and updates explicit. Cancellation and versioned updates must prevent old worker results replacing newer data.

Keep Rust for CPU tasks where measurements justify it. Render on the GPU and keep the Three.js adapter composable with caller-owned scenes, cameras, and render loops. Shared internal modules can live in the current package initially; a package split is not a prerequisite.

## Delivery sequence and acceptance criteria

1. **Establish the performance evidence.** Build a reproducible browser benchmark using solid, multi-material, noisy/porous, scalar-volume, and changing datasets. Include 128³ and 256³ inputs, then use 512³ as a memory/streaming stress case where feasible. Record hardware, browser, resolution, quality, bytes, time to first useful frame, frame-interval percentiles, and update-to-visible latency. Separate cold loading from steady-state interaction. Compare appropriate baselines at matching visual output.
2. **Deliver a complete surface integration.** Ship a local package artifact containing WASM, working workers, typed data input, a Three.js adapter, and documented disposal. A fresh Vite project must install the tarball, display caller-provided data, update it, and serve its production build without a Rust installation. Use that same public API in the demo and CI.
3. **Prove the volume path early.** Display one known scalar dataset with an adjustable transfer function and clipping or slicing. Use the same spatial metadata and lifecycle contracts. Verify values and spatial orientation, as well as interactive performance. This tests the broader architecture before it becomes entrenched around terrain.
4. **Optimise measured bottlenecks.** Prioritise unnecessary copies, reusable buffers, bounded worker scheduling, affected-brick updates, and GPU upload volume. Evaluate level of detail, empty-space skipping, and alternative solid rendering only against benchmark evidence and visual correctness.
5. **Validate external use.** Recruit a small set of developers with actual datasets across the two main paths. A useful initial validation target is three integrations outside this repository, including at least one surface application and one volume application. Track integration time, dataset limits, repeat use, and why they choose Urath over their existing approach. This target is a proposal, not evidence of demand already established.

The first concrete deliverable should be an installable surface renderer plus a reproducible performance viewer. The volume proof should follow early enough to shape the shared data API. Public performance claims should identify the workload and device rather than promise a universal voxel count or frame rate.

## Reference points

- [Three.js volume rendering example](https://threejs.org/examples/webgl_texture3d.html): an existing baseline for the volume path.
- [Efficient Sparse Voxel Octrees](https://research.nvidia.com/publication/2010-02_efficient-sparse-voxel-octrees-analysis-extensions-and-implementation): primary research on compact voxel storage, ray casting, and memory management; not evidence of browser performance for Urath.
- [block-mesh-rs](https://github.com/bonsairobo/block-mesh-rs): existing Rust visible-face and greedy-meshing implementations, relevant for equivalent-output CPU comparisons.
- [Voxelize](https://github.com/voxelize/voxelize): an existing Rust/Three.js voxel engine, including WASM meshing. Rust/WASM alone is not a unique product benefit.

## Verification limits

This review ran native Rust tests, formatting, Clippy, TypeScript compilation, npm pack inspection, a fresh Vite production build, HTTP asset checks, headless Chromium startup, and the native geometry experiment above. It did not compile a new WASM binary, repair the demo, benchmark GPU performance, test a working voxel interaction journey, or validate demand with outside developers. No runtime implementation or release was made as part of this review.
