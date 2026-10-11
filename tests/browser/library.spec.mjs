import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/?test&size=32&dataset=solid");
  await expect(page.locator("#status")).toHaveText("Ready");
});

test("viewer keeps the canvas and both metric columns within a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => (await page.locator("#viewport").boundingBox()).width)
    .toBeLessThanOrEqual(390);
  for (const locator of [
    page.locator("#viewport"),
    page.locator(".metrics > div").nth(1),
    page.locator(".metrics > div").nth(3),
  ]) {
    const bounds = await locator.boundingBox();
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  }
});

test("production build loads WASM and workers and supports an incremental edit", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createSurface } = window.urathTest;
    const source = new Uint16Array(16 * 8 * 8).fill(5);
    const surface = await createSurface({
      data: source,
      dimensions: [16, 8, 8],
      chunkSize: 8,
      workers: 1,
    });
    const before = surface.stats;
    await surface.updateRegion({
      offset: [3, 3, 3],
      dimensions: [1, 1, 1],
      data: new Uint16Array([0]),
    });
    const after = surface.stats;
    const unchanged = source.every((value) => value === 5);
    surface.dispose();
    return { before, after, unchanged, disposed: surface.stats };
  });
  expect(result.before.triangles).toBe(20);
  expect(result.after.meshJobs - result.before.meshJobs).toBe(1);
  expect(result.after.triangles).toBeGreaterThan(result.before.triangles);
  expect(result.unchanged).toBe(true);
  expect(result.disposed.managedBytes).toBe(0);
  expect(result.disposed.workers).toBe(0);
});

test("rapid updates coalesce and stale worker results cannot overwrite the latest edit", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const s = await window.urathTest.createSurface({
      data: new Uint16Array(512),
      dimensions: [8, 8, 8],
      chunkSize: 8,
      workers: 2,
    });
    const update = (value) =>
      s.updateRegion({
        offset: [0, 0, 0],
        dimensions: [8, 8, 8],
        data: new Uint16Array(512).fill(value),
      });
    await Promise.all([update(1), update(0), update(2)]);
    const stats = s.stats;
    const { THREE, renderer } = window.urathTest;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(4, 4, 20);
    camera.lookAt(4, 4, 4);
    scene.add(s);
    renderer.render(scene, camera);
    const id = s.children[0].material.uniforms.materialId.value;
    s.dispose();
    return { stats, id };
  });
  expect(result.stats.triangles).toBe(12);
  expect(result.stats.discardedJobs).toBeGreaterThan(0);
  expect(result.id).toBe(2);
  expect(result.stats.activeJobs).toBe(0);
});

test("disposal rejects pending updates and is idempotent", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const s = await window.urathTest.createSurface({
      data: new Uint16Array(512),
      dimensions: [8, 8, 8],
      chunkSize: 8,
      workers: 1,
    });
    const pending = s
      .updateRegion({
        offset: [0, 0, 0],
        dimensions: [8, 8, 8],
        data: new Uint16Array(512).fill(1),
      })
      .then(
        () => false,
        (error) => error.message,
      );
    s.dispose();
    s.dispose();
    return {
      rejected: await pending,
      stats: s.stats,
      children: s.children.length,
    };
  });
  expect(result.rejected).toContain("disposed");
  expect(result.children).toBe(0);
  expect(result.stats.managedBytes).toBe(0);
});

test("worker startup failure rejects and an aborted load releases its workers", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createSurface } = window.urathTest;
    const options = {
      data: new Uint16Array(512),
      dimensions: [8, 8, 8],
      chunkSize: 8,
      workers: 1,
    };
    const failure = await createSurface({
      ...options,
      workerUrl: "/missing-worker.js",
    }).then(
      () => false,
      (error) => error.message,
    );
    const controller = new AbortController();
    const promise = createSurface({
      ...options,
      signal: controller.signal,
    }).then(
      () => false,
      (error) => error.message,
    );
    controller.abort();
    return { failure, aborted: await promise };
  });
  expect(result.failure).toContain("worker");
  expect(result.aborted).toContain("aborted");
});

test("complex geometry stops at the configured managed-buffer budget", async ({
  page,
}) => {
  const error = await page.evaluate(async () => {
    const data = new Uint16Array(32 ** 3);
    for (let z = 0; z < 32; z++)
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++)
          data[x + 32 * (y + 32 * z)] = (x + y + z) % 2 === 0 ? 1 : 0;
    return window.urathTest
      .createSurface({
        data,
        dimensions: [32, 32, 32],
        chunkSize: 8,
        workers: 1,
        maxMemoryBytes: 4 * 1048576,
      })
      .then(
        (s) => {
          s.dispose();
          return "unexpected success";
        },
        (error) => error.message,
      );
  });
  expect(error).toContain("memory budget");
});

test("volume shader renders scalar values, clipping changes opacity, and isosurface threshold changes visibility", async ({
  page,
}) => {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const result = await page.evaluate(() => {
    const { THREE, renderer, createVolume } = window.urathTest;
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(4, 4, 20);
    camera.lookAt(4, 4, 4);
    camera.updateMatrixWorld();
    const source = new Float32Array(8 * 4 * 2).fill(0.5);
    const volume = createVolume(renderer, {
      data: source,
      dimensions: [8, 4, 2],
      spacing: [1, 2, 4],
      range: [0, 1],
      opacity: 0.3,
    });
    scene.add(volume);
    const target = new THREE.WebGLRenderTarget(48, 48),
      pixels = new Uint8Array(48 * 48 * 4);
    const read = () => {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0, 0);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, 48, 48, pixels);
      renderer.setRenderTarget(null);
      return pixels.reduce((sum, v, i) => sum + (i % 4 === 3 ? v : 0), 0);
    };
    const full = read();
    volume.setClip([0, 0, 0], [1, 1, 0.2]);
    const clipped = read();
    volume.setClip([0, 0, 0], [1, 1, 1]);
    volume.setMode("isosurface");
    volume.setThreshold(0.8);
    const hidden = read();
    volume.setThreshold(0.2);
    const visible = read();
    volume.updateRegion({
      offset: [0, 0, 0],
      dimensions: [8, 4, 2],
      data: new Float32Array(64),
    });
    const empty = read();
    const scale = volume.scale.toArray();
    volume.dispose();
    target.dispose();
    return {
      full,
      clipped,
      hidden,
      visible,
      empty,
      scale,
      sourceUntouched: source.every((v) => v === 0.5),
      stats: volume.stats,
    };
  });
  expect(errors).toEqual([]);
  expect(result.full).toBeGreaterThan(0);
  expect(result.clipped).toBeLessThan(result.full);
  expect(result.hidden).toBe(0);
  expect(result.visible).toBeGreaterThan(0);
  expect(result.empty).toBe(0);
  expect(result.scale).toEqual([8, 8, 8]);
  expect(result.sourceUntouched).toBe(true);
  expect(result.stats.managedBytes).toBe(0);
});

