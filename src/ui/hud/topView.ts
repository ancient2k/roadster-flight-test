// Top-down Roadster line art with the 10 nozzle markers (stream: lower right, left of ALTITUDE).
// Screen mapping for "nose up": screenX = cx - x * k (body +X is LEFT), screenY = cy - z * k.
import { ROADSTER } from '../../shared/roadster';
import { STATIONS } from './carModel';

export const TOP_VIEW = {
  heightRef: 134,      // px at 1080p, nose to tail incl. markers
  lineColor: 'rgb(92,92,92)',
  unlit: 'rgb(62,62,62)',
};

/** Display position (metres, body frame) per nozzle: config positions, spread where markers would overlap. */
export function nozzleDisplayPos(id: number): { x: number; z: number } {
  const n = ROADSTER.nozzles[id];
  if (n.group === 'main') return { x: n.pos.x * 1.55, z: n.pos.z - 0.12 };
  if (n.group === 'yaw') return { x: Math.sign(n.pos.x) * 1.16, z: n.pos.z + 0.12 };
  return { x: n.pos.x * 1.06, z: n.pos.z };
}

/** Pixels per metre for a given HUD scale. */
export const topViewK = (s: number): number => (TOP_VIEW.heightRef * s) / 4.75;

/** Static line art, drawn once per resize into an offscreen canvas. */
export function drawTopViewArt(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  const k = topViewK(s);
  const X = (x: number) => cx - x * k, Y = (z: number) => cy - z * k;
  ctx.save();
  ctx.strokeStyle = TOP_VIEW.lineColor;
  ctx.lineWidth = Math.max(1, 1.5 * s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // wheels (under the body edge)
  ctx.fillStyle = 'rgb(28,28,28)';
  for (const w of ROADSTER.wheels) {
    const ww = w.width * k, wl = w.radius * 2 * k * 0.9;
    const x = X(w.pos.x) - ww / 2, y = Y(w.pos.z) - wl / 2;
    roundRect(ctx, x, y, ww, wl, 2.5 * s); ctx.fill(); ctx.stroke();
  }

  // body outline (max half width per station), pointed nose, kamm tail
  const left: Array<[number, number]> = [], right: Array<[number, number]> = [];
  for (const st of STATIONS) {
    const hw = Math.max(st.hwBelt, st.hwLow) * 0.9;
    left.push([X(hw), Y(st.z)]); right.push([X(-hw), Y(st.z)]);
  }
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  ctx.quadraticCurveTo(cx, Y(STATIONS[0].z + 0.12), right[0][0], right[0][1]);
  for (let i = 1; i < right.length; i++) ctx.lineTo(right[i][0], right[i][1]);
  ctx.lineTo(left[left.length - 1][0], left[left.length - 1][1]);
  for (let i = left.length - 2; i >= 0; i--) ctx.lineTo(left[i][0], left[i][1]);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fill();
  ctx.stroke();

  // glasshouse: windscreen -> roof -> rear glass
  const roof = (i: number) => STATIONS[i].hwRoof * 0.9;
  ctx.beginPath();
  ctx.moveTo(X(roof(2)), Y(STATIONS[2].z));
  ctx.lineTo(X(roof(3)), Y(STATIONS[3].z));
  ctx.lineTo(X(roof(4)), Y(STATIONS[4].z));
  ctx.lineTo(X(roof(5)), Y(STATIONS[5].z));
  ctx.lineTo(X(-roof(5)), Y(STATIONS[5].z));
  ctx.lineTo(X(-roof(4)), Y(STATIONS[4].z));
  ctx.lineTo(X(-roof(3)), Y(STATIONS[3].z));
  ctx.lineTo(X(-roof(2)), Y(STATIONS[2].z));
  ctx.closePath();
  ctx.stroke();
  // windscreen base and roof seams
  for (const i of [3, 4]) {
    ctx.beginPath(); ctx.moveTo(X(roof(i)), Y(STATIONS[i].z)); ctx.lineTo(X(-roof(i)), Y(STATIONS[i].z)); ctx.stroke();
  }
  // hood creases
  ctx.beginPath();
  ctx.moveTo(X(0.42), Y(2.0)); ctx.lineTo(X(roof(2) * 0.8), Y(STATIONS[2].z));
  ctx.moveTo(X(-0.42), Y(2.0)); ctx.lineTo(X(-roof(2) * 0.8), Y(STATIONS[2].z));
  ctx.stroke();
  // rear deck / wing
  ctx.beginPath();
  ctx.moveTo(X(0.78), Y(-1.55)); ctx.lineTo(X(-0.78), Y(-1.55));
  ctx.moveTo(X(0.86), Y(-1.95)); ctx.lineTo(X(-0.86), Y(-1.95));
  ctx.stroke();
  ctx.restore();
}

/**
 * Nozzle markers. duty 0..1 per nozzle. Unlit: grey dot. Lit: white ring + core with a soft plume
 * in the exhaust direction (stream look), size/brightness following the duty.
 */
export function drawNozzles(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, duty: ArrayLike<number>, alpha: number): void {
  const k = topViewK(s);
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let i = 0; i < ROADSTER.nozzles.length; i++) {
    const n = ROADSTER.nozzles[i];
    const p = nozzleDisplayPos(i);
    const x = cx - p.x * k, y = cy - p.z * k;
    const d = Math.max(0, Math.min(1, duty[i] ?? 0));
    const r = (n.group === 'yaw' ? 4.2 : n.group === 'main' ? 4.4 : 6.2) * s;

    if (d > 0.02) {
      // plume: exhaust = -dir; screen dx = dir.x * k, dy = dir.z * k; lift jets fire mostly downward -> halo
      const ex = n.dir.x, ez = n.dir.z;
      const horiz = Math.hypot(ex, ez);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      if (horiz > 0.3) {
        // soft beam in the exhaust direction (stream: a long cone that fades out)
        const len = (n.group === 'main' ? 62 : 78) * s * (0.35 + 0.65 * d);
        const spread = (n.group === 'main' ? 9 : 17) * s;
        const ux = ex / horiz, uy = ez / horiz;
        const g = ctx.createLinearGradient(x, y, x + ux * len, y + uy * len);
        g.addColorStop(0, `rgba(255,255,255,${0.62 * d})`);
        g.addColorStop(0.45, `rgba(255,255,255,${0.22 * d})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x - uy * r * 0.5, y + ux * r * 0.5);
        ctx.quadraticCurveTo(x + ux * len * 0.55 - uy * spread * 1.1, y + uy * len * 0.55 + ux * spread * 1.1, x + ux * len - uy * spread * 0.4, y + uy * len + ux * spread * 0.4);
        ctx.quadraticCurveTo(x + ux * len * 1.04, y + uy * len * 1.04, x + ux * len + uy * spread * 0.4, y + uy * len - ux * spread * 0.4);
        ctx.quadraticCurveTo(x + ux * len * 0.55 + uy * spread * 1.1, y + uy * len * 0.55 - ux * spread * 1.1, x + uy * r * 0.5, y - ux * r * 0.5);
        ctx.closePath();
        ctx.fill();
      }
      const halo = ctx.createRadialGradient(x, y, 0, x, y, r * (2.2 + 1.6 * d));
      halo.addColorStop(0, `rgba(255,255,255,${0.5 * d})`);
      halo.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(x, y, r * (2.2 + 1.6 * d), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // marker
    const lit = Math.min(1, d * 1.6);
    const c = Math.round(62 + (255 - 62) * lit);
    ctx.fillStyle = `rgb(${c},${c},${c})`;
    if (lit > 0.05) {
      ctx.lineWidth = 1.5 * s;
      ctx.strokeStyle = `rgb(${c},${c},${c})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgb(10,10,10)';
      ctx.beginPath(); ctx.arc(x, y, r - 1.5 * s, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgb(${c},${c},${c})`;
      ctx.beginPath(); ctx.arc(x, y, r * 0.48, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
