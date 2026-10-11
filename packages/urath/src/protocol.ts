export interface MeshBuffers {
  positions: Uint8Array;
  normals: Int8Array;
  ao: Uint8Array;
  bounds: Uint8Array;
  indices: Uint16Array | Uint32Array;
}

export interface MeshRequest {
  type: "mesh";
  key: string;
  version: number;
  blocks: Uint16Array;
  borders: Uint16Array;
}

export interface InitRequest {
  type: "init";
  size: number;
  wasmUrl?: string;
}
export interface MeshReply extends MeshRequest {
  mesh?: MeshBuffers;
  /** Zero means this chunk needs per-voxel material lookup. */
  materialId?: number;
  materials?: Uint16Array<ArrayBuffer>;
  error?: string;
  meshMs: number;
}
export interface ReadyReply {
  type: "ready";
}
export interface ErrorReply {
  type: "error";
  error: string;
}
export type WorkerReply = MeshReply | ReadyReply | ErrorReply;

export function meshBytes(mesh: MeshBuffers): number {
  return (
    mesh.positions.byteLength +
    mesh.normals.byteLength +
    mesh.ao.byteLength +
    mesh.bounds.byteLength +
    mesh.indices.byteLength
  );
}
