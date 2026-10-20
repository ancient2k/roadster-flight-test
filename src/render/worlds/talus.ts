// Drift sand and rubble at the foot of the pyramids: the visible counterpart of the physics talus that lets
// the car drive from the plateau into the 52° faces (geometry in src/shared/pyramid.ts, same triangles as the
// collider). Sand on the gentle outer part, limestone rubble where it steepens toward the face.
import * as THREE from 'three/webgpu';
import { vec3, float, positionWorld, normalWorld, abs, mix, smoothstep, mx_noise_float, texture, pow } from 'three/tsl';
import type { DetailLayer } from './terrain';

function triplanar(layer: DetailLayer) {
  const sc = 1 / layer.scaleM, wp = positionWorld;
  const n = abs(normalWorld);
  const w = pow(n, vec3(4));
  const tx = texture(layer.diff, wp.zy.mul(sc)).rgb, ty = texture(layer.diff, wp.xz.mul(sc)).rgb, tz = texture(layer.diff, wp.xy.mul(sc)).rgb;
  return tx.mul(w.x).add(ty.mul(w.y)).add(tz.mul(w.z)).div(w.x.add(w.y).add(w.z)).div(vec3(...layer.mean));
}

export function buildTalusMesh(triangles: Float32Array, sand: DetailLayer | null, rubble: DetailLayer | null): THREE.Mesh | null {
  if (!triangles.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
  g.computeVertexNormals();
  // the builder winds counter-clockwise seen from outside; make sure normals point up anyway
  const nrm = g.getAttribute('normal');
  let up = 0;
  for (let i = 0; i < nrm.count; i++) up += nrm.getY(i);
  if (up < 0) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i += 3) {
      const x = p.getX(i + 1), y = p.getY(i + 1), z = p.getZ(i + 1);
      p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
      p.setXYZ(i + 2, x, y, z);
    }
    g.computeVertexNormals();
  }
  g.computeBoundingSphere();
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'PyramidTalus';
  const wp = positionWorld;
  const grain = mx_noise_float(wp.mul(0.35)).mul(0.1).add(0.95);
  const sandC = vec3(0.6, 0.47, 0.32).mul(sand ? mix(vec3(1, 1, 1), triplanar(sand), 0.8) : vec3(1, 1, 1));
  const rubC = vec3(0.6, 0.5, 0.37).mul(rubble ? mix(vec3(1, 1, 1), triplanar(rubble), 0.85) : vec3(1, 1, 1));
  // steeper than ~30° → rubble; patchy so the boundary is not a contour line
  const steep = smoothstep(float(0.72), float(0.9), float(1).sub(normalWorld.y).add(mx_noise_float(wp.mul(0.08)).mul(0.25)));
  m.colorNode = mix(sandC, rubC, steep).mul(grain);
  m.roughnessNode = float(0.95);
  m.metalnessNode = float(0);
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'PyramidTalus';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