test("volume rejects nonfinite samples, invalid metadata and oversized allocations", async ({
  page,
}) => {
  const errors = await page.evaluate(() => {
    const { renderer, createVolume } = window.urathTest,
      results = [];
    for (const options of [
      { data: new Float32Array([NaN]), dimensions: [1, 1, 1] },
      { data: new Float32Array(8), dimensions: [2, 2, 2], maxMemoryBytes: 1 },
      { data: new Float32Array(8), dimensions: [2, 2, 2], range: [1, 1] },
      { data: new Float32Array(8), dimensions: [2, 2, 2], clipMin: [1, 0, 0] },
    ]) {
      try {
        createVolume(renderer, options).dispose();
        results.push("unexpected success");
      } catch (e) {
        results.push(e.message);
      }
    }
    return results;
  });
  expect(errors[0]).toContain("finite");
  expect(errors[1]).toContain("budget");
  expect(errors[2]).toContain("range");
  expect(errors[3]).toContain("clip");
});

test("volume supports orthographic cameras, including a view from inside the data", async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const { THREE, renderer, createVolume } = window.urathTest;
    const scene = new THREE.Scene();
    const volume = createVolume(renderer, {
      data: new Float32Array(8 ** 3).fill(0.8),
      dimensions: [8, 8, 8],
      range: [0, 1],
      opacity: 0.5,
    });
    scene.add(volume);
    const target = new THREE.WebGLRenderTarget(32, 32),
      pixels = new Uint8Array(32 * 32 * 4);
    const read = (camera) => {
      camera.updateMatrixWorld();
      renderer.setRenderTarget(target);
      renderer.setClearColor(0, 0);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, 32, 32, pixels);
      renderer.setRenderTarget(null);
      return pixels.reduce((sum, v, i) => sum + (i % 4 === 3 ? v : 0), 0);
    };
    const ortho = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 50);
    ortho.position.set(4, 4, 20);
    ortho.lookAt(4, 4, 4);
    const outside = read(ortho);
    const insideCamera = new THREE.PerspectiveCamera(60, 1, 0.01, 50);
    insideCamera.position.set(4, 4, 4);
    insideCamera.lookAt(4, 4, 0);
    const inside = read(insideCamera);
    volume.dispose();
    target.dispose();
    return { outside, inside };
  });
  expect(result.outside).toBeGreaterThan(0);
  expect(result.inside).toBeGreaterThan(0);
});

test("viewer switches modes, captures real frame intervals and exports a report", async ({
  page,
}) => {
  await page.selectOption("#render-mode", "volume");
  await expect(page.locator("#status")).toHaveText("Ready");
  await expect(page.locator("#volume-controls")).toBeVisible();
  await page.selectOption("#render-mode", "isosurface");
  await page.click("#benchmark");
  await expect(page.locator("#export")).toBeEnabled({ timeout: 20000 });
  const report = await page.evaluate(() => window.urathTest.report);
  expect(report.mode).toBe("isosurface");
  expect(report.frameIntervalMs.count).toBeGreaterThan(5);
  expect(report.durationMs).toBeGreaterThanOrEqual(10000);
  expect(report.environment.viewport[0]).toBeGreaterThan(0);
  const download = page.waitForEvent("download");
  await page.click("#export");
  expect((await download).suggestedFilename()).toBe("urath-benchmark.json");
});

