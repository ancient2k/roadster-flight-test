// Time trial and special pieces on the shipped sample track, driven by a scripted car along the course tiles.
import { describe, expect, it } from 'vitest';
import { LevelRun, SKIP_PENALTY_S, FINISH_LAUNCH_S } from '../../src/game/levelRun';
import { validateLevel, partTiles } from '../../src/shared/level';
import sprint from '../../src/editor/samples/starbase-sprint.json';

const AREA = { minX: 0, minZ: 0, tileM: 20, y: 0 };
const level = validateLevel(sprint, { nx: 48, nz: 36 }).level;
const centre = (k: number) => { const t = partTiles(level.parts[k]); return { x: (t[0][0] + 0.5) * 20, z: (t[0][1] + 0.5) * 20 }; };
const car = (x: number, z: number, o: Partial<{ speed: number; grounded: boolean; y: number }> = {}) =>
  ({ x, y: o.y ?? 0.5, z, vx: 0, vz: -(o.speed ?? 20), speedMs: o.speed ?? 20, grounded: o.grounded ?? true });
const fx = () => ({ boosts: 0, refills: 0, boost() { this.boosts++; }, refill() { this.refills++; } });

describe('level run', () => {
  it('a clean lap: all sections in order, finish on the start piece, no penalty, launch announced at the finish', () => {
    const run = new LevelRun(level, AREA);
    const f = fx();
    expect(run.course?.closed).toBe(true);
    for (const k of run.course!.order.slice(1)) { const c = centre(k); run.update(0.5, car(c.x, c.z), f); }
    const s = centre(run.course!.order[0]);
    const ev = run.update(0.5, car(s.x, s.z), f);
    expect(run.state).toBe('finished');
    expect(run.penalty).toBe(0);
    expect(ev.find((e) => e.kind === 'finish')).toBeTruthy();
    expect(run.launchIn).not.toBeNull();                              // the sample's launch clearance armed it
    expect(FINISH_LAUNCH_S).toBeGreaterThanOrEqual(30);
  });

  it('skipping sections and leaving the track cost time', () => {
    const run = new LevelRun(level, AREA);
    const f = fx();
    const o = run.course!.order;
    run.update(0.1, car(centre(o[1]).x, centre(o[1]).z), f);
    run.update(0.1, car(centre(o[3]).x, centre(o[3]).z), f);      // jumped over section 2
    expect(run.missed).toBe(1);
    expect(run.penalty).toBeCloseTo(SKIP_PENALTY_S, 6);
    run.update(2, car(45 * 20, 2 * 20), f);                          // far off the course, on the ground
    expect(run.penalty).toBeCloseTo(SKIP_PENALTY_S + 2, 6);
  });

  it('boost pad pushes along the road, the air station refills at a standstill', () => {
    const run = new LevelRun(level, AREA);
    const f = fx();
    const bi = level.parts.findIndex((p) => p.type === 'boost'), ai = level.parts.findIndex((p) => p.type === 'air_station');
    const b = centre(bi), a = centre(ai);
    run.update(0.1, car(b.x, b.z), f);
    run.update(0.1, car(b.x, b.z), f);                               // cooldown: once per pass
    expect(f.boosts).toBe(1);
    run.update(0.1, car(a.x, a.z, { speed: 0.2 }), f);
    expect(f.refills).toBe(1);
  });

  it('the launch clearance arms the countdown with its option', () => {
    const run = new LevelRun(level, AREA);
    const li = level.parts.findIndex((p) => p.type === 'launch');
    const l = centre(li);
    const ev = run.update(0.1, car(l.x, l.z), fx());
    expect(ev).toContainEqual({ kind: 'launchArmed', countdownS: level.parts[li].opt ?? 60 });
    for (let k = 0; k < 700; k++) run.update(0.1, car(-100, -100), fx());
    expect(run.launchFired).toBe(true);
  });
});
