// "Vehicle damage: Realistic" must not make the auto stunts fail: they never hit anything with the body,
// so at most cosmetic scrapes may register — no functional damage, no total loss.
import { describe, expect, it } from 'vitest';
import { runStunt, summary, vehicleFactory } from '../stunts/helpers';
import { setDamageMode } from '../../../src/sim/vehicle';
import type { StuntId } from '../../../src/shared/types';

const factory = await vehicleFactory();

describe.skipIf(!factory)('auto stunts with realistic damage', () => {
  const cases: [StuntId, number][] = [['zero60', 30], ['ground_flip', 30], ['kickflip', 60], ['ramp_launch', 90], ['ramp_hang', 120]];
  for (const [id, maxS] of cases) {
    it(`${id}: succeeds, no functional damage`, async () => {
      const { result, sim } = await runStunt(id, factory!, { maxS, setup: (s) => setDamageMode(s, 'realistic') });
      const d = sim.getState().damage!;
      console.log(id, summary(result).split('\n')[0], { E: d.energyJ, sev: d.severity, wheels: d.wheels, noz: Math.max(...d.nozzles), skirts: d.skirts });
      expect(d.mode).toBe('realistic');
      expect(result.success, summary(result)).toBe(true);
      expect(sim.getState().crashed).toBe(false);
      expect(d.totalLoss).toBe(false);
      expect(Math.max(...d.wheels, ...d.nozzles, ...d.skirts)).toBe(0);
      expect(d.wingLost || d.wheelLost.some(Boolean)).toBe(false);
      sim.dispose();
    }, 600_000);
  }
});
