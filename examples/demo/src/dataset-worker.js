// Deterministic fixtures; generation stays off the UI thread.
const littleEndian = new Uint16Array(new Uint8Array([1, 0]).buffer)[0] === 1;
self.onmessage = async ({ data: { kind, size, file, rawType } }) => {
  try {
    if (kind === "raw") {
      const bytes = await file.arrayBuffer();
      const width = rawType === "float32" ? 4 : rawType === "uint8" ? 1 : 2;
      const scalar = rawType !== "uint16";
      const ArrayType =
        rawType === "float32"
          ? Float32Array
          : rawType === "uint8"
            ? Uint8Array
            : Uint16Array;
      // Keep native scalar storage and transfer the file buffer without a parse copy.
      const data =
        littleEndian || width === 1
          ? new ArrayType(bytes)
          : new ArrayType(bytes.byteLength / width);
      if (!littleEndian && width > 1) {
        const view = new DataView(bytes);
        for (let i = 0; i < data.length; i++)
          data[i] =
            rawType === "float32"
              ? view.getFloat32(i * 4, true)
              : view.getUint16(i * 2, true);
      }
      self.postMessage({ data, scalar }, [data.buffer]);
      return;
    }
    const scalar = kind === "phantom";
    const data = scalar
      ? new Float32Array(size ** 3)
      : new Uint16Array(size ** 3);
    let seed = 123456789;
    for (let z = 0; z < size; z++)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const nx = ((x + 0.5) / size) * 2 - 1,
            ny = ((y + 0.5) / size) * 2 - 1,
            nz = ((z + 0.5) / size) * 2 - 1;
          const radius = nx * nx + ny * ny + nz * nz;
          let value = 0;
          if (kind === "solid") value = 1;
          else if (kind === "multimaterial") value = 1 + ((x + y + z) % 4);
          else if (kind === "porous") {
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            if ((seed >>> 0) % 2 === 0) value = 1;
          } else if (kind === "model") {
            if (radius < 0.72 && Math.hypot(nx + 0.18, nz) > 0.18)
              value = 1 + Math.floor((y / size) * 6);
          } else if (kind === "terrain") {
            const height =
              size *
              (0.32 +
                0.17 * Math.sin((x / size) * 8) * Math.cos((z / size) * 6) +
                0.12 * Math.sin((z / size) * 13));
            if (y < height) value = y > height - 2 ? 1 : y > height - 6 ? 4 : 2;
          } else if (scalar) {
            const ellipsoid =
              (nx * nx) / 0.64 + (ny * ny) / 0.81 + (nz * nz) / 0.49;
            if (ellipsoid < 1) value = 0.15 + 0.15 * (1 - ellipsoid);
            const a =
              (nx + 0.28) ** 2 / 0.1 +
              (ny - 0.08) ** 2 / 0.24 +
              (nz * nz) / 0.18;
            const b =
              (nx - 0.25) ** 2 / 0.06 +
              (ny + 0.16) ** 2 / 0.12 +
              (nz - 0.1) ** 2 / 0.09;
            if (a < 1) value = 0.48 + 0.2 * (1 - a);
            if (b < 1) value = 0.75 + 0.25 * (1 - b);
            if (Math.hypot(nx, nz + 0.12) < 0.09 && Math.abs(ny) < 0.75)
              value = 0;
          }
          data[x + size * (y + size * z)] = value;
        }
    self.postMessage({ data, scalar }, [data.buffer]);
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
