// near-field pebbles and cobbles (4–45 cm) on a world-anchored 1-m lattice around the camera: the rover
// photos of Jezero/Gale and the Apollo pans show stones everywhere at the feet, far more than the boulder
// population (RockField) can carry. Instances are re-laid only when the camera crosses a lattice cell block;
// the outer ring shrinks with distance instead of popping.
import * as THREE from 'three/webgpu';
import { vec3, float, positionWorld, normalWorld, mx_noise_float, smoothstep, mix, max, min, dot, normalize, cameraPosition, acos, clamp, tan } from 'three/tsl';
import type { TerrainField } from './terrainData';
import type { LookParams } from './skyParams';
import type { UVec3 } from './types';

/** Stone colour per body: dark basalt with a dust cap on Mars, grey breccia on the Moon (regolith BRDF),
 * weathered limestone at Giza – the pebbles must read against the ground, not as coloured beads. */
export function pebbleMaterial(look: LookParams, body: 'moon' | 'mars' | 'earth', sunDir: UVec3): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'Pebble';
  const n1 = mx_noise_float(positionWorld.mul(9)).mul(0.5).add(0.5);
  const n2 = mx_noise_float(positionWorld.mul(37)).mul(0.5).add(0.5);
  const up = smoothstep(float(0.2), float(0.85), normalWorld.y);
  let base, dust;
  if (body === 'mars') { base = vec3(0.075, 0.06, 0.05); dust = vec3(0.3, 0.17, 0.09); }
  else if (body === 'moon') { base = vec3(0.1, 0.098, 0.094); dust = vec3(0.13, 0.125, 0.118); }
  else { base = vec3(0.42, 0.34, 0.24); dust = vec3(0.55, 0.45, 0.32); }
  let col = mix(base, dust, up.mul(body === 'mars' ? 0.75 : 0.5).mul(n1.mul(0.6).add(0.4))).mul(n2.mul(0.3).add(0.85));
  if (look.regolith) {
    const V = normalize(cameraPosition.sub(positionWorld));
    const L = sunDir as unknown as ReturnType<typeof vec3>;
    const mu0 = max(dot(normalWorld, L), float(0.02)), mu = max(dot(normalWorld, V), float(0.02));
    const g = acos(clamp(dot(L, V), -1, 1));
    const surge = float(look.oppositionB0).div(float(1).add(tan(g.mul(0.5)).div(look.oppositionH)));
    col = col.mul(min(float(2).div(mu0.add(mu)), float(4))).mul(surge.add(1)).mul(0.62);
  }
  m.colorNode = col;
  m.roughnessNode = float(body === 'earth' ? 0.85 : 0.8);
  m.metalnessNode = float(0);
  return m;
}

export interface PebbleOptions {
  /** Radius (m) around the camera. */
  radius: number;
  /** Probability that a lattice cell holds a stone. */
  density: number;
  /** Lattice cell (m). */
  cellM?: number;
  /** Diameter range (m); sizes follow a steep power law. */
  dMin: number;
  dMax: number;
  maxInstances: number;
  seed: number;
}

const hash = (x: number, z: number, k: number) => {
  const s = Math.sin(x * 127.1 + z * 311.7 + k * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

export class PebbleField {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private lastX = Infinity;
  private lastZ = Infinity;
  count = 0;

  constructor(private field: TerrainField, geoms: THREE.BufferGeometry[], material: THREE.Material, private o: PebbleOptions) {
    this.group.name = 'Pebbles';
    const per = Math.ceil(o.maxInstances / geoms.length);
    for (const g of geoms) {
      const m = new THREE.InstancedMesh(g, material, per);
      m.name = 'PebbleCell';
      m.castShadow = true; m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      this.meshes.push(m);
      this.group.add(m);
    }
  }

  update(cam: THREE.Vector3): void {
    const step = 3;
    const gx = Math.round(cam.x / step) * step, gz = Math.round(cam.z / step) * step;
    if (gx === this.lastX && gz === this.lastZ) return;
    this.lastX = gx; this.lastZ = gz;
    const o = this.o, R = o.radius, f = this.field;
    const nV = this.meshes.length, cap = this.meshes[0].instanceMatrix.count;
    const fill = new Array(nV).fill(0);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const a = o.dMin ** -2.2, b = o.dMax ** -2.2;
    const c = o.cellM ?? 1;
    for (let iz = Math.floor((gz - R) / c); iz <= (gz + R) / c; iz++) {
      for (let ix = Math.floor((gx - R) / c); ix <= (gx + R) / c; ix++) {
        if (hash(ix, iz, o.seed) > o.density) continue;
        const x = (ix + hash(ix, iz, 1)) * c, z = (iz + hash(ix, iz, 2)) * c;
        const dx = x - cam.x, dz = z - cam.z, d = Math.hypot(dx, dz);
        if (d > R) continue;
        const v = Math.floor(hash(ix, iz, 3) * nV);
        if (fill[v] >= cap) continue;
        const n = f.normal(x, z);
        if (n.y < 0.7) continue;   // no stones glued to cliffs
        let size = (a - hash(ix, iz, 4) * (a - b)) ** (-1 / 2.2);
        size *= 1 - Math.max(0, (d - R * 0.8) / (R * 0.2));   // shrink in the outer ring
        if (size < 0.02) continue;
        e.set((hash(ix, iz, 5) - 0.5) * 0.6, hash(ix, iz, 6) * Math.PI * 2, (hash(ix, iz, 7) - 0.5) * 0.6);
        q.setFromEuler(e);
        const r = size * 0.5;
        s.set(r, r * (0.45 + 0.4 * hash(ix, iz, 8)), r * (0.7 + 0.5 * hash(ix, iz, 9)));
        p.set(x, f.height(x, z) - r * 0.3, z);
        M.compose(p, q, s);
        this.meshes[v].setMatrixAt(fill[v]++, M);
      }
    }
    this.count = 0;
    this.meshes.forEach((m, i) => { m.count = fill[i]; m.instanceMatrix.needsUpdate = true; this.count += fill[i]; });
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of this.meshes) m.dispose();
  }
}
