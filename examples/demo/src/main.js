import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  createSurface,
  createVolume,
  createVoxelRaycast,
  defaultTransferFunction,
} from "@urath/threejs";
import { distribution, GpuTimer } from "./measure.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const MiB = 1048576;
const presentationPalette = [
  "#000000",
  "#c5cbb1",
  "#a8b2bb",
  "#d59d79",
  "#d9b38c",
  "#e5d0ae",
  "#f1e6cc",
  "#747e7c",
];
let renderer, scene, camera, controls, timer;
let current = null,
  metadata = null,
  generation = null,
  controller = null,
  loadPromise = Promise.resolve();
let loadSerial = 0,
  firstFrameMs = null,
  updateMs = null,
  capture = null,
  report = null;
let frameTimes = [],
  lastFrame = null,
  frame = 0,
  latestStats = null;
let fitDistance = 150,
  target = new THREE.Vector3();
const number = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

function errorMessage(error) {
  $("error").textContent =
    error instanceof Error ? error.message : String(error);
  $("error").hidden = false;
  $("status").textContent = "Needs attention";
  $("status").classList.add("error");
}
function clearError() {
  $("error").hidden = true;
  $("status").classList.remove("error");
}
function setBusy(busy) {
  $("loading").hidden = !busy;
  $("cancel").hidden = !busy;
  $("benchmark").disabled = busy || !current;
  $("edit").disabled = busy || !current;
  $("reset-camera").disabled = busy || !current;
}
function afterPaint() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
}
function disposeCurrent() {
  current?.dispose();
  current = null;
  latestStats = null;
}
function applyVolumeControls() {
  if (!current || metadata?.kind !== "scalar") return;
  cancelCapture();
  current.setMode($("render-mode").value);
  current.setQuality(Number($("quality").value));
  current.setOpacity(Number($("opacity").value));
  current.setThreshold(Number($("threshold").value));
  current.setClip([0, 0, 0], [1, 1, Number($("clip").value) / 100]);
  current.setRange([
    Number($("range-min").value),
    Number($("range-max").value),
  ]);
  const map = defaultTransferFunction();
  if ($("transfer").value !== "warm")
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      map[i * 4] = $("transfer").value === "grayscale" ? i : Math.round(70 * t);
      map[i * 4 + 1] =
        $("transfer").value === "grayscale" ? i : Math.round(210 * t);
      map[i * 4 + 2] = i;
    }
  current.setTransferFunction(map);
  $("volume-controls").hidden = false;
  $("quality-value").value = $("quality").value;
  $("opacity-value").value = $("opacity").value;
  $("threshold-value").value = Number(
    Number($("threshold").value).toPrecision(3),
  );
  $("clip-value").value = `${$("clip").value}%`;
  report = null;
  $("export").disabled = true;
}
function fitCamera() {
  if (!current) return;
  const box = new THREE.Box3().setFromObject(current);
  if (box.isEmpty())
    box.set(new THREE.Vector3(), new THREE.Vector3(...metadata.dimensions));
  box.getCenter(target);
  const size = box.getSize(new THREE.Vector3());
  const angle = THREE.MathUtils.degToRad(camera.fov / 2);
  fitDistance =
    (Math.max(size.y, size.x / camera.aspect, size.z) / (2 * Math.tan(angle))) *
    1.6;
  camera.position
    .copy(target)
    .add(
      new THREE.Vector3(1, 0.65, 1.1).normalize().multiplyScalar(fitDistance),
    );
  camera.near = Math.max(0.01, fitDistance / 10000);
  camera.far = fitDistance * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(target);
  controls.update();
}
function generated(request, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./dataset-worker.js", import.meta.url), {
      type: "module",
    });
    generation = worker;
    const cleanup = () => {
      worker.terminate();
      if (generation === worker) generation = null;
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error("Loading cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message));
    };
    worker.onmessage = ({ data }) => {
      cleanup();
      data.error ? reject(new Error(data.error)) : resolve(data);
    };
    worker.postMessage(request);
  });
}

