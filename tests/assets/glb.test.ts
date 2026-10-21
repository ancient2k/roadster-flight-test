// GLB contract tests for the assets (public/assets/car, public/assets/props).
// Dependency-free GLB parsing (header + JSON chunk + BIN chunk); no three.js loader in Node.
import { describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readGlbFile } from './glbFile';
import { ROADSTER } from '../../src/shared/roadster';
import { TRACK } from '../../src/shared/track';

type V3 = [number, number, number];
type Q = [number, number, number, number]; // x y z w

interface GltfNode {
  name?: string; mesh?: number; children?: number[];
  translation?: V3; rotation?: Q; scale?: V3; matrix?: number[];
}
interface Gltf {
  nodes: GltfNode[];
  scenes: { nodes: number[] }[];
  scene?: number;
  meshes: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
  materials?: { name?: string; emissiveFactor?: V3; extensions?: Record<string, { emissiveStrength?: number }> ; pbrMetallicRoughness?: Record<string, unknown> }[];
  accessors: { count: number; min?: number[]; max?: number[]; type: string }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
}

const root = fileURLToPath(new URL('../../', import.meta.url));

function readGlb(rel: string): { json: Gltf; bytes: number } {
  const buf = readGlbFile(root + rel);
  expect(buf.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
  expect(buf.readUInt32LE(4)).toBe(2);
  const jsonLen = buf.readUInt32LE(12);
  expect(buf.readUInt32LE(16)).toBe(0x4e4f534a); // 'JSON'
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as Gltf;
  return { json, bytes: statSync(root + rel).size };
}

// ---------------------------------------------------------------- small math
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
function qrotv(q: Q, v: V3): V3 {
  const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
  return [p[0], p[1], p[2]];
}
interface World { pos: V3; rot: Q; scale: V3 }

/** World transforms of all named nodes (TRS only; scale assumed uniform-ish and positive). */
function worldTransforms(g: Gltf): Map<string, World> {
  const out = new Map<string, World>();
  const visit = (i: number, parent: World) => {
    const n = g.nodes[i];
    expect(n.matrix, `node ${n.name} uses matrix`).toBeUndefined();
    const t = n.translation ?? [0, 0, 0], r = n.rotation ?? [0, 0, 0, 1], s = n.scale ?? [1, 1, 1];
    const ts: V3 = [t[0] * parent.scale[0], t[1] * parent.scale[1], t[2] * parent.scale[2]];
    const tp = qrotv(parent.rot, ts);
    const w: World = {
      pos: [parent.pos[0] + tp[0], parent.pos[1] + tp[1], parent.pos[2] + tp[2]],
      rot: qmul(parent.rot, r),
      scale: [parent.scale[0] * s[0], parent.scale[1] * s[1], parent.scale[2] * s[2]],
    };
    if (n.name) out.set(n.name, w);
    for (const c of n.children ?? []) visit(c, w);
  };
  for (const i of g.scenes[g.scene ?? 0].nodes) visit(i, { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] });
  return out;
}

/** Rendered triangles (per node instance) and world-space AABB from accessor min/max. */
function stats(g: Gltf) {
  const tw = worldTransforms(g);
  let tris = 0;
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const n of g.nodes) {
    if (n.mesh === undefined) continue;
    const w = tw.get(n.name ?? '')!;
    for (const p of g.meshes[n.mesh].primitives) {
      const mode = p.mode ?? 4;
      if (mode !== 4) continue;
      const cnt = p.indices !== undefined ? g.accessors[p.indices].count : g.accessors[p.attributes.POSITION].count;
      tris += cnt / 3;
      const a = g.accessors[p.attributes.POSITION];
      if (!a.min || !a.max || !w) continue;
      for (let c = 0; c < 8; c++) {
        const v: V3 = [c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]];
        const r = qrotv(w.rot, [v[0] * w.scale[0], v[1] * w.scale[1], v[2] * w.scale[2]]);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], r[k] + w.pos[k]);
          max[k] = Math.max(max[k], r[k] + w.pos[k]);
        }
      }
    }
  }
  return { tris, min, max };
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- roadster
const REQUIRED_NODES = [
  'Body', 'Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR',
  'Caliper_FL', 'Caliper_FR', 'Caliper_RL', 'Caliper_RR',
  'Door_L', 'Door_R', 'Wing', 'Seat', 'Yoke',
  ...Array.from({ length: 10 }, (_, i) => `Nozzle_${i}`),
];
const REQUIRED_MATERIALS = [
  'Paint_AnoWhite', 'Carbon', 'Glass_Tint', 'Tire', 'Rim', 'Brass_Nozzle',
  'LED_Front', 'LED_Tail', 'LED_Brake', 'Interior',
];

