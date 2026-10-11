import { Box3 } from "three";
import type { Data3DTexture, WebGLRenderer } from "three";
import type { Vec3 } from "./data.js";

const MAX_REGIONS = 32;
const volume = (box: Box3): number =>
  (box.max.x - box.min.x) * (box.max.y - box.min.y) * (box.max.z - box.min.z);
const unionVolume = (a: Box3, b: Box3): number =>
  (Math.max(a.max.x, b.max.x) - Math.min(a.min.x, b.min.x)) *
  (Math.max(a.max.y, b.max.y) - Math.min(a.min.y, b.min.y)) *
  (Math.max(a.max.z, b.max.z) - Math.min(a.min.z, b.min.z));

/** Bounded, reusable dirty boxes. Adjacent edits coalesce without amplifying
 * transfer size; distant edits stay separate. At the cap, merge the pair with
 * the least additional transfer cost instead of collapsing to one huge box.
 */
export class TextureUploadQueue {
  private readonly boxes = Array.from(
    { length: MAX_REGIONS + 1 },
    () => new Box3(),
  );
  private count = 0;
  uploads = 0;
  get empty(): boolean {
    return this.count === 0;
  }
  drain(visit: (region: Box3) => void): void {
    for (let i = 0; i < this.count; i++) visit(this.boxes[i]!);
    this.clear();
  }

  clear(): void {
    this.count = 0;
  }

  add(offset: Vec3, dimensions: Vec3): void {
    const box = this.boxes[this.count]!;
    box.min.fromArray(offset);
    box.max.set(...dimensions).add(box.min);
    // The final slot is scratch until all beneficial merges are consumed.
    for (let i = 0; i < this.count;) {
      const candidate = this.boxes[i]!;
      if (unionVolume(box, candidate) <= volume(box) + volume(candidate)) {
        box.union(candidate);
        this.count--;
        this.boxes[i] = this.boxes[this.count]!;
        this.boxes[this.count] = candidate;
        i = 0;
      } else i++;
    }
    // The scratch object's old slot may now lie beyond the live prefix.
    const next = this.boxes[this.count]!;
    if (next !== box) next.copy(box);
    this.count++;
    if (this.count <= MAX_REGIONS) return;
    let cost = Infinity,
      left = 0,
      right = 1;
    for (let i = 0; i < this.count - 1; i++)
      for (let j = i + 1; j < this.count; j++) {
        const a = this.boxes[i]!,
          b = this.boxes[j]!;
        const extra = unionVolume(a, b) - volume(a) - volume(b);
        if (extra < cost) {
          cost = extra;
          left = i;
          right = j;
        }
      }
    this.boxes[left]!.union(this.boxes[right]!);
    this.count--;
    const removed = this.boxes[right]!;
    this.boxes[right] = this.boxes[this.count]!;
    this.boxes[this.count] = removed;
  }

  /** The source is a CPU-only view and must never be initialized on the GPU.
   * The target's onUpdate clears the queue after an initial/restoration upload.
   */
  upload(
    renderer: WebGLRenderer,
    source: Data3DTexture,
    target: Data3DTexture,
    bytesPerSample: number,
  ): number {
    this.uploads = 0;
    if (!this.count) return 0;
    // Three r172's cached setTexture3D can leave another texture unit active.
    // Select through its state cache before initTexture unbinds the destination.
    renderer.state.activeTexture(renderer.getContext().TEXTURE0);
    renderer.initTexture(target);
    let bytes = 0;
    for (let i = 0; i < this.count; i++) {
      const box = this.boxes[i]!;
      renderer.copyTextureToTexture(source, target, box, box.min);
      bytes += volume(box) * bytesPerSample;
      this.uploads++;
    }
    this.clear();
    return bytes;
  }
}
