import { Matrix4, Vector3, Vector4 } from "three";
import type { Camera, Object3D, WebGLRenderer } from "three";

export const GRID_RAY_SHADER = `
  uniform vec3 ray00, rayDx, rayDy, rayCamera, rayDirection;
  uniform vec4 rayViewport;
  uniform bool orthographic;
  void gridRay(out vec3 origin, out vec3 direction) {
    vec2 uv = (gl_FragCoord.xy - rayViewport.xy) / rayViewport.zw;
    vec3 ray = ray00 + uv.x * rayDx + uv.y * rayDy;
    origin = orthographic ? ray : rayCamera;
    direction = normalize(orthographic ? rayDirection : ray);
  }
`;

/** Construct pixel-centre rays independently of rasterized box interpolation.
 * This avoids material/sample errors on thin faces and supports target viewports.
 */
export function createGridRays() {
  const uniforms = {
    ray00: { value: new Vector3() },
    rayDx: { value: new Vector3() },
    rayDy: { value: new Vector3() },
    rayCamera: { value: new Vector3() },
    rayDirection: { value: new Vector3() },
    rayViewport: { value: new Vector4() },
    orthographic: { value: false },
  };
  const inverse = new Matrix4(),
    cameraToLocal = new Matrix4();
  const corner = (
    v: Vector3,
    x: number,
    y: number,
    z: number,
    camera: Camera,
  ): Vector3 =>
    v
      .set(x, y, z)
      .applyMatrix4(camera.projectionMatrixInverse)
      .applyMatrix4(cameraToLocal);
  return {
    uniforms,
    update(renderer: WebGLRenderer, camera: Camera, object: Object3D): void {
      inverse.copy(object.matrixWorld).invert();
      cameraToLocal.multiplyMatrices(inverse, camera.matrixWorld);
      const ortho = "isOrthographicCamera" in camera;
      uniforms.orthographic.value = ortho;
      uniforms.rayCamera.value.setFromMatrixPosition(cameraToLocal);
      const z = ortho ? -1 : 0;
      const p0 = corner(uniforms.ray00.value, -1, -1, z, camera);
      corner(uniforms.rayDx.value, 1, -1, z, camera).sub(p0);
      corner(uniforms.rayDy.value, -1, 1, z, camera).sub(p0);
      if (!ortho) p0.sub(uniforms.rayCamera.value);
      camera
        .getWorldDirection(uniforms.rayDirection.value)
        .transformDirection(inverse);
      renderer.getCurrentViewport(uniforms.rayViewport.value);
    },
  };
}
