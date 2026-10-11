import {
  Mesh,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  Scene,
  ShaderMaterial,
  WebGL3DRenderTarget,
  Vector4,
} from "three";
import type { Box3, Data3DTexture, Vector2, WebGLRenderer } from "three";
import type { Vec3 } from "./data.js";
import { TextureUploadQueue } from "./texture-upload.js";
import { TRANSFER_INDEX_SHADER } from "./volume-transfer.js";

/** GPU-generated transfer indices. Stores the exact 256-entry lookup index,
 * not quantized source samples. Raw scalar data remains available for isosurfaces.
 */
export class VolumeTransferCache {
  readonly target: WebGL3DRenderTarget;
  readonly bytes: number;
  builds = 0;
  updatedVoxels = 0;
  private dirty = true;
  private readonly regions = new TextureUploadQueue();
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new PlaneGeometry(2, 2);
  private readonly material = new ShaderMaterial({
    defines: {},
    uniforms: {
      scalarData: { value: null },
      valueRange: { value: null },
      layer: { value: 0 },
    },
    vertexShader: `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      #ifdef URATH_INTEGER_SCALAR
      precision highp usampler3D;
      uniform usampler3D scalarData;
      #else
      precision highp sampler3D;
      uniform sampler3D scalarData;
      #endif
      uniform vec2 valueRange;
      uniform int layer;
      ${TRANSFER_INDEX_SHADER}
      void main() {
        float value = float(texelFetch(scalarData, ivec3(ivec2(gl_FragCoord.xy), layer), 0).r);
        float index = float(transferIndex(value));
        gl_FragColor = vec4(index / 255.0, 0.0, 0.0, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    toneMapped: false,
  });
  private renderer: WebGLRenderer | null = null;
  private readonly restored = (): void => {
    this.dirty = true;
  };
  private readonly savedViewport = new Vector4();
  private readonly savedScissor = new Vector4();
  private readonly activeViewport = new Vector4();
  private readonly activeScissor = new Vector4();
  private readonly targetViewport = new Vector4();
  private readonly targetScissor = new Vector4();

  constructor(private readonly dimensions: Vec3) {
    this.bytes = dimensions[0] * dimensions[1] * dimensions[2];
    this.target = new WebGL3DRenderTarget(...dimensions, {
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.target.texture.format = RedFormat;
    this.target.texture.minFilter = this.target.texture.magFilter =
      NearestFilter;
    this.target.texture.generateMipmaps = false;
    this.scene.add(new Mesh(this.geometry, this.material));
  }

  invalidate(): void {
    this.dirty = true;
  }
  releaseGpuResources(): void {
    this.target.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.dirty = true;
  }
  updateRegion(offset: Vec3, dimensions: Vec3): void {
    this.regions.add(offset, dimensions);
  }

  update(
    renderer: WebGLRenderer,
    scalar: Data3DTexture,
    range: Vector2,
    integer: boolean,
  ): void {
    if (this.renderer !== renderer) {
      this.renderer?.domElement.removeEventListener(
        "webglcontextrestored",
        this.restored,
      );
      this.renderer = renderer;
      renderer.domElement.addEventListener(
        "webglcontextrestored",
        this.restored,
      );
      this.dirty = true;
    }
    if (!this.dirty && this.regions.empty) return;
    const wasInteger = this.material.defines.URATH_INTEGER_SCALAR === 1;
    if (integer !== wasInteger) {
      if (integer) this.material.defines.URATH_INTEGER_SCALAR = 1;
      else delete this.material.defines.URATH_INTEGER_SCALAR;
      this.material.needsUpdate = true;
    }
    this.material.uniforms.scalarData!.value = scalar;
    this.material.uniforms.valueRange!.value = range;
    const oldTarget = renderer.getRenderTarget(),
      oldFace = renderer.getActiveCubeFace(),
      oldMip = renderer.getActiveMipmapLevel();
    const oldAutoClear = renderer.autoClear,
      oldXr = renderer.xr.enabled,
      oldScissorTest = renderer.getScissorTest();
    renderer.getViewport(this.savedViewport);
    renderer.getScissor(this.savedScissor);
    renderer.getCurrentViewport(this.activeViewport);
    const gl = renderer.getContext();
    this.activeScissor.fromArray(gl.getParameter(gl.SCISSOR_BOX) as Int32Array);
    const activeScissorTest = gl.isEnabled(gl.SCISSOR_TEST);
    const render = (
      minX: number,
      minY: number,
      minZ: number,
      maxX: number,
      maxY: number,
      maxZ: number,
    ): void => {
      this.target.scissor.set(minX, minY, maxX - minX, maxY - minY);
      this.target.scissorTest = true;
      for (let z = minZ; z < maxZ; z++) {
        this.material.uniforms.layer!.value = z;
        renderer.setRenderTarget(this.target, z);
        renderer.render(this.scene, this.camera);
      }
      this.updatedVoxels += (maxX - minX) * (maxY - minY) * (maxZ - minZ);
    };
    try {
      renderer.autoClear = false;
      renderer.xr.enabled = false;
      if (this.dirty) {
        render(0, 0, 0, ...this.dimensions);
        this.regions.clear();
      } else
        this.regions.drain((box: Box3) =>
          render(
            box.min.x,
            box.min.y,
            box.min.z,
            box.max.x,
            box.max.y,
            box.max.z,
          ),
        );
      this.dirty = false;
      this.builds++;
    } finally {
      renderer.autoClear = oldAutoClear;
      renderer.xr.enabled = oldXr;
      if (oldTarget) {
        this.targetViewport.copy(oldTarget.viewport);
        this.targetScissor.copy(oldTarget.scissor);
        const targetTest = oldTarget.scissorTest;
        oldTarget.viewport.copy(this.activeViewport);
        oldTarget.scissor.copy(this.activeScissor);
        oldTarget.scissorTest = activeScissorTest;
        renderer.setRenderTarget(oldTarget, oldFace, oldMip);
        oldTarget.viewport.copy(this.targetViewport);
        oldTarget.scissor.copy(this.targetScissor);
        oldTarget.scissorTest = targetTest;
      } else renderer.setRenderTarget(null, oldFace, oldMip);
      // setRenderTarget restores target-specific viewport/scissor. For the screen,
      // preserve the renderer's configured values as well.
      if (oldTarget === null) {
        renderer.setViewport(this.savedViewport);
        renderer.setScissor(this.savedScissor);
        renderer.setScissorTest(oldScissorTest);
      }
    }
  }

  dispose(): void {
    this.renderer?.domElement.removeEventListener(
      "webglcontextrestored",
      this.restored,
    );
    this.renderer = null;
    this.releaseGpuResources();
  }
}
