import test from "node:test";
import assert from "node:assert/strict";
import { VolumeBricks, brickMemoryBytes } from "../dist/volume-bricks.js";
import { TextureUploadQueue } from "../dist/texture-upload.js";

test("every skip cube is the largest empty aligned ancestor, including ragged edges and edits", () => {
  for (const grid of [
    [1, 1, 1],
    [65, 41, 19],
    [8, 17, 129],
  ]) {
    const data = new Uint16Array(grid[0] * grid[1] * grid[2]);
    const index = new VolumeBricks(grid);
    const check = () => {
      index.update(data);
      index.classifyOpaque();
      const [w, h, d] = index.dimensions;
      const occupied = [];
      for (let z = 0; z < grid[2]; z++)
        for (let y = 0; y < grid[1]; y++)
          for (let x = 0; x < grid[0]; x++) {
            if (data[x + grid[0] * (y + grid[1] * z)])
              occupied.push([x >> 3, y >> 3, z >> 3]);
          }
      for (let z = 0; z < d; z++)
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const p = [x, y, z];
            let expected = 255;
            for (
              let level = 0;
              level <= Math.ceil(Math.log2(Math.max(w, h, d)));
              level++
            ) {
              const side = 2 ** level,
                lo = p.map((v) => Math.floor(v / side) * side);
              if (
                occupied.some((q) =>
                  q.every((v, a) => v >= lo[a] && v < lo[a] + side),
                )
              )
                break;
              expected = level;
            }
            assert.equal(
              index.active[x + w * (y + h * z)],
              expected,
              JSON.stringify({ grid, p }),
            );
          }
      assert.equal(index.memoryBytes, brickMemoryBytes(grid));
    };
    check();
    data[0] = 1;
    data[data.length - 1] = 2;
    data[Math.floor(data.length / 2)] = 3;
    check();
    data.fill(0);
    check();
    index.dispose();
    assert.equal(index.memoryBytes, 0);
  }
});

test("upload queue covers every edit, reuses bounded storage and clears on full uploads", () => {
  const queue = new TextureUploadQueue(),
    uploads = [];
  let initialize = () => {};
  const renderer = {
    state: { activeTexture() {} },
    getContext: () => ({ TEXTURE0: 0 }),
    initTexture: () => initialize(),
    copyTextureToTexture: (_source, _target, box) => uploads.push(box.clone()),
  };
  const edits = [];
  for (let i = 0; i < 120; i++) {
    const offset = [(i * 17) % 97, (i * 31) % 89, (i * 13) % 83];
    const dimensions = [1 + (i % 4), 2, 3];
    edits.push({ offset, dimensions });
    queue.add(offset, dimensions);
  }
  const bytes = queue.upload(renderer, {}, {}, 4);
  assert.ok(uploads.length <= 32);
  assert.equal(queue.uploads, uploads.length);
  let actualBytes = 0;
  for (const box of uploads)
    actualBytes +=
      (box.max.x - box.min.x) *
      (box.max.y - box.min.y) *
      (box.max.z - box.min.z) *
      4;
  assert.equal(bytes, actualBytes);
  for (const { offset, dimensions } of edits) {
    for (let z = 0; z < dimensions[2]; z++)
      for (let y = 0; y < dimensions[1]; y++)
        for (let x = 0; x < dimensions[0]; x++) {
          const p = [offset[0] + x, offset[1] + y, offset[2] + z];
          assert.ok(
            uploads.some((box) =>
              p.every(
                (v, a) =>
                  v >= box.min.getComponent(a) && v < box.max.getComponent(a),
              ),
            ),
          );
        }
  }
  assert.equal(queue.upload(renderer, {}, {}, 4), 0);
  for (let run = 0; run < 10; run++) {
    uploads.length = 0;
    for (const offset of [
      [2, 2, 2],
      [3, 2, 2],
      [90, 90, 90],
    ])
      queue.add(offset, [1, 2, 3]);
    assert.equal(queue.upload(renderer, {}, {}, 4), 72);
    assert.equal(uploads.length, 2);
  }
  queue.add([1, 1, 1], [4, 4, 4]);
  initialize = () => queue.clear(); // initial/context-restoration full upload includes the edits
  assert.equal(queue.upload(renderer, {}, {}, 4), 0);
  assert.equal(queue.uploads, 0);
});
