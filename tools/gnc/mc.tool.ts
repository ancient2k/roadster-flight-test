// Monte Carlo subset for tuning (same draws as tests/sim/stunts/montecarlo.test.ts).
//   STUNT=ramp_launch RUNS=20 npx vitest run --config tools/gnc/vitest.config.ts tools/gnc/mc.tool.ts
import { it } from 'vitest';
import { Rng } from '../../src/sim/gnc/estimator';
import type { StuntId } from '../../src/shared/types';
import { runStunt, vehicleFactory, withTireMuScale } from '../../tests/sim/stunts/helpers';
import { applyTuneEnv } from './tune';

it('mc subset', async () => {
  const f = (await vehicleFactory())!;
  applyTuneEnv();
  const id = (process.env.STUNT ?? 'ramp_launch') as StuntId, RUNS = Number(process.env.RUNS ?? 20);
  const ONLY = process.env.ONLY?.split(',').map(Number);
  const rng = new Rng(0xC0FFEE ^ id.length * 7919);
  let ok = 0, n = 0;
  for (let k = 0; k < RUNS; k++) {
    const massScale = rng.range(0.9, 1.1), inertiaScale = rng.range(0.8, 1.2);
    const open = rng.range(0.004, 0.016), close = rng.range(0.003, 0.012), muScale = rng.range(0.8, 1.2);
    if (ONLY && !ONLY.includes(k)) continue;
    const { result, sim } = await withTireMuScale(muScale, () => runStunt(id, f, { sim: { massScale, inertiaScale }, valveDelay: { open, close }, ap: { noiseSeed: 1000 + k }, maxS: 120 }));
    sim.dispose();
    n++; if (result.success) ok++;
    const m = result.metrics;
    console.log(`#${k} m×${massScale.toFixed(3)} μ×${muScale.toFixed(3)} ${result.success ? 'OK ' : 'FAIL'} tdG ${m.touchdownG?.toFixed(2)} burnG ${m.landingBurnG?.toFixed(2)} sink ${m.touchdownSinkMs?.toFixed(2)} air ${result.airUsedKg.toFixed(0)} vAlt ${m.video_altitudeM_rms?.toFixed(2)} vG ${m.video_g_rms?.toFixed(2)} pk ${m.video_g_peakMaxErr?.toFixed(2)} ${result.success ? '' : result.reason}`);
  }
  console.log(`${id}: ${ok}/${n}`);
});
