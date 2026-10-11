import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Data3DTexture,
  Group,
  Mesh,
  NearestFilter,
  RedIntegerFormat,
  UnsignedShortType,
  ShaderMaterial,
} from "three";
import type { ColorRepresentation } from "three";
import { createPalette, DEFAULT_PALETTE } from "./palette.js";
import {
  affectedChunks,
  copyRegion,
  dimensionsOf,
  memoryBudget,
  snapshotChunk,
  validateGrid,
  validateRegion,
  workerReservation,
} from "./data.js";
import type { GridMetadata, RegionUpdate, Vec3 } from "./data.js";
import { meshBytes } from "./protocol.js";
import type { MeshReply, WorkerReply } from "./protocol.js";

export interface SurfaceOptions extends GridMetadata {
  data: Uint16Array;
  /** Palette indexed by material ID; 0 is always empty. IDs wrap the palette. */
  palette?: readonly ColorRepresentation[];
  chunkSize?: 8 | 16 | 32;
  workers?: number;
  /** Budget for owned data, reserved worker buffers, and CPU/GPU geometry estimates. */
  maxMemoryBytes?: number;
  workerUrl?: string | URL;
  wasmUrl?: string;
  signal?: AbortSignal;
  onProgress?: (stats: SurfaceStats) => void;
}

export interface SurfaceStats {
  inputBytes: number;
  geometryBytes: number;
  materialBytes: number;
  gpuBytes: number;
  managedBytes: number;
  peakManagedBytes: number;
  budgetBytes: number;
  workerReservedBytes: number;
  workers: number;
  activeJobs: number;
  pendingChunks: number;
  totalChunks: number;
  completedChunks: number;
  triangles: number;
  meshJobs: number;
  discardedJobs: number;
  totalMeshMs: number;
}

interface Slot {
  worker: Worker;
  busy: boolean;
  blocks: Uint16Array;
  borders: Uint16Array;
  timeout?: ReturnType<typeof setTimeout>;
  rejectInit?: (reason: Error) => void;
}
interface Waiter {
  resolve: () => void;
  reject: (reason: Error) => void;
}
interface ChunkMesh {
  mesh: Mesh<BufferGeometry, ShaderMaterial>;
  bytes: number;
  triangles: number;
  texture?: Data3DTexture;
}

