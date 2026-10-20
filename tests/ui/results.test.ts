import { describe, expect, it } from 'vitest';
import { SERIES, bestOffset, grade, niceTicks, refSeries, sampleAt, seriesToPlot, simSeries, type Pt } from '../../src/ui/results/chartMath';
import { VIDEO_REFERENCE } from '../../src/shared/reference';
import { FT } from '../../src/shared/math';
import type { TelemetryFrame } from '../../src/shared/types';

const frame = (t: number, altM: number, extra: Partial<TelemetryFrame> = {}): TelemetryFrame => ({
  t, altitudeM: altM, pitchDeg: 0, rollDeg: 0, gForce: 1, downforceKg: 0, speedMs: 0, tankPressureBar: 690, airMassKg: 250,
  thrusterDuty: new Array(10).fill(0), fanDeltaPKPa: 0, phase: '', ...extra,
});

describe('result chart math', () => {
  const alt = SERIES.find((s) => s.key === 'altitude')!;
  it('reference series in display units', () => {
    const r = refSeries(VIDEO_REFERENCE.kickflip!, alt, 'imperial');
    expect(Math.max(...r.map((p) => p.v))).toBeCloseTo(25.2, 6);
    const m = refSeries(VIDEO_REFERENCE.kickflip!, alt, 'metric');
    expect(Math.max(...m.map((p) => p.v))).toBeCloseTo(25.2 * FT, 6);
  });
  it('plots only series the video has', () => {
    expect(seriesToPlot(VIDEO_REFERENCE.kickflip, []).map((s) => s.key)).toEqual(['altitude', 'g']);
    expect(seriesToPlot(VIDEO_REFERENCE.ramp_hang, []).map((s) => s.key)).toEqual(['altitude', 'pitch', 'downforce']);
  });
  it('auto-aligns a delayed sim trace to the video', () => {
    const ref = refSeries(VIDEO_REFERENCE.kickflip!, alt, 'imperial');
    // sim = reference shifted by +3.2 s (the run started 3.2 s before the manoeuvre)
    const tel: TelemetryFrame[] = [];
    for (let t = 0; t <= 12; t += 1 / 60) tel.push(frame(t, sampleAt(ref, t - 3.2) * FT));
    const sim = simSeries(tel, alt, 'imperial', 0);
    expect(bestOffset(sim, ref, [-2, 6])).toBeCloseTo(3.2, 1);
  });
  it('down-sampling keeps the peak', () => {
    const tel: TelemetryFrame[] = [];
    for (let i = 0; i < 5000; i++) tel.push(frame(i / 240, i === 2345 ? 9 : 1));
    const s = simSeries(tel, alt, 'metric', 0, 300);
    expect(s.length).toBeLessThanOrEqual(320);
    expect(Math.max(...s.map((p) => p.v))).toBe(9);
  });
  it('sampleAt interpolates and clamps', () => {
    const p: Pt[] = [{ t: 0, v: 0 }, { t: 2, v: 10 }];
    expect(sampleAt(p, 1)).toBe(5);
    expect(sampleAt(p, -1)).toBe(0);
    expect(sampleAt(p, 9)).toBe(10);
    expect(sampleAt([], 1)).toBeNaN();
  });
  it('nice ticks', () => {
    expect(niceTicks(0, 25.2)).toEqual([0, 10, 20]);
    expect(niceTicks(0, 4700, 5)).toEqual([0, 2000, 4000]);
    expect(niceTicks(-180, 180, 5)).toEqual([-100, 0, 100]);
    expect(niceTicks(0, 3.5, 6)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(2, 2)).toEqual([2, 2.25, 2.5, 2.75, 3]);
  });
  it('grading against Tesla reference', () => {
    expect(grade(7.5, 7.7).level).toBe('gut');
    expect(grade(9.5, 7.7).level).toBe('knapp');
    expect(grade(15, 7.7).level).toBe('daneben');
    expect(grade(0.85, 0.81, 0.15).ok).toBe(true);
    expect(grade(NaN, 1).ok).toBe(false);
  });
});
