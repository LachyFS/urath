# Dense browser rendering: measured improvements

Measured 11 October 2026 (Australia/Sydney), using production builds and the public package API. Every workload below contains **256³ = 16,777,216 samples**. These are the first optimization round’s captures; the [subsequent stress experiments](performance-stress.md) cover 512³ data, close-ups, dense translucency, and scattered edits with the latest implementation.

## Hardware and method

Chromium 143.0.7499.4, Three.js r172, Linux, 16 logical processors. The browser reports **ANGLE / Vulkan / AMD Ryzen 7 9800X3D, RADV RAPHAEL_MENDOCINO**, with software rendering false. Hardware access required `--use-angle=vulkan --enable-gpu`; default headless selection used SwiftShader instead.

Canvas: **980 × 584**, pixel ratio 1. The same 10-second camera orbit, 45° field of view, warm-up and centre edit are used for before/after comparisons. The orbit centre is `[128,128,128]`, radius 494.43094, elevation 222.49392. Mesh chunks are 16³ with two workers. Volume rays are capped at **256 samples**, opacity 0.08; transfer function, range and camera are unchanged. The edit fills a 42³ region starting at `[107,107,107]`, with air for material grids and the maximum value for the scalar phantom.

GPU p95 measures elapsed GPU rendering, not frame delivery. Frame intervals include browser scheduling; the display cadence here is approximately 60 Hz. CPU submission is separate. GPU distributions use the most recent 120 completed asynchronous timer queries. First frame includes fixture generation and initial preparation/upload plus two animation frames; edit latency includes preparation/upload and two frames. Memory is managed CPU/GPU buffers plus conservative worker reservations, excluding caller input, driver/browser overhead and garbage collection. These are workload measurements, not a universal FPS guarantee or a comparison with competing libraries.

## Same-path comparison

| Workload                           | GPU p95, ms (before → after) | Frame p95, ms | First frame, ms | Edit to visible, ms |   Managed MiB |
| ---------------------------------- | ---------------------------: | ------------: | --------------: | ------------------: | ------------: |
| Single material, greedy mesh       |                  0.72 → 0.74 |   16.7 → 16.8 |   343.9 → 272.9 |         47.4 → 47.6 |   45.6 → 46.5 |
| Alternating materials, greedy mesh |                  1.72 → 1.01 |   16.8 → 16.8 |   373.0 → 272.7 |         48.4 → 47.9 |  156.0 → 68.5 |
| Scalar phantom, volume             |                 23.78 → 8.34 |   33.3 → 16.7 |   484.4 → 376.7 |         99.1 → 31.3 | 128.0 → 128.3 |

The multicolour fixture drops from **807,600 to 3,504 triangles** after the same edit, a 99.57% reduction. Geometry merges on occupancy and ambient occlusion; colours come from integer material textures. Vertex attributes and indices are packed, and fully enclosed or empty chunks bypass the mesher. The small increase in the single-material memory estimate comes from reserving more of the temporary packing overlap explicitly.

Volume rendering is **2.85× faster in p95 GPU time** at the same sample limit. Conservative 8³-brick min/max classification skips only regions that cannot contribute; the original sample positions remain intact. A separate repeat measured 8.40 ms GPU p95 and 16.8 ms frame p95. This is a repeat check, not a confidence interval.

The scalar edit uploads **296,352 bytes** instead of **67,108,864 bytes** (about 226× fewer scalar bytes). It rescans only affected brick bounds, then reclassifies/uploads the small brick index. Initial rendering and context restoration still upload the full owned texture. This first implementation coalesced multiple edits into one bounding box; the [subsequent stress experiments](performance-stress.md) replaced that policy with a bounded queue to avoid excessive uploads for distant edits.

## Direct material rendering

`createVoxelRaycast(renderer, options)` stores material IDs in an R16UI texture, skips empty bricks, traverses cells to the first occupied voxel, and writes its actual hit depth. It renders in one draw call and does not allocate exposed-face geometry. It uses directional lighting; the greedy mesh path also offers ambient occlusion. These paths are choices with different costs and shading, not interchangeable image-quality benchmarks.

