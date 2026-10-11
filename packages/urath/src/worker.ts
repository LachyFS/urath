import init, { WasmMeshSession } from "../wasm/urath_wasm.js";
import type {
  InitRequest,
  MeshRequest,
  WorkerReply,
  MeshBuffers,
} from "./protocol.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<InitRequest | MeshRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
}
const scope = globalThis as unknown as WorkerScope;
let session: WasmMeshSession | undefined;
let occupancy = new Uint16Array(0);
scope.onmessage = async ({ data }) => {
  if (data.type === "init") {
    try {
      await init(data.wasmUrl ? { module_or_path: data.wasmUrl } : undefined);
      session?.free();
      session = new WasmMeshSession(data.size);
      occupancy = new Uint16Array(data.size ** 3);
      scope.postMessage({ type: "ready" });
    } catch (error) {
      scope.postMessage({ type: "error", error: String(error) });
    }
    return;
  }
  const start = performance.now();
  try {
    if (!session) throw new Error("mesher is not initialized");
    // Geometry depends on occupancy and AO, never on colour boundaries. Keep
    // material IDs in an integer texture only for visible, multicolour chunks.
    let materialId = 0;
    let mixed = false;
    let solid = true;
    for (let i = 0; i < data.blocks.length; i++) {
      const id = data.blocks[i]!;
      occupancy[i] = id === 0 ? 0 : 1;
      if (id === 0) solid = false;
      if (id !== 0) {
        if (materialId === 0) materialId = id;
        else if (id !== materialId) mixed = true;
      }
    }
    if (materialId === 0 || (solid && data.borders.every((id) => id !== 0))) {
      const mesh: MeshBuffers = {
        positions: new Uint8Array(0),
        normals: new Int8Array(0),
        ao: new Uint8Array(0),
        bounds: new Uint8Array(0),
        indices: new Uint16Array(0),
      };
      scope.postMessage(
        { ...data, mesh, materialId, meshMs: performance.now() - start },
        [data.blocks.buffer, data.borders.buffer] as ArrayBuffer[],
      );
      return;
    }
    session.mesh(occupancy, data.borders);
    const positions = session.positions();
    const normals = session.normals();
    const indices = session.indices();
    const bounds = new Uint8Array((positions.length / 3) * 4);
    for (let q = 0; q < positions.length / 12; q++) {
      const base = q * 12;
      const u = normals[base] !== 0 ? 1 : 0;
      const v = normals[base + 2] !== 0 ? 1 : 2;
      let minU = 255,
        minV = 255,
        maxU = 0,
        maxV = 0;
      for (let vertex = 0; vertex < 4; vertex++) {
        const p = base + vertex * 3;
        minU = Math.min(minU, positions[p + u]!);
        minV = Math.min(minV, positions[p + v]!);
        maxU = Math.max(maxU, positions[p + u]!);
        maxV = Math.max(maxV, positions[p + v]!);
      }
      for (let vertex = 0; vertex < 4; vertex++) {
        const b = q * 16 + vertex * 4;
        bounds[b] = minU;
        bounds[b + 1] = minV;
        bounds[b + 2] = maxU - 1;
        bounds[b + 3] = maxV - 1;
      }
    }
    // Chunk coordinates are integral, axis normals are exact, AO has four
    // levels. These packed attributes preserve their values without floats.
    const mesh: MeshBuffers = {
      positions: new Uint8Array(positions),
      normals: Int8Array.from(normals, (n) => n * 127),
      ao: Uint8Array.from(session.ao(), (n) => Math.round(n * 255)),
      indices:
        positions.length / 3 <= 65536 ? new Uint16Array(indices) : indices,
      bounds,
    };
    const materials =
      mixed && indices.length ? new Uint16Array(data.blocks) : undefined;
    scope.postMessage(
      {
        ...data,
        mesh,
        materials,
        materialId: mixed ? 0 : materialId,
        meshMs: performance.now() - start,
      },
      [
        data.blocks.buffer,
        data.borders.buffer,
        mesh.positions.buffer,
        mesh.normals.buffer,
        mesh.ao.buffer,
        mesh.bounds.buffer,
        mesh.indices.buffer,
        ...(materials ? [materials.buffer] : []),
      ] as ArrayBuffer[],
    );
  } catch (error) {
    scope.postMessage(
      { ...data, error: String(error), meshMs: performance.now() - start },
      [data.blocks.buffer, data.borders.buffer] as ArrayBuffer[],
    );
  }
};
