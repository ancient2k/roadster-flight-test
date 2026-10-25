// A level of the track editor in the 3D world: the pieces' triangles (src/shared/parts.ts) merged per material into
// a few meshes, decoration as simple procedural shapes, and the same solids as static physics colliders.
import * as THREE from 'three/webgpu';
import { boxTris, buildPart, partDef, placeTris, type MatKey, type DecoType } from '../../shared/parts';
import type { Level } from '../../shared/level';
import { buildCourse, drawRot } from '../../shared/course';
import type { LandmarkShape } from '../../sim/core/world';

/** Build area of the site (meta.json buildArea). */
export interface LevelArea { minX: number; minZ: number; tileM: number; nx: number; nz: number; y: number }

const MATS: Record<MatKey, () => THREE.Material> = {
  asphalt: () => new THREE.MeshStandardMaterial({ color: 0x2b2c2e, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  paint: () => new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  concrete: () => new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  curb: () => new THREE.MeshStandardMaterial({ color: 0xc8312c, roughness: 0.6 }),
  steel: () => new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.45, metalness: 0.8 }),
  red: () => new THREE.MeshStandardMaterial({ color: 0xd8262d, roughness: 0.5 }),
  glow: () => new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2a1a, emissiveIntensity: 6, roughness: 0.4 }),
  pad: () => new THREE.MeshStandardMaterial({ color: 0x1a3a46, emissive: 0x2fa8d8, emissiveIntensity: 0.6, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
};

/** Deco shapes: closed boxes/prisms in local metres (x across, z along, y up) and whether they collide. */
const DECO: Record<DecoType, { mat: MatKey; size: [number, number, number]; solid: boolean; round?: boolean; taper?: number }> = {
  cone: { mat: 'red', size: [0.45, 0.75, 0.45], solid: false, round: true, taper: 0.15 },
  barrel: { mat: 'red', size: [0.6, 0.9, 0.6], solid: true, round: true },
  crate: { mat: 'concrete', size: [1.2, 1.2, 1.2], solid: true },
  container: { mat: 'steel', size: [2.44, 2.6, 12.2], solid: true },
  light_mast: { mat: 'steel', size: [0.35, 10, 0.35], solid: true },
  barrier: { mat: 'concrete', size: [0.6, 0.9, 3.6], solid: true },
};

function decoGeometry(type: DecoType): THREE.BufferGeometry {
  const d = DECO[type];
  const [w, h, l] = d.size;
  const g = d.round
    ? new THREE.CylinderGeometry((d.taper ?? 1) === 1 ? w / 2 : w * (d.taper ?? 1), w / 2, h, 16)
    : new THREE.BoxGeometry(w, h, l);
  g.translate(0, h / 2, 0);
  return g;
}

export interface LevelScene {
  readonly group: THREE.Group;
  /** Static colliders for createRoadsterSim({ landmarks }). */
  readonly shapes: LandmarkShape[];
  /** World triangles of the roads and pads painted onto the field (no collider of their own: src/shared/paved.ts). */
  readonly paved: Float32Array;
  dispose(): void;
}

/** World position of a tile-space point (x, z in tiles) on the build area. */
export function tileToWorld(a: LevelArea, x: number, z: number): [number, number] {
  return [a.minX + x * a.tileM, a.minZ + z * a.tileM];
}

export function buildLevelScene(level: Level, area: LevelArea): LevelScene {
  const group = new THREE.Group();
  group.name = 'Level';
  const byMat = new Map<MatKey, Float32Array[]>();
  const shapes: LandmarkShape[] = [];
  const pavedParts: Float32Array[] = [];
  const push = (m: MatKey, t: Float32Array) => { let a = byMat.get(m); if (!a) byMat.set(m, a = []); a.push(t); };
  const toWorld = (t: Float32Array) => {
    for (let k = 0; k < t.length; k += 3) { t[k] += area.minX; t[k + 1] += area.y; t[k + 2] += area.minZ; }
    return t;
  };
  const course = buildCourse(level);
  level.parts.forEach((p, n) => {
    const def = partDef(p.type);
    const mesh = buildPart(p.type, p.opt);
    // markings that read in one direction (boost chevrons) follow the way the course runs through the piece
    const rot = drawRot(level, n, course);
    for (const s of mesh.solids) {
      const t = toWorld(placeTris(s.tris, def, p.i, p.j, p.rot, 0, area.tileM));
      push(s.mat, t);
      shapes.push({ id: `level_${n}_${p.type}`, kind: 'mesh', data: t, outward: true });
    }
    // paint lies 6 cm above the field: the coarse terrain LOD further away would otherwise cover it
    for (const d of mesh.decals) {
      const t = toWorld(placeTris(d.tris, def, p.i, p.j, rot, 0.06, area.tileM));
      push(d.mat, t);
      if (d.mat === 'asphalt' || d.mat === 'pad') pavedParts.push(t);
    }
  });
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  for (const [m, parts] of byMat) {
    const n = parts.reduce((s, a) => s + a.length, 0);
    const all = new Float32Array(n);
    let o = 0;
    for (const a of parts) { all.set(a, o); o += a.length; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(all, 3));
    g.computeVertexNormals();
    const mat = MATS[m]();
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = m !== 'asphalt' && m !== 'paint' && m !== 'pad';
    mesh.receiveShadow = true;
    mesh.name = `level_${m}`;
    group.add(mesh);
    geos.push(g); mats.push(mat);
  }
  // decoration: one instanced mesh per type
  for (const type of new Set(level.deco.map((d) => d.type))) {
    const list = level.deco.filter((d) => d.type === type);
    const g = decoGeometry(type);
    const mat = MATS[DECO[type].mat]();
    const im = new THREE.InstancedMesh(g, mat, list.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    list.forEach((d, k) => {
      const [x, z] = tileToWorld(area, d.x, d.z);
      q.setFromAxisAngle(up, d.rotDeg * Math.PI / 180);
      im.setMatrixAt(k, m4.compose(new THREE.Vector3(x, area.y, z), q, one));
      if (DECO[type].solid) {
        // collider: the shape's bounding box, rotated
        const [w, h, l] = DECO[type].size;
        const c = Math.cos(d.rotDeg * Math.PI / 180), s = Math.sin(d.rotDeg * Math.PI / 180);
        const tris = boxTris([-w / 2, 0, -l / 2], [w / 2, h, l / 2]);
        for (let v = 0; v < tris.length; v += 3) {     // rotation about y keeps the winding
          const u = tris[v], ww = tris[v + 2];
          tris[v] = x + c * u + s * ww; tris[v + 1] += area.y; tris[v + 2] = z - s * u + c * ww;
        }
        shapes.push({ id: `deco_${type}_${k}`, kind: 'mesh', data: tris, outward: true });
      }
    });
    im.castShadow = true; im.receiveShadow = true;
    group.add(im);
    geos.push(g); mats.push(mat);
  }
  const paved = new Float32Array(pavedParts.reduce((s, a) => s + a.length, 0));
  let po = 0;
  for (const a of pavedParts) { paved.set(a, po); po += a.length; }
  return {
    group, shapes, paved,
    dispose: () => { geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); },
  };
}
