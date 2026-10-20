// Stroke digits for the stream's 0-60 timer ("00:00:00:81"): tall condensed stadium shapes,
// italic, round caps. Drawn as canvas paths so they stay crisp at any size.
type Pt = [number, number, number?]; // x, y, corner radius
type Path = { pts: Pt[]; closed?: boolean };

const H = 2.7; // digit height in units of the digit width (centre line)
const R = 0.5;

const rr = (x0: number, y0: number, x1: number, y1: number, r = R): Path => ({ pts: [[x0, y0, r], [x1, y0, r], [x1, y1, r], [x0, y1, r]], closed: true });

const DIGITS: Record<string, Path[]> = {
  '0': [rr(0, 0, 1, H)],
  '1': [{ pts: [[0.2, 0.42], [0.62, 0, 0.08], [0.62, H]] }],
  '2': [{ pts: [[0, 0.62], [0, 0, R], [1, 0, R], [1, 1.15, 0.35], [0, H, 0.1], [1, H]] }],
  '3': [{ pts: [[0, 0], [1, 0, R], [1, H, R], [0, H]] }, { pts: [[0.32, 1.32], [1, 1.32]] }],
  '4': [{ pts: [[0.78, H], [0.78, 0, 0.05], [0, 1.85, 0.05], [1, 1.85]] }],
  '5': [{ pts: [[1, 0], [0, 0], [0, 1.18], [1, 1.18, R], [1, H, R], [0, H]] }],
  '6': [{ pts: [[0.95, 0], [0, 0, R], [0, H, R], [1, H, R], [1, 1.18, R], [0, 1.18]] }],
  '7': [{ pts: [[0, 0], [1, 0, 0.06], [0.28, H]] }],
  '8': [rr(0, 0, 1, 1.3), rr(0, 1.3, 1, H)],
  '9': [{ pts: [[0.05, H], [1, H, R], [1, 0, R], [0, 0, R], [0, 1.52, R], [1, 1.52]] }],
};

export const TIMER_ADV = { digit: 1.4, colon: 0.6 };

function tracePath(ctx: CanvasRenderingContext2D, p: Path, ox: number, u: number): void {
  const pts = p.pts.map(([x, y, r]) => [ox + x * u, y * u, (r ?? 0) * u] as const);
  const n = pts.length;
  if (p.closed) {
    // start in the middle of the first edge so every corner can be rounded
    const sx = (pts[0][0] + pts[1][0]) / 2, sy = (pts[0][1] + pts[1][1]) / 2;
    ctx.moveTo(sx, sy);
    for (let i = 1; i <= n; i++) {
      const c = pts[i % n], nx = pts[(i + 1) % n];
      ctx.arcTo(c[0], c[1], nx[0], nx[1], c[2]);
    }
    ctx.closePath();
    return;
  }
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < n - 1; i++) ctx.arcTo(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], pts[i][2]);
  ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
}

/** Width of a timer string in px for digit cap height `capPx` (centre line). */
export function timerWidth(text: string, capPx: number): number {
  const u = capPx / H;
  let w = 0;
  for (const ch of text) w += (ch === ':' ? TIMER_ADV.colon : TIMER_ADV.digit) * u;
  return w - (TIMER_ADV.digit - 1) * u;
}

/**
 * Draw `text` (digits and ':') with its top-left at the current origin. `capPx` = centre-line height.
 * Caller sets fill/stroke style and transform (italic skew).
 */
export function drawTimerText(ctx: CanvasRenderingContext2D, text: string, capPx: number, strokePx: number): void {
  const u = capPx / H;
  let x = 0;
  ctx.lineWidth = strokePx;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const ch of text) {
    if (ch === ':') {
      const cx = x + TIMER_ADV.colon * u * 0.3;
      for (const cy of [0.95 * u, 2.0 * u]) { ctx.beginPath(); ctx.arc(cx, cy, strokePx * 0.62, 0, Math.PI * 2); ctx.fill(); }
      x += TIMER_ADV.colon * u;
      continue;
    }
    const paths = DIGITS[ch];
    if (paths) {
      ctx.beginPath();
      for (const p of paths) tracePath(ctx, p, x, u);
      ctx.stroke();
    }
    x += TIMER_ADV.digit * u;
  }
}
