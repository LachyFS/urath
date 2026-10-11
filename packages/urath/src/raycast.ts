import { createGridRays, GRID_RAY_SHADER } from "./grid-rays.js";
import { TextureUploadQueue } from "./texture-upload.js";
import {
  BackSide,
  BoxGeometry,
  Data3DTexture,
  DataTexture,
  Mesh,
  NearestFilter,
  RedFormat,
  RedIntegerFormat,
  ShaderMaterial,
  UnsignedShortType,
  Vector3,
} from "three";
import type { ColorRepresentation, WebGLRenderer } from "three";
import {
  copyRegion,
  dimensionsOf,
  memoryBudget,
  validateGrid,
  validateRegion,
} from "./data.js";
import type { GridMetadata, RegionUpdate, Vec3 } from "./data.js";
import { createPalette } from "./palette.js";
import {
  VolumeBricks,
  VOLUME_BRICK_SIZE,
  brickMemoryBytes,
} from "./volume-bricks.js";

export interface VoxelRaycastOptions extends GridMetadata {
  data: Uint16Array;
  palette?: readonly ColorRepresentation[];
  maxMemoryBytes?: number;
}
export interface VoxelRaycastStats {
  inputBytes: number;
  gpuBytes: number;
  managedBytes: number;
  budgetBytes: number;
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
  precision highp usampler3D;
  precision highp sampler3D;
  uniform usampler3D voxelData;
  uniform sampler3D activeBricks;
  uniform sampler2D palette;
  uniform float paletteWidth, paletteHeight, paletteCount;
  uniform vec3 dimensions;
  ${GRID_RAY_SHADER}
  uniform mat4 modelViewMatrix, projectionMatrix;
  uniform mat3 normalMatrix;
  varying vec3 vPosition;

