// Time-aligned validation against the stream HUD (VIDEO_REFERENCE): the sim telemetry trace is
// sampled at the reference times (t_ref + StuntResult.startT) and compared per channel.
// "compare position, orientation, time, forces ... against the same reference phase".
import { FT } from '@shared/math';
import { VIDEO_REFERENCE, type RefSample } from '@shared/reference';
import type { StuntId, TelemetryFrame } from '@shared/types';

export type VideoChannel = 'altitudeM' | 'pitchDeg' | 'g' | 'downforceKg';

export interface ChannelFit {
  channel: VideoChannel;
  /** Reference samples compared. */
  n: number;
  /** RMS of sim − video at zero time shift (channel units: m, deg, g, kg). */
  rms: number;
  /** Largest |sim − video| and the reference time where it occurs. */
  maxAbs: number;
  maxAbsT: number;
  refPeak: number;
  /** Peak of the sim channel inside the reference time span (g: smoothed, see G_SMOOTH_S). */
  simPeak: number;
  /** Unsmoothed peak (differs from simPeak only for g). */
  simPeakRaw: number;
  /** rms / refPeak. */
  rmsRel: number;
  /**
   * Best constant HUD lag (s, video value at t matches the sim at t − lag, searched in
   * [−LAG_MIN, LAG_MAX]) and the RMS at that lag. Diagnostic only: the HUD filters its readouts.
   */
  lagS: number;
  rmsAtLag: number;
}

export interface GPeakFit {
  /** Reference time of the peak (local maximum ≥ 1.2 g of the HUD g trace). */
  t: number;
  ref: number;
  /** Max sim g within ±G_PEAK_WINDOW_S of the reference time. */
  sim: number;
  err: number;
}

export interface VideoFit {
  stunt: StuntId;
  channels: ChannelFit[];
  gPeaks: GPeakFit[];
  /** max |err| over gPeaks (NaN when the reference has no g channel). */
  gPeakMaxErr: number;
}

const LAG_MIN = 0.5;
const LAG_MAX = 2.0;
const G_PEAK_WINDOW_S = 0.5;
const G_PEAK_MIN = 1.2;
/**
 * The HUD g reference is sampled at 1–2 fps; valve PWM ripple of the sim (15 ms minimum pulses,
 * still ±0.2–0.4 g after the 10 Hz telemetry low-pass) is far above that resolution. The g channel
 * is therefore compared after a centred moving average of ±G_SMOOTH_S (half the finest reference
 * interval, 5 Hz). The unsmoothed peak is reported as ChannelFit.simPeakRaw.
 */
export const G_SMOOTH_S = 0.1;

/** Copy of the trace with gForce replaced by its centred moving average (±half s). */
export function smoothG(trace: readonly TelemetryFrame[], half = G_SMOOTH_S): TelemetryFrame[] {
  const out: TelemetryFrame[] = [];
  let lo = 0, hi = 0, sum = 0;
  for (let i = 0; i < trace.length; i++) {
    const t = trace[i].t;
    while (hi < trace.length && trace[hi].t <= t + half + 1e-9) sum += trace[hi++].gForce;
    while (trace[lo].t < t - half - 1e-9) sum -= trace[lo++].gForce;
    out.push({ ...trace[i], gForce: sum / (hi - lo) });
  }
  return out;
}

const refValue = (s: RefSample, ch: VideoChannel): number | undefined =>
  ch === 'altitudeM' ? (s.altitudeFt === undefined ? undefined : s.altitudeFt * FT)
    : ch === 'pitchDeg' ? s.pitchDeg
      : ch === 'g' ? s.g
        : s.downforceKg;

const simValue = (f: TelemetryFrame, ch: VideoChannel): number =>
  ch === 'altitudeM' ? f.altitudeM : ch === 'pitchDeg' ? f.pitchDeg : ch === 'g' ? f.gForce : f.downforceKg;

/** Linear interpolation of a channel in the (time-ordered) trace; clamps at the ends. */
export function sampleTrace(trace: readonly TelemetryFrame[], t: number, ch: VideoChannel): number {
  if (!trace.length) return NaN;
  if (t <= trace[0].t) return simValue(trace[0], ch);
  const last = trace[trace.length - 1];
  if (t >= last.t) return simValue(last, ch);
  let lo = 0, hi = trace.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (trace[mid].t <= t) lo = mid; else hi = mid; }
  const a = trace[lo], b = trace[hi], u = (t - a.t) / (b.t - a.t);
  return simValue(a, ch) + (simValue(b, ch) - simValue(a, ch)) * u;
}

function maxInWindow(trace: readonly TelemetryFrame[], t0: number, t1: number, ch: VideoChannel): number {
  let m = -Infinity;
  for (const f of trace) if (f.t >= t0 && f.t <= t1) m = Math.max(m, simValue(f, ch));
  return Number.isFinite(m) ? m : sampleTrace(trace, (t0 + t1) / 2, ch);
}

function rmsAt(trace: readonly TelemetryFrame[], pts: { t: number; v: number }[], startT: number, lag: number, ch: VideoChannel): number {
  let s = 0;
  for (const p of pts) { const d = sampleTrace(trace, p.t + startT - lag, ch) - p.v; s += d * d; }
  return Math.sqrt(s / pts.length);
}

