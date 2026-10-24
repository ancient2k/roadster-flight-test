// ManualAssist: RAW mapping, STABILIZED rate command, ASSIST hover / auto-righting / auto-landing.
import { beforeAll, describe, expect, it } from 'vitest';
import { RoadsterSim } from '../../../src/sim/core/roadsterSim';
import { ManualAssist } from '../../../src/sim/gnc';
import { createRoadsterSim } from '../../../src/sim/vehicle';
import { qaxisAngle, qrot, qrotInv, v3 } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';

let sim: RoadsterSim;
beforeAll(async () => { sim = await RoadsterSim.create(); });
const drive = neutralDrive(), sys = neutralSystems();
const zero = { lift: 0, boost: 0, pitch: 0, roll: 0, yaw: 0 };

describe('ManualAssist', () => {
  it('RAW: lift -> corner jets, boost -> mains, roll right -> left corners up, yaw right -> YAW_L', () => {
    const m = new ManualAssist();
    const d = m.update(sim, { ...zero, lift: 0.5, roll: 1, boost: 0.3, yaw: 1 }, 'RAW').duty;
    expect(d[0]).toBeCloseTo(0.3, 6);
    expect(d[4]).toBeGreaterThan(d[5]); expect(d[6]).toBeGreaterThan(d[7]); // left > right
    expect(d[8]).toBe(1); expect(d[9]).toBe(0);
  });

  it('ASSIST: holds altitude with sticks centred and levels the car', () => {
    // 8 m: inside the height the air reserve allows (at 30 m ASSIST would start an auto-landing)
    sim.reset({ pos: v3(0, 8, 0), quat: qaxisAngle(v3(0, 0, 1), 0.4) });
    const m = new ManualAssist();
    // hovering burns ≈ 31 kg/s on Earth: after ≈ 2.4 s the landing reserve is reached and ASSIST
    // starts the auto-landing (environment.test.ts), so check the hold within the first 2 s
    for (let k = 0; k < 240 * 2; k++) sim.step(drive, sys, m.update(sim, zero, 'ASSIST'));
    const s = sim.getState();
    expect(m.status.autoLand).toBe(false);
    expect(Math.abs(s.linVel.y)).toBeLessThan(0.5);
    expect(qrot(s.quat, v3(0, 1, 0)).y).toBeGreaterThan(0.99);
  });

  it('ASSIST: no ground below (off the terrain) is no reason for LOW_AIR or an automatic landing', () => {
    // 12 km up: the height ray (10 km) finds nothing, like past the edge of a terrain world
    sim.reset({ pos: v3(0, 12_000, 0), quat: qaxisAngle(v3(0, 1, 0), 0) });
    const m = new ManualAssist();
    let maxDuty = 0;
    for (let k = 0; k < 240; k++) { const c = m.update(sim, zero, 'ASSIST'); maxDuty = Math.max(maxDuty, ...c.duty); sim.step(drive, sys, c); }
    expect(sim.getState().heightAboveGroundM).toBeGreaterThanOrEqual(10_000);
    expect(m.status.autoLand).toBe(false);
    expect(m.status.lowAir).toBe(false);
    expect(m.status.label).toBe('');
  });

  it('ASSIST: auto-rights from inverted and lands softly with the lift stick held down', () => {
    sim.reset({ pos: v3(0, 25, 0), quat: qaxisAngle(v3(0, 0, 1), Math.PI) });
    const m = new ManualAssist();
    let maxSink = 0, landed = false;
    for (let k = 0; k < 240 * 12 && !landed; k++) {
      sim.step(drive, sys, m.update(sim, { ...zero, lift: -1 }, 'ASSIST'));
      const s = sim.getState();
      if (s.bodyContact || s.groundContact) { landed = true; maxSink = -s.linVel.y; }
    }
    expect(landed).toBe(true);
    expect(maxSink).toBeLessThan(2.0);
    expect(qrot(sim.getState().quat, v3(0, 1, 0)).y).toBeGreaterThan(0.95);
  });

  it('ASSIST: wheels leaving the ground over a crest without any input do not start the height hold', async () => {
    const car = await createRoadsterSim(); // with wheels (the bare core sim has no ground contact)
    const m = new ManualAssist();
    car.reset({ pos: v3(0, 0.6, 0), quat: qaxisAngle(v3(0, 1, 0), 0) });
    for (let k = 0; k < 240; k++) car.step(drive, sys, zeroThrust());                   // settle onto the wheels
    for (let k = 0; k < 24; k++) car.step(drive, sys, m.update(car, zero, 'ASSIST'));   // ASSIST sees ground contact
    expect(car.getState().groundContact).toBe(true);
    car.reset({ pos: v3(0, 3, 0), quat: qaxisAngle(v3(0, 1, 0), 0) });                  // "over the crest": airborne
    let maxDuty = 0;
    for (let k = 0; k < 120; k++) { const c = m.update(car, zero, 'ASSIST'); maxDuty = Math.max(maxDuty, ...c.duty); car.step(drive, sys, c); }
    expect(maxDuty).toBe(0);
    // the pilot asks for lift: now ASSIST flies
    expect(Math.max(...m.update(car, { ...zero, lift: 0.5 }, 'ASSIST').duty)).toBeGreaterThan(0);
    car.dispose();
  });

  it('ASSIST: switching back to ASSIST in the air (after RAW, sticks centred) takes over at once', async () => {
    const car = await createRoadsterSim();
    const m = new ManualAssist();
    car.reset({ pos: v3(0, 0.6, 0), quat: qaxisAngle(v3(0, 1, 0), 0) });
    for (let k = 0; k < 240; k++) car.step(drive, sys, zeroThrust());
    for (let k = 0; k < 24; k++) car.step(drive, sys, m.update(car, zero, 'ASSIST'));   // ground contact seen
    m.update(car, zero, 'RAW');
    car.reset({ pos: v3(0, 6, 0), quat: qaxisAngle(v3(0, 0, 1), 0.3) });              // airborne in RAW
    let maxDuty = 0;
    for (let k = 0; k < 24; k++) { const c = m.update(car, zero, 'ASSIST'); maxDuty = Math.max(maxDuty, ...c.duty); car.step(drive, sys, c); }
    expect(maxDuty).toBeGreaterThan(0);                                                // holds height / rights the car
    car.dispose();
  });

  it('STABILIZED: roll stick gives a right-side-down roll rate', () => {
    sim.reset({ pos: v3(0, 60, 0), quat: { x: 0, y: 0, z: 0, w: 1 } });
    const m = new ManualAssist();
    for (let k = 0; k < 120; k++) sim.step(drive, sys, m.update(sim, { ...zero, roll: 0.5, lift: 0.3 }, 'STABILIZED'));
    const s = sim.getState();
    const wb = qrotInv(s.quat, s.angVel);
    expect(wb.z).toBeGreaterThan(1.0); // target 1.5 rad/s
  });
});
