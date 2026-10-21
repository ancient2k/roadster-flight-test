// Automatic reverse gear (R14 user finding "Man kann nicht rückwärts fahren mit S").
import { describe, expect, it } from 'vitest';
import { AutoGear, GEAR_HOLD_S } from '../../src/input/autoGear';
import { neutralDrive, type DriveInput } from '../../src/shared/types';
import { createRoadsterSim } from '../../src/sim/vehicle';
import { ManualController } from '../../src/game/session';
import { qrot, v3 } from '../../src/shared/math';
import { spawnPose } from '../../src/sim/core/roadsterSim';

const d = (o: Partial<DriveInput>): DriveInput => ({ ...neutralDrive(), ...o });
const dt = 1 / 240;
const run = (g: AutoGear, input: DriveInput, v: number, s: number) => { let o = g.update(input, v, dt); for (let t = dt; t < s; t += dt) o = g.update(input, v, dt); return o; };

describe('AutoGear', () => {
  it('S brakes while rolling forward; held through the stop it keeps braking, pressed again it engages reverse', () => {
    const g = new AutoGear();
    expect(run(g, d({ brake: 1 }), 8, 1)).toMatchObject({ brake: 1, throttle: 0, reverse: false });
    expect(run(g, d({ brake: 1 }), 0.1, 2).reverse).toBe(false);                    // parked on the brake (pyramid face)
    run(g, d({}), 0.1, 0.1);                                                          // release …
    expect(run(g, d({ brake: 1 }), 0.1, GEAR_HOLD_S * 0.5).reverse).toBe(false);   // a short tap at standstill: still braking
    const o = run(g, d({ brake: 1 }), 0.1, GEAR_HOLD_S);                            // … and hold again
    expect(o).toMatchObject({ throttle: 1, brake: 0, reverse: true });
  });

  it('from a standstill (spawn) S held engages reverse straight away', () => {
    const g = new AutoGear();
    expect(run(g, d({ brake: 1 }), 0, GEAR_HOLD_S * 1.2).reverse).toBe(true);
  });

  it('in reverse W brakes, held at standstill it engages forward again', () => {
    const g = new AutoGear();
    run(g, d({ brake: 1 }), 0, 0.5);
    expect(g.reverse).toBe(true);
    expect(run(g, d({ throttle: 1 }), -5, 1)).toMatchObject({ brake: 1, throttle: 0, reverse: true });
    expect(run(g, d({ throttle: 1 }), -0.1, 0.5)).toMatchObject({ throttle: 1, brake: 0, reverse: false });
  });

  it('both pedals or no pedal never change the gear; the reverse toggle still flips it', () => {
    const g = new AutoGear();
    run(g, d({ brake: 1, throttle: 1 }), 0, 1);
    run(g, d({}), 0, 1);
    expect(g.reverse).toBe(false);
    g.update(d({ reverse: true }), 0, dt);   // toggle edge (G / touch REV)
    expect(g.reverse).toBe(true);
    g.update(d({ reverse: false }), 0, dt);
    expect(g.reverse).toBe(false);
  });
});

describe('ManualController: driving backwards with S on the real chassis', () => {
  it('standstill -> S held drives backwards (limited), W brakes and drives forward again', async () => {
    const sim = await createRoadsterSim();
    sim.reset(spawnPose(v3(0, 0, 0), 0, 0));
    const mc = new ManualController(sim, null);
    const vFwd = () => { const s = sim.getState(); const f = qrot(s.quat, v3(0, 0, 1)); return s.linVel.x * f.x + s.linVel.y * f.y + s.linVel.z * f.z; };
    const drive = (o: Partial<DriveInput>, s: number) => {
      mc.drive = d(o);
      for (let k = 0; k < Math.round(s / sim.dt); k++) { const out = mc.update(); sim.step(out.drive, out.systems, out.thrust); }
    };
    drive({}, 2);                        // settle on the wheels
    drive({ brake: 1 }, 4);
    expect(vFwd()).toBeLessThan(-3);     // rolling backwards
    drive({ brake: 1 }, 6);
    expect(vFwd()).toBeGreaterThan(-13); // reverse speed limit (12 m/s)
    drive({ throttle: 1 }, 6);
    expect(vFwd()).toBeGreaterThan(2);   // braked, then forward again
    sim.dispose();
  });
});
