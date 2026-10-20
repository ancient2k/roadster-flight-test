// Stonehenge visitor path – the tarmac/gravel loop English Heritage laid around the stones (2013), with
// the spur toward the NW (shuttle stop). A terrain-hugging ribbon with a worn, grass-edged surface.
import * as THREE from 'three/webgpu';
import { vec3, float, positionWorld, mx_noise_float, uv, smoothstep, abs } from 'three/tsl';
import type { TerrainField } from './terrainData';

/** Polyline (x, z) → ribbon of width w following the ground (+3 cm, polygon offset). */
function ribbon(field: TerrainField, pts: [number, number][], w: number): THREE.BufferGeometry {
  const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i];
    const [xa, za] = pts[Math.max(0, i - 1)], [xb, zb] = pts[Math.min(pts.length - 1, i + 1)];
    let tx = xb - xa, tz = zb - za;
    const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    if (i > 0) acc += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
    for (const s of [-1, 1]) {
      const px = x - tz * s * w / 2, pz = z + tx * s * w / 2;
      pos.push(px, field.height(px, pz) + 0.03, pz);
      uvs.push(s < 0 ? 0 : 1, acc / w);
    }
    if (i > 0) { const b = (i - 1) * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildVisitorPath(field: TerrainField): THREE.Mesh {
  const pts: [number, number][] = [];
  // loop r ≈ 34 m around the circle centre, from NE (after the Heel Stone) clockwise, open toward the Avenue
  const az = (a: number, r: number): [number, number] => [r * Math.sin(a * Math.PI / 180), -r * Math.cos(a * Math.PI / 180)];
  for (let a = 66; a <= 360 + 32; a += 2) pts.push(az(a, 34 + 3 * Math.sin(a * Math.PI / 90)));
  const loop = ribbon(field, pts, 2.6);
  // spur to the NW, toward the visitor centre shuttle (straight across the downland)
  const spur: [number, number][] = [];
  for (let d = 34; d <= 900; d += 6) spur.push(az(305 + Math.min(12, (d - 34) / 40), d));
  const g2 = ribbon(field, spur, 3.2);
  const merged = new THREE.BufferGeometry();
  const p = [...(loop.getAttribute('position').array as Float32Array), ...(g2.getAttribute('position').array as Float32Array)];
  const u = [...(loop.getAttribute('uv').array as Float32Array), ...(g2.getAttribute('uv').array as Float32Array)];
  const off = loop.getAttribute('position').count;
  const ix = [...Array.from(loop.getIndex()!.array as ArrayLike<number>), ...Array.from(g2.getIndex()!.array as ArrayLike<number>, (i) => i + off)];
  merged.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
  merged.setIndex(ix);
  merged.computeVertexNormals();
  loop.dispose(); g2.dispose();
  const m = new THREE.MeshStandardNodeMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.name = 'VisitorPath';
  const wp = positionWorld;
  const grit = mx_noise_float(vec3(wp.x, 0, wp.z).mul(3.1)).mul(0.08).add(mx_noise_float(vec3(wp.x, 0, wp.z).mul(0.4)).mul(0.06));
  // compacted chalk-gravel tarmac: light warm grey, darker wheel/foot lanes, grassy ragged edges
  const across = abs(uv().x.sub(0.5)).mul(2);
  const lanes = smoothstep(float(0.2), float(0.45), across).mul(0.06);
  m.colorNode = vec3(0.33, 0.31, 0.27).mul(grit.add(1).sub(lanes));
  const edge = mx_noise_float(vec3(wp.x, 0, wp.z).mul(1.7)).mul(0.12);
  m.opacityNode = smoothstep(float(1.0), float(0.82), across.add(edge));
  m.roughnessNode = float(0.85);
  m.metalnessNode = float(0);
  const mesh = new THREE.Mesh(merged, m);
  mesh.name = 'VisitorPath';
  mesh.receiveShadow = true;
  return mesh;
}
