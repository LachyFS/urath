# Dense-volume storage and shader experiments

Measured 11 October 2026 (Australia/Sydney). This round follows the [512³ stress experiments](performance-stress.md). It targets the remaining dense translucent workload, preserves input values, and measures preparation cost as well as steady-state GPU time. Measurements use the same AMD integrated GPU through ANGLE/Vulkan, Chromium 143.0.7499.4, and Three.js r172.

## Implemented changes

**Lossless native scalar storage is now the default.** Uint8 and Uint16 inputs keep their original representation in CPU memory and R8UI/R16UI GPU textures. Float32 inputs remain Float32. `storage: "float32"` explicitly selects the original four-byte representation. Integer updates widen storage when their values no longer fit; fractional or negative updates promote to Float32. Promotion checks the temporary allocation overlap before modifying data and performs a full texture upload. Ordinary edits retain regional uploads.

The viewer's raw importer also preserves these types. On little-endian hosts it transfers a typed view of the file buffer directly from its worker, avoiding the previous parse-and-convert copy. Its early memory check uses the actual sample width.

**An optional transfer-index cache reduces traffic for Float32 data.** `transferCache: true` creates one GPU byte per voxel holding the current transfer-table lookup index. Original scalar samples remain intact. A GPU preparation pass builds the cache; regional edits update only dirty regions. Changing the scalar range rebuilds it, while changing transfer colours or opacity does not. Direct rendering and cache preparation share the same explicit table-index calculation. Isosurfaces always use raw scalar values.

The cache is **off by default**: its extra memory, startup work and view-dependent benefits need an explicit choice. It is included in memory-budget checks and its work has separate counters. It also retains no duplicate CPU index array.

Integer texel coordinates now select scalar cells consistently across texture formats. The software renderer exposed differences between normalized texture sampling paths, which were visible with alternating transfer-table colours. Tests cover these cases. The cache restores viewport/scissor state around its preparation pass and rebuilds after context restoration. Owned GPU resources are released on context loss to avoid stale Three.js r172 disposal handles. Camera-ray setup also reuses its helper instead of allocating one per draw, and setting an unchanged range/mode avoids redundant work.

## Method and results

Every final run uses **512³ = 134,217,728 samples**, a **1024 × 1024 target**, **1024 maximum samples per ray**, and **0.008 opacity**. The four overview and four close-up camera positions, warm-up and 64 GPU samples per view match the [stress methodology](performance-stress.md). All runs are sequential with no concurrent builds or tests. No resolution or sample limit was lowered.

Each native-storage comparison uses exactly the same integer dataset for both paths. `storage: "float32"` converts those integers exactly, so the comparison changes storage rather than source values. Uint8, Uint16 and arbitrary Float32 fixtures are separate datasets and should not be compared as identical images.

| Input   | Storage                  | Managed MiB | Overview GPU p95, ms | Close-up GPU p95, ms | CPU construction, ms | First-draw wall, ms |
| ------- | ------------------------ | ----------: | -------------------: | -------------------: | -------------------: | ------------------: |
| Uint8   | Float32 reference        |     1026.54 |               259.53 |               212.66 |                393.5 |               264.8 |
| Uint8   | Native R8UI              |      258.54 |               246.85 |               143.46 |                276.4 |               182.5 |
| Uint16  | Float32 reference        |     1026.54 |               257.40 |               212.93 |                403.6 |               278.5 |
| Uint16  | Native R16UI             |      514.54 |               191.42 |               140.14 |                309.3 |               176.5 |
| Float32 | Direct R32F              |     1026.54 |               257.79 |               212.29 |                381.8 |               270.5 |
| Float32 | R32F + R8 transfer cache |     1154.54 |               249.40 |               137.86 |                385.1 |               296.6 |

Native Uint8 reduces close-up GPU p95 by **32.5%**, and native Uint16 by **34.2%**. Scalar-buffer memory drops by **75% and 50%**, respectively; the table also includes the unchanged acceleration and fixed buffer estimates. Managed memory excludes the caller's source array and browser/driver overhead.

The Float32 cache reduces close-up GPU p95 by **35.1%**, but overview p95 improves only **3.3%**. It adds **128 MiB** at 512³ and increases the observed first-draw wall time by **26.1 ms**. These camera-dependent results support an explicit option rather than enabling it for every volume.

Two distant 4³ edits upload **128 bytes for Uint8**, **256 for Uint16**, or **512 for Float32**, in two regions. The cached run redraws only those 128 index voxels after its initial full preparation; its counters record two cache builds and 134,217,856 total updated voxels.

Construction is CPU preparation only. First-draw wall time includes shader compilation, initial GPU uploads, optional cache preparation, rendering and waiting for its GPU query; it excludes dataset generation. This is a single cold observation per run, not a latency distribution. GPU p95 values come from warmed draws.

The added cache remains an opt-in tradeoff. Dense translucent rendering at this resolution is still far from a 16.7 ms frame budget on this GPU. Empty-space skipping helps sparse data; it cannot eliminate the work of integrating a deeply translucent field that contributes everywhere.

