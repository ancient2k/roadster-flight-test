// Pure helpers for the result screen: series extraction, time alignment Sim vs. video, axis ticks,
// metric grading. DOM-free (tests/ui/results.test.ts).
import { FT } from '../../shared/math';
import type { RefSample } from '../../shared/reference';
import type { TelemetryFrame } from '../../shared/types';
import type { Units } from '../units';

export type SeriesKey = 'altitude' | 'pitch' | 'g' | 'downforce';

export interface SeriesDef { key: SeriesKey; label: string; unit: (u: Units) => string; fromTel: (f: TelemetryFrame, u: Units) => number; fromRef: (r: RefSample, u: Units) => number | undefined }

export const SERIES: SeriesDef[] = [
  {
    key: 'altitude', label: 'Höhe', unit: (u) => (u === 'imperial' ? 'ft' : 'm'),
    fromTel: (f, u) => (u === 'imperial' ? f.altitudeM / FT : f.altitudeM),
    fromRef: (r, u) => (r.altitudeFt === undefined ? undefined : u === 'imperial' ? r.altitudeFt : r.altitudeFt * FT),
  },
  { key: 'pitch', label: 'Pitch', unit: () => '°', fromTel: (f) => f.pitchDeg, fromRef: (r) => r.pitchDeg },
  { key: 'g', label: 'G-Kraft', unit: () => 'g', fromTel: (f) => f.gForce, fromRef: (r) => r.g },
  { key: 'downforce', label: 'Downforce', unit: () => 'kg', fromTel: (f) => f.downforceKg, fromRef: (r) => r.downforceKg },
];

/** Speed (not in the HUD video data; used for the 0-60 run). */
export const SPEED_SERIES: SeriesDef = {
  key: 'g', label: 'Tempo', unit: (u) => (u === 'imperial' ? 'mph' : 'km/h'),
  fromTel: (f, u) => (u === 'imperial' ? f.speedMs / 0.44704 : f.speedMs * 3.6),
  fromRef: () => undefined,
};

export interface Pt { t: number; v: number }

/** Series that have reference data (or, without reference, sim variation worth plotting). */
export function seriesToPlot(ref: RefSample[] | undefined, tel: readonly TelemetryFrame[]): SeriesDef[] {
  if (ref?.length) return SERIES.filter((s) => ref.some((r) => s.fromRef(r, 'metric') !== undefined));
  return SERIES.filter((s) => {
    let lo = Infinity, hi = -Infinity;
    for (const f of tel) { const v = s.fromTel(f, 'metric'); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return hi - lo > (s.key === 'g' ? 0.2 : s.key === 'downforce' ? 50 : 0.5);
  });
}

/** Down-sample telemetry to at most `maxPts` points (min/max preserving buckets keep peaks visible). */
export function simSeries(tel: readonly TelemetryFrame[], def: SeriesDef, units: Units, t0: number, maxPts = 600): Pt[] {
  const n = tel.length;
  if (n <= maxPts) return tel.map((f) => ({ t: f.t - t0, v: def.fromTel(f, units) }));
  const out: Pt[] = [];
  const bucket = n / (maxPts / 2);
  for (let b = 0; b < n; b += bucket) {
    const i0 = Math.floor(b), i1 = Math.min(n, Math.floor(b + bucket));
    let lo = i0, hi = i0;
    for (let i = i0; i < i1; i++) {
      const v = def.fromTel(tel[i], units);
      if (v < def.fromTel(tel[lo], units)) lo = i;
      if (v > def.fromTel(tel[hi], units)) hi = i;
    }
    for (const i of lo < hi ? [lo, hi] : hi < lo ? [hi, lo] : [lo]) out.push({ t: tel[i].t - t0, v: def.fromTel(tel[i], units) });
  }
  return out;
}

export function refSeries(ref: readonly RefSample[], def: SeriesDef, units: Units): Pt[] {
  const out: Pt[] = [];
  for (const r of ref) { const v = def.fromRef(r, units); if (v !== undefined) out.push({ t: r.t, v }); }
  return out;
}

/** Linear interpolation of a sorted series (clamped at the ends). */
export function sampleAt(pts: readonly Pt[], t: number): number {
  if (!pts.length) return NaN;
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) { const a = pts[i - 1], b = pts[i]; return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t || 1); }
  }
  return pts[pts.length - 1].v;
}

/**
 * Find the time offset (s) that best aligns the sim trace to the reference (sim time - offset ≈ ref time),
 * by brute-force search minimising the normalised squared error on the given series. Used when the game
 * does not pass an explicit manoeuvre start.
 */
export function bestOffset(sim: readonly Pt[], ref: readonly Pt[], search: [number, number], step = 0.05): number {
  if (sim.length < 2 || ref.length < 2) return 0;
  let span = 0;
  for (const r of ref) span = Math.max(span, Math.abs(r.v));
  span = span || 1;
  let best = 0, bestErr = Infinity;
  for (let off = search[0]; off <= search[1] + 1e-9; off += step) {
    let err = 0, n = 0;
    for (const r of ref) {
      const tSim = r.t + off;
      if (tSim < sim[0].t || tSim > sim[sim.length - 1].t) { err += 1; n++; continue; } // penalty: outside the run
      const d = (sampleAt(sim, tSim) - r.v) / span;
      err += d * d; n++;
    }
    err /= n;
    if (err < bestErr - 1e-12) { bestErr = err; best = off; }
  }
  return Math.round(best / step) * step;
}

/** "Nice" axis ticks (1, 2, 2.5, 5 × 10^n). */
export function niceTicks(lo: number, hi: number, maxTicks = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi - lo < 1e-9) { hi = lo + 1; }
  const raw = (hi - lo) / Math.max(1, maxTicks - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.ceil(lo / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(12));
  return out;
}

export interface Grade { ratio: number; ok: boolean; level: 'gut' | 'knapp' | 'daneben' }

/** Compare a sim metric to the Tesla reference. tol = relative tolerance for "gut"; 2·tol for "knapp". */
export function grade(sim: number, ref: number, tol = 0.15): Grade {
  if (!Number.isFinite(sim) || !Number.isFinite(ref)) return { ratio: NaN, ok: false, level: 'daneben' };
  const ratio = ref === 0 ? (sim === 0 ? 1 : Infinity) : sim / ref;
  const dev = Math.abs(ratio - 1);
  const level = dev <= tol ? 'gut' : dev <= 2 * tol ? 'knapp' : 'daneben';
  return { ratio, ok: level !== 'daneben', level };
}
