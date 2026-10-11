import test from "node:test";
import assert from "node:assert/strict";
import {
  snapshotChunk,
  affectedChunks,
  validateGrid,
  validateRegion,
  copyRegion,
} from "../dist/data.js";

test("non-cubic data is partitioned with correct neighbour planes and zero padding", () => {
  const dims = [5, 6, 7],
    data = new Uint16Array(5 * 6 * 7);
  const sample = (x, y, z) =>
    x < 0 || y < 0 || z < 0 || x >= 5 || y >= 6 || z >= 7
      ? 0
      : 1 + x + 5 * (y + 6 * z);
  for (let z = 0; z < 7; z++)
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 5; x++) data[x + 5 * (y + 6 * z)] = sample(x, y, z);
  for (const offset of [
    [0, 0, 0],
    [4, 4, 4],
    [2, 2, 2],
  ]) {
    const size = 4,
      blocks = new Uint16Array(64),
      borders = new Uint16Array(96);
    snapshotChunk(data, dims, offset, size, blocks, borders);
    const [x, y, z] = offset;
    for (let k = 0; k < 4; k++)
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++)
          assert.equal(
            blocks[i + 4 * (j + 4 * k)],
            sample(x + i, y + j, z + k),
          );
    for (let v = 0; v < 4; v++)
      for (let u = 0; u < 4; u++) {
        const expected = [
          sample(x + 4, y + v, z + u),
          sample(x - 1, y + v, z + u),
          sample(x + u, y + 4, z + v),
          sample(x + u, y - 1, z + v),
          sample(x + u, y + v, z + 4),
          sample(x + u, y + v, z - 1),
        ];
        expected.forEach((value, face) =>
          assert.equal(borders[face * 16 + u + v * 4], value),
        );
      }
  }
});

test("edits remesh only affected bricks, including boundary neighbours", () => {
  assert.deepEqual(affectedChunks([3, 3, 3], [1, 1, 1], [32, 32, 32], 8), [
    "0,0,0",
  ]);
  assert.equal(affectedChunks([7, 7, 7], [1, 1, 1], [32, 32, 32], 8).length, 8);
  assert.deepEqual(affectedChunks([0, 0, 0], [1, 1, 1], [32, 32, 32], 8), [
    "0,0,0",
  ]);
});

test("regional writes preserve all samples outside a non-cubic region", () => {
  const dimensions = [7, 5, 3],
    target = new Float32Array(105).fill(9);
  const update = {
    offset: [2, 1, 1],
    dimensions: [3, 2, 1],
    data: new Float32Array([1, 2, 3, 4, 5, 6]),
  };
  validateRegion(dimensions, update);
  copyRegion(target, dimensions, update);
  for (let z = 0; z < 3; z++)
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 7; x++) {
        const inside = z === 1 && y >= 1 && y < 3 && x >= 2 && x < 5;
        assert.equal(
          target[x + 7 * (y + 5 * z)],
          inside ? update.data[x - 2 + 3 * (y - 1)] : 9,
        );
      }
});

test("invalid dimensions, spacing, and out-of-bounds updates reject before writing", () => {
  assert.throws(
    () => validateGrid(new Uint16Array(8), { dimensions: [2, 2, 3] }),
    /data length/,
  );
  assert.throws(
    () =>
      validateGrid(new Uint16Array(8), {
        dimensions: [2, 2, 2],
        spacing: [1, 0, 1],
      }),
    /spacing/,
  );
  assert.throws(
    () => validateGrid(new Uint16Array(0), { dimensions: [0, 2, 2] }),
    /positive/,
  );
  assert.throws(
    () =>
      validateRegion([2, 2, 2], {
        offset: [1, 1, 1],
        dimensions: [2, 1, 1],
        data: new Uint16Array(2),
      }),
    /fit/,
  );
});