| Fixture       | GPU p95, ms | CPU submission p95, ms | Frame p95, ms | First frame, ms | Managed MiB |
| ------------- | ----------: | ---------------------: | ------------: | --------------: | ----------: |
| solid         |        0.37 |                   0.20 |          16.7 |           144.7 |        64.3 |
| multimaterial |        0.59 |                   0.20 |          16.8 |           135.4 |        64.3 |
| porous        |        0.96 |                   0.20 |          16.8 |           253.3 |        64.3 |
| model         |        2.70 |                   0.20 |          16.8 |           235.5 |        64.3 |
| terrain       |        2.39 |                   0.20 |          16.7 |           385.8 |        64.3 |

The 50%-occupied deterministic noisy fixture therefore fits the same buffer budget as a solid grid. All five direct fixtures complete the edit and orbit, with edit-to-visible latency of 29.9–31.6 ms in these runs. The coloured-model and terrain camera fitting differs from a tight surface-only bounding box, so their direct-path figures are reported independently rather than as before/after speedups.

## Software rendering

SwiftShader remains a separate fallback measurement, not hardware evidence. The original 256³ multicolour mesh had 183.3 ms frame p95; the optimized mesh measured 16.8 ms. The scalar phantom changed from 166.7 ms to 100.0 ms. Scalar rendering is still slow in software; hardware acceleration matters.

## Correctness and packaging

- 19 production-browser tests pass on both AMD/Vulkan and SwiftShader.
- Direct rendering matches an independent CPU reference that intersects individual occupied voxel boxes, across eight viewpoints, non-cubic dimensions and nonuniform spacing.
- Accelerated volume pixels match the unaccelerated sampling path within one 8-bit channel value, across cameras, clipping, transfer windows, non-monotonic transfer functions, isosurface thresholds and edits.
- Pixel tests check material colours across chunk seams and edited regions, retained neighbours, real hit-depth composition, and the actual `texSubImage3D` offset/size calls. Shader errors and GL errors fail these checks.
- Budget rejection, stale worker results, disposal, raw imports, responsive layout and export are covered. Six data/acceleration tests also pass.
- An independent TypeScript/Vite consumer installs the `.tgz` and renders all three paths under `/nested/`, without a Rust build.

## Reproduce

```sh
npm ci
npm run build
npx playwright install chromium
npm run test:browser
URATH_TEST_GPU=1 npm run test:browser
npm run test:package

# Same mesh and volume fixtures, hardware requested:
URATH_BENCH_SIZE=256 URATH_BENCH_GPU=1 npm run benchmark

# Direct material fixtures:
URATH_BENCH_SIZE=256 URATH_BENCH_GPU=1 URATH_BENCH_BACKEND=raycast \
  URATH_BENCH_DATASETS=solid,multimaterial,porous,model,terrain \
  URATH_BENCH_LABEL=raycast-hardware npm run benchmark

# Explicit software fallback:
URATH_BENCH_SIZE=256 npm run benchmark
```

Inspect `environment.gpu` and `softwareGpu` in exported results. `URATH_BENCH_LABEL` sets the output suffix. The harness exits unsuccessfully on failed fixtures or rendering errors. Run measurements without simultaneous tests, builds or other GPU workloads. Use the interactive viewer and JSON export for other browsers/devices.

Raw captured reports: [before hardware](benchmarks/browser-benchmark-256-before-hardware.json), [after hardware](benchmarks/browser-benchmark-256-final-hardware.json), [direct hardware](benchmarks/browser-benchmark-256-raycast-hardware.json), [volume repeat](benchmarks/browser-benchmark-256-volume-repeat-hardware.json), [after software](benchmarks/browser-benchmark-256-final-software.json). The [initial preview baseline](performance-baseline.md) records the older software runs.

## Current boundaries

The texture paths require resident data within GPU 3D-texture dimensions and the configured memory budget. Nearest-neighbour scalar sampling, no volume paging/LOD, and no translucent-volume depth composition with internal opaque objects remain limitations. Greedy AO uses six neighbour faces, not a full diagonal halo. There is no WebGPU backend. Choose the renderer for the data and validate on target devices; neither voxel count alone nor one hardware result establishes performance for every workload.