test("raw imports validate their byte length and preserve non-cubic dimensions", async ({
  page,
}) => {
  await page.locator("summary").click();
  await page.fill("#raw-dimensions", "2, 3, 4");
  await page.setInputFiles("#raw-file", {
    name: "invalid.raw",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(1),
  });
  await expect(page.locator("#error")).toContainText("Expected 48 bytes");
  const bytes = Buffer.alloc(48);
  for (let i = 0; i < 24; i++) bytes.writeUInt16LE(1, i * 2);
  await page.setInputFiles("#raw-file", {
    name: "sample.raw",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await expect(page.locator("#status")).toHaveText("Ready");
  await expect(page.locator("#dataset-title")).toHaveText("2 × 3 × 4");
  for (const [type, width, value] of [
    ["uint8", 1, 173],
    ["uint16-scalar", 2, 42001],
    ["float32", 4, 0.75],
  ]) {
    await page.selectOption("#raw-type", type);
    const buffer = Buffer.alloc(24 * width);
    for (let i = 0; i < 24; i++) {
      if (width === 1) buffer.writeUInt8(value, i);
      else if (width === 2) buffer.writeUInt16LE(value, i * 2);
      else buffer.writeFloatLE(value, i * 4);
    }
    await page.setInputFiles("#raw-file", {
      name: `${type}.raw`,
      mimeType: "application/octet-stream",
      buffer,
    });
    await expect(page.locator("#dataset-label")).toContainText(`${type}.raw`);
    await expect(page.locator("#status")).toHaveText("Ready");
    await expect(page.locator("#range-min")).toHaveValue(String(value));
    const stats = await page.evaluate(() => window.urathTest.current.stats);
    expect(stats.storage).toBe(type === "uint16-scalar" ? "uint16" : type);
    expect(stats.inputBytes).toBe(24 * width);
  }
});

test("material colours survive occupancy merging, chunk seams, packed vertices and edits", async ({
  page,
}) => {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const result = await page.evaluate(async () => {
    const { THREE, renderer, createSurface } = window.urathTest;
    const data = new Uint16Array(16 * 8 * 8);
    for (let i = 0; i < data.length; i++) data[i] = i % 2 ? 65535 : 1;
    const s = await createSurface({
      data,
      dimensions: [16, 8, 8],
      chunkSize: 8,
      workers: 1,
      palette: ["black", "red", "blue", "lime"],
    });
    const scene = new THREE.Scene();
    scene.add(s);
    const camera = new THREE.OrthographicCamera(-8, 8, 4, -4, 0.1, 100);
    camera.position.set(8, 4, 30);
    camera.lookAt(8, 4, 4);
    const target = new THREE.WebGLRenderTarget(64, 32);
    const read = () => {
      const pixels = new Uint8Array(64 * 32 * 4);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, 64, 32, pixels);
      renderer.setRenderTarget(null);
      return Array.from({ length: 16 }, (_, x) =>
        Array.from(
          pixels.slice(
            (x * 4 + 2 + 64 * 16) * 4,
            (x * 4 + 2 + 64 * 16) * 4 + 3,
          ),
        ),
      );
    };
    const before = read(),
      stats = s.stats;
    await s.updateRegion({
      offset: [7, 4, 7],
      dimensions: [2, 1, 1],
      data: new Uint16Array([2, 2]),
    });
    const after = read();
    s.dispose();
    target.dispose();
    return { before, after, stats };
  });
  expect(errors).toEqual([]);
  expect(result.stats.triangles).toBe(20);
  expect(result.stats.geometryBytes).toBeLessThan(1000);
  for (let x = 0; x < 16; x++) {
    const rgb = result.before[x];
    expect(rgb[x % 2 ? 1 : 0]).toBeGreaterThan(150);
    expect(rgb[x % 2 ? 0 : 1]).toBe(0);
  }
  for (const x of [7, 8]) expect(result.after[x][2]).toBeGreaterThan(150);
});

test("brick skipping matches reference pixels across cameras, transfer windows and incremental uploads", async ({
  page,
}) => {
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const result = await page.evaluate(() => {
    const { THREE, renderer, createVolume } = window.urathTest;
    const dims = [33, 25, 19],
      data = new Float32Array(33 * 25 * 19);
    for (let z = 4; z < 17; z++)
      for (let y = 3; y < 22; y++)
        for (let x = 8; x < 25; x++)
          data[x + 33 * (y + 25 * z)] = (((x + y + z) % 3) + 1) * 0.25;
    const opts = {
      data,
      dimensions: dims,
      range: [0, 1],
      opacity: 0.13,
      maxSteps: 128,
    };
    const fast = createVolume(renderer, opts),
      ref = createVolume(renderer, { ...opts, emptySpaceSkipping: false });
    const scene = new THREE.Scene(),
      target = new THREE.WebGLRenderTarget(48, 48);
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
    const diffs = [];
    const read = (volume) => {
      scene.add(volume);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0, 0);
      renderer.render(scene, camera);
      const pixels = new Uint8Array(48 * 48 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 48, 48, pixels);
      renderer.setRenderTarget(null);
      scene.remove(volume);
      return pixels;
    };
    const compare = () => {
      const a = read(fast),
        b = read(ref);
      diffs.push(Math.max(...a.map((v, i) => Math.abs(v - b[i]))));
    };
    for (const pos of [
      [16, 12, 65],
      [-40, 31, -20],
      [16, 65, 9],
      [16, 12, 9],
    ]) {
      camera.position.set(...pos);
      camera.lookAt(16, 12, 8);
      compare();
    }
    camera.position.set(16, 12, 65);
    camera.lookAt(16, 12, 8);
    for (const v of [fast, ref])
      v.setClip([0.13, 0.17, 0.23], [0.91, 0.86, 0.92]);
    compare();
    const table = new Uint8Array(1024);
    for (let i = 55; i < 80; i++) table.set([255, 60, 30, 120], i * 4);
    for (const v of [fast, ref]) {
      v.setTransferFunction(table);
      v.setRange([0.05, 0.95]);
    }
    compare();
    for (const v of [fast, ref]) {
      v.setMode("isosurface");
      v.setThreshold(0.6);
    }
    compare();
    const before = fast.stats;
    for (const v of [fast, ref]) {
      v.updateRegion({
        offset: [15, 10, 8],
        dimensions: [2, 3, 4],
        data: new Float32Array(24).fill(0.9),
      });
    }
    compare();
    const after = fast.stats;
    const glError = renderer.getContext().getError();
    fast.dispose();
    ref.dispose();
    target.dispose();
    return { diffs, before, after, glError };
  });
  expect(errors).toEqual([]);
  expect(result.glError).toBe(0);
  expect(Math.max(...result.diffs)).toBeLessThanOrEqual(1);
  expect(result.after.fullUploads).toBe(1);
  expect(result.after.regionUploads).toBe(1);
  expect(result.after.uploadedBytes - result.before.uploadedBytes).toBe(
    2 * 3 * 4 * 4,
  );
});

