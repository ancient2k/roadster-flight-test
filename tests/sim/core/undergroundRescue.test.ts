// A car that tunnels through the zero-thickness terrain mesh after a very hard impact is put back on top
// (R16 user finding: "on the Moon I glitched under the ground after flying forever and crashing").
import { describe, expect, it } from 'vitest';
import { createRoadsterSim } from '../../../src/sim/vehicle';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { v3 } from '../../../src/shared/math';
import { MOON } from '../../../src/shared/environment';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';

describe('below-ground rescue', () => {
  it('a car below the terrain surface comes back on top and stays there', async () => {
    const n = 65, heights = new Float32Array(n * n);                      // flat 640 m terrain at y = 0
    const sim = await createRoadsterSim({ ground: 'terrain', terrain: { heights, size: n, extentM: 640 } });
    sim.setEnvironment(MOON);
    sim.reset(spawnPose(v3(0, -3, 0), 0, 0));                            // 3 m under the ground
    sim.body.setLinvel({ x: 20, y: -40, z: 0 }, true);
    for (let k = 0; k < 240 * 3; k++) sim.step(neutralDrive(), neutralSystems(), zeroThrust());
    const s = sim.getState();
    expect(sim.undergroundRescues).toBeGreaterThanOrEqual(1);
    expect(s.pos.y).toBeGreaterThan(0.2);
    expect(s.pos.y).toBeLessThan(2);
    sim.dispose();
  });

  it('never fires on normal driving', async () => {
    const n = 65, heights = new Float32Array(n * n);
    const sim = await createRoadsterSim({ ground: 'terrain', terrain: { heights, size: n, extentM: 640 } });
    sim.reset(spawnPose(v3(0, 0, 0), 0, 0));
    for (let k = 0; k < 240 * 2; k++) sim.step({ ...neutralDrive(), throttle: 1 }, neutralSystems(), zeroThrust());
    expect(sim.undergroundRescues).toBe(0);
    sim.dispose();
  });
});
