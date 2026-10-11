import type { Vec3 } from "./data.js";

export const VOLUME_BRICK_SIZE = 8;

/** CPU bounds + CPU/GPU skip map + reusable coarse hierarchy. */
export function brickMemoryBytes(grid: Vec3): number {
  let dims = grid.map((n) => Math.ceil(n / VOLUME_BRICK_SIZE));
  let bytes = dims[0]! * dims[1]! * dims[2]! * 10;
  while (dims.some((n) => n > 1)) {
    dims = dims.map((n) => Math.ceil(n / 2));
    bytes += dims[0]! * dims[1]! * dims[2]!;
  }
  return bytes;
}

interface BrickLevel {
  dimensions: Vec3;
  data: Uint8Array<ArrayBuffer>;
}

/** Conservative min/max bounds let transfer functions change without rescanning voxels. */
export class VolumeBricks {
  readonly dimensions: [number, number, number];
  bounds: Float32Array;
  active: Uint8Array<ArrayBuffer>;
  hasEmpty = false;
  private readonly levels: BrickLevel[] = [];

  constructor(private readonly grid: Vec3) {
    this.dimensions = grid.map((n) => Math.ceil(n / VOLUME_BRICK_SIZE)) as [
      number,
      number,
      number,
    ];
    const count = this.dimensions[0] * this.dimensions[1] * this.dimensions[2];
    this.bounds = new Float32Array(count * 2);
    this.active = new Uint8Array(count);
    let dimensions: Vec3 = this.dimensions;
    while (dimensions.some((n) => n > 1)) {
      dimensions = dimensions.map((n) => Math.ceil(n / 2)) as [
        number,
        number,
        number,
      ];
      this.levels.push({
        dimensions,
        data: new Uint8Array(dimensions[0] * dimensions[1] * dimensions[2]),
      });
    }
  }

  get memoryBytes(): number {
    return (
      this.bounds.byteLength +
      2 * this.active.byteLength +
      this.levels.reduce((bytes, level) => bytes + level.data.byteLength, 0)
    );
  }

  /** 255 = contributing brick; 0..N = log2 of its largest empty aligned ancestor.
   * The GPU needs one byte and one fetch per visited brick, with no mip textures.
   * Missing children at non-power-of-two edges are outside the grid and empty.
   */
  private buildSkipMap(): void {
    this.hasEmpty = this.active.includes(0);
    if (!this.hasEmpty) return;
    let child = this.active,
      dims: Vec3 = this.dimensions;
    for (const level of this.levels) {
      level.data.fill(0);
      const [w, h, d] = dims,
        [pw, ph] = level.dimensions;
      for (let z = 0; z < d; z++)
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            if (child[x + w * (y + h * z)] === 255)
              level.data[(x >> 1) + pw * ((y >> 1) + ph * (z >> 1))] = 255;
          }
      child = level.data;
      dims = level.dimensions;
    }
    for (let l = this.levels.length - 1; l >= 0; l--) {
      const parent = this.levels[l]!;
      if (l === this.levels.length - 1 && parent.data[0] !== 255)
        parent.data[0] = l + 1;
      const below = l === 0 ? this.active : this.levels[l - 1]!.data;
      const [w, h, d] =
        l === 0 ? this.dimensions : this.levels[l - 1]!.dimensions;
      const [pw, ph] = parent.dimensions;
      for (let z = 0; z < d; z++)
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const i = x + w * (y + h * z);
            if (below[i] === 255) continue;
            const above =
              parent.data[(x >> 1) + pw * ((y >> 1) + ph * (z >> 1))]!;
            below[i] = above === 255 ? l : above;
          }
    }
  }

  classifyOpaque(): void {
    for (let i = 0; i < this.active.length; i++)
      this.active[i] = this.bounds[i * 2 + 1]! > 0 ? 255 : 0;
    this.buildSkipMap();
  }

  update(
    data: Float32Array | Uint16Array | Uint8Array,
    offset: Vec3 = [0, 0, 0],
    size: Vec3 = this.grid,
    validate = false,
  ): void {
    const b = VOLUME_BRICK_SIZE;
    const [w, h, d] = this.grid;
    const [bw, bh] = this.dimensions;
    const lo = offset.map((n) => Math.floor(n / b));
    const hi = offset.map((n, i) => Math.ceil((n + size[i]!) / b));
    for (let bz = lo[2]!; bz < hi[2]!; bz++)
      for (let by = lo[1]!; by < hi[1]!; by++)
        for (let bx = lo[0]!; bx < hi[0]!; bx++) {
          let min = Infinity,
            max = -Infinity;
          const xEnd = Math.min(w, (bx + 1) * b);
          for (let z = bz * b; z < Math.min(d, (bz + 1) * b); z++)
            for (let y = by * b; y < Math.min(h, (by + 1) * b); y++) {
              const base = w * (y + h * z);
              for (let x = bx * b; x < xEnd; x++) {
                const value = data[base + x]!;
                if (validate && !Number.isFinite(value))
                  throw new RangeError("volume samples must be finite");
                if (value < min) min = value;
                if (value > max) max = value;
              }
            }
          const index = 2 * (bx + bw * (by + bh * bz));
          this.bounds[index] = min;
          this.bounds[index + 1] = max;
        }
  }

  dispose(): void {
    this.bounds = new Float32Array(0);
    this.active = new Uint8Array(0);
    this.levels.length = 0;
  }

  classify(
    range: readonly [number, number],
    table: Uint8Array,
    threshold: number,
    iso: boolean,
    opacity: number,
  ): void {
    // Prefix sums preserve arbitrary, non-monotonic transfer functions.
    const prefix = new Uint16Array(257);
    for (let i = 0; i < 256; i++)
      prefix[i + 1] = prefix[i]! + (table[i * 4 + 3]! > 0 ? 1 : 0);
    const bin = (value: number): number =>
      Math.max(
        0,
        Math.min(
          255,
          Math.floor(((value - range[0]) / (range[1] - range[0])) * 255 + 0.5),
        ),
      );
    for (let i = 0; i < this.active.length; i++) {
      const min = this.bounds[i * 2]!,
        max = this.bounds[i * 2 + 1]!;
      // Keep a bin on either side for CPU/GPU rounding at table boundaries.
      const lo = Math.max(0, bin(min) - 1),
        hi = Math.min(255, bin(max) + 1);
      this.active[i] = (
        iso
          ? max >= Math.fround(threshold)
          : opacity > 0 && prefix[hi + 1]! > prefix[lo]!
      )
        ? 255
        : 0;
    }
    this.buildSkipMap();
  }
}