  vec3 axisNormal(vec3 crossing, vec3 direction) {
    if (crossing.x <= crossing.y && crossing.x <= crossing.z) return vec3(-sign(direction.x), 0.0, 0.0);
    if (crossing.y <= crossing.z) return vec3(0.0, -sign(direction.y), 0.0);
    return vec3(0.0, 0.0, -sign(direction.z));
  }
  void main() {
    vec3 origin, direction; gridRay(origin, direction);
    vec3 reciprocal = vec3(
      abs(direction.x) < 1e-8 ? 1e20 : 1.0 / direction.x,
      abs(direction.y) < 1e-8 ? 1e20 : 1.0 / direction.y,
      abs(direction.z) < 1e-8 ? 1e20 : 1.0 / direction.z);
    vec3 a = -origin * reciprocal, b = (1.0 - origin) * reciprocal;
    vec3 near = min(a, b), far = max(a, b);
    float enter = max(0.0, max(near.x, max(near.y, near.z)));
    float leave = min(far.x, min(far.y, far.z));
    if (leave <= enter) discard;
    vec3 normal = axisNormal(-near, direction);
    vec3 gridOrigin = origin * dimensions;
    vec3 gridDirection = direction * dimensions;
    vec3 delta = abs(reciprocal / dimensions);
    vec3 positive = step(vec3(0.0), direction);
    // Epsilon is in voxel units, independent of grid dimensions and spacing.
    float epsilon = 0.0001 / max(dimensions.x, max(dimensions.y, dimensions.z));
    float t = enter;
    vec3 cell = clamp(floor(gridOrigin + gridDirection * (t + epsilon)), vec3(0.0), dimensions - 1.0);
    vec3 next = (cell + positive - gridOrigin) * reciprocal / dimensions;
    if (abs(direction.x) < 1e-8) next.x = 1e20;
    if (abs(direction.y) < 1e-8) next.y = 1e20;
    if (abs(direction.z) < 1e-8) next.z = 1e20;
    int traversalLimit = int(dimensions.x + dimensions.y + dimensions.z) + 3;
    vec3 lastBrick = vec3(-1.0);
    for (int iteration = 0; iteration < traversalLimit; iteration++) {
      if (t > leave || any(lessThan(cell, vec3(0.0))) || any(greaterThanEqual(cell, dimensions))) break;
      vec3 brick = floor(cell / ${VOLUME_BRICK_SIZE}.0);
      if (any(notEqual(brick, lastBrick))) {
        lastBrick = brick;
        float skip = floor(texelFetch(activeBricks, ivec3(brick), 0).r * 255.0 + 0.5);
        if (skip < 255.0) {
          float size = ${VOLUME_BRICK_SIZE}.0 * exp2(skip);
          vec3 boundary = (floor(cell / size) + positive) * size;
          vec3 crossing = (boundary - gridOrigin) * reciprocal / dimensions;
          if (abs(direction.x) < 1e-8) crossing.x = 1e20;
          if (abs(direction.y) < 1e-8) crossing.y = 1e20;
          if (abs(direction.z) < 1e-8) crossing.z = 1e20;
          t = min(crossing.x, min(crossing.y, crossing.z));
          normal = axisNormal(crossing, direction);
          cell = floor(gridOrigin + gridDirection * (t + epsilon));
          next = (cell + positive - gridOrigin) * reciprocal / dimensions;
          if (abs(direction.x) < 1e-8) next.x = 1e20;
          if (abs(direction.y) < 1e-8) next.y = 1e20;
          if (abs(direction.z) < 1e-8) next.z = 1e20;
          continue;
        }
      }
      uint voxelId = texelFetch(voxelData, ivec3(cell), 0).r;
      if (voxelId != 0u) {
        float id = mod(float(voxelId), paletteCount);
        vec2 uv = vec2((mod(id, paletteWidth) + 0.5) / paletteWidth, (floor(id / paletteWidth) + 0.5) / paletteHeight);
        vec3 colour = texture2D(palette, uv).rgb;
        vec3 viewNormal = normalize(normalMatrix * normal);
        float light = 0.45 + 0.55 * max(dot(viewNormal, normalize(vec3(0.4, 0.7, 0.6))), 0.0);
        gl_FragColor = vec4(colour * light, 1.0);
        vec3 hit = origin + direction * max(t, epsilon);
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(hit, 1.0);
        gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        return;
      }
      normal = axisNormal(next, direction);
      t = min(next.x, min(next.y, next.z));
      // Step every tied axis: touching an edge/corner does not enter its side cells.
      bvec3 crossed = lessThanEqual(next, vec3(t));
      if (crossed.x) { cell.x += sign(direction.x); next.x += delta.x; }
      if (crossed.y) { cell.y += sign(direction.y); next.y += delta.y; }
      if (crossed.z) { cell.z += sign(direction.z); next.z += delta.z; }
    }
    discard;
  }
`;

/** Exact first-occupied-voxel traversal for dense or fragmented opaque material grids.
 * Uses one draw call and resident integer textures; writes hit depth for scene composition.
 */
export class VoxelRaycast extends Mesh<BoxGeometry, ShaderMaterial> {
  readonly dimensions: Vec3;
  private data: Uint16Array;
  private readonly texture: Data3DTexture;
  private readonly source: Data3DTexture;
  private readonly palette: DataTexture;
  private readonly bricks: VolumeBricks;
  private readonly brickTexture: Data3DTexture;
  private readonly pending = new TextureUploadQueue();
  private readonly budget: number;
  private disposed = false;
  private classificationDirty = false;
  private fullUploads = 0;
  private regionUploads = 0;
  private uploadedBytes = 0;

  constructor(renderer: WebGLRenderer, options: VoxelRaycastOptions) {
    if (!(options.data instanceof Uint16Array))
      throw new TypeError("voxel raycasting requires Uint16Array material IDs");
    validateGrid(options.data, options);
    const dimensions = dimensionsOf(options.dimensions);
    const gl = renderer.getContext();
    if (!("texImage3D" in gl) || gl.isContextLost())
      throw new Error("voxel raycasting requires an active WebGL2 context");
    const limit = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    if (dimensions.some((n) => n > limit))
      throw new RangeError(
        `grid exceeds this GPU's ${limit}³ texture dimension limit`,
      );
    const budget = memoryBudget(options.maxMemoryBytes);
    const palette = createPalette(options.palette);
    if (
      options.data.byteLength * 2 +
        brickMemoryBytes(dimensions) +
        palette.image.data.byteLength * 2 +
        8192 >
      budget
    ) {
      palette.dispose();
      throw new RangeError(
        "voxel CPU/GPU buffers exceed the maxMemoryBytes budget",
      );
    }
    const data = new Uint16Array(options.data);
    const texture = new Data3DTexture(data, ...dimensions);
    texture.format = RedIntegerFormat;
    texture.type = UnsignedShortType;
    texture.internalFormat = "R16UI";
    texture.minFilter = texture.magFilter = NearestFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    const bricks = new VolumeBricks(dimensions);
    bricks.update(data);
    bricks.classifyOpaque();
    const brickTexture = new Data3DTexture(bricks.active, ...bricks.dimensions);
    brickTexture.format = RedFormat;
    brickTexture.unpackAlignment = 1;
    brickTexture.minFilter = brickTexture.magFilter = NearestFilter;
    brickTexture.needsUpdate = true;
    const rays = createGridRays();
    const material = new ShaderMaterial({
      uniforms: {
        ...rays.uniforms,
        voxelData: { value: texture },
        activeBricks: { value: brickTexture },
        palette: { value: palette },
        paletteWidth: { value: palette.image.width },
        paletteHeight: { value: palette.image.height },
        paletteCount: { value: options.palette?.length ?? 8 },
        dimensions: { value: new Vector3(...dimensions) },
      },
      vertexShader,
      fragmentShader,
      side: BackSide,
      depthWrite: true,
    });
    const geometry = new BoxGeometry(1, 1, 1);
    geometry.translate(0.5, 0.5, 0.5);
    super(geometry, material);
    this.name = "Urath voxel raycast";
    this.dimensions = dimensions;
    this.data = data;
    this.texture = texture;
    this.palette = palette;
    this.bricks = bricks;
    this.brickTexture = brickTexture;
    this.budget = budget;
    this.source = new Data3DTexture(data, ...dimensions);
    this.source.format = RedIntegerFormat;
    this.source.type = UnsignedShortType;
    const spacing = options.spacing ?? [1, 1, 1];
    this.scale.set(
      dimensions[0] * spacing[0],
      dimensions[1] * spacing[1],
      dimensions[2] * spacing[2],
    );
    this.position.fromArray(options.origin ?? [0, 0, 0]);
    texture.onUpdate = () => {
      this.fullUploads++;
      this.uploadedBytes += this.data.byteLength;
      this.pending.clear();
    };
    this.onBeforeRender = (activeRenderer, _scene, camera) => {
      if (this.classificationDirty) {
        bricks.classifyOpaque();
        brickTexture.needsUpdate = true;
        this.classificationDirty = false;
      }
      const uploaded = this.pending.upload(
        activeRenderer,
        this.source,
        texture,
        2,
      );
      if (uploaded) {
        this.uploadedBytes += uploaded;
        this.regionUploads += this.pending.uploads;
      }
      rays.update(activeRenderer, camera, this);
    };
  }

  get stats(): VoxelRaycastStats {
    const inputBytes = this.data.byteLength;
    const accelerationBytes = this.bricks.memoryBytes;
    const paletteBytes = this.disposed ? 0 : this.palette.image.data.byteLength;
    return {
      inputBytes,
      accelerationBytes,
      gpuBytes: inputBytes + this.bricks.active.byteLength + paletteBytes,
      managedBytes: this.disposed
        ? 0
        : inputBytes * 2 + accelerationBytes + paletteBytes * 2 + 8192,
      budgetBytes: this.budget,
      uploadedBytes: this.uploadedBytes,
      fullUploads: this.fullUploads,
      regionUploads: this.regionUploads,
    };
  }

  updateRegion(update: RegionUpdate<Uint16Array>): void {
    if (this.disposed) throw new Error("voxel raycast disposed");
    if (!(update.data instanceof Uint16Array))
      throw new TypeError("voxel updates require Uint16Array");
    validateRegion(this.dimensions, update);
    copyRegion(this.data, this.dimensions, update);
    this.bricks.update(this.data, update.offset, update.dimensions);
    this.classificationDirty = true;
    this.pending.add(update.offset, update.dimensions);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.palette.dispose();
    this.brickTexture.dispose();
    this.bricks.dispose();
    this.data = new Uint16Array(0);
    this.texture.image.data = this.data;
    this.source.image.data = this.data;
    this.palette.image.data = new Uint8Array(0);
    this.brickTexture.image.data = new Uint8Array(0);
    this.removeFromParent();
  }
}
export const createVoxelRaycast = (
  renderer: WebGLRenderer,
  options: VoxelRaycastOptions,
): VoxelRaycast => new VoxelRaycast(renderer, options);