// ROADSTER_GLB=lod0.glb,lod1.glb checks candidate files (e.g. the R4 v3 build) against the same contract.
const ROADSTER_FILES: [string, number][] = process.env.ROADSTER_GLB
  ? process.env.ROADSTER_GLB.split(',').map((f, i): [string, number] => [f, i === 0 ? 400_000 : 90_000])
  : [['public/assets/car/roadster.glb', 400_000], ['public/assets/car/roadster_lod1.glb', 90_000]];
for (const [file, maxTris] of ROADSTER_FILES) {
  describe(`GLB contract: ${file}`, () => {
    const { json: g, bytes } = readGlb(file);
    const w = worldTransforms(g);

    it('has all required nodes', () => {
      for (const n of REQUIRED_NODES) expect(w.has(n), `missing node ${n}`).toBe(true);
    });

    it('wheels sit exactly at ROADSTER.wheels[].pos with identity rotation (spin axis = X)', () => {
      for (const spec of ROADSTER.wheels) {
        const t = w.get(`Wheel_${spec.id}`)!;
        expect(near(t.pos[0], spec.pos.x, 1e-3) && near(t.pos[1], spec.pos.y, 1e-3) && near(t.pos[2], spec.pos.z, 1e-3),
          `Wheel_${spec.id} at ${t.pos} expected ${JSON.stringify(spec.pos)}`).toBe(true);
        const axis = qrotv(t.rot, [1, 0, 0]);
        expect(axis[0]).toBeGreaterThan(0.9999);
        const up = qrotv(t.rot, [0, 1, 0]);
        expect(up[1]).toBeGreaterThan(0.9999);
        const c = w.get(`Caliper_${spec.id}`)!;
        expect(near(c.pos[0], spec.pos.x, 1e-3) && near(c.pos[1], spec.pos.y, 1e-3) && near(c.pos[2], spec.pos.z, 1e-3)).toBe(true);
      }
    });

    it('wheel meshes have the configured radius and width', () => {
      for (const spec of ROADSTER.wheels) {
        const node = g.nodes.find((n) => n.name === `Wheel_${spec.id}`)!;
        expect(node.mesh).toBeDefined();
        let min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
        for (const p of g.meshes[node.mesh!].primitives) {
          const a = g.accessors[p.attributes.POSITION];
          min = min.map((m, k) => Math.min(m, a.min![k])) as V3;
          max = max.map((m, k) => Math.max(m, a.max![k])) as V3;
        }
        expect(near(max[1], spec.radius, 0.004) && near(-min[1], spec.radius, 0.004), `Wheel_${spec.id} radius ${max[1]}`).toBe(true);
        expect(near(max[2], spec.radius, 0.004) && near(-min[2], spec.radius, 0.004)).toBe(true);
        expect(near(max[0] - min[0], spec.width, 0.02), `Wheel_${spec.id} width ${max[0] - min[0]}`).toBe(true);
      }
    });

    it('nozzle empties sit at ROADSTER.nozzles[].pos with local +Z = exhaust (= -dir)', () => {
      for (const spec of ROADSTER.nozzles) {
        const t = w.get(`Nozzle_${spec.id}`)!;
        expect(near(t.pos[0], spec.pos.x, 1e-3) && near(t.pos[1], spec.pos.y, 1e-3) && near(t.pos[2], spec.pos.z, 1e-3),
          `Nozzle_${spec.id} at ${t.pos}`).toBe(true);
        const z = qrotv(t.rot, [0, 0, 1]);
        const dot = -(z[0] * spec.dir.x + z[1] * spec.dir.y + z[2] * spec.dir.z);
        expect(dot, `Nozzle_${spec.id} exhaust axis ${z}`).toBeGreaterThan(0.9999);
      }
    });

    it('body fits ROADSTER.dims, nose to +Z, left side at +X, wheels on the ground', () => {
      const s = stats(g);
      // nose forward: front of the model near bodyBox.max.z, tail near bodyBox.min.z
      expect(s.max[2]).toBeGreaterThan(2.15);
      expect(s.max[2]).toBeLessThan(2.32);
      expect(s.min[2]).toBeLessThan(-2.0);
      expect(s.min[2]).toBeGreaterThan(-2.2);
      expect(s.max[1]).toBeGreaterThan(0.62);
      expect(s.max[1]).toBeLessThan(0.70);
      expect(s.max[0] - s.min[0]).toBeLessThan(ROADSTER.dims.width + 0.1); // tyres may stand slightly proud
      expect(s.max[0] - s.min[0]).toBeGreaterThan(ROADSTER.dims.width - 0.1);
      // ground contact at y = wheel.pos.y - radius (~ -0.44 .. -0.45)
      expect(s.min[1]).toBeGreaterThan(-0.46);
      expect(s.min[1]).toBeLessThan(-0.43);
      // Door_L is on the +X side
      expect(w.get('Door_L')!.pos[0]).toBeGreaterThan(0);
      expect(w.get('Door_R')!.pos[0]).toBeLessThan(0);
      expect(w.get('Wing')!.pos[2]).toBeLessThan(-1.0);
    });

    it('has the named PBR materials; LEDs are emissive', () => {
      const names = (g.materials ?? []).map((m) => m.name);
      for (const n of REQUIRED_MATERIALS) expect(names, `missing material ${n}`).toContain(n);
      for (const n of ['LED_Front', 'LED_Tail', 'LED_Brake']) {
        const m = g.materials!.find((x) => x.name === n)!;
        expect(Math.max(...(m.emissiveFactor ?? [0, 0, 0]))).toBeGreaterThan(0.1);
      }
      // glass is physically transmissive (KHR_materials_transmission + ior), not alpha-blended
      const glass = g.materials!.find((x) => x.name === 'Glass_Tint')! as { alphaMode?: string; extensions?: Record<string, unknown> };
      expect(glass.alphaMode ?? 'OPAQUE').toBe('OPAQUE');
      expect(glass.extensions?.KHR_materials_transmission).toBeDefined();
      expect(glass.extensions?.KHR_materials_ior).toBeDefined();
    });

    it(`budget: <= ${maxTris} triangles, <= 40 MB, textures embedded`, () => {
      const s = stats(g);
      expect(s.tris).toBeLessThanOrEqual(maxTris);
      expect(bytes).toBeLessThanOrEqual(40 * 1024 * 1024);
      for (const img of g.images ?? []) expect(img.uri, 'textures must be embedded').toBeUndefined();
    });
  });
}

