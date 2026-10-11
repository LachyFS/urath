/** Shared by direct sampling and cache preparation so table rounding agrees. */
export const TRANSFER_INDEX_SHADER = `
  int transferIndex(float value) {
    float t = clamp((value - valueRange.x) / (valueRange.y - valueRange.x), 0.0, 1.0);
    return int(floor(t * 255.0 + 0.5));
  }
`;
