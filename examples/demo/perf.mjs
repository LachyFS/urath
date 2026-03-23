#!/usr/bin/env node
/**
 * Headless WASM performance benchmark.
 * Measures terrain generation and meshing without any rendering.
 *
 * Usage:
 *   node perf.mjs              # default settings
 *   node perf.mjs --radius 8   # larger area
 *   node perf.mjs --seed 42    # custom seed
 *   node perf.mjs --height 4   # fewer vertical chunks
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse args ──
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && i + 1 < args.length ? Number(args[i + 1]) : fallback;
}

const CHUNK_SIZE = 32;
const RADIUS = flag('radius', 6);
const HEIGHT_CHUNKS = flag('height', 8);
const SEED = flag('seed', 0); // 0 = default

// ── Load WASM ──
const wasmPath = join(__dirname, 'pkg', 'urath_wasm_bg.wasm');
const wasmBytes = readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);

// The wasm-bindgen JS glue uses browser APIs (TextEncoder/Decoder).
// Node 18+ has them globally, but import just in case.
const { initSync, WasmChunk, WasmChunkNeighbors, WasmGreedyMesher, WasmTerrainGenerator } = await import('./pkg/urath_wasm.js');
initSync({ module: wasmModule });

// Face constants
const FACE_POS_X = 0, FACE_NEG_X = 1;
const FACE_POS_Y = 2, FACE_NEG_Y = 3;
const FACE_POS_Z = 4, FACE_NEG_Z = 5;

// ── Helpers ──
function key(cx, cy, cz) { return `${cx},${cy},${cz}`; }
function colKey(cx, cz) { return `${cx},${cz}`; }

function stats(arr) {
  if (arr.length === 0) return { count: 0, total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = arr.slice().sort((a, b) => a - b);
  const total = sorted.reduce((s, v) => s + v, 0);
  const pct = (p) => sorted[Math.floor(sorted.length * p)] || 0;
  return {
    count: sorted.length,
    total,
    avg: total / sorted.length,
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    max: sorted[sorted.length - 1],
  };
}

function f(n) { return n.toFixed(2); }

// ── Determine columns ──
const columns = [];
for (let dz = -RADIUS; dz <= RADIUS; dz++) {
  for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    if (dx * dx + dz * dz <= RADIUS * RADIUS) {
      columns.push([dx, dz]);
    }
  }
}

console.log(`[perf] Benchmark: radius=${RADIUS}, height=${HEIGHT_CHUNKS}, seed=${SEED || 'default'}`);
console.log(`[perf] Columns: ${columns.length}, Chunks: ${columns.length * HEIGHT_CHUNKS}`);
console.log('');

// ── Phase 1: Terrain generation ──
const terrainGen = SEED ? WasmTerrainGenerator.with_seed(SEED) : new WasmTerrainGenerator();
const chunkData = new Map();
const genTimes = [];

const genStart = performance.now();
for (const [cx, cz] of columns) {
  for (let cy = 0; cy < HEIGHT_CHUNKS; cy++) {
    const t0 = performance.now();
    chunkData.set(key(cx, cy, cz), terrainGen.generate(cx, cy, cz));
    genTimes.push(performance.now() - t0);
  }
}
const genWall = performance.now() - genStart;

const genS = stats(genTimes);
console.log(`[perf] === TERRAIN GEN (${genS.count} chunks) ===`);
console.log(`[perf]   wall: ${f(genWall)}ms`);
console.log(`[perf]   avg: ${f(genS.avg)}ms  p50: ${f(genS.p50)}ms  p95: ${f(genS.p95)}ms  p99: ${f(genS.p99)}ms  max: ${f(genS.max)}ms`);
console.log('');

// ── Phase 2: Meshing ──
const mesher = new WasmGreedyMesher(CHUNK_SIZE);
const meshTimes = [];
let totalVerts = 0;
let totalTris = 0;

const meshStart = performance.now();
for (const [cx, cz] of columns) {
  const t0 = performance.now();

  for (let cy = 0; cy < HEIGHT_CHUNKS; cy++) {
    const chunk = chunkData.get(key(cx, cy, cz));
    if (!chunk) continue;

    const neighbors = new WasmChunkNeighbors(CHUNK_SIZE);
    const px = chunkData.get(key(cx + 1, cy, cz));
    const nx = chunkData.get(key(cx - 1, cy, cz));
    const py = chunkData.get(key(cx, cy + 1, cz));
    const ny = chunkData.get(key(cx, cy - 1, cz));
    const pz = chunkData.get(key(cx, cy, cz + 1));
    const nz = chunkData.get(key(cx, cy, cz - 1));
    if (px) neighbors.set_neighbor(FACE_POS_X, px);
    if (nx) neighbors.set_neighbor(FACE_NEG_X, nx);
    if (py) neighbors.set_neighbor(FACE_POS_Y, py);
    if (ny) neighbors.set_neighbor(FACE_NEG_Y, ny);
    if (pz) neighbors.set_neighbor(FACE_POS_Z, pz);
    if (nz) neighbors.set_neighbor(FACE_NEG_Z, nz);

    const result = mesher.mesh_with_neighbors(chunk, neighbors);
    neighbors.free();

    if (!result.is_empty()) {
      totalVerts += result.vertex_count();
      totalTris += result.index_count() / 3;
    }
    result.free();
  }

  meshTimes.push(performance.now() - t0);
}
const meshWall = performance.now() - meshStart;

const meshS = stats(meshTimes);
console.log(`[perf] === MESHING (${meshS.count} columns) ===`);
console.log(`[perf]   wall: ${f(meshWall)}ms`);
console.log(`[perf]   avg: ${f(meshS.avg)}ms  p50: ${f(meshS.p50)}ms  p95: ${f(meshS.p95)}ms  p99: ${f(meshS.p99)}ms  max: ${f(meshS.max)}ms`);
console.log(`[perf]   output: ${totalVerts.toLocaleString()} verts, ${Math.round(totalTris).toLocaleString()} tris`);
console.log('');

// ── Summary ──
const totalWall = genWall + meshWall;
console.log(`[perf] === TOTAL ===`);
console.log(`[perf]   gen: ${f(genWall)}ms + mesh: ${f(meshWall)}ms = ${f(totalWall)}ms`);
console.log(`[perf]   throughput: ${f(columns.length / (totalWall / 1000))} columns/sec`);

// Cleanup
for (const chunk of chunkData.values()) chunk.free();
terrainGen.free();
mesher.free();
