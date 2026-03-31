// Mesh worker: handles terrain generation + meshing off the main thread.
// Each worker has its own WASM instance and mesher objects.

import init, {
  WasmChunk, WasmChunkNeighbors, WasmGreedyMesher,
  WasmSurfaceNetsMesher, WasmTerrainGenerator,
} from './pkg/urath_wasm.js';

const CHUNK_SIZE = 32;
const WORLD_HEIGHT_CHUNKS = 8;

// Face direction constants matching Rust Face enum
const FACE_POS_X = 0;
const FACE_NEG_X = 1;
const FACE_POS_Y = 2;
const FACE_NEG_Y = 3;
const FACE_POS_Z = 4;
const FACE_NEG_Z = 5;

let greedyMesher = null;
let smoothMesher = null;
let terrainGen = null;
let ready = false;

async function initialize() {
  await init();
  greedyMesher = new WasmGreedyMesher(CHUNK_SIZE);
  smoothMesher = new WasmSurfaceNetsMesher(CHUNK_SIZE);
  terrainGen = new WasmTerrainGenerator();
  ready = true;
  self.postMessage({ type: 'ready' });
}

// Extract opaque + transparent mesh data from a WasmMeshResult into a slice object.
function extractSlice(result, cy) {
  const opaque = !result.is_empty() ? {
    positions: new Float32Array(result.positions()),
    normals: new Float32Array(result.normals()),
    ao: new Float32Array(result.ao()),
    blockIds: new Float32Array(result.block_ids()),
    uvs: new Float32Array(result.uvs()),
    indices: new Uint32Array(result.indices()),
    vc: result.vertex_count(),
    ic: result.index_count(),
  } : null;

  const transparent = result.has_transparent() ? {
    positions: new Float32Array(result.transparent_positions()),
    normals: new Float32Array(result.transparent_normals()),
    ao: new Float32Array(result.transparent_ao()),
    blockIds: new Float32Array(result.transparent_block_ids()),
    uvs: new Float32Array(result.transparent_uvs()),
    indices: new Uint32Array(result.transparent_indices()),
    vc: result.transparent_vertex_count(),
    ic: result.transparent_index_count(),
  } : null;

  return { cy, opaque, transparent };
}

// Merge per-chunk slices into a single column mesh, applying Y offsets.
function mergeSlices(slices, key) {
  let totalVerts = 0;
  let totalIdx = 0;
  for (const s of slices) {
    const data = s[key];
    if (data) {
      totalVerts += data.vc;
      totalIdx += data.ic;
    }
  }
  if (totalVerts === 0) return null;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const ao = new Float32Array(totalVerts);
  const blockIds = new Float32Array(totalVerts);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalIdx);

  let vOff = 0;
  let iOff = 0;

  for (const s of slices) {
    const data = s[key];
    if (!data) continue;

    const yOffset = s.cy * CHUNK_SIZE;
    const base3 = vOff * 3;

    positions.set(data.positions, base3);
    if (yOffset !== 0) {
      for (let i = 1; i < data.positions.length; i += 3) {
        positions[base3 + i] += yOffset;
      }
    }

    normals.set(data.normals, base3);
    ao.set(data.ao, vOff);
    blockIds.set(data.blockIds, vOff);
    uvs.set(data.uvs, vOff * 2);

    const idx = data.indices;
    for (let i = 0; i < idx.length; i++) {
      indices[iOff + i] = idx[i] + vOff;
    }

    vOff += data.vc;
    iOff += data.ic;
  }

  return { positions, normals, ao, blockIds, uvs, indices };
}

// Generate terrain + mesh a full column, return transferable buffers.
function generateAndMeshColumn(cx, cz, neighborBorders, mesherMode) {
  const mesher = mesherMode === 'smooth' ? smoothMesher : greedyMesher;

  // 1. Generate all Y-chunks
  const chunks = [];
  for (let cy = 0; cy < WORLD_HEIGHT_CHUNKS; cy++) {
    chunks.push(terrainGen.generate(cx, cy, cz));
  }

  // 2. Extract borders from all chunks (for future neighbor requests)
  const borders = {};
  for (let cy = 0; cy < WORLD_HEIGHT_CHUNKS; cy++) {
    const chunk = chunks[cy];
    const key = `${cx},${cy},${cz}`;
    borders[key] = {};
    for (let face = 0; face < 6; face++) {
      const border = chunk.extract_border(face);
      // Copy since the Uint16Array is a WASM view
      borders[key][face] = new Uint16Array(border);
    }
  }

  // 3. Also extract block data (for main thread editing)
  const blockData = {};
  for (let cy = 0; cy < WORLD_HEIGHT_CHUNKS; cy++) {
    const key = `${cx},${cy},${cz}`;
    const blocks = chunks[cy].get_blocks();
    blockData[key] = new Uint16Array(blocks);
  }

  // 4. Mesh each Y-chunk with neighbors
  const slices = [];

  for (let cy = 0; cy < WORLD_HEIGHT_CHUNKS; cy++) {
    const chunk = chunks[cy];
    const neighbors = new WasmChunkNeighbors(CHUNK_SIZE);

    // Y neighbors from within this column
    if (cy + 1 < WORLD_HEIGHT_CHUNKS) {
      neighbors.set_neighbor(FACE_POS_Y, chunks[cy + 1]);
    }
    if (cy > 0) {
      neighbors.set_neighbor(FACE_NEG_Y, chunks[cy - 1]);
    }

    // X/Z neighbors from main thread border data
    const setFromBorders = (face, neighborKey, oppositeFace) => {
      if (neighborBorders[neighborKey] && neighborBorders[neighborKey][oppositeFace]) {
        neighbors.set_neighbor_border(face, neighborBorders[neighborKey][oppositeFace]);
      }
    };

    setFromBorders(FACE_POS_X, `${cx + 1},${cy},${cz}`, FACE_NEG_X);
    setFromBorders(FACE_NEG_X, `${cx - 1},${cy},${cz}`, FACE_POS_X);
    setFromBorders(FACE_POS_Z, `${cx},${cy},${cz + 1}`, FACE_NEG_Z);
    setFromBorders(FACE_NEG_Z, `${cx},${cy},${cz - 1}`, FACE_POS_Z);

    const result = mesher.mesh_with_neighbors(chunk, neighbors);
    neighbors.free();

    slices.push(extractSlice(result, cy));
    result.free();
  }

  // Free chunks
  for (const chunk of chunks) {
    chunk.free();
  }

  // 5. Merge column (opaque + transparent separately)
  const mesh = mergeSlices(slices, 'opaque');
  const transparentMesh = mergeSlices(slices, 'transparent');

  return { mesh, transparentMesh, borders, blockData };
}

