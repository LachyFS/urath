import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { serveDirectory } from "./serve-directory.mjs";

// Capture the production renderer with its interface overlays hidden.
// Keep the actual geometry, colours, and camera; do not composite renders.
const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "docs/images");
await mkdir(destination, { recursive: true });
const server = await serveDirectory(resolve(root, "examples/demo/dist"));
const browser = await chromium.launch({
  headless: true,
  args:
    process.env.URATH_SCREENSHOT_SOFTWARE === "1"
      ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
      : ["--use-angle=vulkan", "--enable-gpu"],
});
const records = [];
try {
  for (const shot of [
    { name: "lab", dataset: "model", size: 64 },
    { name: "volume", dataset: "phantom", size: 128, mode: "volume" },
    { name: "terrain", dataset: "terrain", size: 128 },
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1060 },
      deviceScaleFactor: 1.5,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("404"))
        errors.push(message.text());
    });
    await page.goto(
      `${server.url}?test&dataset=${shot.dataset}&size=${shot.size}`,
    );
    await page.waitForFunction(
      () => document.getElementById("status").textContent === "Ready",
    );
    if (shot.mode) {
      await page.selectOption("#render-mode", shot.mode);
      await page.locator("#quality").fill("512");
      await page.locator("#quality").dispatchEvent("input");
      await page.locator("#opacity").fill("0.14");
      await page.locator("#opacity").dispatchEvent("input");
      await page.mouse.move(1050, 465);
      await page.mouse.wheel(0, -180);
    }
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector(".sidebar").scrollTop = 0;
      document.querySelector(".stage").scrollTop = 0;
    });
    await page.waitForFunction(
      () => document.getElementById("frame-p95").textContent !== "—",
    );
    // Only the viewport is captured. Captions and technical details belong in
    // the README, rather than over the rendered data.
    await page.addStyleTag({
      content: `
      .stage-top, .orientation, .renderer-badge { visibility: hidden !important; }
    `,
    });
    await page.waitForTimeout(500);
    if (errors.length) throw new Error(errors.join("\n"));
    const state = await page.evaluate(() => {
      const { renderer, current, camera } = window.urathTest;
      const gl = renderer.getContext(),
        debug = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        camera: camera.position.toArray(),
        resources: current.stats,
        mode: document.getElementById("render-mode").value,
        controls: Object.fromEntries(
          ["quality", "opacity", "threshold", "clip", "transfer"].map((id) => [
            id,
            document.getElementById(id).value,
          ]),
        ),
        gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unknown",
        glError: gl.getError(),
        userAgent: navigator.userAgent,
      };
    });
    if (state.glError) throw new Error(`WebGL error: ${state.glError}`);
    const path = resolve(destination, `${shot.name}.png`);
    await page.screenshot({
      path,
      clip: await page.locator("#viewport").boundingBox(),
    });
    records.push({
      ...shot,
      ...state,
      viewport: [1600, 1060],
      deviceScaleFactor: 1.5,
      capture: "viewport with interface overlays hidden",
    });
    console.log(`Captured ${path}`);
    await page.close();
  }
  await writeFile(
    resolve(destination, "captures.json"),
    JSON.stringify(records, null, 2) + "\n",
  );
} finally {
  await browser.close();
  await server.close();
}
