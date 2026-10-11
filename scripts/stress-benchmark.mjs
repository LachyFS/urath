import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { serveDirectory } from "./serve-directory.mjs";

// Fixed offscreen resolution, explicit GPU queries, deterministic camera positions.
// The viewer loop is paused: no competing draws or timer queries from the UI.
const root = resolve(import.meta.dirname, "..");
const size = Number(process.env.URATH_STRESS_SIZE ?? 256);
const pixels = Number(process.env.URATH_STRESS_PIXELS ?? 1024);
const samples = Number(process.env.URATH_STRESS_SAMPLES ?? 16);
const shaderVariant = process.env.URATH_STRESS_SHADER ?? "production";
const inputType = process.env.URATH_STRESS_INPUT ?? "float32";
const forceFloat32 = process.env.URATH_STRESS_FORCE_FLOAT === "1";
const transferCache = process.env.URATH_STRESS_CACHE === "1";
if (transferCache && shaderVariant !== "production")
  throw new Error(
    "Shader diagnostics require the transfer cache to be disabled",
  );
if (shaderVariant === "float-bits" && inputType !== "float32")
  throw new Error("Float-bits experiment requires Float32 input");
if (!["float32", "uint8", "uint16"].includes(inputType))
  throw new Error("Invalid scalar input type");
if (!Number.isInteger(samples) || samples < 4 || samples > 128)
  throw new Error("Stress samples must be 4..128");
if (
  ![
    "production",
    "explicit-lod",
    "texel-fetch",
    "uniform-transfer",
    "constant-scalar",
    "float-bits",
  ].includes(shaderVariant)
)
  throw new Error("Unknown shader experiment");
const fixtures = (
  process.env.URATH_STRESS_CASES ??
  "voxel-sparse,voxel-dense,volume-sparse,volume-dense"
).split(",");
if (![64, 128, 256, 512].includes(size))
  throw new Error("Invalid stress grid size");
if (!Number.isInteger(pixels) || pixels < 64 || pixels > 2048)
  throw new Error("Stress target must be 64..2048 pixels square");
if (fixtures.some((f) => !/^(voxel|volume)-(sparse|dense)$/.test(f)))
  throw new Error("Unknown stress fixture");
const dist = resolve(
  root,
  process.env.URATH_BENCH_DIST ?? "examples/demo/dist",
);
const hash = createHash("sha256");
for (const file of (await readdir(resolve(dist, "assets"))).sort())
  hash.update(await readFile(resolve(dist, "assets", file)));