for (const sparse of [false, true])
  test(`direct voxel traversal matches CPU ray-box reference, sparse hierarchy: ${sparse}`, async ({
    page,
  }) => {
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const result = await page.evaluate(async (sparse) => {
      const { THREE, renderer, createVoxelRaycast } = window.urathTest;
      const dimensions = sparse ? [137, 73, 91] : [17, 9, 11],
        [w, h, d] = dimensions,
        data = new Uint16Array(w * h * d);
      // Empty bricks, isolated cells, a cavity, mixed colours and incomplete edge bricks.
      for (let z = 0; z < d; z++)
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            if (
              sparse
                ? (x === 64 || x === 128 || x === 136) &&
                  y > 31 &&
                  y < 41 &&
                  z > 46 &&
                  z < 54
                : x > 8 && (x * 13 + y * 7 + z * 3) % 5 < 3
            )
              data[x + w * (y + h * z)] = 1 + ((x + y + z) % 3);
          }
      data[0] = 65535;
      const options = {
        data,
        dimensions,
        palette: ["black", "red", "lime", "blue"],
        spacing: [1, 1.5, 0.8],
      };
      const rays = createVoxelRaycast(renderer, options);
      const scene = new THREE.Scene(),
        target = new THREE.WebGLRenderTarget(80, 80);
      const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
      const read = (view) => {
        scene.add(view);
        renderer.setRenderTarget(target);
        renderer.setClearColor(0, 0);
        renderer.render(scene, camera);
        const pixels = new Uint8Array(80 * 80 * 4);
        renderer.readRenderTargetPixels(target, 0, 0, 80, 80, pixels);
        renderer.setRenderTarget(null);
        scene.remove(view);
        return pixels;
      };
      const occupied = [];
      for (let z = 0; z < d; z++)
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const id = data[x + w * (y + h * z)];
            if (id) occupied.push([x, y, z, id % 4]);
          }
      const mismatch = [];
      const details = [];
      for (const pos of [
        [8, 6, 55],
        [8, 6, -55],
        [60, 6, 4],
        [-55, 6, 4],
        [8, 60, 4],
        [8, -55, 4],
        [42, 32, 45],
        [-30, 22, -35],
      ]) {
        camera.position.set(
          ...pos.map((v, a) => (v * dimensions[a]) / [17, 9, 11][a]),
        );
        camera.lookAt((8 * w) / 17, (6 * h) / 9, (4 * d) / 11);
        const b = read(rays),
          m = camera.matrixWorld.elements,
          projection = camera.projectionMatrix.elements;
        const spacing = options.spacing,
          origin = camera.position.toArray().map((v, i) => v / spacing[i]);
        let wrong = 0,
          visible = 0;
        // Brute-force intersection of individual occupied cells. This deliberately
        // shares neither DDA stepping nor acceleration logic with the GPU shader.
        for (let y = 0; y < 80; y++)
          for (let x = 0; x < 80; x++) {
            const nx = ((2 * (x + 0.5)) / 80 - 1) / projection[0],
              ny = ((2 * (y + 0.5)) / 80 - 1) / projection[5];
            const inv = [
              spacing[0] / (m[0] * nx + m[4] * ny - m[8]),
              spacing[1] / (m[1] * nx + m[5] * ny - m[9]),
              spacing[2] / (m[2] * nx + m[6] * ny - m[10]),
            ];
            let closest = Infinity,
              expected = -1;
            for (const cell of occupied) {
              let enter = 0,
                leave = Infinity;
              for (let axis = 0; axis < 3; axis++) {
                const lo = (cell[axis] - origin[axis]) * inv[axis],
                  hi = (cell[axis] + 1 - origin[axis]) * inv[axis];
                enter = Math.max(enter, Math.min(lo, hi));
                leave = Math.min(leave, Math.max(lo, hi));
              }
              if (enter < leave && enter < closest) {
                closest = enter;
                expected = cell[3];
              }
            }
            const i = (x + 80 * y) * 4;
            const actual =
              b[i + 3] === 0
                ? -1
                : b[i] > b[i + 1] && b[i] > b[i + 2]
                  ? 1
                  : b[i + 1] > b[i + 2]
                    ? 2
                    : 3;
            if (expected !== -1 || actual !== -1) visible++;
            if (actual !== expected) {
              wrong++;
              if (details.length < 5)
                details.push({ pos, x, y, expected, actual });
            }
          }
        mismatch.push(wrong / Math.max(1, visible));
      }
      const before = rays.stats;
      rays.updateRegion({
        offset: [0, 0, 0],
        dimensions: [1, 1, 1],
        data: new Uint16Array([0]),
      });
      read(rays);
      const after = rays.stats;
      const glError = renderer.getContext().getError();
      rays.dispose();
      target.dispose();
      return {
        mismatch,
        details,
        before,
        after,
        glError,
        disposed: rays.stats,
      };
    }, sparse);
    expect(errors).toEqual([]);
    expect(result.glError).toBe(0);
    expect(Math.max(...result.mismatch), JSON.stringify(result.details)).toBe(
      0,
    );
    expect(result.after.uploadedBytes - result.before.uploadedBytes).toBe(2);
    expect(result.after.fullUploads).toBe(1);
    expect(result.after.regionUploads).toBe(1);
    expect(result.disposed.managedBytes).toBe(0);
  });

test("regional uploads change visible pixels, preserve neighbours and send only the dirty box", async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const { THREE, renderer, createVoxelRaycast, createVolume } =
      window.urathTest;
    const camera = new THREE.OrthographicCamera(-8, 8, 4, -4, 0.1, 100);
    camera.position.set(8, 4, 30);
    camera.lookAt(8, 4, 0);
    const scene = new THREE.Scene(),
      target = new THREE.WebGLRenderTarget(64, 32);
    const gl = renderer.getContext(),
      original = gl.texSubImage3D,
      calls = [];
    gl.texSubImage3D = function (...a) {
      calls.push({
        x: a[2],
        y: a[3],
        z: a[4],
        w: a[5],
        h: a[6],
        d: a[7],
        type: a[9],
      });
      return original.apply(this, a);
    };
    const results = [];
    try {
      for (const scalar of [false, true]) {
        const volume = scalar
          ? createVolume(renderer, {
              data: new Float32Array(1024).fill(0.8),
              dimensions: [16, 8, 8],
              mode: "isosurface",
              threshold: 0.5,
              range: [0, 1],
            })
          : createVoxelRaycast(renderer, {
              data: new Uint16Array(1024).fill(1),
              dimensions: [16, 8, 8],
              palette: ["black", "red", "lime"],
            });
        scene.add(volume);
        const read = () => {
          renderer.setRenderTarget(target);
          renderer.setClearColor(0, 0);
          renderer.render(scene, camera);
          const p = new Uint8Array(64 * 32 * 4);
          renderer.readRenderTargetPixels(target, 0, 0, 64, 32, p);
          renderer.setRenderTarget(null);
          return p;
        };
        const before = read();
        calls.length = 0;
        for (const x of [2, 3])
          volume.updateRegion({
            offset: [x, 2, scalar ? 0 : 7],
            dimensions: [1, 2, scalar ? 8 : 1],
            data: scalar ? new Float32Array(16) : new Uint16Array(2).fill(2),
          });
        const after = read();
        const left = (10 + 64 * 10) * 4,
          right = (46 + 64 * 10) * 4;
        results.push({
          scalar,
          leftBefore: Array.from(before.slice(left, left + 4)),
          leftAfter: Array.from(after.slice(left, left + 4)),
          rightBefore: Array.from(before.slice(right, right + 4)),
          rightAfter: Array.from(after.slice(right, right + 4)),
          calls: calls.filter(
            (c) => c.type === (scalar ? gl.FLOAT : gl.UNSIGNED_SHORT),
          ),
          stats: volume.stats,
        });
        volume.dispose();
      }
    } finally {
      gl.texSubImage3D = original;
      target.dispose();
    }
    return { results, error: gl.getError() };
  });
  expect(result.error).toBe(0);
  for (const r of result.results) {
    expect(r.rightAfter).toEqual(r.rightBefore);
    expect(r.leftAfter).not.toEqual(r.leftBefore);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({
      x: 2,
      y: 2,
      z: r.scalar ? 0 : 7,
      w: 2,
      h: 2,
      d: r.scalar ? 8 : 1,
    });
    expect(r.stats.fullUploads).toBe(1);
    expect(r.stats.regionUploads).toBe(1);
    if (r.scalar) expect(r.leftAfter[3]).toBe(0);
    else {
      expect(r.leftAfter[1]).toBeGreaterThan(150);
      expect(r.leftAfter[0]).toBe(0);
    }
  }
});

