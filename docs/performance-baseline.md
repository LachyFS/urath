# Browser measurements for the first library preview

**Historical baseline.** The rendering paths have since been optimized; see [current measurements](performance.md). Limitations described below refer to the initial implementation.

Measured 2026-10-10 using the production performance viewer and its public package API.

These are **software-renderer smoke measurements**, not hardware GPU performance claims. The browser was Headless Chromium 143.0.7499.4 on Linux, using ANGLE / SwiftShader, reporting 16 logical processors. Three.js r172 rendered a 980 × 584 pixel canvas at pixel ratio 1. The surface path used 16³ chunks and two workers; volume rays were capped at 256 samples. Each measurement used the same 10-second orbit after a warm-up and one regional edit.

| Grid | Fixture | First displayed frame (ms) | Frame interval p95 (ms) | Managed buffers (MiB) | Update to visible (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| 64³ | Solid material | 119.9 | 16.7 | 13.6 | 45.8 |
| 64³ | Alternating materials | 66.7 | 16.7 | 20.5 | 45.6 |
| 64³ | Scalar phantom | 46.5 | 50.1 | 2.0 | 91.9 |
| 256³ | Solid material | 394.0 | 16.8 | 45.6 | 44.9 |
| 256³ | Alternating materials | 408.3 | 183.3 | 156.0 | 173.3 |
| 256³ | Scalar phantom | 510.2 | 166.7 | 128.0 | 685.1 |

A 256³ grid contains 16,777,216 samples. All three fixtures loaded and completed their updates and captures within the configured 256 MiB managed-buffer budget. The noisy/fragmented surface stress test separately verifies that a too-small budget rejects and disposes the load.

The material-heavy surface and volume fixtures are slow under this software renderer. The preview does not establish fast rendering for every dense dataset. The difference between the two solid fixtures confirms that material boundaries and resulting geometry matter as well as input size. The volume update includes a full texture upload, which is an explicit limitation of the prototype.

## Reproduce

```sh
npm ci
npm run build
npx playwright install chromium
npm run benchmark
URATH_BENCH_SIZE=256 npm run benchmark
```

The commands write `artifacts/browser-benchmark-64.json` and `artifacts/browser-benchmark-256.json`, including settings, seed, applied edit, camera path, sample counts, optional GPU timings, and browser/device information. Set `URATH_BENCH_GPU=1` to try the browser's default GPU selection, then check the renderer actually reported. For hardware comparisons, run the interactive viewer on the target device with identical settings and export its JSON.

First-frame timing includes data preparation, initial meshing/upload, and two animation frames. Update latency includes the edit/remesh or upload plus two animation frames. Frame intervals measure actual animation-frame timestamps; CPU submission timings and optional GPU timer queries are separate. Managed memory includes estimated GPU storage and conservative worker reservations, but excludes browser/driver overhead, caller-owned arrays, and GC timing. Results are individual runs, without confidence intervals or a competitive renderer comparison.

## Verification accompanying these measurements

- 75 Rust tests; formatting and Clippy with warnings denied.
- Four data-layout and regional-update tests.
- Eleven browser tests covering real WASM workers, border culling, stale results, disposal, budget failure, volume pixels, clipping, scalar thresholds, camera types, raw imports, benchmark export, and narrow-screen layout.
- An independent consumer installs the packed archive, type-checks the public API, builds with Vite, and renders both paths under `/nested/` without a Rust build in the consumer.
- Native greedy-mesher benchmarks complete for empty, solid, surface, and noisy fixtures. They are not used as browser rendering claims.

Next performance decisions should follow measurements on target hardware: compare surface geometry with a material-texture or direct-voxel approach for highly varied colours, and profile bricked uploads / empty-space skipping for volumes. Those are future optimisations, not implemented features of this preview.
