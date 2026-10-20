// Giza surroundings that the pyramids alone do not carry – the mastaba fields of the Western and
// Eastern Cemetery and the edge of Giza/Cairo (Nazlet el-Samman below the plateau, the city in the haze of
// the Nile valley). Both are instanced boxes placed on the terrain at load time (deterministic); the
// facades/stone courses are TSL patterns, so they cost one draw call each.
import * as THREE from 'three/webgpu';
import {
  vec3, float, positionWorld, normalWorld, fract, abs, step, mix, smoothstep, mx_noise_float, instanceIndex, hash,
  texture, pow,
} from 'three/tsl';
import type { TerrainField } from './terrainData';
import type { DetailLayer } from './terrain';

const rnd = (seed: number) => {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
};

/** Unit block (x, z ∈ ±0.5, y ∈ 0..1) with battered walls: the top is `batter` narrower on each side. */
function batteredBox(batter: number): THREE.BufferGeometry {
  const b = 0.5, t = 0.5 - batter;
  const P = [
    [-b, 0, -b], [b, 0, -b], [b, 0, b], [-b, 0, b],
    [-t, 1, -t], [t, 1, -t], [t, 1, t], [-t, 1, t],
  ];
  const faces = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]];
  const pos: number[] = [];
  for (const f of faces) {
    const [a, b2, c, d] = f.map((i) => P[i]);
    pos.push(...a, ...c, ...b2, ...a, ...d, ...c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export interface GizaExtras { group: THREE.Group; mastabas: number; buildings: number; dispose(): void }

export interface Box { x: number; z: number; w: number; d: number; h: number; yaw: number; y: number }

/** Mastaba fields (Western Cemetery W of Khufu, Eastern Cemetery E of the queens' pyramids), long axis N–S. */
export function mastabaLayout(field: TerrainField): Box[] {
  const r = rnd(29);
  const out: Box[] = [];
  const fieldAt = (x0: number, x1: number, z0: number, z1: number, colW: number, rowD: number, keep: number) => {
    for (let z = z0; z < z1; z += rowD) {
      for (let x = x0; x < x1; x += colW) {
        if (r() > keep) continue;
        const w = 9 + r() * 7, d = 18 + r() * 14;
        const x2 = x + (r() - 0.5) * 3, z2 = z + (r() - 0.5) * 4;
        // ground under the footprint: the lowest corner, so nothing floats on the slope
        let y = Infinity;
        for (const [dx, dz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [0, 0]]) y = Math.min(y, field.height(x2 + dx, z2 + dz));
        out.push({ x: x2, z: z2, w, d, h: 2.2 + r() * r() * 6.5, yaw: (r() - 0.5) * 0.03, y: y - 0.6 });
      }
    }
  };
  // Western Cemetery: rows of mastabas west of Khufu (west face at x ≈ 286), north of Khafre's enclosure
  fieldAt(20, 262, -790, -330, 24, 38, 0.72);
  // Eastern Cemetery: east of G1-a…c (queens at x ≈ 560–600)
  fieldAt(625, 770, -660, -420, 22, 36, 0.78);
  return out;
}

/** Buildings of Nazlet el-Samman / Giza / Cairo: valley floor below the plateau, N and E. */
export function cityLayout(field: TerrainField, valleyY: number): Box[] {
  const r = rnd(71);
  const out: Box[] = [];
  // rings: single houses near the plateau edge (40-m lattice), whole blocks farther out (110-m lattice)
  const rings: [number, number, number][] = [[0, 3200, 40], [3200, Math.min(field.halfExtent * 0.9, 9000), 110]];
  for (const [r0, r1, cell] of rings) {
    for (let z = -r1; z < r1; z += cell) {
      for (let x = -r1; x < r1; x += cell) {
        const d = Math.hypot(x - 400, z + 300);
        if (d < r0 || d >= r1) continue;
        // the plateau and the monuments stay free: east of x ≈ 980 or north of z ≈ −1250 (Mena House, Giza)
        const east = x > 980 + Math.max(0, z + 600) * 0.15, north = z < -1250 && x > -900;
        if (!east && !north) continue;
        const dens = Math.min(0.8, 0.3 + d / 9000);
        if (r() > dens) continue;
        const xx = x + (r() - 0.5) * cell * 0.25, zz = z + (r() - 0.5) * cell * 0.25;
        const y = field.height(xx, zz);
        if (!Number.isFinite(y) || y > valleyY + 9) continue;   // only on the valley floor
        const big = cell > 50;
        const w = big ? 40 + r() * 50 : 12 + r() * 16, dd = big ? 40 + r() * 50 : 12 + r() * 16;
        const floors = Math.round(3 + r() * 5 + Math.min(9, d / 1500) * r());
        out.push({ x: xx, z: zz, w, d: dd, h: floors * 3.1 + 1, yaw: (r() - 0.5) * 0.25 + (r() < 0.2 ? 0.6 : 0), y: y - 0.5 });
      }
    }
  }
  return out;
}

function instanced(geom: THREE.BufferGeometry, mat: THREE.Material, boxes: Box[], name: string): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geom, mat, Math.max(1, boxes.length));
  m.name = name;
  m.count = boxes.length;
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  boxes.forEach((b, i) => {
    q.setFromAxisAngle(up, b.yaw);
    M.compose(p.set(b.x, b.y, b.z), q, s.set(b.w, b.h, b.d));
    m.setMatrixAt(i, M);
  });
  m.instanceMatrix.needsUpdate = true;
  m.computeBoundingSphere();
  return m;
}

