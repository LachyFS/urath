import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { serveDirectory } from "./serve-directory.mjs";

const root = resolve(import.meta.dirname, "..");
const size = Number(process.env.URATH_BENCH_SIZE ?? 64);
const backend = process.env.URATH_BENCH_BACKEND ?? "mesh";
const datasets = (
  process.env.URATH_BENCH_DATASETS ?? "solid,multimaterial,phantom"
).split(",");
if (![32, 64, 128, 256].includes(size))
  throw new Error("URATH_BENCH_SIZE must be 32, 64, 128, or 256");
if (!["mesh", "raycast"].includes(backend))
  throw new Error("URATH_BENCH_BACKEND must be mesh or raycast");
if (
  datasets.some(
    (name) =>
      ![
        "solid",
        "multimaterial",
        "phantom",
        "porous",
        "model",
        "terrain",
      ].includes(name),
  )
)
  throw new Error("URATH_BENCH_DATASETS contains an unknown fixture");
await mkdir(resolve(root, "artifacts"), { recursive: true });
const server = await serveDirectory(resolve(root, "examples/demo/dist"));
const browser = await chromium.launch({
  headless: true,
  args:
    process.env.URATH_BENCH_GPU === "1"
      ? ["--use-angle=vulkan", "--enable-gpu"]
      : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const results = [];
  for (const dataset of datasets) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      const value = message.text();
      if (
        (message.type() === "error" && !value.includes("404 (Not Found)")) ||
        value.includes("WebGL: INVALID_")
      )
        browserErrors.push(value);
    });
    await page.goto(
      `${server.url}?test&size=${size}&dataset=${dataset}&backend=${backend}`,
    );
    await page.waitForFunction(
      () =>
        ["Ready", "Needs attention"].includes(
          document.getElementById("status").textContent,
        ),
      null,
      { timeout: 60000 },
    );
    const ready = await page.locator("#status").textContent();
    if (ready !== "Ready") {
      results.push({
        dataset,
        size,
        error: await page.locator("#error").textContent(),
      });
      await page.close();
      continue;
    }
    // Warm up shader compilation and the render loop before measuring steady state.
    await page.waitForTimeout(1000);
    await page.click("#edit");
    await page.waitForFunction(() => !document.getElementById("edit").disabled);
    await page.click("#benchmark");
    await page.waitForFunction(
      () => !document.getElementById("export").disabled,
      null,
      { timeout: 60000 },
    );
    const report = await page.evaluate(() => window.urathTest.report);
    if (browserErrors.length) {
      results.push({ dataset, size, error: browserErrors.join("; ") });
      await page.close();
      continue;
    }
    results.push(report);
    console.log(
      JSON.stringify({
        dataset,
        size,
        p95FrameMs: report.frameIntervalMs?.p95,
        p95GpuMs: report.gpuRenderMs?.p95,
        firstFrameMs: report.firstFrameMs,
        managedMiB: report.resources.managedBytes / 1048576,
        gpu: report.environment.gpu,
      }),
    );
    await page.close();
  }
  const suffix =
    process.env.URATH_BENCH_LABEL ??
    (process.env.URATH_BENCH_GPU === "1" ? "hardware" : "software");
  const output = resolve(
    root,
    `artifacts/browser-benchmark-${size}-${suffix}.json`,
  );
  await writeFile(output, JSON.stringify(results, null, 2) + "\n");
  console.log(`Saved ${output}`);
  const failures = results.filter((result) => result.error);
  if (failures.length) {
    console.error(JSON.stringify(failures));
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await server.close();
}
