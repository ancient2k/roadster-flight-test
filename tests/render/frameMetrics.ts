// Image-sequence metrics for flicker and ghosting (pure, no GPU): used by tests/render/flickerGhost.mjs
// on downsampled luma frames of a fixed-step capture, unit-tested in frameMetrics.test.ts.
//
// Flicker = brightness that goes up and comes back down (or the reverse) from one frame to the next.
// Smooth motion (camera pans, the car driving through the frame) changes a pixel in the same
// direction over consecutive frames; flicker reverses the sign. The reversal energy
// sqrt(max(0, -(c - p)·(n - c))) is zero for monotonic changes and equals the amplitude for a
// one-frame blink, so it measures flicker without a static camera. Downsampling the frames to
// blocks of ~10×10 pixels first averages out film grain and the sub-pixel TRAA jitter.

/** One luma frame (0–255), row-major. */
export interface LumaFrame { w: number; h: number; data: Uint8Array }

/** Screen box in frame pixels (inclusive min, exclusive max). */
export interface Box { x0: number; y0: number; x1: number; y1: number }

/** Mean sign-reversal energy per pixel between frames p, c, n (optionally inside a mask). */
export function reversalEnergy(p: LumaFrame, c: LumaFrame, n: LumaFrame, mask?: Uint8Array): number {
  let s = 0, k = 0;
  for (let i = 0; i < c.data.length; i++) {
    if (mask && !mask[i]) continue;
    const a = c.data[i] - p.data[i], b = n.data[i] - c.data[i];
    const r = -a * b;
    if (r > 0) s += Math.sqrt(r);
    k++;
  }
  return k ? s / k : 0;
}

/** Mean absolute difference of two frames (optionally inside a box). */
export function meanAbsDiff(a: LumaFrame, b: LumaFrame, box?: Box): number {
  const x0 = box ? Math.max(0, box.x0) : 0, x1 = box ? Math.min(a.w, box.x1) : a.w;
  const y0 = box ? Math.max(0, box.y0) : 0, y1 = box ? Math.min(a.h, box.y1) : a.h;
  let s = 0, k = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * a.w + x; s += Math.abs(a.data[i] - b.data[i]); k++; }
  return k ? s / k : 0;
}

export function meanLuma(f: LumaFrame): number {
  let s = 0;
  for (let i = 0; i < f.data.length; i++) s += f.data[i];
  return s / f.data.length;
}

/** Per-pixel accumulated reversal energy (heat map of flicker sources), frames in `skip` left out. */
export function reversalHeat(frames: LumaFrame[], skip: Set<number> = new Set()): Float32Array {
  const { w, h } = frames[0];
  const heat = new Float32Array(w * h);
  let k = 0;
  for (let t = 1; t + 1 < frames.length; t++) {
    if (skip.has(t) || skip.has(t + 1)) continue;
    const p = frames[t - 1].data, c = frames[t].data, n = frames[t + 1].data;
    for (let i = 0; i < heat.length; i++) { const r = -(c[i] - p[i]) * (n[i] - c[i]); if (r > 0) heat[i] += Math.sqrt(r); }
    k++;
  }
  if (k) for (let i = 0; i < heat.length; i++) heat[i] /= k;
  return heat;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]);
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

/**
 * Frames whose overall change is a one-frame step far above the local motion (light switching on/off,
 * exposure jumps, history pops): ratio of mean|F_t − F_t−1| to the median of the surrounding window.
 */
export function popFrames(frames: LumaFrame[], skip: Set<number> = new Set(), ratio = 3, minDiff = 1.5, win = 15): { t: number; d: number; ratio: number }[] {
  const d = frames.map((f, t) => (t ? meanAbsDiff(frames[t - 1], f) : 0));
  const out: { t: number; d: number; ratio: number }[] = [];
  for (let t = 2; t < frames.length; t++) {
    if (skip.has(t)) continue;
    const around: number[] = [];
    for (let u = Math.max(1, t - win); u <= Math.min(frames.length - 1, t + win); u++) if (u !== t && !skip.has(u)) around.push(d[u]);
    const m = Math.max(0.25, median(around));
    if (d[t] > minDiff && d[t] / m > ratio) out.push({ t, d: d[t], ratio: d[t] / m });
  }
  return out;
}

/**
 * Global brightness pumping: sign-reversal energy of the mean luma series (exposure oscillating
 * between frames), in luma steps per frame.
 */
export function pumping(series: number[]): number {
  let s = 0, k = 0;
  for (let t = 1; t + 1 < series.length; t++) {
    const r = -(series[t] - series[t - 1]) * (series[t + 1] - series[t]);
    if (r > 0) s += Math.sqrt(r);
    k++;
  }
  return k ? s / k : 0;
}

/**
 * Cut residual: a clean camera cut shows the new shot at once, so the change from the cut frame to
 * the next is ordinary motion. Ghosting of the old shot (TRAA history) or a whole-frame motion-blur
 * smear (velocity buffer still holding the previous camera) makes |F_c − F_c+1| several times
 * |F_c+1 − F_c+2|. Returns that ratio (≈1 for a clean cut).
 */
export function cutResidual(frames: LumaFrame[], c: number): number {
  if (c + 2 >= frames.length) return NaN;
  const a = meanAbsDiff(frames[c], frames[c + 1]);
  const b = meanAbsDiff(frames[c + 1], frames[c + 2]);
  return a / Math.max(0.5, b);
}

/** Union of boxes, grown by `pad` pixels. */
export function unionBox(boxes: (Box | null)[], pad = 0): Box | null {
  const v = boxes.filter((b): b is Box => !!b);
  if (!v.length) return null;
  return {
    x0: Math.min(...v.map((b) => b.x0)) - pad, y0: Math.min(...v.map((b) => b.y0)) - pad,
    x1: Math.max(...v.map((b) => b.x1)) + pad, y1: Math.max(...v.map((b) => b.y1)) + pad,
  };
}

/** Summary statistics of a per-frame series. */
export function stats(xs: number[]): { mean: number; p50: number; p95: number; max: number } {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return { mean: 0, p50: 0, p95: 0, max: 0 };
  return { mean: v.reduce((a, b) => a + b, 0) / v.length, p50: quantile(v, 0.5), p95: quantile(v, 0.95), max: Math.max(...v) };
}

/**
 * Light dropout: share of (block, frame) samples of lit blocks whose luma falls below `drop` × the
 * block's rolling median (window ±`win`). A light that TRAA keeps losing shows as a sawtooth that
 * repeatedly falls back to the background – dropout counts those falls, while a steady shimmer of
 * ±15 % (which the reversal energy penalises) counts zero. Lit = median ≥ `minLit` luma.
 */
export function dropout(frames: LumaFrame[], skip: Set<number> = new Set(), minLit = 20, drop = 0.5, win = 7): number {
  const { w, h } = frames[0];
  let hits = 0, total = 0;
  const buf: number[] = [];
  for (let i = 0; i < w * h; i++) {
    for (let t = win; t + win < frames.length; t++) {
      if (skip.has(t)) continue;
      buf.length = 0;
      for (let u = t - win; u <= t + win; u++) if (!skip.has(u)) buf.push(frames[u].data[i]);
      const m = median(buf);
      if (m < minLit) continue;
      total++;
      if (frames[t].data[i] < m * drop) hits++;
    }
  }
  return total ? hits / total : 0;
}