export function buildGizaExtras(field: TerrainField, limestone: DetailLayer | null, quality: 'low' | 'medium' | 'high' | 'ultra'): GizaExtras {
  const group = new THREE.Group();
  group.name = 'GizaExtras';

  // ---- mastabas: limestone courses (≈0,6 m), weathered, sand-filled at the foot
  const mb = mastabaLayout(field);
  const mm = new THREE.MeshStandardNodeMaterial();
  mm.name = 'Mastaba';
  const wp = positionWorld;
  const stoneTint = vec3(0.62, 0.5, 0.36);
  let stone = stoneTint.mul(mx_noise_float(wp.mul(0.9)).mul(0.12).add(0.95));
  if (limestone) {
    const sc = 1 / limestone.scaleM;
    const n = abs(normalWorld);
    const tx = texture(limestone.diff, wp.zy.mul(sc)).rgb, ty = texture(limestone.diff, wp.xz.mul(sc)).rgb, tz = texture(limestone.diff, wp.xy.mul(sc)).rgb;
    const w = pow(n, vec3(4));
    const tri = tx.mul(w.x).add(ty.mul(w.y)).add(tz.mul(w.z)).div(w.x.add(w.y).add(w.z));
    const mean = vec3(...limestone.mean);
    stone = stone.mul(mix(vec3(1, 1, 1), tri.div(mean), 0.75));
  }
  // horizontal courses + staggered vertical joints on the walls
  const course = smoothstep(float(0.0), float(0.06), fract(wp.y.div(0.62))).mul(0.18).add(0.82);
  const joints = smoothstep(float(0.0), float(0.04), fract(wp.x.add(wp.z).div(1.3).add(fract(wp.y.div(0.62).floor().mul(0.5))))).mul(0.12).add(0.88);
  const wall = float(1).sub(abs(normalWorld.y));
  mm.colorNode = stone.mul(mix(float(1), course.mul(joints), wall));
  mm.roughnessNode = float(0.9);
  mm.metalnessNode = float(0);
  const mastabas = instanced(batteredBox(0.07), mm, mb, 'Mastabas');
  mastabas.castShadow = true; mastabas.receiveShadow = true;
  group.add(mastabas);

  // ---- city: plastered/brick facades in Cairo ochres and greys, window grid, darker roofs
  const valleyY = field.height(1500, -200);
  const cb = quality === 'low' ? cityLayout(field, valleyY).filter((_, i) => i % 2 === 0) : cityLayout(field, valleyY);
  const cm = new THREE.MeshStandardNodeMaterial();
  cm.name = 'CityFacade';
  const h = hash(instanceIndex);
  const h2 = hash(instanceIndex.add(7919));
  // unfinished red brick, ochre plaster, grey concrete (linear; dusty, darker than the limestone)
  const pal = mix(mix(vec3(0.24, 0.17, 0.115), vec3(0.32, 0.25, 0.18), h), mix(vec3(0.25, 0.13, 0.085), vec3(0.3, 0.29, 0.27), h), step(float(0.55), h2));
  const along = mix(wp.x, wp.z, step(abs(normalWorld.x), abs(normalWorld.z)).oneMinus());
  const win = step(float(0.35), fract(wp.y.div(3.1))).mul(step(float(0.3), fract(along.div(3.6)))).mul(step(float(0.25), float(1).sub(fract(along.div(3.6)))));
  const isWall = float(1).sub(abs(normalWorld.y)).greaterThan(0.5).select(float(1), float(0));
  const facade = mix(pal, pal.mul(0.28), win.mul(isWall));
  const grime = mx_noise_float(wp.mul(0.15)).mul(0.08).add(0.96);
  cm.colorNode = mix(facade.mul(grime), pal.mul(0.62), float(1).sub(isWall));
  cm.roughnessNode = float(0.92);
  cm.metalnessNode = float(0);
  const city = instanced(batteredBox(0), cm, cb, 'City');
  // far beyond the shadow map (±130 m): casting would push all instances through the shadow pass every frame
  city.castShadow = false;
  city.receiveShadow = true;
  group.add(city);

  return {
    group, mastabas: mb.length, buildings: cb.length,
    dispose() {
      group.removeFromParent();
      for (const m of [mastabas, city]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); m.dispose(); }
    },
  };
}