async function loadDataset(file) {
  const serial = ++loadSerial;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  cancelCapture();
  report = null;
  $("export").disabled = true;
  disposeCurrent();
  clearError();
  setBusy(true);
  $("progress").value = 0;
  $("status").textContent = "Loading";
  $("loading-text").textContent = "Preparing data…";
  const start = performance.now();
  firstFrameMs = null;
  updateMs = null;
  try {
    let dimensions,
      spacing = [1, 1, 1],
      payload,
      scalar,
      label;
    if (file) {
      dimensions = $("raw-dimensions").value.split(",").map(Number);
      spacing = $("raw-spacing").value.split(",").map(Number);
      if (
        dimensions.length !== 3 ||
        !dimensions.every((n) => Number.isSafeInteger(n) && n > 0)
      )
        throw new Error("Enter three positive integer dimensions.");
      if (
        spacing.length !== 3 ||
        !spacing.every((n) => Number.isFinite(n) && n > 0)
      )
        throw new Error("Enter three positive voxel spacings.");
      const type = $("raw-type").value;
      const bytesPerValue = type === "float32" ? 4 : type === "uint8" ? 1 : 2;
      const expected = dimensions.reduce((a, b) => a * b, 1) * bytesPerValue;
      if (!Number.isSafeInteger(expected) || file.size !== expected)
        throw new Error(
          `Expected ${number(expected)} bytes for these dimensions and type; file has ${number(file.size)}.`,
        );
      scalar = type !== "uint16";
      const storage = expected * 2;
      if (storage + 8192 > Number($("budget").value) * MiB)
        throw new Error(
          "File exceeds the available input budget. Choose a smaller dataset or increase the budget.",
        );
      const parsed = await generated(
        { kind: "raw", file, rawType: type },
        signal,
      );
      payload = parsed.data;
      label = file.name;
    } else {
      const size = Number($("size").value);
      dimensions = [size, size, size];
      const kind = $("dataset").value;
      const inputBytes = size ** 3 * (kind === "phantom" ? 4 : 2);
      if (inputBytes * 2 >= Number($("budget").value) * MiB)
        throw new Error("This grid needs a larger memory budget.");
      const result = await generated({ kind, size }, signal);
      payload = result.data;
      scalar = result.scalar;
      label = $("dataset").selectedOptions[0].textContent;
    }
    if (serial !== loadSerial || signal.aborted) return;
    const options = {
      data: payload,
      dimensions,
      spacing,
      maxMemoryBytes: Number($("budget").value) * MiB,
    };
    metadata = {
      label,
      dimensions,
      spacing,
      kind: scalar ? "scalar" : "material",
      sourceBytes: payload.byteLength,
      seed: file ? null : 123456789,
      fixture: file ? null : $("dataset").value,
      fixtureVersion: 1,
      palette: scalar ? null : presentationPalette,
      edits: [],
      backend: scalar ? "volume" : $("material-backend").value,
    };
    $("dataset-title").textContent = dimensions.join(" × ");
    $("dataset-label").textContent =
      `${label} / ${scalar ? "SCALAR FIELD" : "MATERIAL GRID"}`;
    $("volume-controls").hidden = !scalar;
    $("render-mode").value = scalar
      ? $("render-mode").value === "surface"
        ? "volume"
        : $("render-mode").value
      : "surface";
    $("loading-text").textContent = scalar
      ? "Uploading scalar field…"
      : "Meshing in workers…";
    if (scalar) {
      current = createVolume(renderer, {
        ...options,
        maxSteps: Number($("quality").value),
        mode: $("render-mode").value,
      });
      const range = current.material.uniforms.valueRange.value;
      $("range-min").value = range.x;
      $("range-max").value = range.y;
      $("threshold").min = range.x;
      $("threshold").max = range.y;
      $("threshold").step = (range.y - range.x) / 100;
      $("threshold").value = range.x + (range.y - range.x) * 0.45;
      applyVolumeControls();
    } else if ($("material-backend").value === "raycast") {
      $("loading-text").textContent = "Preparing voxel textures…";
      current = createVoxelRaycast(renderer, {
        ...options,
        palette: presentationPalette,
      });
    } else {
      const surface = await createSurface({
        ...options,
        palette: presentationPalette,
        chunkSize: Number($("chunk-size").value),
        workers: Number($("worker-count").value),
        signal,
        onProgress: (stats) => {
          if (serial !== loadSerial) return;
          latestStats = stats;
          $("progress").value = stats.completedChunks / stats.totalChunks;
          $("loading-text").textContent =
            `Meshing ${stats.completedChunks} / ${stats.totalChunks} chunks`;
        },
      });
      if (serial !== loadSerial || signal.aborted) {
        surface.dispose();
        return;
      }
      current = surface;
    }
    scene.add(current);
    fitCamera();
    await afterPaint();
    if (serial !== loadSerial) return;
    if (signal.aborted) throw new Error("Loading cancelled");
    firstFrameMs = performance.now() - start;
    $("status").textContent = "Ready";
    setBusy(false);
    frameTimes = [];
    lastFrame = null;
    timer.clear();
    updateMetrics();
  } catch (error) {
    if (serial !== loadSerial) return;
    disposeCurrent();
    setBusy(false);
    if (signal.aborted) {
      $("status").textContent = "Cancelled";
      return;
    }
    errorMessage(error);
  }
}

