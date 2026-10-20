// the stream shows the rear wing stowed during the whole wall ramp hang (run-up, ≈ 90° from
// above, back at the bottom). The stunt runs in low-drag mode; the ramp figures must not get worse
// than with the former high-downforce preset (≈ 169° / 68.7 ft against the stream's 170° / 69.1 ft).
import { describe, expect, it } from 'vitest';
import { runStunt, vehicleFactory } from './helpers';
import { TUNING } from '../../../src/sim/stunts/tuning';
import { AERO } from '../../../src/sim/vehicle/params';
import type { AeroMode } from '../../../src/shared/types';

const factory = await vehicleFactory();
const M_TO_FT = 1 / 0.3048;

async function run(mode: AeroMode) {
  const prev = TUNING.rampHang.aeroMode;
  TUNING.rampHang.aeroMode = mode;
  let wingMax = 0;
  try {
    const { result, sim } = await runStunt('ramp_hang', factory!, {
      maxS: 120,
      onStep: (s, ap) => { if (ap.stunt.phase !== 'spool') wingMax = Math.max(wingMax, s.getState().aero.wingAngleDeg); },
    });
    return { result, crashed: sim.getState().crashed, wingMax };
  } finally { TUNING.rampHang.aeroMode = prev; }
}

describe.skipIf(!factory)('ramp hang: wing stowed like the stream', () => {
  it('keeps the wing at the low-drag angle after the spool-up and holds the ramp figures', async () => {
    expect(TUNING.rampHang.aeroMode).toBe('lowDrag');
    const lo = await run('lowDrag');
    const hi = await run('highDownforce');
    const fig = (r: typeof lo) => ({
      pitch: r.result.metrics.maxPitchDeg, altFt: r.result.metrics.holdAltitudeM * M_TO_FT,
      hold: r.result.metrics.holdS, altRms: r.result.metrics.video_altitudeM_rms,
    });
    console.log('ramp_hang lowDrag', fig(lo), 'wing max', lo.wingMax.toFixed(2), '| highDownforce', fig(hi));
    expect(lo.result.success).toBe(true);
    expect(lo.crashed).toBe(false);
    expect(lo.wingMax).toBeLessThanOrEqual(AERO.wingAngleRangeDeg[0] + 1e-6);
    // not worse than the high-downforce preset against the stream (170° / 69.1 ft)
    const errLo = fig(lo), errHi = fig(hi);
    expect(Math.abs(errLo.pitch - 170)).toBeLessThanOrEqual(Math.abs(errHi.pitch - 170) + 0.1);
    expect(Math.abs(errLo.altFt - 69.1)).toBeLessThanOrEqual(Math.abs(errHi.altFt - 69.1) + 0.1);
  }, 240_000);
});
