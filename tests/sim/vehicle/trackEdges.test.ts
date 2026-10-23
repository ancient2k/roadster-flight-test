// Ground-level stretches of track pieces can be driven onto from the side (R17 finding: "you get stuck on track
// pieces when driving from the ground onto the track"): no 45 cm curbs where the road still lies on the ground.
import { describe, expect, it } from 'vitest';
import { createRoadsterSim } from '../../../src/sim/vehicle';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { v3 } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';
import { boxTris, buildPart, partDef, placeTris, TILE_M, type PartType } from '../../../src/shared/parts';

/** Drive at a piece placed at the origin from x = −12 m at height z (m) with full throttle; x after 4 s. */
async function sideRun(type: PartType, z: number): Promise<number> {
  const def = partDef(type);
  const landmarks = buildPart(type).solids.map((s, k) => ({ id: `p${k}`, kind: 'mesh' as const, data: placeTris(s.tris, def, 0, 0, 0, 0, TILE_M), outward: true }));
  const n = 65, heights = new Float32Array(n * n);
  const sim = await createRoadsterSim({ ground: 'terrain', terrain: { heights, size: n, extentM: 640 }, landmarks });
  sim.reset(spawnPose(v3(-12, 0, z), 90, 10));
  for (let k = 0; k < 240 * 4; k++) sim.step({ ...neutralDrive(), throttle: 1 }, neutralSystems(), zeroThrust());
  const x = sim.body.translation().x;
  sim.dispose();
  return x;
}

describe('track pieces: driving on from the side', () => {
  it.each([['kicker', 3], ['wallramp', 4], ['loop', 3]] as [PartType, number][])('%s at z = %d m: the car crosses it', async (type, z) => {
    expect(await sideRun(type, z)).toBeGreaterThan(TILE_M + 5);
  });
  it('a raised stretch still has its curbs (the kicker near the lip stops a car from the side)', async () => {
    expect(await sideRun('kicker', 14)).toBeLessThan(TILE_M);
  });
});

// A wheel rubbing along a wall or a curb face: its shape cast starts inside the obstacle and used to read full bump,
// ≈ 500 kN straight up per step (R17 finding "drove against an edge and got flung away": 20 m/s at 30° into a 2 m wall
// threw the car 66 m up, into a 45 cm curb 53 m).
describe('glancing hits on walls and curbs', () => {
  it.each([['wall 2 m', 2, 20], ['wall 2 m', 2, 30], ['curb 45 cm', 0.45, 20], ['curb 45 cm', 0.45, 30]] as [string, number, number][])('%s at %d m/s, 30°: the car is not thrown up', async (_n, h, v) => {
    const landmarks = [{ id: 'o', kind: 'mesh' as const, data: boxTris([0, -1, -50], [h > 1 ? 1 : 0.4, h, 50]), outward: true }];
    const n = 65, heights = new Float32Array(n * n);
    const sim = await createRoadsterSim({ ground: 'terrain', terrain: { heights, size: n, extentM: 640 }, landmarks });
    const a = 30 * Math.PI / 180;
    sim.reset(spawnPose(v3(-14 * Math.sin(a), 0, -14 * Math.cos(a)), 30, v));
    let rise = 0, up = 0;
    for (let k = 0; k < 240 * 3; k++) {
      sim.step(neutralDrive(), neutralSystems(), zeroThrust());
      rise = Math.max(rise, sim.body.translation().y - 0.45); up = Math.max(up, sim.body.linvel().y);
    }
    sim.dispose();
    expect(rise).toBeLessThan(0.5);
    expect(up).toBeLessThan(2);
  });
});

