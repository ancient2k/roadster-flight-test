// Ground-level stretches of track pieces can be driven onto from the side (R17 finding: "you get stuck on track
// pieces when driving from the ground onto the track"): no 45 cm curbs where the road still lies on the ground.
import { describe, expect, it } from 'vitest';
import { createRoadsterSim } from '../../../src/sim/vehicle';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { v3 } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';
import { buildPart, partDef, placeTris, TILE_M, type PartType } from '../../../src/shared/parts';

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
