// (detailed Apollo descent stages and Stonehenge): the rebuilt landmark GLBs still fit the prop contract
// (meta.json `dynamic`). Re-implements the triangle → part assignment of splitDynamicLandmarks
// (src/render/worlds/landmarks.ts) on the raw GLB (no GPU, no textures): every part must get triangles, and almost
// nothing may stay static (a static triangle does not move when its part breaks off or a stone topples).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three/webgpu';
import { partRegions, type PropObjectDef } from '../../../src/shared/props';

interface Glb { json: { nodes: { name?: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[]; meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[]; accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[]; bufferViews: { byteOffset?: number; byteStride?: number }[] }; bin: Buffer; size: number }

function readGlb(path: string): Glb {
  const b = fs.readFileSync(path);
  const jl = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jl).toString('utf8'));
  const bl = b.readUInt32LE(20 + jl);
  return { json, bin: b.subarray(28 + jl, 28 + jl + bl), size: b.length };
}

function accessor(g: Glb, i: number): Float32Array | Uint32Array {
  const a = g.json.accessors[i], bv = g.json.bufferViews[a.bufferView];
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type as 'SCALAR'] ?? 1;
  const off = g.bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const buf = g.bin.buffer.slice(off, off + a.count * n * (a.componentType === 5123 ? 2 : 4));
  if (a.componentType === 5126) return new Float32Array(buf);
  if (a.componentType === 5125) return new Uint32Array(buf);
  return Uint32Array.from(new Uint16Array(buf));
}

/** Triangle centroids (GLB frame) of all meshes below a node named in `names`. */
function centroids(g: Glb, names: string[]): THREE.Vector3[] {
  const parent = new Map<number, number>();
  g.json.nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const local = (i: number) => {
    const n = g.json.nodes[i];
    return new THREE.Matrix4().compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])));
  };
  const out: THREE.Vector3[] = [];
  g.json.nodes.forEach((n, i) => {
    if (n.mesh === undefined) return;
    let M = local(i), ok = names.includes(n.name ?? '');
    for (let p = parent.get(i); p !== undefined; p = parent.get(p)) { M = local(p).multiply(M); ok ||= names.includes(g.json.nodes[p].name ?? ''); }
    if (!ok) return;
    for (const prim of g.json.meshes[n.mesh].primitives) {
      const P = accessor(g, prim.attributes.POSITION) as Float32Array;
      const idx = prim.indices !== undefined ? accessor(g, prim.indices) : Uint32Array.from({ length: P.length / 3 }, (_, k) => k);
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const c = new THREE.Vector3();
        for (let k = 0; k < 3; k++) c.add(new THREE.Vector3(P[idx[t + k] * 3], P[idx[t + k] * 3 + 1], P[idx[t + k] * 3 + 2]));
        out.push(c.divideScalar(3).applyMatrix4(M));
      }
    }
  });
  return out;
}

/** Same rules as splitDynamicLandmarks: first non-body part whose region holds the centroid, else the body. */
function assign(defs: PropObjectDef[], tris: THREE.Vector3[]): { counts: Map<string, number>; statics: number } {
  const counts = new Map<string, number>();
  const objs = defs.map((d) => {
    const O = new THREE.Matrix4().compose(new THREE.Vector3(...d.origin), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), d.yawDeg * Math.PI / 180), new THREE.Vector3(1, 1, 1));
    const regions = d.parts.map((p, i) => (i === 0 && !p.region?.length ? [] : partRegions(p)).map((r) => new THREE.Box3(new THREE.Vector3(...r.min), new THREE.Vector3(...r.max))));
    d.parts.forEach((p) => counts.set(`${d.id}:${p.id}`, 0));
    return { d, inv: O.invert(), regions, claimRest: !d.parts[0].region?.length };
  });
  let statics = 0;
  const co = new THREE.Vector3();
  for (const c of tris) {
    let hit: string | null = null;
    for (const o of objs) {
      co.copy(c).applyMatrix4(o.inv);
      let part = -1;
      for (let pi = 1; pi < o.regions.length && part < 0; pi++) if (o.regions[pi].some((b) => b.containsPoint(co))) part = pi;
      if (part < 0 && (o.claimRest || o.regions[0].some((b) => b.containsPoint(co)))) part = 0;
      if (part >= 0) { hit = `${o.d.id}:${o.d.parts[part].id}`; break; }
    }
    if (hit) counts.set(hit, counts.get(hit)! + 1); else statics++;
  }
  return { counts, statics };
}

const meta = (site: string) => JSON.parse(fs.readFileSync(`public/assets/worlds/${site}/meta.json`, 'utf8')).landmarks[0].dynamic as PropObjectDef[];
const nodeNames = (g: Glb) => g.json.nodes.map((n) => n.name);

describe('Apollo descent stages', () => {
  for (const site of ['moon_tranquility', 'moon_hadley']) {
    it(`${site}: every LM part gets triangles, nothing static, budget kept`, () => {
      const g = readGlb(`public/assets/worlds/${site}/apollo_lm_descent.glb`);
      expect(nodeNames(g)).toEqual(expect.arrayContaining(['LM_Descent', 'Experiments', 'Ladder_Foot']));
      const lmDefs = meta(site).filter((d) => d.meshes.includes('LM_Descent'));
      const tris = centroids(g, ['LM_Descent']);
      expect(tris.length).toBeGreaterThan(8000);          // detailed model (previously 2778)
      expect(tris.length).toBeLessThan(40000);
      const { counts, statics } = assign(lmDefs, tris);
      for (const [part, n] of counts) expect(n, part).toBeGreaterThan(200);
      expect(statics).toBe(0);
      // geometry stays within the colliders' frame: footpad ring 9,45 m, deck below 3,6 m (leg regions)
      const box = new THREE.Box3().setFromPoints(tris);
      expect(box.max.x).toBeLessThan(5.3); expect(box.min.z).toBeGreaterThan(-5.3);
      expect(box.max.y).toBeLessThan(3.9);
      expect(g.size).toBeLessThan(3 * 1024 * 1024);       // load time: smaller than the previous file (3.9 MB)
    });
  }
});

describe('Stonehenge', () => {
  it('88 stones: each stone gets its triangles, ≤ 3 % static (previously 4 %)', () => {
    const g = readGlb('public/assets/worlds/earth_stonehenge/stonehenge.glb');
    expect(nodeNames(g)).toContain('Stonehenge');
    const defs = meta('earth_stonehenge');
    expect(defs).toHaveLength(88);
    const tris = centroids(g, ['Stonehenge']);
    expect(tris.length).toBeGreaterThan(60000);
    expect(tris.length).toBeLessThan(150000);
    const { counts, statics } = assign(defs, tris);
    for (const [stone, n] of counts) expect(n, stone).toBeGreaterThan(100);
    expect(statics / tris.length).toBeLessThan(0.03);
    expect(g.size).toBeLessThan(7 * 1024 * 1024);
  });
  it('the collision boxes are unchanged (survey layout kept)', () => {
    const stones = JSON.parse(fs.readFileSync('public/assets/worlds/earth_stonehenge/stonehenge_stones.json', 'utf8'));
    const lm = JSON.parse(fs.readFileSync('public/assets/worlds/earth_stonehenge/landmarks.json', 'utf8'))[0].stones;
    expect(lm).toEqual(stones);
    expect(stones).toHaveLength(88);
  });
});