/** Compare a sim trace with the video reference of a stunt (null: no reference for this stunt). */
export function videoFit(stunt: StuntId, trace: readonly TelemetryFrame[], startT: number, ref = VIDEO_REFERENCE[stunt]): VideoFit | null {
  if (!ref || !ref.length || !trace.length) return null;
  const raw = trace;
  const smooth = smoothG(trace);
  const channels: ChannelFit[] = [];
  for (const ch of ['altitudeM', 'pitchDeg', 'g', 'downforceKg'] as VideoChannel[]) {
    trace = ch === 'g' ? smooth : raw;
    const pts = ref.flatMap((s) => { const v = refValue(s, ch); return v === undefined ? [] : [{ t: s.t, v }]; });
    if (pts.length < 3) continue;
    let maxAbs = 0, maxAbsT = pts[0].t, refPeak = -Infinity, simPeak = -Infinity, simPeakRaw = -Infinity;
    for (const p of pts) {
      const v = sampleTrace(trace, p.t + startT, ch), d = Math.abs(v - p.v);
      if (d > maxAbs) { maxAbs = d; maxAbsT = p.t; }
      refPeak = Math.max(refPeak, p.v);
    }
    const t0 = pts[0].t + startT, t1 = pts[pts.length - 1].t + startT;
    for (const f of trace) if (f.t >= t0 && f.t <= t1) simPeak = Math.max(simPeak, simValue(f, ch));
    for (const f of raw) if (f.t >= t0 && f.t <= t1) simPeakRaw = Math.max(simPeakRaw, simValue(f, ch));
    const rms = rmsAt(trace, pts, startT, 0, ch);
    let lagS = 0, rmsAtLag = rms;
    for (let lag = -LAG_MIN; lag <= LAG_MAX + 1e-9; lag += 0.05) {
      const r = rmsAt(trace, pts, startT, lag, ch);
      if (r < rmsAtLag - 1e-12) { rmsAtLag = r; lagS = lag; }
    }
    channels.push({ channel: ch, n: pts.length, rms, maxAbs, maxAbsT, refPeak, simPeak, simPeakRaw, rmsRel: rms / Math.max(1e-9, Math.abs(refPeak)), lagS, rmsAtLag });
  }
  const gPeaks: GPeakFit[] = [];
  for (let i = 0; i < ref.length; i++) {
    const g = ref[i].g;
    if (g === undefined || g < G_PEAK_MIN) continue;
    const prev = ref[i - 1]?.g ?? -Infinity, next = ref[i + 1]?.g ?? -Infinity;
    if (g < prev || g < next) continue;
    if (g === prev) continue; // plateau: count it once (first sample)
    const t = ref[i].t + startT;
    const sim = maxInWindow(smooth, t - G_PEAK_WINDOW_S, t + G_PEAK_WINDOW_S, 'g');
    gPeaks.push({ t: ref[i].t, ref: g, sim, err: sim - g });
  }
  const gPeakMaxErr = gPeaks.length ? Math.max(...gPeaks.map((p) => Math.abs(p.err))) : NaN;
  return { stunt, channels, gPeaks, gPeakMaxErr };
}

/** Flat metric keys (video_<channel>_<figure>) for StuntResult.metrics. */
export function videoFitMetrics(fit: VideoFit | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!fit) return out;
  for (const c of fit.channels) {
    out[`video_${c.channel}_rms`] = c.rms;
    out[`video_${c.channel}_maxAbs`] = c.maxAbs;
    out[`video_${c.channel}_rmsRel`] = c.rmsRel;
    out[`video_${c.channel}_lagS`] = c.lagS;
    out[`video_${c.channel}_rmsAtLag`] = c.rmsAtLag;
  }
  if (Number.isFinite(fit.gPeakMaxErr)) out.video_g_peakMaxErr = fit.gPeakMaxErr;
  return out;
}

/** Text table (tools, test logs). */
export function formatVideoFit(fit: VideoFit | null): string {
  if (!fit) return '(no video reference)';
  const rows = fit.channels.map((c) =>
    `  ${c.channel.padEnd(11)} n ${String(c.n).padStart(2)}  RMS ${c.rms.toFixed(2).padStart(7)} (${(100 * c.rmsRel).toFixed(1)} % of peak ${c.refPeak.toFixed(1)})  max ${c.maxAbs.toFixed(2)} @ t ${c.maxAbsT.toFixed(1)} s  ` +
    `peak sim ${c.simPeak.toFixed(2)}${c.channel === 'g' ? ` (raw ${c.simPeakRaw.toFixed(2)})` : ''}  best lag ${c.lagS.toFixed(2)} s -> RMS ${c.rmsAtLag.toFixed(2)}`);
  const peaks = fit.gPeaks.map((p) => `  g peak t ${p.t.toFixed(1)} s: video ${p.ref.toFixed(2)} sim ${p.sim.toFixed(2)} (${p.err >= 0 ? '+' : ''}${p.err.toFixed(2)})`);
  return [`${fit.stunt} vs video:`, ...rows, ...peaks].join('\n');
}
