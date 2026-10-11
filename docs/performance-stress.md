# Stress experiments: larger grids, empty rays, and scattered edits

Measured 11 October 2026 (Australia/Sydney). This round starts from the implementation measured in [the first optimization round](performance.md), rather than the original prototype. The later [storage and transfer-cache experiments](performance-storage.md) build on these results. The changes are implemented in the library; the benchmark uses its public constructors and update APIs.

## What changed

- **Hierarchical empty-space jumps.** Each 8³ brick stores one byte indicating either contributing data or the largest aligned empty ancestor containing it. Rays can cross large empty regions in one step. A reusable CPU hierarchy builds the map; GPU texture size and texture fetch count per visited brick do not increase. At 512³ the additional CPU buffers total 37,449 bytes. Non-power-of-two edges are supported.
- **Bounded regional uploads.** Up to 32 dirty boxes replace the single bounding box. Adjacent edits merge when that does not increase transfer volume. Distant edits stay separate; at the cap, the pair with the least additional transfer cost merges. Both scalar and material renderers use this queue. Multiple edits rebuild the skip hierarchy once per render.
- **Dense-volume shader work.** Fields with no empty bricks bypass skip checks. Volume and isosurface modes compile separate shader variants, removing the unused mode's work. The first hierarchy experiment regressed dense volume rendering; these changes eliminated that regression and improved the original result.

The scalar sample positions, sample limits, transfer tables and opacity are unchanged between before and after. Material rays still find the first occupied voxel exactly; these results do not reduce resolution or quality to obtain a speedup.

## Method

Chromium 143.0.7499.4, Three.js r172, Linux, AMD integrated graphics through ANGLE/Vulkan (RADV RAPHAEL_MENDOCINO), software rendering false. The offscreen target is **1024 × 1024**, without multisampling. These measurements are separate from the earlier viewer's 980 × 584 orbit and should not be compared directly with its timings.

The harness pauses the viewer loop, disposes its dataset and renders only the test object. Each view uses four fixed camera angles, five warm-up draws per angle, and sixteen timed draws per angle: **64 GPU samples per reported distribution**. It waits for asynchronous `EXT_disjoint_timer_query_webgl2` results and fails on disjoint queries, GL errors or shader errors. Captures include a SHA-256 hash of the production assets. Runs are sequential, without simultaneous builds or tests.

Overview distance is 1.9 × grid size; close-up distance is 0.67 × grid size. Both use 45° vertical FOV, elevation 0.16 × distance, and angles 0.13, 0.53, 1.13 and 2.43 radians around the grid centre. The close-ups fill most or all of the target.

Sparse fixtures contain three separated small spheres in an otherwise empty, fully resident grid. Their radius is `floor(size / 24)`. The dense material fixture has deterministic 50% occupancy; essentially every 8³ brick contributes. The dense scalar fixture has a deterministic value in [0.25, 0.75] at every sample. Scalar opacity is **0.008**, with a **1024-sample maximum per ray**, so dense translucency traces deep into the data. The sampler uses fewer samples when the ray is shorter than that limit. This deliberately demanding setting differs from the earlier phantom's 256-sample limit and 0.08 opacity.

## Results

GPU p95 in milliseconds; lower is better.

| Grid | Fixture                  | Overview, before → after | Close-up, before → after |
| ---- | ------------------------ | -----------------------: | -----------------------: |
| 256³ | Sparse materials         |              7.23 → 2.34 |             16.57 → 4.97 |
| 256³ | 50% noisy materials      |              2.86 → 2.83 |              2.29 → 2.30 |
| 256³ | Sparse scalar            |              6.90 → 2.22 |             16.75 → 5.29 |
| 256³ | Dense translucent scalar |            46.78 → 39.07 |            76.99 → 59.70 |
| 512³ | Sparse materials         |             16.56 → 2.68 |             33.25 → 5.09 |
| 512³ | 50% noisy materials      |              3.41 → 3.40 |              2.50 → 2.43 |
| 512³ | Sparse scalar            |             12.35 → 2.57 |             32.02 → 6.60 |
| 512³ | Dense translucent scalar |          275.91 → 251.28 |          232.04 → 216.51 |

