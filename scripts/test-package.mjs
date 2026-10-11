import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { serveDirectory } from "./serve-directory.mjs";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "urath-consumer-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let server, browser;
try {
  const output = execFileSync(
    npm,
    ["pack", "-w", "@urath/threejs", "--pack-destination", directory, "--json"],
    { cwd: root, encoding: "utf8" },
  );
  const packed = JSON.parse(output)[0];
  for (const file of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/worker.js",
    "dist/volume-transfer-cache.js",
    "wasm/urath_wasm.js",
    "wasm/urath_wasm_bg.wasm",
    "LICENSE",
    "README.md",
  ])
    assert(
      packed.files.some((f) => f.path === file),
      `Missing ${file} in archive`,
    );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@urath/threejs": `file:./${packed.filename}`,
          three: "0.172.0",
        },
        devDependencies: {
          vite: "6.4.1",
          typescript: "5.7.3",
          "@types/three": "0.172.0",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(directory, "vite.config.js"),
    "export default { base:'/nested/' };\n",
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["main.ts"],
    }),
  );
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><html><head><title>Urath packed consumer</title></head><body><div id="status">Loading</div><script type="module" src="./main.ts"></script></body></html>',
  );
  await writeFile(
    join(directory, "main.ts"),
    `
    import * as THREE from 'three';
    import {createSurface, createVolume, createVoxelRaycast, type SurfaceOptions} from '@urath/threejs';
    async function main() {
    const renderer=new THREE.WebGLRenderer({antialias:false});renderer.setSize(320,240);document.body.appendChild(renderer.domElement);
    renderer.domElement.addEventListener('webglcontextlost',()=>console.error('Consumer WebGL context lost'));
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(45,320/240,.1,100);
    camera.position.set(20,16,24);camera.lookAt(8,4,4);
    const options:SurfaceOptions={data:new Uint16Array(512).fill(1),dimensions:[8,8,8],chunkSize:8,workers:1};
    try {
      const surface=await createSurface(options);scene.add(surface);
      await surface.updateRegion({offset:[3,3,3],dimensions:[1,1,1],data:new Uint16Array([0])});
      const volume=createVolume(renderer,{data:new Uint8Array(512).fill(179),dimensions:[8,8,8],origin:[9,0,0],range:[0,255],transferCache:true});scene.add(volume);
      renderer.render(scene,camera);
      volume.updateRegion({offset:[0,0,0],dimensions:[1,1,1],data:new Float32Array([.5])});
      renderer.render(scene,camera);
      if(volume.stats.storage!=='float32'||volume.stats.transferCacheBuilds<2)throw new Error('Consumer volume storage/cache update failed');
      volume.setMode('isosurface');volume.setThreshold(128);
      const rays=createVoxelRaycast(renderer,{data:new Uint16Array(512).fill(2),dimensions:[8,8,8],origin:[0,9,0]});scene.add(rays);
      renderer.render(scene,camera);
      rays.updateRegion({offset:[0,0,0],dimensions:[1,1,1],data:new Uint16Array([3])});
      renderer.render(scene,camera);
      if(renderer.getContext().getError()!==0)throw new Error('Consumer WebGL error');
      const status=document.getElementById('status')!;status.textContent='Ready';status.dataset.triangles=String(surface.stats.triangles);status.dataset.volume=String(volume.stats.gpuBytes);
    }catch(error){document.getElementById('status')!.textContent=String(error);throw error;}
    }
    void main();
  `,
  );
  console.log(
    "Installing the packed archive in an independent consumer (no Rust build)…",
  );
  execFileSync(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: directory, stdio: "inherit" },
  );
  execFileSync(join(directory, "node_modules", ".bin", "tsc"), [], {
    cwd: directory,
    stdio: "inherit",
  });
  execFileSync(join(directory, "node_modules", ".bin", "vite"), ["build"], {
    cwd: directory,
    stdio: "inherit",
  });
  server = await serveDirectory(join(directory, "dist"), "/nested/");
  browser = await chromium.launch({
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(server.url);
  await page
    .waitForFunction(
      () => document.getElementById("status")?.textContent !== "Loading",
      null,
      { timeout: 35000 },
    )
    .catch((error) => {
      console.error("Consumer browser errors:", errors);
      throw error;
    });
  assert.equal(
    await page.locator("#status").textContent(),
    "Ready",
    JSON.stringify(errors),
  );
  assert(
    Number(await page.locator("#status").getAttribute("data-triangles")) > 12,
  );
  assert(Number(await page.locator("#status").getAttribute("data-volume")) > 0);
  // Ignore the browser's optional favicon request, but no script/shader errors.
  assert.deepEqual(
    errors.filter((e) => !e.includes("404 (Not Found)")),
    [],
  );
  const resources = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((e) => e.name),
  );
  assert(resources.some((url) => url.includes("/nested/assets/")));
  console.log(
    "Packed consumer passed: types, WASM, worker, update, volume, and /nested/ production assets.",
  );
  console.log(
    JSON.stringify({
      package: packed.filename,
      archiveBytes: packed.size,
      unpackedBytes: packed.unpackedSize,
    }),
  );
} finally {
  await browser?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