test("direct voxel hit depth composes with opaque meshes in front and behind", async ({
  page,
}) => {
  const pixels = await page.evaluate(async () => {
    const { THREE, renderer, createSurface, createVoxelRaycast } =
      window.urathTest;
    const data = new Uint16Array(512);
    data.fill(1, 64, 128);
    const rays = createVoxelRaycast(renderer, {
      data,
      dimensions: [8, 8, 8],
      palette: ["black", "red"],
    });
    const slab = await createSurface({
      data: new Uint16Array(64).fill(1),
      dimensions: [8, 8, 1],
      origin: [0, 0, 3],
      palette: ["black", "lime"],
      workers: 1,
      chunkSize: 8,
    });
    const scene = new THREE.Scene();
    scene.add(rays, slab);
    const camera = new THREE.OrthographicCamera(-4, 4, 4, -4, 0.1, 100);
    camera.position.set(4, 4, 30);
    camera.lookAt(4, 4, 0);
    const target = new THREE.WebGLRenderTarget(32, 32),
      p = new Uint8Array(32 * 32 * 4);
    const read = () => {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, 32, 32, p);
      renderer.setRenderTarget(null);
      return Array.from(p.slice((16 + 32 * 16) * 4, (16 + 32 * 16) * 4 + 3));
    };
    const front = read();
    slab.position.z = 0;
    const back = read();
    rays.dispose();
    slab.dispose();
    target.dispose();
    return { front, back };
  });
  expect(pixels.front[1]).toBeGreaterThan(150);
  expect(pixels.front[0]).toBe(0);
  expect(pixels.back[0]).toBeGreaterThan(150);
  expect(pixels.back[1]).toBe(0);
});

test("hierarchical volume skips preserve sparse thin features, ragged edges, clipping and reclassification", async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const { THREE, renderer, createVolume } = window.urathTest;
    const dims = [137, 73, 91],
      data = new Float32Array(137 * 73 * 91);
    for (const x of [0, 31, 64, 128, 136])
      for (let z = 39; z < 53; z++)
        for (let y = 28; y < 44; y++)
          data[x + 137 * (y + 73 * z)] = x === 64 ? 0.25 : 0.75;
    const opts = {
      data,
      dimensions: dims,
      range: [0, 1],
      opacity: 0.1,
      maxSteps: 1024,
    };
    const fast = createVolume(renderer, opts),
      ref = createVolume(renderer, { ...opts, emptySpaceSkipping: false });
    const target = new THREE.WebGLRenderTarget(64, 64),
      scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 1000);
    const read = (object) => {
      scene.add(object);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0, 0);
      renderer.render(scene, camera);
      const p = new Uint8Array(64 * 64 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 64, 64, p);
      scene.remove(object);
      return p;
    };
    let maxDifference = 0,
      visible = 0;
    const compare = () => {
      const a = read(fast),
        b = read(ref);
      for (let i = 0; i < a.length; i++)
        maxDifference = Math.max(maxDifference, Math.abs(a[i] - b[i]));
      for (let i = 3; i < b.length; i += 4) if (b[i]) visible++;
    };
    for (const mode of ["volume", "isosurface"]) {
      for (const object of [fast, ref]) object.setMode(mode);
      for (const position of [
        [68, 36, 210],
        [-110, 80, 110],
        [230, 50, 45],
        [68, 180, -110],
        [68, 36, 45],
      ]) {
        camera.position.set(...position);
        camera.lookAt(64, 36, 43);
        compare();
      }
      const table = new Uint8Array(1024);
      for (let i = 48; i < 82; i++) table.set([255, 64, 32, 255], i * 4);
      for (const object of [fast, ref]) {
        object.setTransferFunction(table);
        object.setThreshold(0.2);
        object.setClip([0.09, 0.11, 0.13], [0.95, 0.92, 0.97]);
      }
      camera.position.set(68, 36, 210);
      camera.lookAt(64, 36, 43);
      compare();
      for (const object of [fast, ref])
        object.updateRegion({
          offset: [95, 31, 47],
          dimensions: [1, 8, 8],
          data: new Float32Array(64).fill(0.25),
        });
      compare();
      // Low sample limits must retain exactly the same lattice after long jumps.
      for (const object of [fast, ref]) object.setQuality(16);
      compare();
      for (const object of [fast, ref]) object.setQuality(1024);
    }
    const glError = renderer.getContext().getError();
    renderer.setRenderTarget(null);
    fast.dispose();
    ref.dispose();
    target.dispose();
    return { maxDifference, visible, glError };
  });
  expect(result.glError).toBe(0);
  expect(result.visible).toBeGreaterThan(50);
  expect(result.maxDifference).toBeLessThanOrEqual(1);
});