Regression runs retain the earlier fast paths: 512³ close-up GPU p95 is **5.15 ms for sparse materials**, **2.51 ms for 50% noisy opaque materials**, and **6.82 ms for sparse scalar data**. The original 256³ viewer workloads measure **0.98 ms for porous materials** and **7.37 ms for the scalar phantom**, with frame-interval p95 of 16.7 and 16.8 ms. Viewer resolution and quality differ from the stress target, as described in the earlier reports.

## Experiments that did not justify a fast path

Short exploratory runs used four timed draws per camera (16 per view), rather than the final 64. Explicit LOD sampling, a uniform-array colour table, and reading Float32 bit patterns through R32UI did not materially improve the original dense Float32 path. Integer texel fetches were ultimately retained for consistent sample selection across formats, rather than a general speed claim. The original untyped Float32 overview had about 251 ms GPU p95; explicit cell selection initially measured about 267 ms, while the close-up stayed around 213–217 ms. Correctness takes priority over this view-dependent difference.

A constant-scalar diagnostic removed the large texture read and changed the rendered image. It helped locate cost but is **not an optimization or quality-preserving benchmark**. Likewise, the first transfer-cache experiment was not shipped unchanged: software-renderer tests caught boundary rounding and coordinate-selection differences. A raw-scalar fallback fixed those images but regressed close-up GPU p95 to 348 ms and was rejected. The final implementation uses explicit cell selection and the same integer table-index calculation in both shaders; its final timing is reported separately.

## Correctness and package checks

- 26 browser tests pass on AMD/Vulkan and SwiftShader, including native storage against a Float32 reference, both rendering modes, edits, precision-preserving promotion and budget rejection before mutation.
- Cached rendering matches the uncached reference within one 8-bit channel value across data types, non-monotonic transfer tables, lookup boundaries, ranges, clipping, mode changes and partial edits.
- A separate test checks both adjacent Float32 values around all 255 table boundaries across four scalar windows, including a narrow window around 10²⁰, with sharply alternating colours.
- Tests check real GPU context loss/restoration and a manually configured render-target viewport/scissor at device pixel ratio two.
- The raw-import test checks numerical values and preserved storage for Uint8, Uint16 and Float32 files, alongside non-cubic dimensions and invalid byte lengths.
- Six data and acceleration tests pass. The independent packaged consumer exercises native storage, GPU cache preparation, promotion, WASM workers and production assets under a URL subpath.

## Reproduce

```sh
npm run build

# Uint8 input: reference versus native default.
URATH_BENCH_GPU=1 URATH_STRESS_SIZE=512 URATH_STRESS_CASES=volume-dense \
  URATH_STRESS_INPUT=uint8 URATH_STRESS_FORCE_FLOAT=1 \
  URATH_BENCH_LABEL=u8-reference npm run benchmark:stress
URATH_BENCH_GPU=1 URATH_STRESS_SIZE=512 URATH_STRESS_CASES=volume-dense \
  URATH_STRESS_INPUT=uint8 URATH_BENCH_LABEL=u8-native npm run benchmark:stress

# Float32 source with optional GPU transfer-index caching.
URATH_BENCH_GPU=1 URATH_STRESS_SIZE=512 URATH_STRESS_CASES=volume-dense \
  URATH_STRESS_CACHE=1 URATH_BENCH_LABEL=float-cache npm run benchmark:stress
```

`URATH_STRESS_INPUT` accepts `float32`, `uint8`, or `uint16`. `URATH_STRESS_SAMPLES` controls timed draws per camera and defaults to 16. The JSON records input type, chosen storage, cache setting, asset hash, GPU identity, preparation costs, upload counters and managed memory. Shader diagnostic switches are experimental instrumentation, not package API or production defaults.

Final raw captures: [Uint8 reference](benchmarks/stress-512-storage-u8-reference.json), [Uint8 native](benchmarks/stress-512-storage-u8-native.json), [Uint16 reference](benchmarks/stress-512-storage-u16-reference.json), [Uint16 native](benchmarks/stress-512-storage-u16-native.json), [Float32 direct](benchmarks/stress-512-storage-f32-reference.json), [Float32 cached](benchmarks/stress-512-storage-f32-cache.json).

Regression captures: [512³ sparse and opaque stress](benchmarks/stress-512-storage-regression.json), [256³ viewer orbit](benchmarks/browser-benchmark-256-storage-regression.json).

Exploratory captures: [explicit LOD](benchmarks/stress-512-lod-experiment.json), [texel fetch](benchmarks/stress-512-fetch-experiment.json), [uniform colour table](benchmarks/stress-512-uniform-experiment.json), [Float32 bit patterns](benchmarks/stress-512-f32-bits-experiment.json), [constant-scalar diagnostic, changed image](benchmarks/stress-512-constant-diagnostic.json), [rejected raw-fallback cache](benchmarks/stress-512-cache-rejected-fallback.json). These use earlier candidate shaders and are not the final package's performance.
