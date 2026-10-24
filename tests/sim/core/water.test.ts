// Water slows the car down and carries it (user finding: at Starbase the car raced over the sea floor at 50 m/s, out of
// sight under the surface – the sea was only drawn). Flat terrain at y = 0 under a 2 m deep sea.
import { describe, expect, it } from 'vitest';
import { createRoadsterSim } from '../../../src/sim/vehicle';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { ManualAssist } from '../../../src/sim/gnc';
import { v3 } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';

const n = 65, extentM = 640;
const make = (water: boolean) => createRoadsterSim({ ground: 'terrain', terrain: { heights: new Float32Array(n * n), size: n, extentM }, water: water ? { levelY: 2 } : null });

describe('water', () => {
  it('a car racing into the sea slows to a wade; without water it keeps rolling', async () => {
    const speedAfter = async (water: boolean) => {
      const sim = await make(water);
      sim.reset(spawnPose(v3(-200, 0.6, 0), 90, 30));
      for (let k = 0; k < 240 * 3; k++) sim.step({ ...neutralDrive(), throttle: 1 }, neutralSystems(), zeroThrust());
      const s = sim.getState(), sub = sim.submersion;
      sim.dispose();
      return { v: s.speedMs, sub };
    };
    const wet = await speedAfter(true), dry = await speedAfter(false);
    expect(wet.sub).toBeGreaterThan(0.3);
    expect(wet.v).toBeLessThan(10);
    expect(dry.v).toBeGreaterThan(25);
  });

  it('the car floats, paddles along at walking pace and steers with the front wheels', async () => {
    const sim = await make(true);
    sim.reset(spawnPose(v3(0, 1.5, 0), 0, 0));                                   // heading +Z
    for (let k = 0; k < 240 * 3; k++) sim.step(neutralDrive(), neutralSystems(), zeroThrust());
    const s0 = sim.getState();
    expect(s0.pos.y + 0.6).toBeGreaterThan(2);                                   // roof above the surface
    expect(s0.groundContact).toBe(false);
    expect(s0.afloat).toBe(true);
    // afloat counts as ground for the flight controller: no height hold, no automatic landing burning the air
    const ma = new ManualAssist();
    let maxDuty = 0;
    for (let k = 0; k < 240 * 2; k++) { const c = ma.update(sim, { lift: 0, boost: 0, pitch: 0, roll: 0, yaw: 0 }, 'ASSIST'); maxDuty = Math.max(maxDuty, ...c.duty); sim.step(neutralDrive(), neutralSystems(), c); }
    expect(maxDuty).toBe(0);
    expect(ma.status.autoLand).toBe(false);
    expect(sim.telemetry().altitudeM).toBe(0);
    for (let k = 0; k < 240 * 4; k++) sim.step({ ...neutralDrive(), throttle: 1 }, neutralSystems(), zeroThrust());
    const s1 = sim.getState();
    expect(s1.speedMs).toBeGreaterThan(1.5);
    expect(s1.speedMs).toBeLessThan(4);
    expect(s1.linVel.z).toBeGreaterThan(1);
    for (let k = 0; k < 240 * 3; k++) sim.step({ ...neutralDrive(), throttle: 1, steer: 1 }, neutralSystems(), zeroThrust());
    const s2 = sim.getState();
    expect(s2.linVel.x).toBeLessThan(-0.3);                                      // turned right (+X is the car's left)
    sim.dispose();
  });

  it('the lift jets still get the car out of 2 m of water', async () => {
    const sim = await make(true);
    sim.reset(spawnPose(v3(0, 0.6, 0), 0, 0));
    for (let k = 0; k < 240; k++) sim.step(neutralDrive(), neutralSystems(), zeroThrust());
    const m = new ManualAssist();
    let out = -1;
    for (let k = 0; k < 240 * 6 && out < 0; k++) {
      sim.step(neutralDrive(), neutralSystems(), m.update(sim, { lift: 1, boost: 0, pitch: 0, roll: 0, yaw: 0 }, 'ASSIST'));
      if (sim.submersion === 0) out = k / 240;
    }
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(4);
    sim.dispose();
  });
});
