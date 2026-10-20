// Nominal run of every stunt: key figures (TRACK reference keys) vs. the video reference.
//   npx vitest run --config tools/gnc/vitest.config.ts tools/gnc/report.tool.ts
import { it } from 'vitest';
import { runStunt, vehicleFactory } from '../../tests/sim/stunts/helpers';
import type { StuntId } from '../../src/shared/types';

it('sim vs video', async () => {
  const f = (await vehicleFactory())!;
  for (const id of ['kickflip', 'ramp_hang', 'ramp_launch', 'zero60', 'ground_flip'] as StuntId[]) {
    const { result, sim } = await runStunt(id, f, { maxS: 120 });
    sim.dispose();
    const keys = Object.keys(result.reference);
    console.log(`${id}: ${result.success ? 'OK' : 'FAIL'} startT ${result.startT.toFixed(2)} s, air ${result.airUsedKg.toFixed(1)} kg, ` +
      keys.map((k) => `${k} ${result.metrics[k]?.toFixed(2)} (video ${result.reference[k]})`).join(', '));
  }
});
