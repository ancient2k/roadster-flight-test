// Course order (time trial) and the sample tracks. With GEN_SAMPLES=1 the samples are (re)written to
// src/editor/samples/*.json from the turtle descriptions below; normal runs check that the shipped files match.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { buildCourse, exitOf, fitPiece } from '../../src/shared/course';
import { DIRS, partDef, placedConnectors, type PartType } from '../../src/shared/parts';
import { canPlace, emptyLevel, levelToJson, validateLevel, type Level, type LevelPart } from '../../src/shared/level';

const GRID = { nx: 48, nz: 36 };

/** Lays pieces one after another: 'R'/'L' = 90° curve right/left (z down, so right turns clockwise on the map). */
function turtle(name: string, i: number, j: number, dir: number, steps: (PartType | 'R' | 'L' | 'RW' | 'LW' | 'RB' | 'LB' | ['gap', number])[]): Level {
  const L = emptyLevel(name);
  // start piece whose exit points along dir
  const start = [0, 1, 2, 3].map((rot) => ({ type: 'start' as const, i, j, rot: rot as 0 | 1 | 2 | 3 }))
    .find((p) => placedConnectors(partDef('start'), p.i, p.j, p.rot)[1].dir === dir)!;
  L.parts.push(start);
  let exit = placedConnectors(partDef('start'), start.i, start.j, start.rot)[1];
  for (const s of steps) {
    if (Array.isArray(s)) { exit = { ...exit, ti: exit.ti + DIRS[exit.dir][0] * s[1], tj: exit.tj + DIRS[exit.dir][1] * s[1] }; continue; }
    const turn = s === 'R' || s === 'RW' || s === 'RB' ? 1 : s === 'L' || s === 'LW' || s === 'LB' ? 3 : 0;
    const type: PartType = s === 'R' || s === 'L' ? 'curve' : s === 'RW' || s === 'LW' ? 'curve_wide' : s === 'RB' || s === 'LB' ? 'banked' : s;
    const ti = exit.ti + DIRS[exit.dir][0], tj = exit.tj + DIRS[exit.dir][1], back = (exit.dir + 2) % 4;
    let placed: LevelPart | null = null;
    if (type === 'landing') {
      // the landing ramp's only road end is its exit (forward); its high end starts on the target tile
      for (const rot of [0, 1, 2, 3] as const) {
        const c = placedConnectors(partDef('landing'), 0, 0, rot)[0];
        if (c.dir !== exit.dir) continue;
        const d = partDef('landing').d - 1;
        placed = { type, i: ti - (c.ti - DIRS[exit.dir][0] * d), j: tj - (c.tj - DIRS[exit.dir][1] * d), rot };
      }
    }
    for (let v = 0; v < 8 && !placed; v++) {
      const p = fitPiece(type, ti, tj, back, exit.lv, v);
      if (!p) break;
      const ex = exitOf(p, ti, tj, back);
      const wantDir = (exit.dir + turn) % 4;
      if (partDef(type).conn.length < 2 || (ex && ex.dir === wantDir)) placed = p;
    }
    if (!placed) throw new Error(`cannot place ${s} after ${JSON.stringify(exit)}`);
    if (!canPlace(L, GRID, placed)) throw new Error(`${s} overlaps or leaves the grid at ${placed.i},${placed.j}`);
    L.parts.push(placed);
    const ex = exitOf(placed, ti, tj, back);
    if (ex) exit = ex;
    else {
      // dead end (jump ramp): continue straight from its far tile
      const far = placedConnectors(partDef(type), placed.i, placed.j, placed.rot)[0];
      exit = { ti: far.ti + DIRS[exit.dir][0] * (partDef(type).d - 1), tj: far.tj + DIRS[exit.dir][1] * (partDef(type).d - 1), dir: exit.dir, lv: exit.lv };
    }
  }
  return L;
}

const SAMPLES: Record<string, () => Level> = {
  'starbase-sprint': () => {
    const L = turtle('Starbase Sprint', 6, 28, 0, [
      'road', 'boost', 'road', 'loop', 'road', 'road', 'RW',
      'road', 'road', 'road', 'kicker', ['gap', 1], 'landing', 'road', 'road', 'air_station', 'road', 'road', 'road', 'RB',
      'road', 'road', 'halfpipe', 'road', 'road', 'road', 'RW',
      'road', 'road', 'road', 'road', 'road', 'road', 'road', 'road', 'road', 'road', 'road', 'road', 'road', 'launch', 'R',
    ]);
    L.deco.push(
      { type: 'light_mast', x: 5.2, z: 28.5, rotDeg: 0 }, { type: 'light_mast', x: 7.8, z: 28.5, rotDeg: 0 },
      { type: 'cone', x: 6.2, z: 26.2, rotDeg: 0 }, { type: 'cone', x: 6.8, z: 26.2, rotDeg: 0 },
      { type: 'container', x: 3.5, z: 20, rotDeg: 0 }, { type: 'barrier', x: 5.4, z: 22, rotDeg: 0 }, { type: 'barrier', x: 7.6, z: 22, rotDeg: 0 },
    );
    return L;
  },
};

describe('course', () => {
  it('follows the road from the start and detects a closed lap', () => {
    const L = SAMPLES['starbase-sprint']();
    const c = buildCourse(L)!;
    expect(c.closed).toBe(true);
    expect(c.order.length).toBe(L.parts.length);
  });

  it('an open course ends at the last piece', () => {
    const L = emptyLevel('x');
    L.parts.push({ type: 'start', i: 5, j: 5, rot: 0 }, { type: 'road', i: 5, j: 6, rot: 0 });
    expect(buildCourse(L)).toEqual({ order: [0, 1], closed: false });
    expect(buildCourse(emptyLevel('y'))).toBeNull();
  });

  for (const [id, make] of Object.entries(SAMPLES)) {
    it(`sample ${id} is shipped, valid and up to date`, () => {
      const L = make();
      const file = `src/editor/samples/${id}.json`;
      const json = JSON.stringify(JSON.parse(levelToJson(L)), null, 1) + '\n';
      if (process.env.GEN_SAMPLES) { fs.mkdirSync('src/editor/samples', { recursive: true }); fs.writeFileSync(file, json); }
      expect(fs.readFileSync(file, 'utf8')).toBe(json);
      expect(validateLevel(JSON.parse(json), GRID).dropped).toBe(0);
    });
  }
});
