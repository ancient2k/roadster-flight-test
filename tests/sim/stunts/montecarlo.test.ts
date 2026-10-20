// Monte Carlo robustness (robustness requirement): per stunt N runs with mass ±10 %, inertia ±20 %,
// valve opening delay 4–16 ms (closing 3–12 ms), sensor noise on and tyre friction μ0 ±20 %.
// Seeded -> reproducible. Success rate ≥ 95 %. N = 20 in CI; MC_RUNS=100 for the nightly sweep.
import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/sim/gnc/estimator';
import { ROADSTER } from '../../../src/shared/roadster';
import { runStunt, vehicleFactory, withTireMuScale } from './helpers';
import type { StuntId } from '../../../src/shared/types';

const factory = await vehicleFactory();
const vehicle = await import('../../../src/sim/vehicle').catch(() => null);
const RUNS = Number(process.env.MC_RUNS ?? 20);
const STUNTS: [StuntId, number][] = [['zero60', 30], ['ground_flip', 30], ['kickflip', 60], ['ramp_launch', 90], ['ramp_hang', 120]];

describe.skipIf(!factory)(`Monte Carlo (${RUNS} runs per stunt, friction ±20 %)`, () => {
  it('the friction scaling reaches the tyre model', async () => {
    const fz = ROADSTER.tire.fz0N, mu = vehicle!.tire.muLoad(fz);
    await withTireMuScale(0.8, async () => { expect(vehicle!.tire.muLoad(fz)).toBeCloseTo(0.8 * mu, 9); });
    expect(vehicle!.tire.muLoad(fz)).toBeCloseTo(mu, 12);
  });

  for (const [id, maxS] of STUNTS) {
    it(`${id}: success rate ≥ 95 %`, async () => {
      const rng = new Rng(0xC0FFEE ^ id.length * 7919);
      let ok = 0;
      const lines: string[] = [];
      for (let k = 0; k < RUNS; k++) {
        const massScale = rng.range(0.9, 1.1), inertiaScale = rng.range(0.8, 1.2);
        const open = rng.range(0.004, 0.016), close = rng.range(0.003, 0.012);
        const muScale = rng.range(0.8, 1.2);
        const seed = 1000 + k;
        const { result, sim } = await withTireMuScale(muScale, () => runStunt(id, factory!, {
          sim: { massScale, inertiaScale }, valveDelay: { open, close }, ap: { noiseSeed: seed }, maxS,
        }));
        sim.dispose();
        if (result.success) ok++;
        const m = result.metrics;
        lines.push(`${id} #${k} m×${massScale.toFixed(3)} I×${inertiaScale.toFixed(3)} μ×${muScale.toFixed(3)} valve ${(open * 1e3).toFixed(1)}/${(close * 1e3).toFixed(1)} ms -> ${result.success ? 'OK ' : 'FAIL'} apex ${m.maxAltitudeM?.toFixed(2)} tdG ${m.touchdownG?.toFixed(2)} burnG ${m.landingBurnG?.toFixed(2)} sink ${m.touchdownSinkMs?.toFixed(2)} 0-60 ${m.zeroToSixtyS?.toFixed(3)} leave ${m.leaveAltitudeM?.toFixed(2)} launchG ${m.launchG?.toFixed(2)} hold ${m.holdAltitudeM?.toFixed(2)} air ${result.airUsedKg.toFixed(0)}${result.success ? '' : ' :: ' + result.reason}`);
      }
      console.log(lines.join('\n'));
      console.log(`${id}: ${ok}/${RUNS} = ${(100 * ok / RUNS).toFixed(0)} %`);
      expect(ok / RUNS).toBeGreaterThanOrEqual(0.95);
    }, 3_600_000);
  }
});
