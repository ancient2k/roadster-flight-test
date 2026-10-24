// Terrain worlds end where the collision terrain ends: the car is stopped softly before the edge instead of driving
// off into the void (user finding: driven out to sea at Starbase, the car fell for a minute at 240 m/s while the
// HUD showed altitude 0 and an automatic landing).
import { describe, expect, it } from 'vitest';
import { createRoadsterSim } from '../../../src/sim/vehicle';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { v3 } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';

describe('world edge', () => {
  it('a car racing towards the edge stops inside the terrain and keeps its ground', async () => {
    const n = 65, heights = new Float32Array(n * n), extentM = 640;      // flat terrain, edge at x = ±320
    const sim = await createRoadsterSim({ ground: 'terrain', terrain: { heights, size: n, extentM } });
    sim.reset(spawnPose(v3(0, 0.6, 0), 90, 0));                           // heading +X
    sim.body.setLinvel({ x: 50, y: 0, z: 0 }, true);
    let edge = false, maxX = 0;
    for (let k = 0; k < 240 * 12; k++) {
      sim.step({ ...neutralDrive(), throttle: 1 }, neutralSystems(), zeroThrust());
      edge ||= sim.atWorldEdge; maxX = Math.max(maxX, sim.getState().pos.x);
    }
    const s = sim.getState();
    expect(edge).toBe(true);
    expect(maxX).toBeLessThanOrEqual(extentM / 2 - 29.9);
    expect(s.heightAboveGroundM).toBeLessThan(2);
    expect(s.pos.y).toBeGreaterThan(-1);
    sim.dispose();
  });

  it('does not touch a car in the middle of the world', async () => {
    const n = 65, heights = new Float32Array(n * n);
    const sim = await createRoadsterSim({ ground: 'terrain', terrain: { heights, size: n, extentM: 640 } });
    sim.reset(spawnPose(v3(0, 0.6, 0), 0, 0));
    let edge = false;
    for (let k = 0; k < 240 * 2; k++) { sim.step({ ...neutralDrive(), throttle: 1 }, neutralSystems(), zeroThrust()); edge ||= sim.atWorldEdge; }
    expect(edge).toBe(false);
    sim.dispose();
  });
});
