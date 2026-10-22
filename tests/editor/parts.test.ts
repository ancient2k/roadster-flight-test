// Track pieces of the level editor: every solid is closed and wound outward (the physics uses them as one-sided
// trimeshes with FIX_INTERNAL_EDGES), stays inside its footprint, and the road ends rotate with the piece.
import { describe, expect, it } from 'vitest';
import { PARTS, buildPart, placeTris, placedConnectors, partDef, TILE_M, triangulate, DIRS } from '../../src/shared/parts';
import { canPlace, emptyLevel, levelToJson, partTiles, validateLevel, type Level } from '../../src/shared/level';

const key = (x: number, y: number, z: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;

/** Every directed edge must have exactly one opposite partner; returns the number of bad edges. */
function openEdges(t: Float32Array): number {
  const count = new Map<string, number>();
  for (let k = 0; k < t.length; k += 9) {
    const v = [key(t[k], t[k + 1], t[k + 2]), key(t[k + 3], t[k + 4], t[k + 5]), key(t[k + 6], t[k + 7], t[k + 8])];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;      // degenerate sliver (pinched section end)
    for (let e = 0; e < 3; e++) { const a = v[e], b = v[(e + 1) % 3]; count.set(`${a}|${b}`, (count.get(`${a}|${b}`) ?? 0) + 1); }
  }
  let bad = 0;
  for (const [e, n] of count) {
    const [a, b] = e.split('|');
    if (n !== 1 || count.get(`${b}|${a}`) !== 1) bad++;
  }
  return bad;
}

function signedVolume(t: Float32Array): number {
  let v = 0;
  for (let k = 0; k < t.length; k += 9) {
    const ax = t[k], ay = t[k + 1], az = t[k + 2], bx = t[k + 3], by = t[k + 4], bz = t[k + 5], cx = t[k + 6], cy = t[k + 7], cz = t[k + 8];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

describe('track pieces', () => {
  for (const def of PARTS) {
    it(`${def.type}: closed, outward solids inside the footprint`, () => {
      const m = buildPart(def.type);
      expect(m.solids.length + m.decals.length).toBeGreaterThan(0);
      for (const s of m.solids) {
        expect(s.tris.length % 9).toBe(0);
        expect(openEdges(s.tris), `${def.type} ${s.mat}`).toBe(0);
        expect(signedVolume(s.tris), `${def.type} ${s.mat}`).toBeGreaterThan(0);
        for (let k = 0; k < s.tris.length; k += 3) {
          expect(s.tris[k]).toBeGreaterThan(-2);
          expect(s.tris[k]).toBeLessThan(def.w * TILE_M + 2);
          expect(s.tris[k + 2]).toBeGreaterThan(-2);
          expect(s.tris[k + 2]).toBeLessThan(def.d * TILE_M + 2);
        }
      }
    });
  }

  it('ear clipping triangulates concave polygons', () => {
    const L: [number, number][] = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
    expect(triangulate(L)).toHaveLength(4);
    expect(triangulate([...L].reverse())).toHaveLength(4);
  });

  it('road ends rotate with the piece', () => {
    const road = partDef('road');
    expect(placedConnectors(road, 5, 5, 0).map((c) => c.dir).sort()).toEqual([0, 2]);
    expect(placedConnectors(road, 5, 5, 1).map((c) => c.dir).sort()).toEqual([1, 3]);
    const curve = partDef('curve');
    const dirs = [0, 1, 2, 3].map((r) => placedConnectors(curve, 0, 0, r).map((c) => c.dir).sort().join(','));
    expect(new Set(dirs).size).toBe(4);                     // four distinct orientations
    // a wide curve leaves its 2×2 footprint on the far tile
    const wide = placedConnectors(partDef('curve_wide'), 10, 10, 0);
    expect(wide).toEqual(expect.arrayContaining([{ ti: 10, tj: 10, dir: 0, lv: 0 }, { ti: 11, tj: 11, dir: 1, lv: 0 }]));
  });

  it('the road end of a placed straight lies on the shared tile edge, at the road centre', () => {
    const road = partDef('road');
    for (const rot of [0, 1, 2, 3]) {
      const t = placeTris(buildPart('road').decals[0].tris, road, 3, 4, rot, 0);
      // all asphalt vertices inside tile (3, 4)
      for (let k = 0; k < t.length; k += 3) {
        expect(t[k]).toBeGreaterThanOrEqual(3 * TILE_M - 1e-6); expect(t[k]).toBeLessThanOrEqual(4 * TILE_M + 1e-6);
        expect(t[k + 2]).toBeGreaterThanOrEqual(4 * TILE_M - 1e-6); expect(t[k + 2]).toBeLessThanOrEqual(5 * TILE_M + 1e-6);
      }
      for (const c of placedConnectors(road, 3, 4, rot)) expect(DIRS[c.dir]).toBeDefined();
    }
  });
});

describe('level format', () => {
  const grid = { nx: 48, nz: 36 };
  it('places pieces without overlap on the same level, bridges over roads on level 1', () => {
    const L: Level = emptyLevel('t');
    const a = { type: 'road' as const, i: 2, j: 2, rot: 0 as const };
    expect(canPlace(L, grid, a)).toBe(true);
    L.parts.push(a);
    expect(canPlace(L, grid, { type: 'road', i: 2, j: 2, rot: 1 })).toBe(false);
    expect(canPlace(L, grid, { type: 'elevated', i: 2, j: 2, rot: 1, lv: 1 })).toBe(true);
    expect(canPlace(L, grid, { type: 'loop', i: 47, j: 0, rot: 1 })).toBe(false);   // 2 tiles wide after rotation
    expect(partTiles({ type: 'loop', i: 0, j: 0, rot: 1 })).toHaveLength(2);
  });

  it('round-trips through JSON and drops broken entries', () => {
    const L = emptyLevel('Test track');
    L.parts.push({ type: 'start', i: 1, j: 1, rot: 0 }, { type: 'launch', i: 1, j: 2, rot: 0, opt: 90 }, { type: 'elevated', i: 1, j: 1, rot: 0, lv: 1 });
    L.deco.push({ type: 'cone', x: 3.5, z: 4.25, rotDeg: 15 });
    L.settings = { damage: 'full' };
    const back = validateLevel(JSON.parse(levelToJson(L)), grid);
    expect(back.dropped).toBe(0);
    expect(back.level).toEqual({ ...L, v: 1 });
    const raw = JSON.parse(levelToJson(L));
    raw.parts.push({ type: 'teleporter', i: 0, j: 0, rot: 0 }, { type: 'road', i: 99, j: 0, rot: 0 }, { type: 'road', i: 1, j: 1, rot: 2 });
    raw.deco.push({ type: 'cone', x: 'a', z: 1, rotDeg: 0 });
    expect(validateLevel(raw, grid).dropped).toBe(4);
    expect(() => validateLevel({ v: 99 }, grid)).toThrow(/newer/);
    expect(() => validateLevel('x', grid)).toThrow();
  });
});

describe('sample levels', () => {
  it('showcase.json is a valid level without dropped entries', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = JSON.parse(readFileSync('tests/editor/levels/showcase.json', 'utf8'));
    const r = validateLevel(raw, { nx: 48, nz: 36 });
    expect(r.dropped).toBe(0);
    expect(r.level.parts.length).toBe(raw.parts.length);
  });
});
