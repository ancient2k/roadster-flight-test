// Tiny software-rendered low-poly Roadster for the HUD attitude sphere and the top view.
// Body frame: +X LEFT, +Y up, +Z forward (src/shared/roadster.ts). No three.js: ~70 flat-shaded
// polygons painted back-to-front on a 2D canvas, cheap enough to redraw every frame.
import { ROADSTER } from '../../shared/roadster';
import { qrot, type Quat, type Vec3 } from '../../shared/math';

interface Station { z: number; hwLow: number; yLow: number; hwBelt: number; yBelt: number; hwRoof: number; yRoof: number }

// Hand-fitted to the Gen 2 silhouette (stream reference frames): low pointed nose, cab-forward glasshouse,
// long flat rear deck with a kamm tail.
const FLOOR = ROADSTER.bodyBox.min.y + 0.05;
export const STATIONS: Station[] = [
  { z: 2.22, hwLow: 0.55, yLow: FLOOR + 0.05, hwBelt: 0.60, yBelt: -0.14, hwRoof: 0.40, yRoof: -0.13 },
  { z: 1.85, hwLow: 0.78, yLow: FLOOR, hwBelt: 0.93, yBelt: 0.08, hwRoof: 0.58, yRoof: 0.02 },
  { z: 1.40, hwLow: 0.78, yLow: FLOOR, hwBelt: 0.97, yBelt: 0.26, hwRoof: 0.58, yRoof: 0.12 },
  { z: 0.85, hwLow: 0.80, yLow: FLOOR, hwBelt: 0.96, yBelt: 0.22, hwRoof: 0.60, yRoof: 0.20 },
  { z: 0.20, hwLow: 0.82, yLow: FLOOR, hwBelt: 0.94, yBelt: 0.24, hwRoof: 0.50, yRoof: 0.50 },
  { z: -0.50, hwLow: 0.82, yLow: FLOOR, hwBelt: 0.95, yBelt: 0.27, hwRoof: 0.50, yRoof: 0.52 },
  { z: -1.25, hwLow: 0.80, yLow: FLOOR, hwBelt: 0.99, yBelt: 0.31, hwRoof: 0.70, yRoof: 0.33 },
  { z: -1.75, hwLow: 0.78, yLow: FLOOR + 0.02, hwBelt: 0.97, yBelt: 0.30, hwRoof: 0.80, yRoof: 0.31 },
  { z: -2.12, hwLow: 0.74, yLow: FLOOR + 0.07, hwBelt: 0.90, yBelt: 0.26, hwRoof: 0.78, yRoof: 0.28 },
];

export type Mat = 'body' | 'glass' | 'dark' | 'tyre' | 'rim' | 'light' | 'tail';
/** n: outward unit normal (body frame); sort: point used for painter's ordering. */
export interface Face { v: Vec3[]; mat: Mat; n: Vec3; sort: Vec3 }

/** Section ring (6 points, left to right over the top, then bottom). */
function ring(s: Station): Vec3[] {
  return [
    { x: s.hwLow, y: s.yLow, z: s.z },
    { x: s.hwBelt, y: s.yBelt, z: s.z },
    { x: s.hwRoof, y: s.yRoof, z: s.z },
    { x: -s.hwRoof, y: s.yRoof, z: s.z },
    { x: -s.hwBelt, y: s.yBelt, z: s.z },
    { x: -s.hwLow, y: s.yLow, z: s.z },
  ];
}

const centroid = (v: Vec3[]): Vec3 => {
  const c = { x: 0, y: 0, z: 0 };
  for (const p of v) { c.x += p.x; c.y += p.y; c.z += p.z; }
  return { x: c.x / v.length, y: c.y / v.length, z: c.z / v.length };
};

/** Face with its geometric normal oriented to agree with `outward` (winding-independent). */
function face(v: Vec3[], mat: Mat, outward: Vec3, sortShift: Vec3 = { x: 0, y: 0, z: 0 }): Face {
  // Newell normal (robust for slightly non-planar quads)
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    nx += (a.y - b.y) * (a.z + b.z); ny += (a.z - b.z) * (a.x + b.x); nz += (a.x - b.x) * (a.y + b.y);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  let n = { x: nx / l, y: ny / l, z: nz / l };
  if (n.x * outward.x + n.y * outward.y + n.z * outward.z < 0) n = { x: -n.x, y: -n.y, z: -n.z };
  const c = centroid(v);
  return { v, mat, n, sort: { x: c.x + sortShift.x, y: c.y + sortShift.y, z: c.z + sortShift.z } };
}

