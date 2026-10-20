import { describe, expect, it } from 'vitest';
import { Allocator, LEVELS } from '../../../src/sim/gnc/allocator';
import { BoxQP } from '../../../src/sim/gnc/boxqp';
import { buildEffectiveness, applyEffectiveness, N_NOZ } from '../../../src/sim/gnc/wrench';
import { nominalMassProps } from '../../../src/sim/gnc/massProps';
import { Propulsion } from '../../../src/sim/core/propulsion';
import { Rng } from '../../../src/sim/gnc/estimator';
import { G0 } from '../../../src/shared/math';

const prop = new Propulsion(); prop.reset();
const thrust = prop.availableThrust();
const mp = nominalMassProps(250);
const B = buildEffectiveness(mp.com, thrust);
const mg = mp.mass * G0;
const scale = [mg, mg, mg, mp.inertia.x, mp.inertia.y, mp.inertia.z];

describe('box QP', () => {
  it('matches the unconstrained optimum when interior and clamps at bounds', () => {
    const qp = new BoxQP(2);
    const H = new Float64Array([2, 0, 0, 2]);
    const x = new Float64Array(2);
    qp.solve(H, new Float64Array([-1, -1]), new Float64Array([0, 0]), new Float64Array([1, 1]), x);
    expect(x[0]).toBeCloseTo(0.5, 12); expect(x[1]).toBeCloseTo(0.5, 12);
    qp.solve(H, new Float64Array([-6, 2]), new Float64Array([0, 0]), new Float64Array([1, 1]), x);
    expect(x[0]).toBe(1); expect(x[1]).toBe(0);
  });
});

describe('allocator', () => {
  it('hover: produces m·g lift with zero moment, duties within [0,1]', () => {
    const a = new Allocator();
    const w = [0, mg, 0, 0, 0, 0];
    const d = a.solve(B, w, scale, LEVELS.balanced);
    const ach = applyEffectiveness(B, d);
    expect(Math.abs(ach[1] - mg) / mg).toBeLessThan(0.01);
    for (let r = 3; r < 6; r++) expect(Math.abs(ach[r])).toBeLessThan(200); // N·m
    for (const x of d) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
    // mains not used for a pure lift request
    for (let i = 0; i < 4; i++) expect(d[i]).toBeLessThan(0.02);
  });

  it('reaches any attainable wrench (random interior points) within tolerance', () => {
    const rng = new Rng(42);
    const a = new Allocator();
    a.fuelWeight = 0; a.rateWeight = 0;
    for (let k = 0; k < 200; k++) {
      const dt = new Float64Array(N_NOZ).map(() => rng.range(0.05, 0.95));
      const w = applyEffectiveness(B, dt);
      a.reset();
      const d = a.solve(B, w, scale, LEVELS.balanced);
      const ach = applyEffectiveness(B, d);
      for (let r = 0; r < 6; r++) expect(Math.abs(ach[r] - w[r]) / scale[r]).toBeLessThan(2e-3);
    }
  });

  it('respects the box under infeasible requests (no NaN, saturates sensibly)', () => {
    const a = new Allocator();
    const d = a.solve(B, [0, 6 * mg, 0, 0, 0, 0], scale, LEVELS.balanced);
    for (const x of d) { expect(Number.isFinite(x)).toBe(true); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
    for (let i = 4; i < 8; i++) expect(d[i]).toBeGreaterThan(0.9);
  });

  it('hierarchy: landing keeps braking force + pitch/roll and sacrifices yaw', () => {
    // near-max braking plus an excessive yaw demand
    const w = [0, 2.6 * mg, 0, 0, 40_000, 0];
    const land = new Allocator(), flat = new Allocator();
    const dl = land.solve(B, w, scale, LEVELS.landing);
    const df = flat.solve(B, w, scale, [0, 0, 0, 0, 0, 0]);
    const al = applyEffectiveness(B, dl), af = applyEffectiveness(B, df);
    expect(Math.abs(al[1] - w[1]) / mg).toBeLessThan(0.01);          // braking met
    expect(Math.abs(al[3]) / mp.inertia.x).toBeLessThan(0.02);        // pitch held
    expect(Math.abs(al[5]) / mp.inertia.z).toBeLessThan(0.02);        // roll held
    expect(Math.abs(af[1] - w[1]) / mg).toBeGreaterThan(Math.abs(al[1] - w[1]) / mg); // flat trades lift away
  });

  it('honours lower bounds from valves inside their min on-time and masks', () => {
    const a = new Allocator();
    a.lo[0] = 1; a.hi[8] = 0; a.hi[9] = 0;
    const d = a.solve(B, [0, mg, 0, 0, 0, 0], scale, LEVELS.balanced);
    expect(d[0]).toBe(1); expect(d[8]).toBe(0); expect(d[9]).toBe(0);
  });

  it('is deterministic', () => {
    const run = () => {
      const a = new Allocator(); const rng = new Rng(7); const out: number[] = [];
      for (let k = 0; k < 50; k++) {
        const d = a.solve(B, [rng.range(-1, 1) * 5e3, rng.range(0, 2) * mg, rng.range(-1, 1) * 5e3, rng.range(-1, 1) * 2e4, rng.range(-1, 1) * 5e3, rng.range(-1, 1) * 2e4], scale, LEVELS.landing);
        out.push(...d);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