function updateMetrics() {
  const stats = current?.stats ?? latestStats;
  const frameStats = distribution(frameTimes);
  $("frame-p95").textContent = frameStats
    ? `${number(frameStats.p95)} ms`
    : "—";
  $("first-frame").textContent =
    firstFrameMs === null ? "—" : `${number(firstFrameMs)} ms`;
  $("memory").textContent = stats
    ? `${number(stats.managedBytes / MiB)} MiB`
    : "—";
  const scalar = metadata?.kind === "scalar";
  const direct = metadata?.backend === "raycast";
  $("dataset-summary").textContent = metadata
    ? `${number(metadata.dimensions.reduce((a, b) => a * b, 1))} samples · ${scalar ? "scalar field" : "material grid"} · local data`
    : "Preparing your view";
  $("renderer-label").textContent = scalar
    ? $("render-mode").value === "isosurface"
      ? "SCALAR ISOSURFACE"
      : "VOLUME RAY MARCHING"
    : direct
      ? "DIRECT VOXEL TRAVERSAL"
      : "RUST / WASM GREEDY MESH";
  $("geometry-label").textContent = scalar
    ? "RAY SAMPLE LIMIT"
    : direct
      ? "VOXELS"
      : "TRIANGLES";
  $("triangles").textContent = stats
    ? number(
        scalar
          ? stats.maxSteps
          : direct
            ? metadata.dimensions.reduce((a, b) => a * b, 1)
            : stats.triangles,
      )
    : "—";
  $("geometry-note").textContent = scalar
    ? "adaptive to ray length"
    : direct
      ? "exact traversal · one draw call"
      : "resident surface geometry";
  $("detail-data").textContent = stats
    ? scalar || direct
      ? `${number(stats.inputBytes / MiB)} MiB data · WebGL2`
      : `${stats.completedChunks}/${stats.totalChunks} chunks · ${stats.workers} workers · ${number(stats.totalMeshMs)} ms worker CPU`
    : "—";
  const gpu = distribution(timer.values);
  $("gpu-time").textContent = gpu
    ? `GPU p95: ${number(gpu.p95)} ms`
    : "GPU time: unavailable";
  $("update-time").textContent =
    `Update latency: ${updateMs === null ? "—" : `${number(updateMs)} ms`}`;
}

