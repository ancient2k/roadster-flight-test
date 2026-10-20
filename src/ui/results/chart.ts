// Canvas telemetry chart "Simulation vs. Tesla-Stream": stacked panels sharing one time axis.
import { DISPLAY_FONT } from '../fonts';
import { fmtNumMax, t, upper } from '../../i18n';
import { niceTicks, type Pt } from './chartMath';

export interface ChartPanel { label: string; unit: string; sim: Pt[]; ref: Pt[] }

const C = {
  grid: 'rgba(255,255,255,0.07)',
  axis: 'rgba(255,255,255,0.28)',
  text: 'rgba(255,255,255,0.55)',
  label: '#f2f2f2',
  sim: '#ffffff',
  ref: '#e8261c',
};

export function drawChart(canvas: HTMLCanvasElement, panels: ChartPanel[], xRange?: [number, number]): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(10, canvas.clientWidth), H = Math.max(10, canvas.clientHeight);
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  const c = canvas.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  if (!panels.length) {
    c.fillStyle = C.text; c.font = `600 14px ${DISPLAY_FONT}`; c.textAlign = 'center';
    c.fillText(upper(t('chart.noTelemetry')), W / 2, H / 2);
    return;
  }
  const fs = Math.max(10, Math.min(13, W / 70));
  const padL = fs * 4.6, padR = fs * 1.2, padT = fs * 0.6, padB = fs * 2.8, gap = fs * 1.6;

  // shared time range
  let t0 = Infinity, t1 = -Infinity;
  for (const p of panels) for (const s of [p.sim, p.ref]) for (const q of s) { t0 = Math.min(t0, q.t); t1 = Math.max(t1, q.t); }
  if (xRange) [t0, t1] = xRange;
  if (!(t1 > t0)) { t0 = 0; t1 = 1; }
  const ph = (H - padT - padB - gap * (panels.length - 1)) / panels.length;
  const X = (t: number) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const xt = niceTicks(t0, t1, Math.max(3, Math.floor((W - padL) / 90)));

  panels.forEach((p, i) => {
    const top = padT + i * (ph + gap), bot = top + ph;
    let lo = Infinity, hi = -Infinity;
    for (const s of [p.sim, p.ref]) for (const q of s) if (q.t >= t0 && q.t <= t1) { lo = Math.min(lo, q.v); hi = Math.max(hi, q.v); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (lo > 0 && lo < hi * 0.4) lo = 0;
    const span = hi - lo || Math.abs(hi) || 1;
    lo -= span * 0.06; hi += span * 0.08;
    const Y = (v: number) => bot - ((v - lo) / (hi - lo)) * ph;

    // grid + y ticks
    c.lineWidth = 1;
    c.font = `600 ${fs * 0.85}px ${DISPLAY_FONT}`;
    c.textAlign = 'right'; c.textBaseline = 'middle';
    for (const v of niceTicks(lo, hi, Math.max(2, Math.floor(ph / 34)))) {
      const y = Math.round(Y(v)) + 0.5;
      c.strokeStyle = C.grid; c.beginPath(); c.moveTo(padL, y); c.lineTo(W - padR, y); c.stroke();
      c.fillStyle = C.text; c.fillText(fmtNumMax(v, 2), padL - fs * 0.5, y);
    }
    for (const t of xt) {
      const x = Math.round(X(t)) + 0.5;
      c.strokeStyle = C.grid; c.beginPath(); c.moveTo(x, top); c.lineTo(x, bot); c.stroke();
    }
    c.strokeStyle = C.axis; c.beginPath(); c.moveTo(padL, bot + 0.5); c.lineTo(W - padR, bot + 0.5); c.stroke();

    // panel label
    c.textAlign = 'left'; c.textBaseline = 'top';
    c.fillStyle = C.label; c.font = `600 ${fs}px ${DISPLAY_FONT}`;
    c.fillText(`${upper(p.label)}  (${p.unit.toUpperCase()})`, padL + fs * 0.5, top + fs * 0.3);

    c.save();
    c.beginPath(); c.rect(padL, top - 2, W - padL - padR, ph + 4); c.clip();
    // reference: dashed red line + dots
    if (p.ref.length) {
      c.strokeStyle = C.ref; c.lineWidth = 1.6; c.setLineDash([5, 4]);
      c.beginPath(); p.ref.forEach((q, k) => (k ? c.lineTo(X(q.t), Y(q.v)) : c.moveTo(X(q.t), Y(q.v)))); c.stroke();
      c.setLineDash([]);
      c.fillStyle = C.ref;
      for (const q of p.ref) { c.beginPath(); c.arc(X(q.t), Y(q.v), 3, 0, Math.PI * 2); c.fill(); }
    }
    // simulation
    if (p.sim.length) {
      c.strokeStyle = C.sim; c.lineWidth = 2; c.lineJoin = 'round';
      c.shadowColor = 'rgba(255,255,255,0.35)'; c.shadowBlur = 6;
      c.beginPath(); p.sim.forEach((q, k) => (k ? c.lineTo(X(q.t), Y(q.v)) : c.moveTo(X(q.t), Y(q.v)))); c.stroke();
    }
    c.restore();
  });

  // x axis labels
  c.fillStyle = C.text; c.font = `600 ${fs * 0.85}px ${DISPLAY_FONT}`;
  c.textAlign = 'center'; c.textBaseline = 'top';
  const yAxis = H - padB + fs * 0.5;
  for (const x of xt) c.fillText(fmtNumMax(x, 2), X(x), yAxis);
  c.fillText(upper(t('chart.timeAxis')), padL + (W - padL - padR) / 2, yAxis + fs * 1.25);
}
