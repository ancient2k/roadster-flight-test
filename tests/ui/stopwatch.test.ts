import { describe, expect, it } from 'vitest';
import { MPH } from '../../src/shared/math';
import { ZeroSixtyWatch } from '../../src/ui/hud/stopwatch';

const dt = 1 / 60;

describe('HUD 0–60 stopwatch', () => {
  it('ignores the staging creep and starts at the launch phase (autopilot)', () => {
    const w = new ZeroSixtyWatch();
    const tLaunch = 2.4;
    let t = 0;
    // staging: brakes on, the car creeps a little after the spawn
    for (; t < tLaunch - 1e-9; t += dt) expect(w.update(t, t > 0.1 ? 0.2 : 0, 'staging')).toBe(0);
    // launch at tLaunch; the HUD sees it one frame late, the stunt reports the exact start
    let v = 0.2;
    for (; t < tLaunch + 0.62 + 1e-9; t += dt, v += 30 * dt) w.update(t, v, 'launch', tLaunch);
    expect(w.value).toBeCloseTo(0.62, 2);
    expect(w.running).toBe(true);
  });

  it('launch_no_jets arms too; without a launch time the previous frame is the start', () => {
    const w = new ZeroSixtyWatch();
    w.update(1.0, 0.3, 'staging');
    w.update(1.0 + dt, 1, 'launch_no_jets');
    expect(w.t0).toBeCloseTo(1.0, 9);
  });

  it('stops at 60 mph with the interpolated crossing', () => {
    const w = new ZeroSixtyWatch();
    w.update(0, 0, 'staging');
    w.update(0.5, 0, 'launch', 0.5);
    w.update(1.0, 50 * MPH, 'launch', 0.5);
    w.update(1.5, 70 * MPH, 'launch', 0.5);
    expect(w.done).toBe(true);
    expect(w.value).toBeCloseTo(0.75, 9);
    w.update(2.0, 80 * MPH, 'stop', 0.5);
    expect(w.value).toBeCloseTo(0.75, 9);
  });

  it('free play (no phase) still starts on the first creep from standstill', () => {
    const w = new ZeroSixtyWatch();
    w.update(0, 0, '');
    w.update(0.1, 0, '');
    w.update(0.2, 1, '');
    expect(w.t0).toBeCloseTo(0.1, 9);
    expect(w.running).toBe(true);
  });
});
