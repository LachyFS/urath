import { createGridRays, GRID_RAY_SHADER } from "./grid-rays.js";
import { TextureUploadQueue } from "./texture-upload.js";
import { VolumeTransferCache } from "./volume-transfer-cache.js";
import { TRANSFER_INDEX_SHADER } from "./volume-transfer.js";
import {
  BackSide,
  BoxGeometry,
  Data3DTexture,
  DataTexture,
  FloatType,
  Mesh,
  NearestFilter,
  RedFormat,
  RedIntegerFormat,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  UnsignedShortType,
  Vector2,
  Vector3,
} from "three";
import type { WebGLRenderer } from "three";
import {
  copyRegion,
  dimensionsOf,
  memoryBudget,
  validateGrid,
  validateRegion,
} from "./data.js";
import type { GridMetadata, RegionUpdate, Vec3 } from "./data.js";
import {
  VolumeBricks,
  VOLUME_BRICK_SIZE,
  brickMemoryBytes,
} from "./volume-bricks.js";

export type VolumeMode = "volume" | "isosurface";
export type VolumeStorage = "uint8" | "uint16" | "float32";
type ScalarArray = Float32Array | Uint8Array | Uint16Array;
export interface VolumeOptions extends GridMetadata {
  /** Scalar samples, copied without normalising their numerical values. */
  data: Float32Array | Uint8Array | Uint16Array;
  /** Preserve integer inputs losslessly by default. Float32 forces four-byte storage. */
  storage?: "auto" | "float32";
  /** Cache transfer-table indices on the GPU. Extra one byte per voxel; no scalar precision loss. */
  transferCache?: boolean;
  range?: readonly [number, number];
  mode?: VolumeMode;
  threshold?: number;
  opacity?: number;
  /** Maximum samples per ray; covering the entire ray takes priority. */
  maxSteps?: number;
  /** 256 RGBA entries, indexed by the selected scalar range. */
  transferFunction?: Uint8Array;
  clipMin?: Vec3;
  clipMax?: Vec3;
  maxMemoryBytes?: number;
  /** Skip bricks with provably zero contribution, preserving the sampling lattice. Default true. */
  emptySpaceSkipping?: boolean;
}

export interface VolumeStats {
  transferCacheBytes: number;
  transferCacheBuilds: number;
  transferCacheUpdatedVoxels: number;
  storage: VolumeStorage;
  inputBytes: number;
  gpuBytes: number;
  managedBytes: number;
  budgetBytes: number;
  textureDimensions: Vec3;
  maxSteps: number;
  accelerationBytes: number;
  uploadedBytes: number;
  fullUploads: number;
  regionUploads: number;
}

