export type Vec3 = readonly [number, number, number];

export interface GridMetadata {
  /** X varies fastest: x + width * (y + height * z). */
  dimensions: Vec3;
  /** World units per voxel, default [1, 1, 1]. */
  spacing?: Vec3;
  /** Minimum corner in world coordinates, default [0, 0, 0]. */
  origin?: Vec3;
}

export interface RegionUpdate<
  T extends Uint8Array | Uint16Array | Float32Array,
> {
  offset: Vec3;
  dimensions: Vec3;
  data: T;
}

export function dimensionsOf(value: Vec3): [number, number, number] {
  if (
    value.length !== 3 ||
    !value.every((n) => Number.isSafeInteger(n) && n > 0)
  ) {
    throw new RangeError("dimensions must contain three positive integers");
  }
  if (!Number.isSafeInteger(value[0] * value[1] * value[2])) {
    throw new RangeError("voxel count exceeds safe integer range");
  }
  return [...value];
}

export function validateGrid(
  data: ArrayLike<number>,
  metadata: GridMetadata,
): void {
  const d = dimensionsOf(metadata.dimensions);
  if (data.length !== d[0] * d[1] * d[2])
    throw new RangeError("data length must equal width × height × depth");
  const spacing = metadata.spacing ?? [1, 1, 1];
  const origin = metadata.origin ?? [0, 0, 0];
  if (
    spacing.length !== 3 ||
    !spacing.every((n) => Number.isFinite(n) && n > 0)
  )
    throw new RangeError("spacing must be finite and positive");
  if (origin.length !== 3 || !origin.every(Number.isFinite))
    throw new RangeError("origin must be finite");
}

export function validateRegion(
  dimensions: Vec3,
  update: RegionUpdate<Uint8Array | Uint16Array | Float32Array>,
): void {
  const size = dimensionsOf(update.dimensions);
  if (
    update.offset.length !== 3 ||
    !update.offset.every(
      (n, i) => Number.isInteger(n) && n >= 0 && n + size[i]! <= dimensions[i]!,
    )
  ) {
    throw new RangeError("update region must fit inside the dataset");
  }
  if (update.data.length !== size[0] * size[1] * size[2])
    throw new RangeError("update data length does not match its dimensions");
}

export function copyRegion(
  target: Uint8Array | Uint16Array | Float32Array,
  dimensions: Vec3,
  update: RegionUpdate<Uint8Array | Uint16Array | Float32Array>,
): void {
  const [w, h] = dimensions;
  const [x, y, z] = update.offset;
  const [rw, rh, rd] = update.dimensions;
  for (let iz = 0; iz < rd; iz++)
    for (let iy = 0; iy < rh; iy++) {
      const start = rw * (iy + rh * iz);
      target.set(
        update.data.subarray(start, start + rw),
        x + w * (y + iy + h * (z + iz)),
      );
    }
}

/** A reusable snapshot. Border ordering matches the Rust mesher. */
export function snapshotChunk(
  data: Uint16Array,
  dimensions: Vec3,
  offset: Vec3,
  size: number,
  blocks: Uint16Array,
  borders: Uint16Array,
): void {
  const [w, h, d] = dimensions;
  const [ox, oy, oz] = offset;
  const sample = (x: number, y: number, z: number): number =>
    x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d
      ? 0
      : data[x + w * (y + h * z)]!;
  const width = Math.min(size, w - ox),
    height = Math.min(size, h - oy),
    depth = Math.min(size, d - oz);
  if (width < size || height < size || depth < size) blocks.fill(0);
  for (let z = 0; z < depth; z++)
    for (let y = 0; y < height; y++) {
      const from = ox + w * (oy + y + h * (oz + z));
      const to = size * (y + size * z);
      for (let x = 0; x < width; x++) blocks[to + x] = data[from + x]!;
    }
  const area = size * size;
  for (let v = 0; v < size; v++)
    for (let u = 0; u < size; u++) {
      const i = u + v * size;
      borders[i] = sample(ox + size, oy + v, oz + u);
      borders[area + i] = sample(ox - 1, oy + v, oz + u);
      borders[2 * area + i] = sample(ox + u, oy + size, oz + v);
      borders[3 * area + i] = sample(ox + u, oy - 1, oz + v);
      borders[4 * area + i] = sample(ox + u, oy + v, oz + size);
      borders[5 * area + i] = sample(ox + u, oy + v, oz - 1);
    }
}

export function affectedChunks(
  offset: Vec3,
  region: Vec3,
  dimensions: Vec3,
  size: number,
): string[] {
  const low = offset.map((n) => Math.max(0, Math.floor((n - 1) / size)));
  const high = offset.map((n, i) =>
    Math.min(
      Math.ceil(dimensions[i]! / size) - 1,
      Math.floor((n + region[i]!) / size),
    ),
  );
  const keys: string[] = [];
  for (let z = low[2]!; z <= high[2]!; z++)
    for (let y = low[1]!; y <= high[1]!; y++)
      for (let x = low[0]!; x <= high[0]!; x++) keys.push(`${x},${y},${z}`);
  return keys;
}

/** Conservative reservation for retained WASM output, scratch, and transport. */
export function workerReservation(size: number): number {
  const quads = 3 * size ** 3 + 3 * size ** 2;
  return (
    2 *
      // Retained WASM output + float getters + packed transferable attributes
      // can overlap during conversion. Reserve 400 bytes per worst-case quad.
      (quads * 200 + (size + 2) ** 3 * 8 + size ** 3 * 8 + 6 * size ** 2 * 4) +
    2 * 1024 * 1024
  );
}

export function memoryBudget(value = 256 * 1024 * 1024): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError("maxMemoryBytes must be a positive integer");
  return value;
}