test("distant edits stay separate on the GPU and newly occupied empty regions become visible", async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const { THREE, renderer, createVoxelRaycast, createVolume } =
      window.urathTest;
    const scene = new THREE.Scene(),
      target = new THREE.WebGLRenderTarget(64, 64);
    const camera = new THREE.OrthographicCamera(-32, 32, 32, -32, 0.1, 200);
    camera.position.set(32, 32, 150);
    camera.lookAt(32, 32, 32);
    const gl = renderer.getContext(),
      original = gl.texSubImage3D,
      calls = [],
      results = [];
    gl.texSubImage3D = function (...args) {
      calls.push(args.slice(2, 10));
      return original.apply(this, args);
    };
    try {
      for (const scalar of [false, true]) {
        const object = scalar
          ? createVolume(renderer, {
              data: new Float32Array(64 ** 3),
              dimensions: [64, 64, 64],
              mode: "isosurface",
              range: [0, 1],
              threshold: 0.5,
            })
          : createVoxelRaycast(renderer, {
              data: new Uint16Array(64 ** 3),
              dimensions: [64, 64, 64],
            });
        scene.add(object);
        const read = () => {
          renderer.setRenderTarget(target);
          renderer.setClearColor(0, 0);
          renderer.render(scene, camera);
          const p = new Uint8Array(64 * 64 * 4);
          renderer.readRenderTargetPixels(target, 0, 0, 64, 64, p);
          return p;
        };
        read();
        calls.length = 0;
        const before = object.stats;
        for (const offset of [
          [2, 2, 2],
          [58, 58, 58],
        ])
          object.updateRegion({
            offset,
            dimensions: [4, 4, 4],
            data: scalar
              ? new Float32Array(64).fill(1)
              : new Uint16Array(64).fill(1),
          });
        const after = read();
        results.push({
          scalar,
          bytes: object.stats.uploadedBytes - before.uploadedBytes,
          regions: object.stats.regionUploads - before.regionUploads,
          calls: calls.filter(
            (c) => c[7] === (scalar ? gl.FLOAT : gl.UNSIGNED_SHORT),
          ),
          alpha: [
            after[(3 + 3 * 64) * 4 + 3],
            after[(59 + 59 * 64) * 4 + 3],
            after[(32 + 32 * 64) * 4 + 3],
          ],
        });
        object.dispose();
      }
    } finally {
      gl.texSubImage3D = original;
      renderer.setRenderTarget(null);
      target.dispose();
    }
    return { results, glError: gl.getError() };
  });
  expect(result.glError).toBe(0);
  for (const r of result.results) {
    expect(r.bytes).toBe(r.scalar ? 512 : 256);
    expect(r.regions).toBe(2);
    expect(r.calls.map((c) => c.slice(0, 6))).toEqual([
      [2, 2, 2, 4, 4, 4],
      [58, 58, 58, 4, 4, 4],
    ]);
    expect(r.alpha).toEqual([255, 255, 0]);
  }
});

for (const bits of [8, 16])
  test(`native uint${bits} scalar textures match Float32, including edits and both modes`, async ({
    page,
  }) => {
    const result = await page.evaluate((bits) => {
      const { THREE, renderer, createVolume } = window.urathTest;
      const ArrayType = bits === 8 ? Uint8Array : Uint16Array,
        max = bits === 8 ? 255 : 65535;
      const dims = [33, 17, 25],
        data = new ArrayType(33 * 17 * 25);
      for (let i = 0; i < data.length; i++)
        data[i] = (i * 109 + 31) % (max + 1);
      const opts = {
        data,
        dimensions: dims,
        range: [0, max],
        opacity: 0.11,
        maxSteps: 128,
      };
      const native = createVolume(renderer, opts),
        ref = createVolume(renderer, { ...opts, storage: "float32" });
      const scene = new THREE.Scene(),
        target = new THREE.WebGLRenderTarget(48, 48);
      const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 300);
      let difference = 0;
      const read = (object) => {
        scene.add(object);
        renderer.setRenderTarget(target);
        renderer.setClearColor(0, 0);
        renderer.render(scene, camera);
        const pixels = new Uint8Array(48 * 48 * 4);
        renderer.readRenderTargetPixels(target, 0, 0, 48, 48, pixels);
        scene.remove(object);
        return pixels;
      };
      const compare = () => {
        const a = read(native),
          b = read(ref);
        for (let i = 0; i < a.length; i++)
          difference = Math.max(difference, Math.abs(a[i] - b[i]));
      };
      for (const mode of ["volume", "isosurface"]) {
        for (const object of [native, ref]) {
          object.setMode(mode);
          object.setThreshold(max * 0.55);
        }
        for (const position of [
          [16, 8, 75],
          [-40, 31, -20],
          [16, 65, 9],
          [16, 8, 10],
        ]) {
          camera.position.set(...position);
          camera.lookAt(16, 8, 9);
          compare();
        }
      }
      camera.position.set(16, 8, 75);
      camera.lookAt(16, 8, 9);
      const before = native.stats;
      for (const object of [native, ref])
        object.updateRegion({
          offset: [13, 5, 19],
          dimensions: [3, 3, 3],
          data: new ArrayType(27).fill(max),
        });
      compare();
      const after = native.stats,
        glError = renderer.getContext().getError();
      renderer.setRenderTarget(null);
      native.dispose();
      ref.dispose();
      target.dispose();
      return { difference, before, after, glError };
    }, bits);
    expect(result.glError).toBe(0);
    expect(result.difference).toBeLessThanOrEqual(1);
    expect(result.before.storage).toBe(`uint${bits}`);
    expect(result.before.inputBytes).toBe((33 * 17 * 25 * bits) / 8);
    expect(result.after.uploadedBytes - result.before.uploadedBytes).toBe(
      (27 * bits) / 8,
    );
    expect(result.after.fullUploads).toBe(1);
    expect(result.after.regionUploads).toBe(1);
  });