// Remesh a column from existing block data (for editing or neighbor updates)
function remeshColumn(cx, cz, allBlockData, neighborBorders, mesherMode) {
  const mesher = mesherMode === 'smooth' ? smoothMesher : greedyMesher;

  // Recreate chunks from block data
  const chunks = [];
  for (let cy = 0; cy < WORLD_HEIGHT_CHUNKS; cy++) {
    const key = `${cx},${cy},${cz}`;
    const chunk = new WasmChunk(CHUNK_SIZE);
    if (allBlockData[key]) {
      chunk.set_all_blocks(allBlockData[key]);
    }
    chunks.push(chunk);
  }

  // Extract updated borders
  const borders = {};
  for (let cy = 0; cy < WORLD_HEIGHT_CHUNKS; cy++) {
    const key = `${cx},${cy},${cz}`;
    borders[key] = {};
    for (let face = 0; face < 6; face++) {
      borders[key][face] = new Uint16Array(chunks[cy].extract_border(face));
    }
  }

  // Mesh each Y-chunk
  const slices = [];

  for (let cy = 0; cy < WORLD_HEIGHT_CHUNKS; cy++) {
    const chunk = chunks[cy];
    const neighbors = new WasmChunkNeighbors(CHUNK_SIZE);

    if (cy + 1 < WORLD_HEIGHT_CHUNKS) neighbors.set_neighbor(FACE_POS_Y, chunks[cy + 1]);
    if (cy > 0) neighbors.set_neighbor(FACE_NEG_Y, chunks[cy - 1]);

    const setFromBorders = (face, neighborKey, oppositeFace) => {
      if (neighborBorders[neighborKey] && neighborBorders[neighborKey][oppositeFace]) {
        neighbors.set_neighbor_border(face, neighborBorders[neighborKey][oppositeFace]);
      }
    };

    setFromBorders(FACE_POS_X, `${cx + 1},${cy},${cz}`, FACE_NEG_X);
    setFromBorders(FACE_NEG_X, `${cx - 1},${cy},${cz}`, FACE_POS_X);
    setFromBorders(FACE_POS_Z, `${cx},${cy},${cz + 1}`, FACE_NEG_Z);
    setFromBorders(FACE_NEG_Z, `${cx},${cy},${cz - 1}`, FACE_POS_Z);

    const result = mesher.mesh_with_neighbors(chunk, neighbors);
    neighbors.free();

    slices.push(extractSlice(result, cy));
    result.free();
  }

  for (const chunk of chunks) chunk.free();

  const mesh = mergeSlices(slices, 'opaque');
  const transparentMesh = mergeSlices(slices, 'transparent');

  return { mesh, transparentMesh, borders };
}

// Collect transferable ArrayBuffers from a result
function getTransferables(result) {
  const list = [];
  for (const m of [result.mesh, result.transparentMesh]) {
    if (m) {
      list.push(
        m.positions.buffer,
        m.normals.buffer,
        m.ao.buffer,
        m.blockIds.buffer,
        m.uvs.buffer,
        m.indices.buffer,
      );
    }
  }
  return list;
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'generate') {
    if (!ready) await initialize();
    const { cx, cz, neighborBorders, mesherMode, requestId } = msg;
    const result = generateAndMeshColumn(cx, cz, neighborBorders, mesherMode);
    const transferables = getTransferables(result);
    self.postMessage({
      type: 'columnReady',
      cx, cz, requestId,
      mesh: result.mesh,
      transparentMesh: result.transparentMesh,
      borders: result.borders,
      blockData: result.blockData,
    }, transferables);
  }

  if (msg.type === 'remesh') {
    if (!ready) await initialize();
    const { cx, cz, blockData, neighborBorders, mesherMode, requestId } = msg;
    const result = remeshColumn(cx, cz, blockData, neighborBorders, mesherMode);
    const transferables = getTransferables(result);
    self.postMessage({
      type: 'remeshReady',
      cx, cz, requestId,
      mesh: result.mesh,
      transparentMesh: result.transparentMesh,
      borders: result.borders,
    }, transferables);
  }
};

initialize().catch((err) => {
  console.error('Worker initialization failed:', err);
  self.postMessage({ type: 'error', message: String(err) });
});