const server = await serveDirectory(dist);
const browser = await chromium.launch({
  headless: true,
  args:
    process.env.URATH_BENCH_GPU === "1"
      ? ["--use-angle=vulkan", "--enable-gpu"]
      : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const results = [];
try {
  for (const fixture of fixtures) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        (message.type() === "error" &&
          !message.text().includes("404 (Not Found)")) ||
        message.text().includes("WebGL: INVALID_")
      )
        errors.push(message.text());
    });
    await page.goto(`${server.url}?test&size=32&backend=raycast`);
    await page.waitForFunction(() => window.urathTest?.current);
    const result = await page.evaluate(
      async ({
        fixture,
        n,
        pixels,
        samples,
        shaderVariant,
        inputType,
        forceFloat32,
        transferCache,
      }) => {
        const api = window.urathTest;
        api.pauseRendering();
        api.current.dispose();
        const { renderer, THREE } = api;
        const gl = renderer.getContext();
        const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
        if (!ext)
          throw new Error("GPU timer queries are required for this benchmark");
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        const scalar = fixture.startsWith("volume");
        const sparse = fixture.endsWith("sparse");
        const scalarScale =
          inputType === "uint8" ? 255 : inputType === "uint16" ? 65535 : 1;
        const ScalarType =
          inputType === "uint8"
            ? Uint8Array
            : inputType === "uint16"
              ? Uint16Array
              : Float32Array;
        const data = scalar ? new ScalarType(n ** 3) : new Uint16Array(n ** 3);
        if (sparse) {
          // Three small separated components: most rays miss, many cross long empty spans.
          for (const [cx, cy, cz] of [
            [0.25, 0.25, 0.25],
            [0.72, 0.7, 0.7],
            [0.48, 0.54, 0.45],
          ]) {
            const r = Math.floor(n / 24);
            const center = [cx, cy, cz].map((v) => Math.floor(v * n));
            for (let z = -r; z <= r; z++)
              for (let y = -r; y <= r; y++)
                for (let x = -r; x <= r; x++) {
                  if (x * x + y * y + z * z <= r * r)
                    data[
                      center[0] + x + n * (center[1] + y + n * (center[2] + z))
                    ] = scalar ? 0.8 * scalarScale : 1;
                }
          }
        } else {
          let seed = 123456789;
          for (let i = 0; i < data.length; i++) {
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            data[i] = scalar
              ? (0.25 + ((seed >>> 0) / 4294967296) * 0.5) * scalarScale
              : (seed >>> 0) % 2;
          }
        }
        const start = performance.now();
        const object = scalar
          ? api.createVolume(renderer, {
              data,
              dimensions: [n, n, n],
              range: [0, scalarScale],
              storage: forceFloat32 ? "float32" : "auto",
              transferCache,
              opacity: 0.008,
              maxSteps: 1024,
              maxMemoryBytes: 1536 * 1048576,
            })
          : api.createVoxelRaycast(renderer, {
              data,
              dimensions: [n, n, n],
              maxMemoryBytes: 1536 * 1048576,
            });
        const constructionMs = performance.now() - start;
        if (scalar && shaderVariant !== "production") {
          let shader = object.material.fragmentShader;
          const implicitFetch = "texture(scalarData, clamp(p, 0.0, 1.0))";
          const sourceFetch = shader.includes(implicitFetch)
            ? implicitFetch
            : "texelFetch(scalarData, scalarCell(p), 0)";
          if (shaderVariant === "float-bits") {
            // Same 32 bits per sample, read through the integer texture path.
            for (const texture of [
              object.material.uniforms.scalarData.value,
              object.uploadSource,
            ]) {
              const source = texture.image.data;
              texture.image.data = new Uint32Array(
                source.buffer,
                source.byteOffset,
                source.length,
              );
              texture.format = 1029;
              texture.type = 1014;
              texture.internalFormat = "R32UI";
            }
            object.material.defines.URATH_INTEGER_SCALAR = 1;
            shader = shader.replace(
              `${sourceFetch}.r`,
              `uintBitsToFloat(${sourceFetch}.r)`,
            );
          }
          if (shaderVariant === "explicit-lod")
            shader = shader.replace(
              sourceFetch,
              "textureLod(scalarData, clamp(p, 0.0, 1.0), 0.0)",
            );
          if (shaderVariant === "texel-fetch")
            shader = shader.replace(
              sourceFetch,
              "texelFetch(scalarData, ivec3(clamp(p * dimensions, vec3(0.0), dimensions - 1.0)), 0)",
            );
          if (shaderVariant === "uniform-transfer") {
            shader = shader.replace(
              "uniform sampler2D transferData;",
              "uniform vec4 transferValues[256];",
            );
            shader = shader.replace(
              "texture2D(transferData, vec2((t * 255.0 + 0.5) / 256.0, 0.5))",
              "transferValues[int(floor(t * 255.0 + 0.5))]",
            );
            shader = shader.replace(
              "texelFetch(transferData, ivec2(transferIndex(value), 0), 0)",
              "transferValues[transferIndex(value)]",
            );
            object.material.uniforms.transferValues = {
              value: Float32Array.from(
                object.material.uniforms.transferData.value.image.data,
                (v) => v / 255,
              ),
            };
          }
          // Diagnostic only: removes the large-volume texture fetch and changes the image.
          if (shaderVariant === "constant-scalar")
            shader = shader.replace(
              "float value = scalar(p);",
              "float value = 0.5;",
            );
          if (shader === object.material.fragmentShader)
            throw new Error("Experiment did not change the shader");
          object.material.fragmentShader = shader;
          object.material.needsUpdate = true;
        }
        const scene = new THREE.Scene();
        scene.add(object);
        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, n * 10);
        const target = new THREE.WebGLRenderTarget(pixels, pixels);
        renderer.setRenderTarget(target);
        renderer.setClearColor(0, 0);
        const distribution = (values) => {
          const a = [...values].sort((a, b) => a - b);
          return {
            count: a.length,
            p50: a[Math.ceil(a.length * 0.5) - 1],
            p95: a[Math.ceil(a.length * 0.95) - 1],
            max: a.at(-1),
          };
        };
        const frame = () =>
          new Promise((resolve) => requestAnimationFrame(resolve));
        let firstDraw = null;
        const queryDraw = async () => {
          const wallStart = performance.now();
          const q = gl.createQuery();
          gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
          renderer.render(scene, camera);
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          gl.flush();
          const began = performance.now();
          while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
            if (performance.now() - began > 15000)
              throw new Error("GPU query timed out");
            await frame();
          }
          const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
          const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
          gl.deleteQuery(q);
          if (disjoint)
            throw new Error("Disjoint GPU measurement; rerun the benchmark");
          if (firstDraw === null)
            firstDraw = { gpuMs: ms, wallMs: performance.now() - wallStart };
          return ms;
        };
        const views = [];
        for (const close of [false, true]) {
          const times = [];
          for (const angle of [0.13, 0.53, 1.13, 2.43]) {
            const distance = n * (close ? 0.67 : 1.9);
            camera.position.set(
              n / 2 + Math.sin(angle) * distance,
              n / 2 + distance * 0.16,
              n / 2 + Math.cos(angle) * distance,
            );
            camera.lookAt(n / 2, n / 2, n / 2);
            for (let i = 0; i < 5; i++) await queryDraw();
            for (let i = 0; i < samples; i++) times.push(await queryDraw());
          }
          views.push({
            view: close ? "close" : "overview",
            gpuMs: distribution(times),
          });
        }
        const before = object.stats;
        const updateStart = performance.now();
        for (const offset of [
          [2, 2, 2],
          [n - 6, n - 6, n - 6],
        ])
          object.updateRegion({
            offset,
            dimensions: [4, 4, 4],
            data: scalar
              ? new Float32Array(64).fill(
                  inputType === "float32" ? 0.9 : Math.floor(0.9 * scalarScale),
                )
              : new Uint16Array(64).fill(2),
          });
        const updateCpuMs = performance.now() - updateStart;
        const updateGpuMs = await queryDraw();
        const after = object.stats;
        const gpu = debug
          ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          : "unknown";
        const result = {
          fixture,
          shaderVariant,
          inputType: scalar ? inputType : "uint16",
          forceFloat32,
          transferCache,
          size: n,
          pixels,
          samplesPerRay: scalar ? 1024 : null,
          opacity: scalar ? 0.008 : null,
          constructionMs,
          firstDraw,
          views,
          scatteredEdit: {
            updateCpuMs,
            renderGpuMs: updateGpuMs,
            uploadedBytes: after.uploadedBytes - before.uploadedBytes,
            regionUploads: after.regionUploads - before.regionUploads,
          },
          resources: after,
          gpu,
          softwareGpu: /swiftshader|llvmpipe|software/i.test(gpu),
          glError: gl.getError(),
          userAgent: navigator.userAgent,
        };
        renderer.setRenderTarget(null);
        object.dispose();
        target.dispose();
        return result;
      },
      {
        fixture,
        n: size,
        pixels,
        samples,
        shaderVariant,
        inputType,
        forceFloat32,
        transferCache,
      },
    );
    if (errors.length || result.glError)
      throw new Error(JSON.stringify({ errors, glError: result.glError }));
    results.push(result);
    console.log(JSON.stringify(result));
    await page.close();
  }
  await mkdir(resolve(root, "artifacts"), { recursive: true });
  const output = resolve(
    root,
    `artifacts/stress-${size}-${process.env.URATH_BENCH_LABEL ?? "latest"}.json`,
  );
  await writeFile(
    output,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        buildSha256: hash.digest("hex"),
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Saved ${output}`);
} finally {
  await browser.close();
  await server.close();
}