test("integer scalar storage widens losslessly and rejects unaffordable promotion before mutation", async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const { THREE, renderer, createVolume } = window.urathTest;
    const scene = new THREE.Scene(),
      target = new THREE.WebGLRenderTarget(32, 32);
    const camera = new THREE.OrthographicCamera(-4, 4, 4, -4, 0.1, 100);
    camera.position.set(4, 4, 30);
    camera.lookAt(4, 4, 0);
    const opts = {
      data: new Uint8Array(512).fill(1),
      dimensions: [8, 8, 8],
      range: [0, 4],
      mode: "isosurface",
      threshold: 0.5,
    };
    const object = createVolume(renderer, opts),
      ref = createVolume(renderer, { ...opts, storage: "float32" });
    const read = (v) => {
      scene.add(v);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0, 0);
      renderer.render(scene, camera);
      const p = new Uint8Array(4096);
      renderer.readRenderTargetPixels(target, 0, 0, 32, 32, p);
      scene.remove(v);
      return p;
    };
    read(object);
    const texturesBefore = renderer.info.memory.textures;
    const states = [object.stats.storage],
      diffs = [];
    for (const value of [500, 0.75, -0.5]) {
      for (const v of [object, ref])
        v.updateRegion({
          offset: [2, 2, 0],
          dimensions: [3, 3, 8],
          data: new Float32Array(72).fill(value),
        });
      const a = read(object),
        b = read(ref);
      diffs.push(Math.max(...a.map((v, i) => Math.abs(v - b[i]))));
      states.push(object.stats.storage);
    }
    const stats = object.stats;
    ref.dispose();
    const texturesAfter = renderer.info.memory.textures;
    const limited = createVolume(renderer, { ...opts, maxMemoryBytes: 11000 });
    const before = read(limited);
    let rejected = "";
    try {
      limited.updateRegion({
        offset: [0, 0, 0],
        dimensions: [8, 8, 8],
        data: new Float32Array(512).fill(0.1),
      });
    } catch (error) {
      rejected = String(error);
    }
    const after = read(limited),
      unchanged = before.every((v, i) => v === after[i]);
    const limitedStorage = limited.stats.storage;
    limited.dispose();
    object.dispose();
    renderer.setRenderTarget(null);
    target.dispose();
    return {
      states,
      diffs,
      stats,
      texturesBefore,
      texturesAfter,
      rejected,
      unchanged,
      limitedStorage,
      error: renderer.getContext().getError(),
    };
  });
  expect(result.error).toBe(0);
  expect(result.states).toEqual(["uint8", "uint16", "float32", "float32"]);
  expect(Math.max(...result.diffs)).toBeLessThanOrEqual(1);
  expect(result.stats.fullUploads).toBe(3);
  expect(result.texturesAfter).toBe(result.texturesBefore);
  expect(result.rejected).toMatch(/promotion.*budget/);
  expect(result.unchanged).toBe(true);
  expect(result.limitedStorage).toBe("uint8");
});

test("GPU transfer cache matches reference pixels through ranges, tables, partial edits and mode changes", async ({
  page,
}) => {
  const results = await page.evaluate(() => {
    const { THREE, renderer, createVolume } = window.urathTest,
      results = [];
    const target = new THREE.WebGLRenderTarget(48, 48),
      scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 200);
    for (const Type of [Float32Array, Uint8Array, Uint16Array]) {
      const scale =
        Type === Float32Array ? 1 : Type === Uint8Array ? 255 : 65535;
      const data = new Type(33 * 17 * 25);
      for (let i = 0; i < data.length; i++)
        data[i] = (((i % 255) + 0.5) / 255) * scale;
      const table = new Uint8Array(1024);
      for (let i = 0; i < 256; i++)
        table.set(
          [i % 2 ? 255 : 0, i % 3 ? 0 : 255, i % 5 ? 0 : 255, i % 4 ? 100 : 0],
          i * 4,
        );
      const opts = {
        data,
        dimensions: [33, 17, 25],
        range: [0, scale],
        transferFunction: table,
        opacity: 0.08,
        maxSteps: 128,
      };
      const cache = createVolume(renderer, { ...opts, transferCache: true }),
        ref = createVolume(renderer, opts);
      let difference = 0;
      const phases = [];
      const read = (object) => {
        scene.add(object);
        renderer.setRenderTarget(target);
        renderer.setClearColor(0, 0);
        renderer.render(scene, camera);
        const p = new Uint8Array(48 * 48 * 4);
        renderer.readRenderTargetPixels(target, 0, 0, 48, 48, p);
        scene.remove(object);
        return p;
      };
      const compare = () => {
        const a = read(cache),
          b = read(ref);
        let phase = 0;
        for (let i = 0; i < a.length; i++)
          phase = Math.max(phase, Math.abs(a[i] - b[i]));
        phases.push(phase);
        difference = Math.max(difference, phase);
      };
      for (const pos of [
        [16, 8, 75],
        [-40, 31, -20],
        [16, 8, 10],
      ]) {
        camera.position.set(...pos);
        camera.lookAt(16, 8, 9);
        compare();
      }
      const initial = cache.stats;
      for (const object of [cache, ref]) {
        object.setRange([0.031 * scale, 0.971 * scale]);
        object.setClip([0.11, 0.17, 0.23], [0.91, 0.93, 0.89]);
      }
      compare();
      const afterRange = cache.stats;
      for (const object of [cache, ref])
        object.setTransferFunction(new Uint8Array(1024).fill(170));
      compare();
      const afterTable = cache.stats;
      for (const object of [cache, ref])
        object.updateRegion({
          offset: [2, 3, 4],
          dimensions: [3, 2, 4],
          data: new Type(24).fill(0.9 * scale),
        });
      compare();
      const afterEdit = cache.stats;
      for (const object of [cache, ref]) {
        object.setMode("isosurface");
        object.setThreshold(0.5 * scale);
      }
      compare();
      // Editing while in isosurface mode must refresh the cache when returning.
      for (const object of [cache, ref])
        object.updateRegion({
          offset: [11, 7, 12],
          dimensions: [2, 2, 2],
          data: new Float32Array(8).fill(-0.5),
        });
      compare();
      for (const object of [cache, ref]) object.setMode("volume");
      compare();
      results.push({
        type: Type.name,
        phases,
        difference,
        initial,
        afterRange,
        afterTable,
        afterEdit,
        error: renderer.getContext().getError(),
      });
      cache.dispose();
      ref.dispose();
    }
    renderer.setRenderTarget(null);
    target.dispose();
    return results;
  });
  for (const r of results) {
    expect(r.error, r.type).toBe(0);
    expect(r.difference, JSON.stringify(r)).toBeLessThanOrEqual(1);
    expect(r.initial.transferCacheBytes).toBe(33 * 17 * 25);
    expect(r.initial.transferCacheBuilds).toBe(1);
    expect(r.afterRange.transferCacheBuilds).toBe(2);
    expect(r.afterTable.transferCacheBuilds).toBe(2);
    expect(
      r.afterEdit.transferCacheUpdatedVoxels -
        r.afterTable.transferCacheUpdatedVoxels,
    ).toBe(24);
  }
});

