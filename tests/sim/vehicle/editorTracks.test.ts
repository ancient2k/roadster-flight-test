// Drivability of the track-editor pieces and tracks, with the full vehicle model: the course driver
// (src/sim/gnc/courseDriver.ts) drives what a player builds – every piece between run-up and run-out, in all four
// directions of the field, curves to both sides, jumps over different gaps, up onto the elevated road and down again,
// and the shipped sample tracks lap by lap. A piece passes when the car gets through it at the speeds the driver
// picks (curve limits, the run-up a loop or a jump needs) without leaving the line, getting stuck or wrecking.
import { describe, expect, it } from 'vitest';
import { driveLevel } from './courseHarness';
import { exitOf, fitPiece } from '../../../src/shared/course';
import { partDef, placedConnectors, DIRS, type PartType } from '../../../src/shared/parts';
import type { Level, LevelPart } from '../../../src/shared/level';
import sprint from '../../../src/editor/samples/starbase-sprint.json';
import showcase from '../../../src/editor/samples/showcase.json';

type Step = PartType | { type: PartType; variant: number } | { jump: number };

/**
 * A chain of pieces from a start piece at the middle of the field heading `dir` (index into DIRS): each piece continues
 * the road end of the previous one (variant: which way a curve turns); { jump: g } is a kicker and a landing g tiles
 * further on.
 */
export function chain(dir: number, steps: Step[]): Level {
  const parts: LevelPart[] = [];
  const [dx0, dz0] = DIRS[dir];
  const si = 24 - dx0 * 8, sj = 18 - dz0 * 8;
  // the start piece: its south end faces back (the course leaves it through its north end)
  const back0 = (dir + 2) % 4;
  let start: LevelPart | null = null;
  for (let v = 0; v < 4 && !start; v++) {
    const p = fitPiece('start', si, sj, back0, 0, v);
    if (p && placedConnectors(partDef('start'), p.i, p.j, p.rot)[0].dir === back0) start = p;
  }
  parts.push(start!);
  let exit = placedConnectors(partDef('start'), start!.i, start!.j, start!.rot)[1];
  for (const st of steps) {
    const [dx, dz] = DIRS[exit.dir];
    if (typeof st === 'object' && 'jump' in st) {
      const ti = exit.ti + dx, tj = exit.tj + dz;
      const k = fitPiece('kicker', ti, tj, (exit.dir + 2) % 4, 0, 0)!;
      parts.push(k);
      // landing: high end toward the kicker, its road end (N) on the far tile facing on
      const far = { ti: ti + dx * (st.jump + 2), tj: tj + dz * (st.jump + 2) };
      const l = fitPiece('landing', far.ti, far.tj, exit.dir, 0, 0)!;
      parts.push(l);
      exit = { ...far, dir: exit.dir, lv: 0 };
      continue;
    }
    const type = typeof st === 'string' ? st : st.type, variant = typeof st === 'string' ? 0 : st.variant;
    const ti = exit.ti + dx, tj = exit.tj + dz, back = (exit.dir + 2) % 4;
    const p = fitPiece(type, ti, tj, back, exit.lv, variant);
    if (!p) throw new Error(`no fit for ${type}`);
    parts.push(p);
    exit = exitOf(p, ti, tj, back)!;
  }
  return { v: 1, name: 'test', site: 'earth_bocachica', parts, deco: [] } as unknown as Level;
}

const RUN_UP = ['road', 'road', 'road'] as const;
const RUN_OUT = ['road', 'road'] as const;
const ALL_DIRS = [0, 1, 2, 3];

async function expectDrivable(level: Level, label: string) {
  const r = await driveLevel(level, { maxS: 60 });
  const where = r.failPart != null ? ` at ${level.parts[r.failPart]?.type} (#${r.failPart})` : '';
  expect(r.fail ? `${label}: ${r.fail}${where}` : 'ok', label).toBe('ok');
  expect(r.done, `${label}: reached the end`).toBe(true);
}

describe('track pieces are drivable', () => {
  const cases: [string, Step[], number[]][] = [
    ['straights', ['road', 'boost', 'air_station', 'launch', 'road'], [0, 1]],
    ['curve left', [...RUN_UP, { type: 'curve', variant: 0 }, ...RUN_OUT], ALL_DIRS],
    ['curve right', [...RUN_UP, { type: 'curve', variant: 1 }, ...RUN_OUT], ALL_DIRS],
    ['wide curve left', [...RUN_UP, { type: 'curve_wide', variant: 0 }, ...RUN_OUT], [0, 1]],
    ['wide curve right', [...RUN_UP, { type: 'curve_wide', variant: 1 }, ...RUN_OUT], [0, 1]],
    ['banked curve left', [...RUN_UP, { type: 'banked', variant: 0 }, ...RUN_OUT], [0, 1]],
    ['banked curve right', [...RUN_UP, { type: 'banked', variant: 1 }, ...RUN_OUT], [0, 1]],
    ['half pipe', [...RUN_UP, 'halfpipe', ...RUN_OUT], [0, 1]],
    ['loop', [...RUN_UP, 'road', 'loop', ...RUN_OUT], ALL_DIRS],
    ['loop driven backwards', [...RUN_UP, 'road', { type: 'loop', variant: 1 }, ...RUN_OUT], [0, 1]],
    ['two loops in a row', [...RUN_UP, 'road', 'loop', 'road', 'road', 'loop', ...RUN_OUT], [0]],
    ['up onto the elevated road and down', [...RUN_UP, 'ramp_up', 'elevated', { type: 'elevated_curve', variant: 0 }, 'elevated', { type: 'ramp_up', variant: 1 }, ...RUN_OUT], [0, 1]],
    ['jump over 1 tile', [...RUN_UP, 'road', { jump: 1 }, ...RUN_OUT], ALL_DIRS],
    ['jump over 2 tiles', [...RUN_UP, 'road', { jump: 2 }, ...RUN_OUT], [0, 1]],
    ['jump over 3 tiles', [...RUN_UP, 'road', 'road', { jump: 3 }, ...RUN_OUT], [0, 1]],
  ];
  for (const [name, steps, dirs] of cases) for (const d of dirs) {
    it(`${name}, heading ${['north', 'east', 'south', 'west'][d]}`, async () => {
      await expectDrivable(chain(d, steps), `${name} ${d}`);
    }, 60000);
  }
});

describe('the loop is forgiving', () => {
  // a player does not hit one exact speed: the clothoid loop has to work across the range, with and without the fans
  const L = chain(0, [...RUN_UP, 'road', 'loop', ...RUN_OUT]);
  for (const assist of ['ASSIST', 'STABILIZED'] as const) for (const v of [22, 26, 30, 34]) {
    it(`entered at ${v} m/s (${assist})`, async () => {
      const r = await driveLevel(L, { maxS: 40, assist, speeds: { loop: { vMin: v, vMax: v }, road: { vMax: v }, start: { vMax: v } } });
      expect(r.fail, `${v} m/s ${assist}: ${r.fail}`).toBeNull();
      expect(r.done).toBe(true);
    }, 60000);
  }
});

describe('sample tracks', () => {
  for (const [name, level] of [['Starbase Sprint', sprint], ['Showcase', showcase]] as const) {
    it(`${name}: a clean lap`, async () => {
      const r = await driveLevel(level as unknown as Level, { maxS: 240 });
      expect(r.fail, `${name}: ${r.fail} at part ${r.failPart}`).toBeNull();
      expect(r.finished).toBe(true);
      expect(r.missed).toBe(0);
    }, 240000);
  }
});