const vertexShader = `
  varying vec3 vPosition;
  void main() {
    vPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = `
  precision highp sampler3D;
  #ifdef URATH_INTEGER_SCALAR
  precision highp usampler3D;
  uniform usampler3D scalarData;
  #else
  uniform sampler3D scalarData;
  #endif
  uniform sampler3D activeBricks;
  uniform sampler2D transferData;
  uniform sampler3D transferIndices;
  uniform vec3 dimensions, clipMin, clipMax;
  ${GRID_RAY_SHADER}
  uniform vec2 valueRange;
  uniform float opacityScale, threshold;
  uniform int maxSteps;
  uniform bool skipEmpty;
  uniform mat4 modelViewMatrix, projectionMatrix;
  varying vec3 vPosition;

  ${TRANSFER_INDEX_SHADER}
  vec4 transfer(float value) { return texelFetch(transferData, ivec2(transferIndex(value), 0), 0); }
  ivec3 scalarCell(vec3 p) { return ivec3(clamp(p * dimensions, vec3(0.0), dimensions - 1.0)); }
  float scalar(vec3 p) { return float(texelFetch(scalarData, scalarCell(p), 0).r); }

  void main() {
    vec3 origin, direction; gridRay(origin, direction);
    // A finite reciprocal handles axis-aligned rays without 0 * infinity NaNs.
    vec3 safeDirection = vec3(
      abs(direction.x) < 1e-7 ? (direction.x < 0.0 ? -1e-7 : 1e-7) : direction.x,
      abs(direction.y) < 1e-7 ? (direction.y < 0.0 ? -1e-7 : 1e-7) : direction.y,
      abs(direction.z) < 1e-7 ? (direction.z < 0.0 ? -1e-7 : 1e-7) : direction.z);
    vec3 ta = (clipMin - origin) / safeDirection;
    vec3 tb = (clipMax - origin) / safeDirection;
    vec3 lo = min(ta, tb), hi = max(ta, tb);
    float enter = max(0.0, max(lo.x, max(lo.y, lo.z)));
    float leave = min(hi.x, min(hi.y, hi.z));
    if (leave <= enter) discard;
    float voxelDistance = length(direction * dimensions);
    int steps = min(maxSteps, max(1, int(ceil((leave - enter) * voxelDistance))));
    float stepSize = (leave - enter) / float(steps);
    vec4 accumulated = vec4(0.0);
    int i = 0;
    int nextBrickSample = 0;
    for (int iteration = 0; iteration < 2048; iteration++) {
      if (i >= steps) break;
      vec3 p = origin + direction * (enter + (float(i) + 0.5) * stepSize);
      if (skipEmpty && i >= nextBrickSample) {
        vec3 brick = floor(clamp(p * dimensions, vec3(0.0), dimensions - 0.0001) / ${VOLUME_BRICK_SIZE}.0);
        float skip = floor(texelFetch(activeBricks, ivec3(brick), 0).r * 255.0 + 0.5);
        float size = ${VOLUME_BRICK_SIZE}.0 * exp2(skip < 255.0 ? skip : 0.0);
        vec3 boundary = (floor(p * dimensions / size) + step(vec3(0.0), direction)) * size / dimensions;
        vec3 exitDistance = (boundary - p) / safeDirection;
        // Parallel axes never terminate a brick, including a ray exactly on its boundary.
        if (abs(direction.x) < 1e-7) exitDistance.x = 1e20;
        if (abs(direction.y) < 1e-7) exitDistance.y = 1e20;
        if (abs(direction.z) < 1e-7) exitDistance.z = 1e20;
        float travel = min(exitDistance.x, min(exitDistance.y, exitDistance.z));
        nextBrickSample = i + max(1, int(ceil(travel / stepSize - 0.0001)));
        if (skip < 255.0) {
          i = nextBrickSample;
          continue;
        }
      }
      i++;
      #if defined(URATH_ISOSURFACE) || !defined(URATH_TRANSFER_CACHE)
        float value = scalar(p);
        vec4 mapped = transfer(value);
      #else
        int index = int(floor(texelFetch(transferIndices, scalarCell(p), 0).r * 255.0 + 0.5));
        vec4 mapped = texelFetch(transferData, ivec2(index, 0), 0);
      #endif
      #ifdef URATH_ISOSURFACE
        if (value < threshold) continue;
        vec3 e = 1.0 / dimensions;
        vec3 gradient = vec3(scalar(p + vec3(e.x,0,0)) - scalar(p - vec3(e.x,0,0)),
          scalar(p + vec3(0,e.y,0)) - scalar(p - vec3(0,e.y,0)),
          scalar(p + vec3(0,0,e.z)) - scalar(p - vec3(0,0,e.z)));
        vec3 normal = length(gradient) > 1e-6 ? -normalize(gradient) : -direction;
        float light = 0.35 + 0.65 * abs(dot(normal, normalize(vec3(0.4, 0.8, 0.6))));
        gl_FragColor = vec4(mapped.rgb * light, 1.0);
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        return;
      #else
      float alpha = 1.0 - exp(-mapped.a * opacityScale * stepSize * voxelDistance);
      accumulated.rgb += (1.0 - accumulated.a) * mapped.rgb * alpha;
      accumulated.a += (1.0 - accumulated.a) * alpha;
      if (accumulated.a > 0.99) break;
      #endif
    }
    #ifdef URATH_ISOSURFACE
    discard;
    #else
    if (accumulated.a < 0.001) discard;
    gl_FragColor = vec4(accumulated.rgb / accumulated.a, accumulated.a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #endif
  }
`;

/** Linear-RGB transfer table with transparent low values and a warm high end. */
export function defaultTransferFunction(): Uint8Array {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    data.set(
      [
        Math.round(255 * t),
        Math.round(255 * t * t),
        Math.round(255 * (0.15 + 0.65 * (1 - t))),
        Math.round(255 * t * t),
      ],
      i * 4,
    );
  }
  return data;
}

function validRange(range: readonly [number, number]): void {
  if (
    range.length !== 2 ||
    !range.every(Number.isFinite) ||
    range[0] >= range[1]
  )
    throw new RangeError(
      "range must be [minimum, maximum] with minimum < maximum",
    );
}

function configureScalarTexture(
  texture: Data3DTexture,
  data: ScalarArray,
): void {
  const floating = data instanceof Float32Array;
  texture.image.data = data;
  texture.format = floating ? RedFormat : RedIntegerFormat;
  texture.type = floating
    ? FloatType
    : data instanceof Uint16Array
      ? UnsignedShortType
      : UnsignedByteType;
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.unpackAlignment = 1;
}

/** GPU ray-marched scalar volume with conservative brick skipping and regional uploads. */
export class VoxelVolume extends Mesh<BoxGeometry, ShaderMaterial> {
  readonly dimensions: Vec3;
  private data: ScalarArray;
  private readonly texture: Data3DTexture;
  private readonly transferTexture: DataTexture;
  private readonly bricks: VolumeBricks;
  private readonly brickTexture: Data3DTexture;
  private readonly uploadSource: Data3DTexture;
  private readonly pendingUpload = new TextureUploadQueue();
  private classificationDirty = true;
  private uploadedBytes = 0;
  private fullUploads = 0;
  private regionUploads = 0;
  private readonly budget: number;
  private readonly transferCache: VolumeTransferCache | null;
  private readonly releaseOnContextLoss: () => void;
  private readonly renderer: WebGLRenderer;
  private disposed = false;

  constructor(renderer: WebGLRenderer, options: VolumeOptions) {
    if (!(
      options.data instanceof Float32Array ||
      options.data instanceof Uint8Array ||
      options.data instanceof Uint16Array
    ))
      throw new TypeError(
        "volume data must be Float32Array, Uint8Array, or Uint16Array",
      );
    validateGrid(options.data, options);
    if (
      options.transferCache !== undefined &&
      typeof options.transferCache !== "boolean"
    )
      throw new TypeError("transferCache must be a boolean");
    if (
      options.storage !== undefined &&
      options.storage !== "auto" &&
      options.storage !== "float32"
    )
      throw new RangeError("volume storage must be auto or float32");
    const dimensions = dimensionsOf(options.dimensions);
    const gl = renderer.getContext();
    if (!("texImage3D" in gl))
      throw new Error("volume rendering requires WebGL2");
    if (gl.isContextLost())
      throw new Error("cannot create a volume while the WebGL context is lost");
    const limit = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    if (dimensions.some((n) => n > limit))
      throw new RangeError(
        `volume exceeds this GPU's ${limit}³ texture dimension limit`,
      );
    const budget = memoryBudget(options.maxMemoryBytes);
    const floating =
      options.storage === "float32" || options.data instanceof Float32Array;
    const bytes =
      options.data.length * (floating ? 4 : options.data.BYTES_PER_ELEMENT);
    const cacheBytes = options.transferCache ? options.data.length : 0;
    if (bytes * 2 + cacheBytes + brickMemoryBytes(dimensions) + 8192 > budget)
      throw new RangeError(
        "volume CPU/GPU buffers exceed the maxMemoryBytes budget",
      );
    const data = floating
      ? new Float32Array(options.data)
      : options.data instanceof Uint16Array
        ? new Uint16Array(options.data)
        : new Uint8Array(options.data);
    const bricks = new VolumeBricks(dimensions);
    bricks.update(data, [0, 0, 0], dimensions, true);
    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < bricks.bounds.length; i += 2) {
      min = Math.min(min, bricks.bounds[i]!);
      max = Math.max(max, bricks.bounds[i + 1]!);
    }
    const range = options.range ?? [min, max > min ? max : min + 1];
    validRange(range);
    const texture = new Data3DTexture(data, ...dimensions);
    configureScalarTexture(texture, data);
    texture.needsUpdate = true;
    const brickTexture = new Data3DTexture(bricks.active, ...bricks.dimensions);
    brickTexture.format = RedFormat;
    brickTexture.minFilter = brickTexture.magFilter = NearestFilter;
    brickTexture.unpackAlignment = 1;
    const transferTexture = new DataTexture(
      defaultTransferFunction(),
      256,
      1,
      RGBAFormat,
    );
    transferTexture.minFilter = transferTexture.magFilter = NearestFilter;
    transferTexture.needsUpdate = true;
    const rays = createGridRays();
    const enableSkipping = options.emptySpaceSkipping ?? true;
    const material = new ShaderMaterial({
      defines: floating ? {} : { URATH_INTEGER_SCALAR: 1 },
      uniforms: {
        ...rays.uniforms,
        scalarData: { value: texture },
        transferIndices: { value: null },
        activeBricks: { value: brickTexture },
        skipEmpty: { value: enableSkipping },
        transferData: { value: transferTexture },
        dimensions: { value: new Vector3(...dimensions) },
        clipMin: { value: new Vector3(0, 0, 0) },
        clipMax: { value: new Vector3(1, 1, 1) },
        valueRange: { value: new Vector2(...range) },
        opacityScale: { value: 0.08 },
        threshold: { value: (range[0] + range[1]) / 2 },
        maxSteps: { value: 512 },
      },
      vertexShader,
      fragmentShader,
      side: BackSide,
      transparent: true,
      depthWrite: false,
    });
    const geometry = new BoxGeometry(1, 1, 1);
    geometry.translate(0.5, 0.5, 0.5);
    super(geometry, material);
    this.name = "Urath volume";
    this.renderer = renderer;
    this.transferCache = options.transferCache
      ? new VolumeTransferCache(dimensions)
      : null;
    if (this.transferCache) {
      material.defines.URATH_TRANSFER_CACHE = 1;
      material.uniforms.transferIndices!.value =
        this.transferCache.target.texture;
    }
    this.data = data;
    this.texture = texture;
    this.transferTexture = transferTexture;
    this.bricks = bricks;
    this.brickTexture = brickTexture;
    // This CPU-only view must never be initialized as a GPU texture: Three.js
    // then copies the selected box directly with texSubImage3D and pixel strides.
    this.uploadSource = new Data3DTexture(data, ...dimensions);
    configureScalarTexture(this.uploadSource, data);
    texture.onUpdate = () => {
      this.fullUploads++;
      this.uploadedBytes += this.data.byteLength;
      this.pendingUpload.clear();
    };
    this.dimensions = dimensions;
    this.budget = budget;
    // Three r172 retains resource disposal listeners across renderer restoration.
    // Release old GPU handles while the context is lost; keep all owned CPU data.
    this.releaseOnContextLoss = () => {
      this.geometry.dispose();
      this.material.dispose();
      this.texture.dispose();
      this.transferTexture.dispose();
      this.brickTexture.dispose();
      this.transferCache?.releaseGpuResources();
    };
    renderer.domElement.addEventListener(
      "webglcontextlost",
      this.releaseOnContextLoss,
    );
    const spacing = options.spacing ?? [1, 1, 1];
    this.scale.set(
      dimensions[0] * spacing[0],
      dimensions[1] * spacing[1],
      dimensions[2] * spacing[2],
    );
    this.position.fromArray(options.origin ?? [0, 0, 0]);
    this.onBeforeRender = (_renderer, _scene, camera) => {
      if (this.classificationDirty) {
        const u = material.uniforms;
        bricks.classify(
          [u.valueRange!.value.x, u.valueRange!.value.y],
          transferTexture.image.data as Uint8Array,
          u.threshold!.value as number,
          material.defines.URATH_ISOSURFACE === 1,
          u.opacityScale!.value as number,
        );
        u.skipEmpty!.value = enableSkipping && bricks.hasEmpty;
        brickTexture.needsUpdate = true;
        this.classificationDirty = false;
      }
      const uploaded = this.pendingUpload.upload(
        _renderer,
        this.uploadSource,
        texture,
        this.data.BYTES_PER_ELEMENT,
      );
      if (uploaded) {
        this.uploadedBytes += uploaded;
        this.regionUploads += this.pendingUpload.uploads;
      }
      if (material.defines.URATH_ISOSURFACE !== 1)
        this.transferCache?.update(
          _renderer,
          texture,
          material.uniforms.valueRange!.value as Vector2,
          this.data.BYTES_PER_ELEMENT !== 4,
        );
      rays.update(_renderer, camera, this);
    };
    try {
      this.setMode(options.mode ?? "volume");
      this.setQuality(options.maxSteps ?? 512);
      this.setOpacity(options.opacity ?? 0.08);
      this.setThreshold(options.threshold ?? (range[0] + range[1]) / 2);
      this.setClip(options.clipMin ?? [0, 0, 0], options.clipMax ?? [1, 1, 1]);
      if (options.transferFunction)
        this.setTransferFunction(options.transferFunction);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get stats(): VolumeStats {
    const bytes = this.disposed ? 0 : this.data.byteLength;
    const accelerationBytes = this.disposed ? 0 : this.bricks.memoryBytes;
    return {
      transferCacheBytes: this.disposed ? 0 : (this.transferCache?.bytes ?? 0),
      transferCacheBuilds: this.transferCache?.builds ?? 0,
      transferCacheUpdatedVoxels: this.transferCache?.updatedVoxels ?? 0,
      storage:
        this.data instanceof Uint8Array
          ? "uint8"
          : this.data instanceof Uint16Array
            ? "uint16"
            : "float32",
      inputBytes: bytes,
      gpuBytes: this.disposed
        ? 0
        : bytes +
          this.bricks.active.byteLength +
          2048 +
          (this.transferCache?.bytes ?? 0),
      managedBytes: this.disposed
        ? 0
        : bytes * 2 +
          accelerationBytes +
          8192 +
          (this.transferCache?.bytes ?? 0),
      budgetBytes: this.budget,
      textureDimensions: this.dimensions,
      maxSteps: this.material.uniforms.maxSteps!.value as number,
      accelerationBytes,
      uploadedBytes: this.uploadedBytes,
      fullUploads: this.fullUploads,
      regionUploads: this.regionUploads,
    };
  }
  private assertLive(): void {
    if (this.disposed) throw new Error("volume disposed");
  }
  setMode(mode: VolumeMode): void {
    this.assertLive();
    if (mode !== "volume" && mode !== "isosurface")
      throw new RangeError("mode must be volume or isosurface");
    if (
      (this.material.defines.URATH_ISOSURFACE === 1) ===
      (mode === "isosurface")
    )
      return;
    if (mode === "isosurface") this.material.defines.URATH_ISOSURFACE = 1;
    else delete this.material.defines.URATH_ISOSURFACE;
    this.material.transparent = mode === "volume";
    this.material.depthWrite = mode === "isosurface";
    this.material.needsUpdate = true;
    this.classificationDirty = true;
  }
  setRange(range: readonly [number, number]): void {
    this.assertLive();
    validRange(range);
    const current = this.material.uniforms.valueRange!.value as Vector2;
    if (current.x === range[0] && current.y === range[1]) return;
    this.material.uniforms.valueRange!.value.set(...range);
    this.transferCache?.invalidate();
    this.classificationDirty = true;
  }
  setQuality(maxSteps: number): void {
    this.assertLive();
    if (!Number.isInteger(maxSteps) || maxSteps < 16 || maxSteps > 2048)
      throw new RangeError("maxSteps must be an integer from 16 to 2048");
    this.material.uniforms.maxSteps!.value = maxSteps;
  }
  setOpacity(value: number): void {
    this.assertLive();
    if (!Number.isFinite(value) || value < 0 || value > 10)
      throw new RangeError("opacity must be between 0 and 10");
    if (this.material.uniforms.opacityScale!.value === value) return;
    this.material.uniforms.opacityScale!.value = value;
    this.classificationDirty = true;
  }
  setThreshold(value: number): void {
    this.assertLive();
    if (!Number.isFinite(value))
      throw new RangeError("threshold must be finite");
    if (this.material.uniforms.threshold!.value === value) return;
    this.material.uniforms.threshold!.value = value;
    this.classificationDirty = true;
  }
  setClip(min: Vec3, max: Vec3): void {
    this.assertLive();
    if (
      min.length !== 3 ||
      max.length !== 3 ||
      !min.every(
        (n, i) =>
          Number.isFinite(n) &&
          n >= 0 &&
          Number.isFinite(max[i]) &&
          max[i]! <= 1 &&
          n < max[i]!,
      )
    )
      throw new RangeError("clip bounds must satisfy 0 ≤ min < max ≤ 1");
    this.material.uniforms.clipMin!.value.fromArray(min);
    this.material.uniforms.clipMax!.value.fromArray(max);
  }
  setTransferFunction(data: Uint8Array): void {
    this.assertLive();
    if (!(data instanceof Uint8Array) || data.length !== 1024)
      throw new RangeError("transferFunction requires 256 RGBA Uint8 entries");
    (this.transferTexture.image.data as Uint8Array).set(data);
    this.transferTexture.needsUpdate = true;
    this.classificationDirty = true;
  }
  /** Copy a region, rebuild its brick bounds, and queue regional uploads on the next render. */
  updateRegion(update: RegionUpdate<ScalarArray>): void {
    this.assertLive();
    if (!(
      update.data instanceof Float32Array ||
      update.data instanceof Uint8Array ||
      update.data instanceof Uint16Array
    ))
      throw new TypeError(
        "volume updates require Float32Array, Uint8Array, or Uint16Array",
      );
    validateRegion(this.dimensions, update);
    let requiredBytes = this.data.BYTES_PER_ELEMENT;
    for (let i = 0; i < update.data.length; i++) {
      const value = update.data[i]!;
      if (!Number.isFinite(value))
        throw new RangeError("volume samples must be finite");
      if (requiredBytes < 4) {
        if (!Number.isInteger(value) || value < 0 || value > 65535)
          requiredBytes = 4;
        else if (value > 255) requiredBytes = 2;
      }
    }
    if (requiredBytes > this.data.BYTES_PER_ELEMENT) {
      const nextBytes = this.data.length * requiredBytes;
      // Reserve both representations during replacement, before mutating any samples.
      if (
        2 * (this.data.byteLength + nextBytes) +
          this.bricks.memoryBytes +
          (this.transferCache?.bytes ?? 0) +
          8192 >
        this.budget
      )
        throw new RangeError(
          "volume storage promotion exceeds the maxMemoryBytes budget",
        );
      this.data =
        requiredBytes === 2
          ? new Uint16Array(this.data)
          : new Float32Array(this.data);
      configureScalarTexture(this.texture, this.data);
      configureScalarTexture(this.uploadSource, this.data);
      if (requiredBytes === 4)
        delete this.material.defines.URATH_INTEGER_SCALAR;
      this.material.needsUpdate = true;
      this.texture.needsUpdate = true;
    }
    copyRegion(this.data, this.dimensions, update);
    this.bricks.update(this.data, update.offset, update.dimensions);
    this.classificationDirty = true;
    this.pendingUpload.add(update.offset, update.dimensions);
    this.transferCache?.updateRegion(update.offset, update.dimensions);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.domElement.removeEventListener(
      "webglcontextlost",
      this.releaseOnContextLoss,
    );
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.transferTexture.dispose();
    this.brickTexture.dispose();
    this.brickTexture.image.data = new Uint8Array(0);
    this.bricks.dispose();
    this.transferCache?.dispose();
    this.data = new Float32Array(0);
    this.texture.image.data = this.data;
    this.uploadSource.image.data = this.data;
    this.transferTexture.image.data = new Uint8Array(0);
    this.removeFromParent();
  }
}

export const createVolume = (
  renderer: WebGLRenderer,
  options: VolumeOptions,
): VoxelVolume => new VoxelVolume(renderer, options);
