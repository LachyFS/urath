# README screenshots

These images are viewport captures from Urath's production performance lab. The capture script hides interface overlays and crops out the controls and metrics. Geometry, colours, lighting, and backgrounds remain real browser output; renders are not composited or retouched.

| Image         | Fixture              | Rendering                                 |
| ------------- | -------------------- | ----------------------------------------- |
| `lab.png`     | 64³ Strata model     | Rust/WASM greedy surface, viewport crop   |
| `terrain.png` | 128³ layered terrain | Greedy surface, viewport crop             |
| `volume.png`  | 128³ scalar phantom  | Volume, 512 maximum samples, 0.14 opacity |

The desktop viewport is 1600 × 1060 CSS pixels at device scale 1.5. Only the rendering area appears in the saved images. Scalar views are zoomed using the normal orbit controls. `captures.json` records the actual camera, settings, resource statistics, browser, and GPU. Use the benchmark reports for performance comparisons.

After installing dependencies and building:

```sh
npx playwright install chromium
npm run screenshots
```

Chromium uses the Vulkan backend by default. Set `URATH_SCREENSHOT_SOFTWARE=1` to use SwiftShader where hardware rendering is unavailable. Inspect the recorded GPU identity. The script saves images in this directory and fails on browser, shader, or GL errors.

The voxel mark is a repository-native SVG shared with the demo favicon.
