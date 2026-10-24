// 'fun' handling: a full brake on sand stops the car at about 1 g (user finding: "the brake is extremely weak" –
// the soil model alone gives ≈ 0.55 g); 'realistic' keeps the plain terramechanics.
import { describe, expect, it } from 'vitest';
import { createRoadsterSim } from '../../../src/sim/vehicle';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { v3 } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';

const stop = async (handling: 'fun' | 'realistic') => {
  const sim = await createRoadsterSim();
  sim.surface = 'sand';
  sim.handling = handling;
  sim.reset(spawnPose(v3(0, 0.6, 0), 0, 25));
  for (let k = 0; k < 120; k++) sim.step(neutralDrive(), neutralSystems(), zeroThrust());
  const v0 = sim.getState().speedMs;
  let t = 0;
  while (sim.getState().speedMs > 0.5 && t < 20) { sim.step({ ...neutralDrive(), brake: 1 }, neutralSystems(), zeroThrust()); t += sim.dt; }
  sim.dispose();
  return v0 / t / 9.81;
};

describe('brake on sand', () => {
  it('fun: about 1 g, clearly stronger than the soil alone; realistic unchanged', async () => {
    const fun = await stop('fun'), real = await stop('realistic');
    expect(real).toBeLessThan(0.75);
    expect(fun).toBeGreaterThan(0.9);
    expect(fun).toBeLessThan(1.3);
  });
});
