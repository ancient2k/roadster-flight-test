// R5 (Welten-Optik): pure parts of the new world detail – baked small-crater tile, Giza layouts (mastaba
// fields, city edge), pebble lattice. No GPU.
import { describe, expect, it } from 'vitest';
import { craterTile } from '../../../src/render/worlds/terrain';
import { mastabaLayout, cityLayout } from '../../../src/render/worlds/giza';
import { PebbleField } from '../../../src/render/worlds/pebbles';
import { TerrainField, type HeightGrid } from '../../../src/render/worlds/terrainData';
import * as THREE from 'three/webgpu';

const grid = (size: number, extentM: number, f: (x: number, z: number) => number): HeightGrid => {
  const h = new Float32Array(size * size);
  const cs = extentM / (size - 1);
  let minM = Infinity, maxM = -Infinity;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const v = f(c * cs - extentM / 2, r * cs - extentM / 2);
    h[r * size + c] = v; minM = Math.min(minM, v); maxM = Math.max(maxM, v);
  }
  return { h, size, extentM, cx: 0, cz: 0, minM, maxM } as HeightGrid;
};

describe('small-crater tile', () => {
  it('is deterministic, periodic-safe and mostly flat with bowls (Moon dense, Mars sparse)', () => {
    const a = craterTile('moon', 256), b = craterTile('moon', 256), m = craterTile('mars', 256);
    const da = a.image.data as Uint8Array, db = b.image.data as Uint8Array, dm = m.image.data as Uint8Array;
    expect(Array.from(da.slice(0, 4096))).toEqual(Array.from(db.slice(0, 4096)));
    const busy = (d: Uint8Array) => { let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 128) > 6 || Math.abs(d[i + 1] - 128) > 6) n++; return n / (d.length / 4); };
    const bm = busy(da), bmars = busy(dm);
    expect(bm).toBeGreaterThan(0.05);
    expect(bm).toBeLessThan(0.7);            // regolith between craters stays level
    expect(bmars).toBeLessThan(bm);           // Mars: far fewer small craters than the Moon
    // slopes are signed: a bowl tilts both ways, so the mean slope stays near zero
    let sx = 0; for (let i = 0; i < da.length; i += 4) sx += da[i] - 128;
    expect(Math.abs(sx / (da.length / 4))).toBeLessThan(4);
    expect(a.wrapS).toBe(THREE.RepeatWrapping);
  });
});

describe('Giza layouts', () => {
  // plateau (y 0) west of x = 900, Nile valley (y −45) east of it
  const near = grid(129, 4000, (x) => (x > 900 ? -45 : 0));
  const far = grid(129, 30000, (x) => (x > 900 ? -45 : 0));
  const field = new TerrainField(near, far);
  it('mastabas: Western/Eastern Cemetery, long axis N–S, a few metres high, on the ground', () => {
    const mb = mastabaLayout(field);
    expect(mb.length).toBeGreaterThan(80);
    for (const b of mb) {
      const west = b.x > 0 && b.x < 290 && b.z > -800 && b.z < -320;
      const east = b.x > 600 && b.x < 790 && b.z > -680 && b.z < -400;
      expect(west || east).toBe(true);
      expect(b.d).toBeGreaterThan(b.w);
      expect(b.h).toBeGreaterThan(2); expect(b.h).toBeLessThan(9.5);
    }
  });
  it('city: only on the valley floor, never on the plateau or among the monuments', () => {
    const cb = cityLayout(field, -45);
    expect(cb.length).toBeGreaterThan(500);
    for (const b of cb) {
      expect(b.y).toBeLessThan(-45 + 9);      // within 9 m of the valley floor
      expect(b.x > 900 || b.z < -1250).toBe(true);
    }
  });
});

describe('pebble lattice', () => {
  it('is world-anchored: the same stones come back after the camera moves away and returns', () => {
    const g = grid(65, 400, () => 0);
    const field = new TerrainField(g, null);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial();
    const pf = new PebbleField(field, [geo, geo], mat, { radius: 20, density: 0.5, cellM: 0.7, dMin: 0.05, dMax: 0.6, maxInstances: 3000, seed: 3 });
    const snap = () => { const m = new THREE.Matrix4(); const out: number[] = []; for (const im of pf.group.children as THREE.InstancedMesh[]) for (let i = 0; i < Math.min(5, im.count); i++) { im.getMatrixAt(i, m); out.push(...m.elements.slice(12, 15)); } return out; };
    pf.update(new THREE.Vector3(0, 2, 0));
    const n0 = pf.count, s0 = snap();
    // about π r² / cell² · density stones
    expect(n0).toBeGreaterThan(0.7 * Math.PI * 400 / 0.49 * 0.5);
    expect(n0).toBeLessThan(1.3 * Math.PI * 400 / 0.49 * 0.5);
    pf.update(new THREE.Vector3(60, 2, 0));
    pf.update(new THREE.Vector3(0, 2, 0));
    expect(snap()).toEqual(s0);
    pf.dispose();
  });
});