function buildBody(): Face[] {
  const faces: Face[] = [];
  const rings = STATIONS.map(ring);
  const core = (c: Vec3): Vec3 => ({ x: c.x, y: c.y - 0.05, z: c.z * 0.15 });
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    const zMid = (STATIONS[i].z + STATIONS[i + 1].z) / 2;
    for (let k = 0; k < 6; k++) {
      const k2 = (k + 1) % 6;
      let mat: Mat = 'body';
      const isSideUpper = k === 1 || k === 3;     // belt -> roof (side glass)
      const isTop = k === 2;                       // roof strip
      if (isTop && zMid < 0.85 && zMid > 0.2) mat = 'glass';          // windscreen
      if (isTop && zMid <= 0.2 && zMid > -1.25) mat = 'dark';         // black glass roof + rear glass
      if (isSideUpper && zMid < 0.85 && zMid > -0.5) mat = 'glass';   // side windows
      if (k === 5) mat = 'dark';                                       // underbody
      const v = [a[k], a[k2], b[k2], b[k]];
      faces.push(face(v, mat, core(centroid(v))));
    }
  }
  const nose = rings[0], tail = rings[rings.length - 1];
  faces.push(face(nose, 'body', { x: 0, y: 0, z: 1 }));
  faces.push(face(tail, 'tail', { x: 0, y: 0, z: -1 }));
  const tl = STATIONS[STATIONS.length - 1];
  const zt = tl.z - 0.01;
  faces.push(face([
    { x: tl.hwBelt * 0.92, y: tl.yBelt - 0.02, z: zt }, { x: -tl.hwBelt * 0.92, y: tl.yBelt - 0.02, z: zt },
    { x: -tl.hwBelt * 0.92, y: tl.yBelt - 0.07, z: zt }, { x: tl.hwBelt * 0.92, y: tl.yBelt - 0.07, z: zt },
  ], 'light', { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -0.02 }));
  return faces;
}

function buildWheel(c: Vec3, r: number, w: number, outward: number): Face[] {
  const n = 16;
  const outer: Vec3[] = [], inner: Vec3[] = [], hub: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const y = Math.sin(a) * r, z = Math.cos(a) * r;
    outer.push({ x: c.x + outward * w * 0.5, y: c.y + y, z: c.z + z });
    inner.push({ x: c.x - outward * w * 0.5, y: c.y + y, z: c.z + z });
    hub.push({ x: c.x + outward * (w * 0.5 + 0.01), y: c.y + y * 0.6, z: c.z + z * 0.6 });
  }
  // wheels sort as if they sat further out, so the near-side wheels paint over the body side
  const shift = { x: outward * 0.45, y: 0, z: 0 };
  const faces: Face[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const v = [outer[i], inner[i], inner[j], outer[j]];
    const m = centroid(v);
    faces.push(face(v, 'tyre', { x: 0, y: m.y - c.y, z: m.z - c.z }, shift));
  }
  faces.push(face(outer, 'tyre', { x: outward, y: 0, z: 0 }, shift));
  faces.push(face(hub, 'rim', { x: outward, y: 0, z: 0 }, { x: outward * 0.47, y: 0, z: 0 }));
  return faces;
}

export const CAR_FACES: Face[] = (() => {
  const f = buildBody();
  for (const w of ROADSTER.wheels) {
    const out = w.pos.x > 0 ? 1 : -1;
    f.push(...buildWheel({ x: w.pos.x + out * 0.06, y: w.pos.y, z: w.pos.z }, w.radius, w.width * 0.8, out));
  }
  return f;
})();

// ------------------------------------------------------------------ yaw removal for the attitude sphere
/**
 * Tracks the vehicle heading continuously so the sphere shows pitch/roll only. When the forward axis
 * is near vertical (wall ramp) the previous heading is held, and through inversion the heading branch
 * nearest to the previous one is kept, so a 170° pitch stays "nose back" and a kickflip stays "nose forward".
 */
export class HeadingTracker {
  heading = 0;
  private init = false;
  update(q: Quat): number {
    const f = qrot(q, { x: 0, y: 0, z: 1 });
    const h = Math.hypot(f.x, f.z);
    if (h > 0.25) {
      const cand = Math.atan2(f.x, f.z);
      if (!this.init) { this.heading = cand; this.init = true; }
      else {
        const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
        const d0 = wrap(cand - this.heading), d1 = wrap(cand + Math.PI - this.heading);
        this.heading = wrap(this.heading + (Math.abs(d0) <= Math.abs(d1) ? d0 : d1));
      }
    }
    return this.heading;
  }
  reset(): void { this.init = false; this.heading = 0; }
}