test("transfer cache restores custom target viewport/scissor at device pixel ratio two", async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const { THREE, renderer, createVolume, pauseRendering } = window.urathTest;
    pauseRendering();
    renderer.setPixelRatio(2);
    const scene = new THREE.Scene(),
      target = new THREE.WebGLRenderTarget(72, 64);
    const camera = new THREE.PerspectiveCamera(45, 48 / 40, 0.1, 100);
    camera.position.set(5, 6, 26);
    camera.lookAt(4, 4, 4);
    const opts = {
      data: new Float32Array(512).fill(0.7),
      dimensions: [8, 8, 8],
      range: [0, 1],
    };
    const cache = createVolume(renderer, { ...opts, transferCache: true }),
      ref = createVolume(renderer, opts);
    const gl = renderer.getContext(),
      states = [];
    const read = (object) => {
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.setClearColor(0, 0);
      renderer.clear();
      renderer.setViewport(4, 6, 24, 20);
      renderer.setScissor(6, 8, 18, 14);
      renderer.setScissorTest(true);
      scene.add(object);
      renderer.render(scene, camera);
      scene.remove(object);
      states.push({
        viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
        scissor: Array.from(gl.getParameter(gl.SCISSOR_BOX)),
        test: gl.isEnabled(gl.SCISSOR_TEST),
        target: renderer.getRenderTarget() === target,
        autoClear: renderer.autoClear,
      });
      const p = new Uint8Array(72 * 64 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 72, 64, p);
      return p;
    };
    const a = read(cache),
      b = read(ref),
      difference = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    renderer.setRenderTarget(null);
    renderer.setScissorTest(false);
    renderer.setPixelRatio(1);
    cache.dispose();
    ref.dispose();
    target.dispose();
    return { states, difference, error: gl.getError() };
  });
  expect(result.error).toBe(0);
  expect(result.difference).toBeLessThanOrEqual(1);
  expect(result.states[0]).toEqual(result.states[1]);
  expect(result.states[0]).toEqual({
    viewport: [8, 12, 48, 40],
    scissor: [12, 16, 36, 28],
    test: true,
    target: true,
    autoClear: true,
  });
});

test("GPU transfer cache rebuilds after WebGL context restoration", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { THREE, renderer, createVolume, pauseRendering } = window.urathTest;
    pauseRendering();
    const scene = new THREE.Scene(),
      target = new THREE.WebGLRenderTarget(40, 40);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(4, 5, 25);
    camera.lookAt(4, 4, 4);
    const volume = createVolume(renderer, {
      data: new Float32Array(512).fill(0.8),
      dimensions: [8, 8, 8],
      range: [0, 1],
      transferCache: true,
    });
    scene.add(volume);
    const read = () => {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0, 0);
      renderer.render(scene, camera);
      const p = new Uint8Array(40 * 40 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 40, 40, p);
      renderer.setRenderTarget(null);
      return p;
    };
    const before = read(),
      buildsBefore = volume.stats.transferCacheBuilds;
    const gl = renderer.getContext(),
      ext = gl.getExtension("WEBGL_lose_context");
    if (!ext) throw new Error("Context loss extension unavailable");
    await new Promise((resolve) => {
      renderer.domElement.addEventListener(
        "webglcontextlost",
        () => {
          target.dispose();
          resolve();
        },
        {
          once: true,
        },
      );
      ext.loseContext();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => {
      renderer.domElement.addEventListener("webglcontextrestored", resolve, {
        once: true,
      });
      ext.restoreContext();
    });
    const after = read(),
      buildsAfter = volume.stats.transferCacheBuilds;
    const difference = Math.max(
      ...before.map((v, i) => Math.abs(v - after[i])),
    );
    volume.dispose();
    target.dispose();
    return { difference, buildsBefore, buildsAfter, error: gl.getError() };
  });
  expect(result.error).toBe(0);
  expect(result.difference).toBeLessThanOrEqual(1);
  expect(result.buildsAfter).toBe(result.buildsBefore + 1);
});

test("cached lookup agrees at both Float32 neighbours of every transfer boundary", async ({
  page,
}) => {
  const results = await page.evaluate(() => {
    const { THREE, renderer, createVolume, pauseRendering } = window.urathTest;
    pauseRendering();
    const scene = new THREE.Scene(),
      target = new THREE.WebGLRenderTarget(51, 15);
    const camera = new THREE.OrthographicCamera(
      -25.5,
      25.5,
      7.5,
      -7.5,
      0.1,
      20,
    );
    camera.position.set(25.5, 7.5, 5);
    camera.lookAt(25.5, 7.5, 0);
    const table = new Uint8Array(1024);
    for (let i = 0; i < 256; i++)
      table.set(
        [
          i % 3 === 0 ? 255 : 0,
          i % 3 === 1 ? 255 : 0,
          i % 3 === 2 ? 255 : 0,
          255,
        ],
        i * 4,
      );
    const bits = new Uint32Array(1),
      value = new Float32Array(bits.buffer),
      results = [];
    for (const range of [
      [0, 1],
      [-1000, 3000],
      [0.00001, 0.00004],
      [1e20, 1.001e20],
    ]) {
      const data = new Float32Array(765);
      for (let bin = 0; bin < 255; bin++) {
        value[0] = range[0] + ((bin + 0.5) / 255) * (range[1] - range[0]);
        const center = bits[0];
        for (let neighbour = -1; neighbour <= 1; neighbour++) {
          bits[0] = center + neighbour;
          data[bin * 3 + neighbour + 1] = value[0];
        }
      }
      const opts = {
        data,
        dimensions: [51, 15, 1],
        range,
        opacity: 10,
        transferFunction: table,
      };
      const cached = createVolume(renderer, { ...opts, transferCache: true }),
        direct = createVolume(renderer, opts);
      const read = (object) => {
        scene.add(object);
        renderer.setRenderTarget(target);
        renderer.setClearColor(0, 0);
        renderer.render(scene, camera);
        const p = new Uint8Array(765 * 4);
        renderer.readRenderTargetPixels(target, 0, 0, 51, 15, p);
        scene.remove(object);
        return p;
      };
      const a = read(cached),
        b = read(direct);
      let difference = 0,
        visible = 0;
      for (let i = 0; i < a.length; i++)
        difference = Math.max(difference, Math.abs(a[i] - b[i]));
      for (let i = 3; i < b.length; i += 4) if (b[i]) visible++;
      results.push({
        range,
        difference,
        visible,
        error: renderer.getContext().getError(),
      });
      cached.dispose();
      direct.dispose();
    }
    renderer.setRenderTarget(null);
    target.dispose();
    return results;
  });
  for (const r of results) {
    expect(r.error).toBe(0);
    expect(r.visible).toBe(765);
    expect(r.difference, JSON.stringify(r)).toBeLessThanOrEqual(1);
  }
});
