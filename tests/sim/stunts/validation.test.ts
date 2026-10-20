// Time-aligned video validation (src/sim/stunts/validation.ts) on synthetic traces.
import { describe, expect, it } from 'vitest';
import { FT } from '../../../src/shared/math';
import { VIDEO_REFERENCE } from '../../../src/shared/reference';
import type { TelemetryFrame } from '../../../src/shared/types';
import { sampleTrace, smoothG, videoFit, videoFitMetrics } from '../../../src/sim/stunts/validation';

const frame = (t: number, altitudeM: number, gForce = 1, pitchDeg = 0, downforceKg = 0): TelemetryFrame => ({
  t, altitudeM, pitchDeg, rollDeg: 0, gForce, downforceKg, speedMs: 0, tankPressureBar: 0, airMassKg: 0, thrusterDuty: [], fanDeltaPKPa: 0, phase: '',
});

/** Trace that reproduces the reference exactly (linear between samples), shifted by `lag` and offset by startT. */
function replay(id: 'ramp_launch' | 'kickflip' | 'ramp_hang', startT: number, lag = 0): TelemetryFrame[] {
  const ref = VIDEO_REFERENCE[id]!;
  const out: TelemetryFrame[] = [];
  const at = (t: number, key: 'altitudeFt' | 'g' | 'pitchDeg' | 'downforceKg') => {
    const pts = ref.filter((r) => r[key] !== undefined);
    if (!pts.length) return 0;
    if (t <= pts[0].t) return pts[0][key]!;
    for (let i = 1; i < pts.length; i++) if (t <= pts[i].t) { const a = pts[i - 1], b = pts[i]; return a[key]! + (b[key]! - a[key]!) * (t - a.t) / (b.t - a.t); }
    return pts[pts.length - 1][key]!;
  };
  for (let t = -1; t <= ref[ref.length - 1].t + 2; t += 0.05) {
    const tv = t + lag; // the sim leads the HUD by `lag`
    out.push(frame(t + startT, at(tv, 'altitudeFt') * FT, at(tv, 'g'), at(tv, 'pitchDeg'), at(tv, 'downforceKg')));
  }
  return out;
}

describe('video validation', () => {
  it('trace interpolation and centred g smoothing', () => {
    const tr = [frame(0, 0, 1), frame(0.05, 1, 3), frame(0.1, 2, 1)];
    expect(sampleTrace(tr, 0.025, 'altitudeM')).toBeCloseTo(0.5, 9);
    expect(sampleTrace(tr, -1, 'altitudeM')).toBe(0);
    expect(sampleTrace(tr, 9, 'altitudeM')).toBe(2);
    expect(smoothG(tr, 0.05)[1].gForce).toBeCloseTo(5 / 3, 9);
  });

  it('a trace equal to the reference has zero error at the right alignment', () => {
    for (const id of ['ramp_launch', 'kickflip', 'ramp_hang'] as const) {
      const fit = videoFit(id, replay(id, 12.3), 12.3)!;
      for (const c of fit.channels) {
        if (c.channel === 'g') continue; // compared after smoothing (peaks of the piecewise-linear g are rounded)
        expect(c.rms, `${id} ${c.channel}`).toBeLessThan(1e-6);
        expect(c.lagS).toBeCloseTo(0, 6);
      }
      expect(Number.isFinite(videoFitMetrics(fit).video_altitudeM_rms)).toBe(true);
    }
  });

  it('a time-shifted trace shows up as RMS error and is recovered as HUD lag', () => {
    const fit = videoFit('ramp_hang', replay('ramp_hang', 0, 1.0), 0)!;
    const alt = fit.channels.find((c) => c.channel === 'altitudeM')!;
    expect(alt.rms).toBeGreaterThan(1);
    expect(alt.lagS).toBeCloseTo(1.0, 1);
    expect(alt.rmsAtLag).toBeLessThan(0.05);
  });

  it('g peaks: local maxima ≥ 1.2 g of the HUD trace, plateaus counted once', () => {
    const fit = videoFit('ramp_launch', replay('ramp_launch', 0), 0)!;
    expect(fit.gPeaks.map((p) => p.t)).toEqual([0, 8]);
    expect(fit.gPeakMaxErr).toBeLessThan(0.05);
  });
});