function beginCapture() {
  if (!current || document.hidden) return;
  clearError();
  controls.enabled = false;
  capture = {
    started: performance.now(),
    frames: [],
    cpu: [],
    previous: null,
    cameraPosition: camera.position.clone(),
  };
  report = null;
  $("export").disabled = true;
  timer.clear();
  $("benchmark").disabled = true;
  $("edit").disabled = true;
  $("reset-camera").disabled = true;
  $("capture-description").textContent = "Capturing a 10-second orbit…";
}
function cancelCapture() {
  if (!capture) return;
  camera.position.copy(capture.cameraPosition);
  controls.enabled = true;
  controls.update();
  capture = null;
  $("benchmark").disabled = !current;
  $("edit").disabled = !current;
  $("reset-camera").disabled = !current;
  $("capture-description").textContent =
    "Capture cancelled because the view changed.";
}
function finishCapture() {
  if (!capture) return;
  const gl = renderer.getContext(),
    debug = gl.getExtension("WEBGL_debug_renderer_info");
  report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    durationMs: performance.now() - capture.started,
    dataset: metadata,
    mode: $("render-mode").value,
    firstFrameMs,
    updateToVisibleMs: updateMs,
    frameIntervalMs: distribution(capture.frames),
    cpuRenderSubmissionMs: distribution(capture.cpu),
    gpuRenderMs: distribution(timer.values),
    resources: current.stats,
    cameraPath: {
      center: target.toArray(),
      radius: fitDistance,
      elevation: fitDistance * 0.45,
      fov: camera.fov,
      durationMs: 10000,
    },
    settings: {
      chunkSize: current.chunkSize ?? null,
      materialBackend: metadata.backend,
      workers: current.stats.workers ?? 0,
      maxSteps: Number($("quality").value),
      opacity: Number($("opacity").value),
      threshold: Number($("threshold").value),
      range: [Number($("range-min").value), Number($("range-max").value)],
      clipMaxZ: Number($("clip").value) / 100,
      transfer: $("transfer").value,
    },
    environment: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      threeRevision: THREE.REVISION,
      viewport: [renderer.domElement.width, renderer.domElement.height],
      pixelRatio: renderer.getPixelRatio(),
      gpu: debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : "unavailable",
      softwareGpu: debug
        ? /swiftshader|llvmpipe|software/i.test(
            gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
          )
        : null,
    },
    notes: [
      "Memory is an estimate of managed buffers, not total browser process memory.",
      "CPU render submission is not GPU time.",
      "GPU timings are optional, asynchronous, and represent the most recent 120 available samples.",
      "Volume mode uses resident textures, conservative brick skipping, and regional uploads.",
    ],
  };
  camera.position.copy(capture.cameraPosition);
  controls.enabled = true;
  controls.update();
  capture = null;
  $("benchmark").disabled = false;
  $("edit").disabled = false;
  $("reset-camera").disabled = false;
  $("export").disabled = false;
  $("capture-description").textContent =
    `Captured ${report.frameIntervalMs?.count ?? 0} intervals · p95 ${number(report.frameIntervalMs?.p95 ?? 0)} ms`;
}

async function editRegion() {
  if (!current) return;
  const view = current;
  const d = metadata.dimensions,
    size = d.map((n) => Math.max(1, Math.floor(n / 6))),
    offset = d.map((n, i) => Math.floor((n - size[i]) / 2));
  const data =
    metadata.kind === "scalar"
      ? new Float32Array(size.reduce((a, b) => a * b, 1)).fill(
          Number($("range-max").value),
        )
      : new Uint16Array(size.reduce((a, b) => a * b, 1));
  const started = performance.now();
  $("edit").disabled = true;
  try {
    await view.updateRegion({ offset, dimensions: size, data });
    await afterPaint();
    if (current !== view) return;
    metadata.edits.push({
      offset,
      dimensions: size,
      operation: "fill",
      value: data[0],
    });
    updateMs = performance.now() - started;
    report = null;
    $("export").disabled = true;
    updateMetrics();
  } catch (error) {
    if (current === view) errorMessage(error);
  } finally {
    if (current === view) $("edit").disabled = false;
  }
}

