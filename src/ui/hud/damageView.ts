// Damage top view (HUD and results screen): body zones, wheels, nozzles and the rear wing coloured by damage.
// Same screen mapping as topView.ts ("nose up": screenX = cx − x·k, body +X is LEFT; screenY = cy − z·k).
import { ROADSTER } from '../../shared/roadster';
import type { DamageState, DamageZone } from '../../shared/damage';
import { nozzleDisplayPos } from './topView';

const INTACT = 'rgba(255,255,255,0.10)';
const LINE = 'rgba(255,255,255,0.38)';
export const DAMAGE_RED = '#ff4b3e';

/** Fill colour for a damage level 0..1 (amber → red; intact = faint white). */
export function damageColor(level: number, alpha = 1): string {
  if (!(level > 0.005)) return INTACT;
  const t = Math.min(1, level);
  const g = Math.round(196 - 121 * t), b = Math.round(64 - 2 * t);
  return `rgba(255,${g},${b},${((0.45 + 0.5 * t) * alpha).toFixed(3)})`;
}

/** Body-frame rectangles of the zones (x0, x1, z0, z1), drawn in this order. */
const ZONE_RECT: Array<[DamageZone, number, number, number, number]> = [
  ['underbody', -0.7, 0.7, -1.65, 1.6],
  ['front', -0.95, 0.95, 1.6, 2.2],
  ['rear', -0.95, 0.95, -2.08, -1.65],
  ['left', 0.7, 0.98, -1.65, 1.6],
  ['right', -0.98, -0.7, -1.65, 1.6],
  ['roof', -0.55, 0.55, -0.95, 0.55],
];

/** Draws the damage top view centred at (cx, cy); `lengthPx` = car length on screen. */
export function drawDamageView(c: CanvasRenderingContext2D, cx: number, cy: number, lengthPx: number, d: Readonly<DamageState>): void {
  const k = lengthPx / 4.6;
  const X = (x: number) => cx - x * k, Y = (z: number) => cy - z * k;
  const lw = Math.max(1, lengthPx / 110);
  c.save();
  c.lineJoin = 'round';
  c.lineWidth = lw;
  // zones
  for (const [z, x0, x1, z0, z1] of ZONE_RECT) {
    const sx = X(x1), sy = Y(z1), w = (x1 - x0) * k, h = (z1 - z0) * k;
    c.fillStyle = damageColor(d.zones[z]);
    c.fillRect(sx, sy, w, h);
    c.strokeStyle = LINE;
    c.strokeRect(sx, sy, w, h);
  }
  // wheels
  for (let i = 0; i < 4; i++) {
    const w = ROADSTER.wheels[i];
    const ww = w.width * k, wl = w.radius * 1.8 * k;
    const x = X(w.pos.x) - ww / 2 + (w.pos.x > 0 ? -0.18 : 0.18) * k, y = Y(w.pos.z) - wl / 2;
    if (d.wheelLost[i]) {
      c.setLineDash([2 * lw, 2 * lw]);
      c.strokeStyle = DAMAGE_RED;
      c.strokeRect(x, y, ww, wl);
      c.setLineDash([]);
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + ww, y + wl); c.moveTo(x + ww, y); c.lineTo(x, y + wl); c.stroke();
      continue;
    }
    c.fillStyle = d.wheels[i] > 0.005 ? damageColor(d.wheels[i]) : 'rgba(30,30,30,0.95)';
    c.fillRect(x, y, ww, wl);
    c.strokeStyle = LINE;
    c.strokeRect(x, y, ww, wl);
  }
  // rear wing
  const wy = Y(-1.5);
  c.lineWidth = 2.2 * lw;
  if (d.wingLost) c.setLineDash([2.5 * lw, 2 * lw]);
  c.strokeStyle = d.wingLost ? DAMAGE_RED : 'rgba(255,255,255,0.55)';
  c.beginPath(); c.moveTo(X(0.72), wy); c.lineTo(X(-0.72), wy); c.stroke();
  c.setLineDash([]);
  // nozzles
  for (let i = 0; i < ROADSTER.nozzles.length; i++) {
    const p = nozzleDisplayPos(i);
    const r = Math.max(1.5, 0.075 * k);
    c.beginPath(); c.arc(X(p.x), Y(p.z), r, 0, Math.PI * 2);
    c.fillStyle = d.nozzles[i] > 0.005 ? damageColor(d.nozzles[i], 1.6) : 'rgba(200,200,200,0.6)';
    c.fill();
  }
  c.restore();
}

/** Worst functional damage 0..1 (wheels, nozzles, skirts, wing). */
export function functionalDamage(d: Readonly<DamageState>): number {
  return Math.max(...d.wheels, ...d.nozzles, ...d.skirts, d.wingLost ? 1 : 0, ...d.wheelLost.map((x) => (x ? 1 : 0)));
}