The 512³ sparse close-ups improve **6.53× for materials** and **4.85× for scalar data**. Dense material performance is effectively unchanged. Dense scalar rendering improves modestly at 512³ but remains **217–251 ms GPU p95**, despite the much better sparse results. At 256³ its close-up improves from 76.99 to 59.70 ms. **Full-resolution, deeply translucent, unskippable 512³ fields are not interactive on this GPU at these settings.** Paging alone would not remove that sample cost; this remains a separate rendering bottleneck.

The 512³ sparse repeats measured 5.19 ms for direct material close-ups and 6.67 ms for scalar close-ups, compared with 5.09 and 6.60 ms in the first final run. These are repeat checks, not confidence intervals. Fully resident memory remains about **514.5 MiB for 512³ materials** and **1026.5 MiB for 512³ scalar data**, excluding the caller's input and browser/driver overhead. The hierarchy improves traversal, not the whole-grid residency requirement.

## Scattered edits

After the timing runs, the harness writes two 4³ blocks at `[2,2,2]` and `[size-6,size-6,size-6]`, then renders. Both edits used to produce one nearly full-grid bounding box.

| Grid | Material bytes, before → after | Scalar bytes, before → after |
| ---- | -----------------------------: | ---------------------------: |
| 256³ |               32,006,016 → 256 |             64,012,032 → 512 |
| 512³ |              262,193,024 → 256 |            524,386,048 → 512 |

These are scalar/material texture bytes, excluding the small acceleration-map upload. The final implementation issues two subregion uploads. The measurements include one post-edit GPU draw, but do not constitute an update-latency distribution. Independent browser tests inspect actual `texSubImage3D` dimensions and verify both edited patches become visible while their neighbours stay unchanged.

## Correctness and repeatability

All **19 browser tests pass on AMD/Vulkan and SwiftShader**. Sparse material rays match an independent CPU reference that intersects occupied voxel boxes. Hierarchical scalar rendering matches the unaccelerated reference within one 8-bit channel value, including thin features, ragged edges, inside cameras, clipping, non-monotonic transfer functions, mode changes, low sample limits and edits. Six data tests include exhaustive skip-cube checks on small irregular grids and upload-coverage checks after exceeding the 32-region cap.

The original viewer workloads were checked again after these changes: 256³ porous materials measured **0.84 ms GPU p95** and the scalar phantom **7.56 ms GPU p95**, both with 16.7 ms frame-interval p95. Those use the earlier viewer resolution/settings and are regression checks, not the stress numbers above.

```sh
npm run build
URATH_BENCH_GPU=1 URATH_BENCH_LABEL=local npm run benchmark:stress
URATH_BENCH_GPU=1 URATH_STRESS_SIZE=512 URATH_BENCH_LABEL=large npm run benchmark:stress

# Select individual cases and resolution:
URATH_BENCH_GPU=1 URATH_STRESS_SIZE=512 URATH_STRESS_PIXELS=1024 \
  URATH_STRESS_CASES=voxel-sparse,volume-sparse \
  URATH_BENCH_LABEL=sparse npm run benchmark:stress
```

`URATH_STRESS_CASES` accepts `voxel-sparse`, `voxel-dense`, `volume-sparse`, and `volume-dense`. Grid sizes are 64, 128, 256 and 512. Set `URATH_BENCH_DIST` to a retained production build directory for comparisons. Inspect the GPU identity and `softwareGpu` flag; requesting hardware does not guarantee that Chromium selected it. Outputs are written to `artifacts/stress-<size>-<label>.json`.

Raw captures: [stress-256-before](benchmarks/stress-256-before.json), [stress-256-hierarchy](benchmarks/stress-256-hierarchy.json), [stress-256-dense-specialized](benchmarks/stress-256-dense-specialized.json), [stress-256-final](benchmarks/stress-256-final.json), [stress-512-before](benchmarks/stress-512-before.json), [stress-512-final](benchmarks/stress-512-final.json), [stress-512-repeat](benchmarks/stress-512-repeat.json), [stress-512-dense-before](benchmarks/stress-512-dense-before.json), [stress-512-dense-final](benchmarks/stress-512-dense-final.json), [browser-benchmark-256-stress-regression](benchmarks/browser-benchmark-256-stress-regression.json).
