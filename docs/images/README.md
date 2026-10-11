# README screenshots

These images are captured from Urath's production performance lab. The UI, geometry, colours, and measurements are real browser output; the capture script does not replace metric text or composite renders.

| Image         | Fixture              | Rendering                                 |
| ------------- | -------------------- | ----------------------------------------- |
| `lab.png`     | 64³ Strata model     | Full interface, Rust/WASM greedy surface  |
| `terrain.png` | 128³ layered terrain | Greedy surface, viewport crop             |
| `volume.png`  | 128³ scalar phantom  | Volume, 512 maximum samples, 0.14 opacity |

The desktop viewport is 1600 × 1060 CSS pixels at device scale 1.5. Scalar views are zoomed using the normal orbit controls. `captures.json` records the actual camera, settings, resource statistics, browser, and GPU. Timing values visible in the full screenshot describe that capture session; use the benchmark reports for comparisons.

After installing dependencies and building:

```sh
npx playwright install chromium
npm run screenshots
```

Chromium uses the Vulkan backend by default. Set `URATH_SCREENSHOT_SOFTWARE=1` to use SwiftShader where hardware rendering is unavailable. Inspect the recorded GPU identity. The script saves images in this directory and fails on browser, shader, or GL errors.

The voxel mark is a repository-native SVG shared with the demo favicon.