// ---------------------------------------------------------------- props
describe('GLB contract: props', () => {
  for (const ob of TRACK.obstacles) {
    it(`${ob.model}.glb matches TRACK obstacle size (x width, y height, z length, origin bottom-centre)`, () => {
      const { json: g, bytes } = readGlb(`public/assets/props/${ob.model}.glb`);
      const s = stats(g);
      expect(s.tris).toBeLessThanOrEqual(65_000); // Lead: props 25-60k
      expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      const size = [s.max[0] - s.min[0], s.max[1] - s.min[1], s.max[2] - s.min[2]];
      expect(near(size[0], ob.size.x, 0.06), `${ob.model} width ${size[0]}`).toBe(true);
      expect(near(size[1], ob.size.y, 0.06), `${ob.model} height ${size[1]}`).toBe(true);
      expect(near(size[2], ob.size.z, 0.06), `${ob.model} length ${size[2]}`).toBe(true);
      expect(Math.abs(s.min[1])).toBeLessThan(0.01);
      expect(Math.abs((s.max[0] + s.min[0]) / 2)).toBeLessThan(0.05);
      expect(Math.abs((s.max[2] + s.min[2]) / 2)).toBeLessThan(0.05);
    });
  }
});

// ---------------------------------------------------------------- Starman roadster (2008 Roadster, phase 2 sun scene)
describe('GLB contract: car/roadster1_starman.glb', () => {
  const { json: g, bytes } = readGlb('public/assets/car/roadster1_starman.glb');
  const w = worldTransforms(g);
  it('has body, four wheels and Starman', () => {
    for (const n of ['Body', 'Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR', 'Starman', 'SteeringWheel']) expect(w.has(n), n).toBe(true);
    expect(w.get('Wheel_FL')!.pos[0]).toBeGreaterThan(0);   // left side at +X
    expect(w.get('Wheel_FL')!.pos[2]).toBeGreaterThan(w.get('Wheel_RL')!.pos[2]); // nose to +Z
  });
  it('origin = centre of the vehicle, 2008 Roadster dimensions, <= 150k triangles', () => {
    const s = stats(g);
    for (let k = 0; k < 3; k++) expect(Math.abs((s.max[k] + s.min[k]) / 2), `centre axis ${k}`).toBeLessThan(0.03);
    expect(near(s.max[2] - s.min[2], 3.946, 0.08)).toBe(true);
    expect(s.max[0] - s.min[0]).toBeGreaterThan(1.8);
    expect(s.max[0] - s.min[0]).toBeLessThan(2.1);  // incl. mirrors
    expect(s.tris).toBeLessThanOrEqual(150_000);
    expect(bytes).toBeLessThanOrEqual(20 * 1024 * 1024);
  });
});
