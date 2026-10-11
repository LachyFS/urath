import { Color, DataTexture, NearestFilter, RGBAFormat } from "three";
import type { ColorRepresentation } from "three";

export const DEFAULT_PALETTE = [
  "#000000",
  "#79d5b0",
  "#78a5df",
  "#efd099",
  "#c586c0",
  "#80cad3",
  "#c7d6de",
  "#728096",
];

export function createPalette(
  palette: readonly ColorRepresentation[] = DEFAULT_PALETTE,
): DataTexture {
  if (palette.length < 1 || palette.length > 65536)
    throw new RangeError("palette must contain 1–65536 colours");
  const width = Math.min(palette.length, 256);
  const height = Math.ceil(palette.length / width);
  const pixels = new Uint8Array(width * height * 4);
  const color = new Color();
  palette.forEach((value, i) => {
    color.set(value);
    pixels.set(
      [
        Math.round(color.r * 255),
        Math.round(color.g * 255),
        Math.round(color.b * 255),
        255,
      ],
      i * 4,
    );
  });
  const texture = new DataTexture(pixels, width, height, RGBAFormat);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}