function materialTexture(
  data: Uint16Array<ArrayBuffer>,
  size: number,
): Data3DTexture {
  const texture = new Data3DTexture(data, size, size, size);
  texture.format = RedIntegerFormat;
  texture.type = UnsignedShortType;
  texture.internalFormat = "R16UI";
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function surfaceMaterial(palette: readonly ColorRepresentation[]): {
  material: ShaderMaterial;
  texture: DataTexture;
} {
  const texture = createPalette(palette);
  const { width, height } = texture.image;
  const material = new ShaderMaterial({
    uniforms: {
      palette: { value: texture },
      paletteWidth: { value: width },
      paletteHeight: { value: height },
      paletteCount: { value: palette.length },
      materialId: { value: 1 },
      materialData: { value: null },
    },
    vertexShader: `
      attribute float ao;
      attribute vec4 cellBounds;
      flat varying vec4 vBounds;
      flat varying vec3 vFace;
      varying float vAo;
      varying vec3 vVoxel;
      varying vec3 vNormal;
      void main() {
        vAo = ao; vVoxel = position - normal * 0.001;
        vBounds = cellBounds; vFace = normal;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D palette;
      precision highp usampler3D;
      uniform usampler3D materialData;
      uniform float materialId;
      uniform float paletteWidth, paletteHeight, paletteCount;
      varying float vAo;
      varying vec3 vVoxel;
      flat varying vec4 vBounds;
      flat varying vec3 vFace;
      varying vec3 vNormal;
      void main() {
        float voxelId = materialId;
        if (materialId == 0.0) {
          vec3 cell = floor(vVoxel);
          if (vFace.x != 0.0) cell.yz = clamp(cell.yz, vBounds.xy, vBounds.zw);
          else if (vFace.y != 0.0) cell.xz = clamp(cell.xz, vBounds.xy, vBounds.zw);
          else cell.xy = clamp(cell.xy, vBounds.xy, vBounds.zw);
          voxelId = float(texelFetch(materialData, ivec3(cell), 0).r);
        }
        float id = mod(voxelId, paletteCount);
        vec2 uv = vec2((mod(id, paletteWidth) + 0.5) / paletteWidth, (floor(id / paletteWidth) + 0.5) / paletteHeight);
        vec3 color = texture2D(palette, uv).rgb;
        float light = 0.45 + 0.55 * max(dot(normalize(vNormal), normalize(vec3(0.4, 0.7, 0.6))), 0.0);
        gl_FragColor = vec4(color * light * (0.4 + 0.6 * vAo), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  return { material, texture };
}

/** A caller-owned Three.js group. Use dispose() to release workers and GPU resources. */
export class VoxelSurface extends Group {
  readonly dimensions: Vec3;
  readonly chunkSize: number;
  private data: Uint16Array;
  private readonly slots: Slot[] = [];
  private readonly dirty = new Set<string>();
  private readonly versions = new Map<string, number>();
  private readonly completed = new Set<string>();
  private readonly meshes = new Map<string, ChunkMesh>();
  private readonly waiters: Waiter[] = [];
  private readonly material: ShaderMaterial;
  private readonly palette: DataTexture;
  private readonly emptyMaterials = materialTexture(new Uint16Array([1]), 1);
  private readonly budget: number;
  private readonly reserved: number;
  private readonly workerCount: number;
  private readonly total: number;
  private readonly onProgress?: (stats: SurfaceStats) => void;
  private readonly signal?: AbortSignal;
  private initialized = false;
  private disposed = false;
  private failure?: Error;
  private geometryBytes = 0;
  private materialBytes = 0;
  private triangleCount = 0;
  private jobCount = 0;
  private discarded = 0;
  private meshMs = 0;
  private peak = 0;
  private readonly abort = (): void =>
    this.dispose(new Error("surface operation aborted"));

  private constructor(options: SurfaceOptions) {
    super();
    if (!(options.data instanceof Uint16Array))
      throw new TypeError("surface data must be a Uint16Array of material IDs");
    validateGrid(options.data, options);
    if (typeof Worker === "undefined")
      throw new Error("voxel surfaces require browser Web Workers");
    if (options.signal?.aborted) throw new Error("surface operation aborted");
    this.dimensions = dimensionsOf(options.dimensions);
    this.chunkSize = options.chunkSize ?? 16;
    if (![8, 16, 32].includes(this.chunkSize))
      throw new RangeError("chunkSize must be 8, 16, or 32");
    this.budget = memoryBudget(options.maxMemoryBytes);
    const perWorker = workerReservation(this.chunkSize);
    const available = Math.floor(
      (this.budget - options.data.byteLength - 512 * 1024) / perWorker,
    );
    this.workerCount =
      options.workers ??
      Math.min(
        2,
        Math.max(1, (navigator.hardwareConcurrency || 2) - 1),
        available,
      );
    if (
      !Number.isInteger(this.workerCount) ||
      this.workerCount < 1 ||
      this.workerCount > 8
    )
      throw new RangeError(
        "budget must accommodate at least one worker; workers must be 1–8",
      );
    this.reserved = this.workerCount * perWorker;
    if (options.data.byteLength + this.reserved + 512 * 1024 > this.budget)
      throw new RangeError(
        "input and worker reservation exceed maxMemoryBytes",
      );
    const shading = surfaceMaterial(options.palette ?? DEFAULT_PALETTE);
    this.material = shading.material;
    this.palette = shading.texture;
    this.data = new Uint16Array(options.data);
    this.scale.fromArray(options.spacing ?? [1, 1, 1]);
    this.position.fromArray(options.origin ?? [0, 0, 0]);
    this.name = "Urath surface";
    this.onProgress = options.onProgress;
    this.signal = options.signal;
    this.signal?.addEventListener("abort", this.abort, { once: true });
    const [w, h, d] = this.dimensions.map((n) => Math.ceil(n / this.chunkSize));
    this.total = w! * h! * d!;
    for (let z = 0; z < d!; z++)
      for (let y = 0; y < h!; y++)
        for (let x = 0; x < w!; x++) this.mark(`${x},${y},${z}`);
    this.peak = this.stats.managedBytes;
  }

  static async create(options: SurfaceOptions): Promise<VoxelSurface> {
    const surface = new VoxelSurface(options);
    try {
      await Promise.all(
        Array.from({ length: surface.workerCount }, () =>
          surface.startWorker(options.workerUrl, options.wasmUrl),
        ),
      );
      if (surface.disposed)
        throw surface.failure ?? new Error("surface disposed");
      surface.initialized = true;
      await surface.flush();
      return surface;
    } catch (error) {
      surface.dispose(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  get stats(): SurfaceStats {
    const paletteBytes = this.disposed ? 0 : this.palette.image.data.byteLength;
    const managed =
      this.data.byteLength +
      (this.disposed ? 0 : this.reserved) +
      2 *
        (this.geometryBytes +
          this.materialBytes +
          paletteBytes +
          (this.disposed ? 0 : 2));
    return {
      inputBytes: this.data.byteLength,
      geometryBytes: this.geometryBytes,
      materialBytes: this.materialBytes,
      gpuBytes:
        this.geometryBytes +
        this.materialBytes +
        paletteBytes +
        (this.disposed ? 0 : 2),
      managedBytes: managed,
      peakManagedBytes: Math.max(this.peak, managed),
      budgetBytes: this.budget,
      workerReservedBytes: this.disposed ? 0 : this.reserved,
      workers: this.disposed ? 0 : this.workerCount,
      activeJobs: this.slots.filter((slot) => slot.busy).length,
      pendingChunks: this.dirty.size,
      totalChunks: this.total,
      completedChunks: this.completed.size,
      triangles: this.triangleCount,
      meshJobs: this.jobCount,
      discardedJobs: this.discarded,
      totalMeshMs: this.meshMs,
    };
  }

  /** Copy a region and remesh affected bricks plus their one-voxel neighbourhood. */
  updateRegion(update: RegionUpdate<Uint16Array>): Promise<void> {
    if (this.disposed)
      return Promise.reject(this.failure ?? new Error("surface disposed"));
    if (!(update.data instanceof Uint16Array))
      return Promise.reject(
        new TypeError("surface updates require Uint16Array"),
      );
    try {
      validateRegion(this.dimensions, update);
    } catch (error) {
      return Promise.reject(error);
    }
    copyRegion(this.data, this.dimensions, update);
    for (const key of affectedChunks(
      update.offset,
      update.dimensions,
      this.dimensions,
      this.chunkSize,
    ))
      this.mark(key);
    return this.flush();
  }

  /** Resolves when all currently coalesced edits are meshed, or rejects on failure/disposal. */
  flush(): Promise<void> {
    if (this.disposed)
      return Promise.reject(this.failure ?? new Error("surface disposed"));
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.pump();
    });
  }

  dispose(reason = new Error("surface disposed")): void {
    if (this.disposed) return;
    this.failure = reason;
    this.disposed = true;
    this.signal?.removeEventListener("abort", this.abort);
    for (const slot of this.slots) {
      clearTimeout(slot.timeout);
      slot.rejectInit?.(reason);
      slot.worker.terminate();
    }
    this.slots.length = 0;
    for (const { mesh, texture } of this.meshes.values()) {
      mesh.geometry.dispose();
      texture?.dispose();
      this.remove(mesh);
    }
    this.meshes.clear();
    this.dirty.clear();
    this.versions.clear();
    this.completed.clear();
    this.material.dispose();
    this.palette.dispose();
    this.emptyMaterials.dispose();
    this.material.uniforms.materialData!.value = null;
    this.palette.image.data = new Uint8Array(0);
    this.data = new Uint16Array(0);
    this.geometryBytes = 0;
    this.materialBytes = 0;
    this.triangleCount = 0;
    this.removeFromParent();
    for (const waiter of this.waiters.splice(0)) waiter.reject(reason);
  }

  private mark(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.dirty.add(key);
  }

  private startWorker(url?: string | URL, wasmUrl?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = url
        ? new Worker(url, { type: "module" })
        : new Worker(new URL("./worker.js", import.meta.url), {
            type: "module",
          });
      const slot: Slot = {
        worker,
        busy: false,
        blocks: new Uint16Array(this.chunkSize ** 3),
        borders: new Uint16Array(6 * this.chunkSize ** 2),
        rejectInit: reject,
      };
      this.slots.push(slot);
      const fail = (message: string): void => {
        const error = new Error(message);
        reject(error);
        this.dispose(error);
      };
      slot.timeout = setTimeout(
        () => fail("voxel worker initialization timed out"),
        30000,
      );
      worker.onerror = (event) =>
        fail(
          `voxel worker failed: ${event.message || "script could not load"}`,
        );
      worker.onmessageerror = () =>
        fail("voxel worker returned an unreadable message");
      worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
        if (this.disposed) return;
        clearTimeout(slot.timeout);
        if (data.type === "error") {
          fail(data.error);
          return;
        }
        if (data.type === "ready") {
          slot.rejectInit = undefined;
          resolve();
          return;
        }
        slot.busy = false;
        slot.blocks = data.blocks;
        slot.borders = data.borders;
        try {
          this.receive(data);
          this.pump();
        } catch (error) {
          fail(String(error));
        }
      };
      worker.postMessage({ type: "init", size: this.chunkSize, wasmUrl });
    });
  }

  private receive(reply: MeshReply): void {
    this.jobCount++;
    this.meshMs += reply.meshMs;
    if (reply.error || !reply.mesh)
      throw new Error(reply.error ?? "missing mesh buffers");
    if (reply.version !== this.versions.get(reply.key)) {
      this.discarded++;
      return;
    }
    const old = this.meshes.get(reply.key);
    const bytes = meshBytes(reply.mesh);
    const materialBytes = reply.materials?.byteLength ?? 0;
    // Reserve replacement geometry before disposing the old one, accounting for overlap.
    const peak = this.stats.managedBytes + 2 * (bytes + materialBytes);
    if (peak > this.budget)
      throw new RangeError(
        `mesh exceeds memory budget (${Math.ceil(peak / 1048576)} MiB estimated); use simpler data, smaller chunks, or a larger budget`,
      );
    this.peak = Math.max(this.peak, peak);
    if (old) {
      this.remove(old.mesh);
      old.mesh.geometry.dispose();
      if (old.texture) {
        this.materialBytes -= old.texture.image.data.byteLength;
        old.texture.dispose();
      }
      this.meshes.delete(reply.key);
      this.geometryBytes -= old.bytes;
      this.triangleCount -= old.triangles;
    }
    if (reply.mesh.indices.length) {
      const data = reply.mesh;
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(data.positions, 3));
      geometry.setAttribute(
        "normal",
        new BufferAttribute(data.normals, 3, true),
      );
      geometry.setAttribute("ao", new BufferAttribute(data.ao, 1, true));
      geometry.setAttribute("cellBounds", new BufferAttribute(data.bounds, 4));
      geometry.setIndex(new BufferAttribute(data.indices, 1));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mesh = new Mesh(geometry, this.material);
      const texture = reply.materials
        ? materialTexture(reply.materials, this.chunkSize)
        : undefined;
      const materialId = reply.materialId ?? 1;
      mesh.onBeforeRender = () => {
        this.material.uniforms.materialData!.value =
          texture ?? this.emptyMaterials;
        this.material.uniforms.materialId!.value = materialId;
        this.material.uniformsNeedUpdate = true;
      };
      const [x, y, z] = reply.key.split(",").map(Number);
      mesh.position.set(
        x! * this.chunkSize,
        y! * this.chunkSize,
        z! * this.chunkSize,
      );
      mesh.name = `chunk:${reply.key}`;
      this.add(mesh);
      const triangles = data.indices.length / 3;
      this.meshes.set(reply.key, { mesh, bytes, triangles, texture });
      this.geometryBytes += bytes;
      this.materialBytes += materialBytes;
      this.triangleCount += triangles;
    }
    this.completed.add(reply.key);
  }

  private pump(): void {
    if (!this.initialized || this.disposed) return;
    for (const slot of this.slots) {
      if (slot.busy || this.dirty.size === 0) continue;
      const key = this.dirty.values().next().value!;
      this.dirty.delete(key);
      const coordinates = key
        .split(",")
        .map((n) => Number(n) * this.chunkSize) as [number, number, number];
      snapshotChunk(
        this.data,
        this.dimensions,
        coordinates,
        this.chunkSize,
        slot.blocks,
        slot.borders,
      );
      slot.busy = true;
      slot.timeout = setTimeout(
        () => this.dispose(new Error("voxel meshing job timed out")),
        30000,
      );
      slot.worker.postMessage(
        {
          type: "mesh",
          key,
          version: this.versions.get(key)!,
          blocks: slot.blocks,
          borders: slot.borders,
        },
        [slot.blocks.buffer, slot.borders.buffer],
      );
    }
    this.onProgress?.(this.stats);
    if (this.dirty.size === 0 && this.slots.every((slot) => !slot.busy)) {
      for (const waiter of this.waiters.splice(0)) waiter.resolve();
    }
  }
}

export const createSurface = (options: SurfaceOptions): Promise<VoxelSurface> =>
  VoxelSurface.create(options);
