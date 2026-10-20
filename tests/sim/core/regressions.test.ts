// Regression tests from an external code review.
import { describe, expect, it } from 'vitest';
import { ValveBank } from '../../../src/sim/core/valves';
import { ROADSTER } from '../../../src/shared/roadster';
import { SIM_DT } from '../../../src/shared/types';
import { DEG, PitchTracker, qaxisAngle, qmul } from '../../../src/shared/math';
import { Recorder } from '../../../src/game/recorder';
import { RoadsterSim, spawnPose } from '../../../src/sim/core/roadsterSim';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';

describe('review #1: PWM delivers the requested duty despite valve delays', () => {
  for (const delay of [0.004, 0.008, 0.016]) {
    it(`open/close delay ${delay * 1000} ms`, () => {
      const v = new ValveBank(1, { ...ROADSTER.valves, openDelayS: delay, closeDelayS: delay * 0.75 });
      for (const d of [0.15, 0.35, 0.6, 0.85]) {
        v.reset();
        let open = 0; const N = 240 * 6;
        for (let i = 0; i < N; i++) open += v.step(SIM_DT, [d])[0];
        expect(Math.abs(open / N - d)).toBeLessThan(0.03);
      }
    });
  }
});

describe('review #4: HUD pitch distinguishes a roll from going over the top', () => {
  it('pure 180° roll keeps pitch near 0', () => {
    const pt = new PitchTracker();
    let p = 0;
    for (let a = 0; a <= 180; a += 2) p = pt.update(qaxisAngle({ x: 0, y: 0, z: 1 }, a * DEG), { x: 0, y: 0, z: 3 });
    expect(Math.abs(p)).toBeLessThan(1);
  });
  it('pitching over the top continues past 90° to 170°', () => {
    const pt = new PitchTracker();
    let p = 0;
    for (let a = 0; a <= 170; a += 2) p = pt.update(qaxisAngle({ x: -1, y: 0, z: 0 }, a * DEG), { x: -1, y: 0, z: 0 });
    expect(p).toBeCloseTo(170, 0);
  });
  it('kickflip roll with a little nose-up stays a small pitch', () => {
    const pt = new PitchTracker();
    let maxAbs = 0;
    for (let a = 0; a <= 360; a += 3) {
      const q = qmul(qaxisAngle({ x: -1, y: 0, z: 0 }, 8 * DEG), qaxisAngle({ x: 0, y: 0, z: 1 }, a * DEG));
      maxAbs = Math.max(maxAbs, Math.abs(pt.update(q, { x: 0, y: 0, z: 5 })));
    }
    expect(maxAbs).toBeLessThan(15);
  });
});

describe('review #13: recorder samples on a fixed grid', () => {
  it('50 Hz at 240 Hz physics', async () => {
    const sim = await RoadsterSim.create();
    sim.reset(spawnPose({ x: 0, y: 0, z: 0 }, 0));
    const rec = new Recorder(50, 300);
    for (let i = 0; i < 240 * 60; i++) { sim.step(neutralDrive(), neutralSystems(), zeroThrust()); rec.push(sim.getState(), sim.telemetry()); }
    expect(rec.frames.length).toBeGreaterThanOrEqual(2999); expect(rec.frames.length).toBeLessThanOrEqual(3001);
    const s = rec.sample(50)!;
    expect(Math.abs(s.a.state.t - rec.frames[0].state.t - 50)).toBeLessThan(0.03);
    sim.dispose();
  });
});

describe('review #14: reset clears the phase label', () => {
  it('phase label empty after reset', async () => {
    const sim = await RoadsterSim.create();
    sim.setPhaseLabel('climb');
    sim.reset(spawnPose({ x: 0, y: 0, z: 0 }, 0));
    expect(sim.telemetry().phase).toBe('');
    sim.dispose();
  });
});
