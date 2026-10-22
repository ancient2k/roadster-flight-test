// Sea, lagoons and tidal channels (Boca Chica, meta.water): one flat plane at the water level over the far tile.
// The terrain below is a shallow basin (tools/worlds/bocachica.py), so the shoreline is where the terrain crosses the
// plane. Drifting ripples in the normal; greener and lighter in the shallows (water depth from a coarse texture).
import * as THREE from 'three/webgpu';
import { float, mx_noise_float, positionWorld, time, vec2, vec3, normalize, transformNormalToView, clamp, mix, texture } from 'three/tsl';

export interface WaterHandle {
  readonly mesh: THREE.Mesh;
  dispose(): void;
}

/** depthAt: terrain height at world x/z (water depth = levelY − terrain). */
export function buildWater(levelY: number, extentM: number, groundAt: (x: number, z: number) => number): WaterHandle {
  const geo = new THREE.PlaneGeometry(extentM, extentM, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const N = 256, half = extentM / 2;
  const data = new Float32Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = -half + (i + 0.5) / N * extentM, z = -half + (j + 0.5) / N * extentM;
    data[(j * N + i) * 4] = Math.max(0, levelY - groundAt(x, z));
  }
  const depthTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
  depthTex.minFilter = depthTex.magFilter = THREE.LinearFilter;
  depthTex.needsUpdate = true;

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.07, metalness: 0 });
  const p = positionWorld.xz;
  const hgt = (q: typeof p) => mx_noise_float(q.mul(0.18).add(vec2(time.mul(0.05), time.mul(0.03)))).mul(0.6)
    .add(mx_noise_float(q.mul(0.9).add(vec2(time.mul(-0.12), time.mul(0.09)))).mul(0.18));
  const e = 0.6;
  const h0 = hgt(p), hx = hgt(p.add(vec2(e, 0))), hz = hgt(p.add(vec2(0, e)));
  mat.normalNode = transformNormalToView(normalize(vec3(h0.sub(hx).mul(0.9), float(1), h0.sub(hz).mul(0.9)))) as never;
  // texture v runs along +z (row j = z from −half): flipY off for the data texture
  const uvw = vec2(p.x.add(half).div(extentM), p.y.add(half).div(extentM));
  const deep = clamp(texture(depthTex, uvw).r.div(1.2), 0, 1);
  mat.colorNode = mix(vec3(0.16, 0.30, 0.27), vec3(0.03, 0.11, 0.16), deep) as never;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = levelY;
  mesh.name = 'Water';
  mesh.receiveShadow = true;
  return { mesh, dispose: () => { geo.dispose(); mat.dispose(); depthTex.dispose(); } };
}