let renderingPaused = false;
function animate(now) {
  requestAnimationFrame(animate);
  if (document.hidden || renderingPaused) {
    lastFrame = null;
    return;
  }
  if (lastFrame !== null && current) {
    frameTimes.push(now - lastFrame);
    if (frameTimes.length > 120) frameTimes.shift();
  }
  lastFrame = now;
  if (capture) {
    if (capture.previous !== null) capture.frames.push(now - capture.previous);
    capture.previous = now;
    const angle = ((now - capture.started) / 10000) * Math.PI * 2;
    camera.position.set(
      target.x + Math.cos(angle) * fitDistance,
      target.y + fitDistance * 0.45,
      target.z + Math.sin(angle) * fitDistance,
    );
    camera.lookAt(target);
  } else controls.update();
  timer.poll();
  if (frame % 4 === 0) timer.begin();
  const start = performance.now();
  renderer.render(scene, camera);
  const cpuMs = performance.now() - start;
  timer.end();
  if (capture) {
    capture.cpu.push(cpuMs);
    if (now - capture.started >= 10000) finishCapture();
  }
  if (frame++ % 15 === 0) updateMetrics();
}

function initialize() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0x0d1721, 0);
  $("viewport").appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  timer = new GpuTimer(renderer);
  new ResizeObserver(() => {
    const { width, height } = $("viewport").getBoundingClientRect();
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }).observe($("viewport"));
  renderer.domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    errorMessage(
      new Error(
        "The graphics context was lost. Reload the page to restart the viewer.",
      ),
    );
  });
  $("dataset-form").addEventListener("submit", (event) => {
    event.preventDefault();
    loadPromise = loadDataset();
  });
  $("cancel").onclick = () => controller?.abort();
  $("raw-file").onchange = () => {
    const file = $("raw-file").files[0];
    if (file) loadPromise = loadDataset(file);
  };
  $("reset-camera").onclick = fitCamera;
  $("edit").onclick = editRegion;
  $("benchmark").onclick = beginCapture;
  $("export").onclick = () => {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "urath-benchmark.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $("render-mode").onchange = () => {
    if (metadata?.kind === "scalar" && $("render-mode").value !== "surface") {
      try {
        applyVolumeControls();
        clearError();
      } catch (error) {
        errorMessage(error);
      }
    } else if ($("render-mode").value !== "surface") {
      $("dataset").value = "phantom";
      loadPromise = loadDataset();
    } else if (metadata?.kind === "scalar") {
      $("dataset").value = "model";
      loadPromise = loadDataset();
    }
  };
  $("material-backend").onchange = () => {
    if (metadata?.kind === "material")
      loadPromise = loadDataset(
        metadata.fixture === null ? $("raw-file").files[0] : undefined,
      );
  };
  for (const id of [
    "quality",
    "opacity",
    "threshold",
    "clip",
    "range-min",
    "range-max",
    "transfer",
  ])
    $(id).addEventListener("input", () => {
      try {
        applyVolumeControls();
        clearError();
      } catch (error) {
        errorMessage(error);
      }
    });
  document.addEventListener("visibilitychange", () => {
    if (capture && document.hidden) {
      cancelCapture();
      $("capture-description").textContent =
        "Capture cancelled because the tab was hidden.";
    }
  });
  if (
    params.has("size") &&
    [...$("size").options].some((o) => o.value === params.get("size"))
  )
    $("size").value = params.get("size");
  if (
    params.has("dataset") &&
    [...$("dataset").options].some((o) => o.value === params.get("dataset"))
  )
    $("dataset").value = params.get("dataset");
  if (params.get("backend") === "raycast")
    $("material-backend").value = "raycast";
  if (params.has("test"))
    window.urathTest = {
      THREE: {
        Scene: THREE.Scene,
        PerspectiveCamera: THREE.PerspectiveCamera,
        OrthographicCamera: THREE.OrthographicCamera,
        WebGLRenderTarget: THREE.WebGLRenderTarget,
      },
      createSurface,
      createVolume,
      createVoxelRaycast,
      renderer,
      scene,
      camera,
      get current() {
        return current;
      },
      get report() {
        return report;
      },
      get ready() {
        return loadPromise;
      },
      loadDataset,
      pauseRendering() {
        renderingPaused = true;
        timer.clear();
      },
    };
  requestAnimationFrame(animate);
  loadPromise = loadDataset();
}

try {
  initialize();
} catch (error) {
  setBusy(false);
  errorMessage(error);
}