/** q' = yaw(-heading) * q */
export function removeYaw(q: Quat, heading: number): Quat {
  const s = Math.sin(-heading / 2), c = Math.cos(-heading / 2);
  // (0, s, 0, c) * q
  return {
    x: c * q.x + s * q.z,
    y: c * q.y + s * q.w,
    z: c * q.z - s * q.x,
    w: c * q.w - s * q.y,
  };
}

// ------------------------------------------------------------------ projection & painting
export interface Camera { right: Vec3; up: Vec3; fwd: Vec3 }

export function makeCamera(from: Vec3): Camera {
  const l = Math.hypot(from.x, from.y, from.z);
  const fwd = { x: -from.x / l, y: -from.y / l, z: -from.z / l };
  // right = fwd x worldUp
  let right = { x: -fwd.z, y: 0, z: fwd.x };
  const rl = Math.hypot(right.x, right.z) || 1;
  right = { x: right.x / rl, y: 0, z: right.z / rl };
  // up = right x fwd
  const up = { x: right.y * fwd.z - right.z * fwd.y, y: right.z * fwd.x - right.x * fwd.z, z: right.x * fwd.y - right.y * fwd.x };
  return { right, up, fwd };
}

/** Camera for the sphere: in front-left of the car, above it (matches the stream's 3/4 view, nose to the left). */
export const SPHERE_CAMERA = makeCamera({ x: 1, y: 0.62, z: 0.42 });

const LIGHT = (() => { const l = { x: 0.45, y: 0.85, z: 0.35 }; const n = Math.hypot(l.x, l.y, l.z); return { x: l.x / n, y: l.y / n, z: l.z / n }; })();

interface Proj { pts: number[]; depth: number; shade: number; mat: Mat }
const projPool: Proj[] = [];

/**
 * Paint `faces` rotated by q into ctx, centred at (cx, cy), `scale` px per metre.
 * Returns nothing; uses an internal pool so there is no per-frame garbage beyond tiny vectors.
 */
export function paintMesh(ctx: CanvasRenderingContext2D, faces: Face[], q: Quat, cam: Camera, cx: number, cy: number, scale: number, alpha = 1, offset: Vec3 = { x: 0, y: 0, z: 0 }): void {
  let n = 0;
  const tmp: Vec3 = { x: 0, y: 0, z: 0 };
  for (const f of faces) {
    const nw = qrot(q, f.n, tmp);
    const nx = nw.x, ny = nw.y, nz = nw.z;
    const facing = -(nx * cam.fwd.x + ny * cam.fwd.y + nz * cam.fwd.z);
    if (facing <= 0.0) continue; // back face
    const p = projPool[n] ?? (projPool[n] = { pts: [], depth: 0, shade: 0, mat: 'body' });
    p.pts.length = 0;
    for (const v of f.v) {
      qrot(q, v, tmp);
      tmp.x += offset.x; tmp.y += offset.y; tmp.z += offset.z;
      const sx = tmp.x * cam.right.x + tmp.y * cam.right.y + tmp.z * cam.right.z;
      const sy = tmp.x * cam.up.x + tmp.y * cam.up.y + tmp.z * cam.up.z;
      p.pts.push(cx + sx * scale, cy - sy * scale);
    }
    qrot(q, f.sort, tmp);
    p.depth = tmp.x * cam.fwd.x + tmp.y * cam.fwd.y + tmp.z * cam.fwd.z;
    p.shade = Math.max(0, nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z) * 0.75 + 0.25 * facing;
    p.mat = f.mat;
    n++;
  }
  const list = projPool.slice(0, n).sort((a, b) => b.depth - a.depth);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(0.6, scale * 0.012);
  for (const p of list) {
    ctx.beginPath();
    ctx.moveTo(p.pts[0], p.pts[1]);
    for (let i = 2; i < p.pts.length; i += 2) ctx.lineTo(p.pts[i], p.pts[i + 1]);
    ctx.closePath();
    const col = matColor(p.mat, p.shade);
    ctx.fillStyle = col;
    ctx.fill();
    // seams in the fill colour (no AA cracks); body panels get a faint darker line like the stream art
    ctx.strokeStyle = p.mat === 'body' ? matColor('body', p.shade * 0.8 - 0.08) : col;
    ctx.stroke();
  }
  ctx.restore();
}

function grey(v: number): string { const c = Math.round(Math.max(0, Math.min(255, v))); return `rgb(${c},${c},${c})`; }

function matColor(m: Mat, s: number): string {
  switch (m) {
    case 'body': return grey(105 + 150 * s);
    case 'glass': return grey(18 + 40 * s);
    case 'dark': return grey(10 + 22 * s);
    case 'tyre': return grey(6 + 18 * s);
    case 'rim': return grey(60 + 90 * s);
    case 'light': return '#ff3a3a';
    case 'tail': return grey(40 + 60 * s);
  }
}
