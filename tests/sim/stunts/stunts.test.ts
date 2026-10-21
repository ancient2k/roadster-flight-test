// Full stunts in auto mode on the full vehicle plant (createRoadsterSim), with the acceptance criteria against the stream HUD values.
import { describe, expect, it } from 'vitest';
import { runStunt, summary, vehicleFactory } from './helpers';
import type { StuntId } from '../../../src/shared/types';
import type { StuntResult } from '../../../src/sim/gnc';
import { formatVideoFit } from '../../../src/sim/stunts/validation';

/**
 * Time-aligned comparison with the stream HUD: the sim trace sampled at the
 * VIDEO_REFERENCE times (aligned via StuntResult.startT). Thresholds: altitude RMS ≤ 2 m or ≤ 10 % of
 * the video peak, pitch RMS ≤ 12°, downforce RMS ≤ 10 % of the peak, every HUD g peak within ±0.5 g
 * (g compared at the reference resolution, ±0.1 s moving average against valve PWM ripple).
 */
function expectVideoFit(r: StuntResult): void {
  const fit = r.video;
  expect(fit, 'video fit present').toBeTruthy();
  const ch = (name: string) => fit!.channels.find((c) => c.channel === name);
  const alt = ch('altitudeM')!;
  expect(alt.rms <= 2.0 || alt.rmsRel <= 0.10, `altitude RMS ${alt.rms.toFixed(2)} m (${(100 * alt.rmsRel).toFixed(1)} %)`).toBe(true);
  const pitch = ch('pitchDeg');
  if (pitch) expect(pitch.rms, 'pitch RMS (deg)').toBeLessThanOrEqual(12);
  const df = ch('downforceKg');
  if (df) expect(df.rmsRel, 'downforce RMS / peak').toBeLessThanOrEqual(0.10);
  for (const p of fit!.gPeaks) expect(Math.abs(p.err), `g peak at t = ${p.t} s: video ${p.ref} sim ${p.sim.toFixed(2)}`).toBeLessThanOrEqual(0.5);
  expect(r.metrics.video_altitudeM_rms).toBe(alt.rms); // flattened into the metrics (result screen, tools)
}

const factory = await vehicleFactory();

describe.skipIf(!factory)('stunts end to end (auto mode)', () => {
  const cases: [StuntId, number][] = [['zero60', 30], ['ground_flip', 30], ['kickflip', 60], ['ramp_launch', 90], ['ramp_hang', 120]];
  for (const [id, maxS] of cases) {
    it(`${id} passes all acceptance checks`, async () => {
      const { result, sim } = await runStunt(id, factory!, { maxS });
      console.log(summary(result));
      expect(result.success, summary(result)).toBe(true);
      expect(sim.getState().crashed).toBe(false);
      // result screen contract: reference keys present, start time for the video alignment
      for (const k of Object.keys(result.reference)) expect(Number.isFinite(result.metrics[k]), k).toBe(true);
      expect(Number.isFinite(result.startT)).toBe(true);
      expect(result.startT).toBeLessThan(result.durationS);
      if (id === 'ramp_hang' || id === 'ramp_launch' || id === 'kickflip') {
        console.log(formatVideoFit(result.video ?? null));
        expectVideoFit(result);
      }
      if (id === 'ramp_launch') {
        // leave the lip end at ≈ 20.7 m (HUD peak 67.8 ft, 4 fps; the HUD lags, settled on the same spot
        // in run 1 it reads 69.1 ft), entry ≈ 1.4 g, landing burn ≈ 1.4 g, touchdown ≈ 10 s after the ramp
        // entry and ≈ 13 m in front of the ramp foot like the stream (R14)
        const m = result.metrics;
        expect(Math.abs(m.leaveAltitudeM - 20.7), `leave ${m.leaveAltitudeM}`).toBeLessThanOrEqual(0.6);
        expect(m.climbG, 'ramp entry g').toBeLessThanOrEqual(1.55);
        expect(m.touchdownT - result.startT, 'ramp entry -> touchdown (s)').toBeGreaterThan(9.0);
        expect(m.touchdownT - result.startT, 'ramp entry -> touchdown (s)').toBeLessThan(11.0);
        expect(m.touchdownG, 'touchdown impact g').toBeLessThanOrEqual(2.0);
      }
    });
  }

  it('empty tank: thruster stunts abort safely on the ground', async () => {
    for (const id of ['ground_flip', 'kickflip'] as StuntId[]) {
      const { result, sim } = await runStunt(id, factory!, { airKg: 20, maxS: 40 });
      expect(result.success).toBe(false);
      expect(result.reason).toMatch(/insufficient air/);
      expect(result.metrics.airborneS).toBe(0);
      expect(sim.getState().crashed).toBe(false);
    }
  });

  it('pre-flight valve test: passes nominally (< 6 kg) and aborts on the ground with a stuck corner jet', async () => {
    const ok = await runStunt('ground_flip', factory!, { maxS: 30 });
    expect(ok.ap.stunt.events.some((e) => e.message === 'valve test passed')).toBe(true);
    const bitAir = 250 - ok.result.trace.find((f) => f.phase !== 'precheck')!.airMassKg;
    expect(bitAir).toBeLessThan(6);
    const bad = await runStunt('ground_flip', factory!, { maxS: 30, setup: (sim) => sim.propulsion.valves.setFault(5, -1) });
    expect(bad.result.success).toBe(false);
    expect(bad.result.reason).toMatch(/valve test failed.*LIFT_FR stuck closed/);
    expect(bad.result.metrics.airborneS).toBe(0);
    expect(bad.sim.getState().crashed).toBe(false);
    console.log('BIT air', bitAir.toFixed(2), 'kg;', bad.result.reason);
  });
});
