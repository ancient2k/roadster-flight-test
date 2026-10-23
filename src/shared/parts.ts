// Track pieces of the level editor (docs/EDITOR.md). Each piece lives on whole tiles of the build area and is
// generated from a centre line (frames) swept with a cross-section: closed, outward-wound solids that are both the
// physics collider (static trimesh, FIX_INTERNAL_EDGES) and the rendered mesh. Ground-level road is paint only (the
// graded field is already drivable); everything that leaves the ground is a solid. Pure TypeScript, no three.js.
//
// Piece frame (before rotation): footprint w × d tiles, x ∈ [0, w·T] across, z ∈ [0, d·T] along, y up from the field
// (y = 0). Roads enter at the south edge (z = 0) in the middle of tile 0 and run towards +z.

export const TILE_M = 20;
export const ROAD_W = 10;            // asphalt width of the ground road
export const ELEVATED_Y = 6;         // deck height of the elevated road (top surface)
export const DECK_T = 0.6;           // deck thickness

export type PartType =
  | 'road' | 'curve' | 'curve_wide' | 'start' | 'ramp_up' | 'elevated' | 'elevated_curve' | 'kicker' | 'landing'
  | 'loop' | 'banked' | 'halfpipe' | 'wallramp' | 'ring' | 'air_station' | 'boost' | 'launch';
export type DecoType = 'cone' | 'barrel' | 'crate' | 'container' | 'light_mast' | 'barrier';

export type Side = 'S' | 'E' | 'N' | 'W';
/** Road end on a footprint edge: tile index along that edge, level (0 ground, 1 elevated). */
export interface Connector { side: Side; at: number; lv: 0 | 1 }

export type MatKey = 'asphalt' | 'concrete' | 'paint' | 'curb' | 'steel' | 'red' | 'glow' | 'pad';

export interface PartDef {
  type: PartType;
  w: number; d: number;
  /** Can be placed on level 1 (on top of the elevated network). */
  elevated?: boolean;
  /** Road ends in the piece frame (rotated with the piece). Empty = stunt or logic piece without a through road. */
  conn: Connector[];
  /** Palette group in the editor. */
  group: 'road' | 'stunt' | 'special';
  /** Numeric option (e.g. countdown of the launch clearance). */
  opt?: { min: number; max: number; def: number; step: number };
}

const C = (side: Side, at = 0, lv: 0 | 1 = 0): Connector => ({ side, at, lv });

export const PARTS: PartDef[] = [
  { type: 'road', w: 1, d: 1, conn: [C('S'), C('N')], group: 'road' },
  { type: 'curve', w: 1, d: 1, conn: [C('S'), C('E')], group: 'road' },
  { type: 'curve_wide', w: 2, d: 2, conn: [C('S'), C('E', 1)], group: 'road' },
  { type: 'start', w: 1, d: 1, conn: [C('S'), C('N')], group: 'road' },
  { type: 'ramp_up', w: 1, d: 2, conn: [C('S'), C('N', 0, 1)], group: 'road' },
  { type: 'elevated', w: 1, d: 1, elevated: true, conn: [C('S', 0, 1), C('N', 0, 1)], group: 'road' },
  { type: 'elevated_curve', w: 1, d: 1, elevated: true, conn: [C('S', 0, 1), C('E', 0, 1)], group: 'road' },
  { type: 'banked', w: 2, d: 2, conn: [C('S'), C('E', 1)], group: 'road' },
  { type: 'kicker', w: 1, d: 1, conn: [C('S')], group: 'stunt' },
  { type: 'landing', w: 1, d: 2, conn: [C('N')], group: 'stunt' },
  { type: 'loop', w: 1, d: 2, conn: [C('S'), C('N')], group: 'stunt' },
  { type: 'halfpipe', w: 1, d: 2, conn: [C('S'), C('N')], group: 'stunt' },
  { type: 'wallramp', w: 1, d: 2, conn: [C('S')], group: 'stunt' },
  { type: 'ring', w: 1, d: 1, conn: [], group: 'stunt' },
  { type: 'air_station', w: 1, d: 1, conn: [C('S'), C('N')], group: 'special' },
  { type: 'boost', w: 1, d: 1, conn: [C('S'), C('N')], group: 'special' },
  { type: 'launch', w: 1, d: 1, conn: [C('S'), C('N')], group: 'special', opt: { min: 30, max: 180, def: 60, step: 10 } },
];
export const PART_TYPES = PARTS.map((p) => p.type);
export const DECO_TYPES: DecoType[] = ['cone', 'barrel', 'crate', 'container', 'light_mast', 'barrier'];

export function partDef(t: PartType): PartDef {
  const d = PARTS.find((p) => p.type === t);
  if (!d) throw new Error(`unknown piece ${t}`);
  return d;
}

// ---------------------------------------------------------------- small vector helpers
type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const sstep = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/** A point of a swept centre line: position, tangent (direction of travel) and up (road surface normal). */
export interface Frame { p: V; t: V; n: V }

/** Frames from a parametric centre line p(s), s ∈ [0, 1]; up from upFn (default: derived by bending, see below). */
function frames(pos: (s: number) => V, steps: number, upFn?: (s: number, t: V) => V): Frame[] {
  const out: Frame[] = [];
  for (let k = 0; k <= steps; k++) {
    const s = k / steps, e = 1e-4;
    const t = norm(sub(pos(Math.min(1, s + e)), pos(Math.max(0, s - e))));
    let n: V = upFn ? upFn(s, t) : [0, 1, 0];
    n = norm(sub(n, mul(t, dot(n, t))));          // orthogonal to the tangent
    out.push({ p: pos(s), t, n });
  }
  return out;
}

// ---------------------------------------------------------------- geometry output
export interface PartMesh {
  /** Closed, outward-wound triangle soups (x,y,z × 3 per triangle) in piece coordinates: physics + render. */
  solids: { mat: MatKey; tris: Float32Array }[];
  /** Render-only triangles (paint on the ground, glow strips, arrows). */
  decals: { mat: MatKey; tris: Float32Array }[];
}

class Builder {
  solids = new Map<MatKey, number[]>();
  solidList: { mat: MatKey; tris: number[] }[] = [];
  decals = new Map<MatKey, number[]>();
  /** One closed solid (kept separate so each is its own collider). */
  solid(mat: MatKey): number[] { const tris: number[] = []; this.solidList.push({ mat, tris }); return tris; }
  decal(mat: MatKey): number[] { let a = this.decals.get(mat); if (!a) this.decals.set(mat, a = []); return a; }
  done(): PartMesh {
    return {
      solids: this.solidList.filter((s) => s.tris.length).map((s) => ({ mat: s.mat, tris: new Float32Array(s.tris) })),
      decals: [...this.decals].map(([mat, t]) => ({ mat, tris: new Float32Array(t) })),
    };
  }
}

/** Push a triangle, flipped if needed so that its normal points along `out`. */
function tri(dst: number[], a: V, b: V, c: V, out?: V): void {
  if (out && dot(cross(sub(b, a), sub(c, a)), out) < 0) { const t = b; b = c; c = t; }
  dst.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

/** Ear clipping of a simple polygon (2D, either winding); returns index triples. */
export function triangulate(poly: [number, number][]): [number, number, number][] {
  const n = poly.length;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  const idx = [...Array(n).keys()];
  if (area < 0) idx.reverse();
  const out: [number, number, number][] = [];
  const crossZ = (a: [number, number], b: [number, number], c: [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p: [number, number], a: [number, number], b: [number, number], c: [number, number]) =>
    crossZ(a, b, p) >= -1e-12 && crossZ(b, c, p) >= -1e-12 && crossZ(c, a, p) >= -1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length], ib = idx[k], ic = idx[(k + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (crossZ(a, b, c) <= 1e-12) continue;                       // reflex
      if (idx.some((m) => m !== ia && m !== ib && m !== ic && inside(poly[m], a, b, c))) continue;
      out.push([ia, ib, ic]); idx.splice(k, 1); cut = true; break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/**
 * Sweep a cross-section along frames into a closed solid. section: polygon in (lateral, up) metres, lateral axis =
 * up × tangent. Caps at both ends unless the path is closed (first frame ≈ last frame).
 */
export function sweep(dst: number[], fr: Frame[], section: [number, number][]): void {
  const m = section.length;
  const at = (f: Frame, q: [number, number]): V => { const l = cross(f.n, f.t); return add(add(f.p, mul(l, q[0])), mul(f.n, q[1])); };
  // outward normal of each section edge from the polygon's winding (works for concave sections too)
  let area2 = 0;
  for (let i = 0, j = m - 1; i < m; j = i++) area2 += section[j][0] * section[i][1] - section[i][0] * section[j][1];
  const sg = area2 > 0 ? 1 : -1;
  const rings = fr.map((f) => section.map((q) => at(f, q)));
  for (let k = 0; k + 1 < fr.length; k++) {
    const f = fr[k], l = cross(f.n, f.t);
    for (let e = 0; e < m; e++) {
      const e2 = (e + 1) % m;
      const a = rings[k][e], b = rings[k][e2], c = rings[k + 1][e2], d = rings[k + 1][e];
      const dx = section[e2][0] - section[e][0], dy = section[e2][1] - section[e][1];
      const out = add(mul(l, sg * dy), mul(f.n, -sg * dx));
      tri(dst, a, b, c, out); tri(dst, a, c, d, out);
    }
  }
  const closed = Math.hypot(...sub(fr[0].p, fr[fr.length - 1].p)) < 1e-3;
  if (!closed) {
    const capTris = triangulate(section);
    for (const [end, f, sgn] of [[0, fr[0], -1], [fr.length - 1, fr[fr.length - 1], 1]] as const) {
      const r = rings[end];
      for (const [i0, i1, i2] of capTris) tri(dst, r[i0], r[i1], r[i2], mul(f.t, sgn));
    }
  }
}

/** Axis-aligned box (closed). */
function box(dst: number[], min: V, max: V): void {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const c: V = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const v = (x: number, y: number, z: number): V => [x, y, z];
  const quad = (a: V, b: V, cc: V, d: V) => { const o = sub(mul(add(add(a, b), add(cc, d)), 0.25), c); tri(dst, a, b, cc, o); tri(dst, a, cc, d, o); };
  quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1));
  quad(v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1));
  quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0));
  quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1));
  quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0));
  quad(v(x1, y0, z0), v(x1, y0, z1), v(x1, y1, z1), v(x1, y1, z0));
}

/** Flat paint strip on the ground along frames (render only), lifted 2 cm. */
function paint(dst: number[], fr: Frame[], l0: number, l1: number, y = 0.02): void {
  for (let k = 0; k + 1 < fr.length; k++) {
    const P = (f: Frame, q: number): V => { const l = cross(f.n, f.t); return add(add(f.p, mul(l, q)), mul(f.n, y)); };
    const a = P(fr[k], l0), b = P(fr[k], l1), c = P(fr[k + 1], l1), d = P(fr[k + 1], l0);
    tri(dst, a, b, c, fr[k].n); tri(dst, a, c, d, fr[k].n);
  }
}

/** Ground road: asphalt, edge lines, dashed centre line (render only; the field below is solid). */
function groundRoad(B: Builder, fr: Frame[], w = ROAD_W): void {
  paint(B.decal('asphalt'), fr, -w / 2, w / 2, 0.015);
  paint(B.decal('paint'), fr, -w / 2 + 0.3, -w / 2 + 0.5, 0.03);
  paint(B.decal('paint'), fr, w / 2 - 0.5, w / 2 - 0.3, 0.03);
  let s = 0;
  for (let k = 0; k + 1 < fr.length; k++) {
    s += Math.hypot(...sub(fr[k + 1].p, fr[k].p));
    if (Math.floor(s / 3) % 2 === 0) paint(B.decal('paint'), [fr[k], fr[k + 1]], -0.12, 0.12, 0.03);
  }
}

/** Deck section: road on top, thickness below, low curbs at the edges (closed, convex parts separately). */
const deck = (w: number, t = DECK_T): [number, number][] => [[-w / 2, -t], [w / 2, -t], [w / 2, 0], [-w / 2, 0]];
const curbL = (w: number): [number, number][] => [[-w / 2 - 0.4, -0.2], [-w / 2, -0.2], [-w / 2, 0.45], [-w / 2 - 0.4, 0.45]];
const curbR = (w: number): [number, number][] => [[w / 2, -0.2], [w / 2 + 0.4, -0.2], [w / 2 + 0.4, 0.45], [w / 2, 0.45]];

/** Deck height from which curbs line a road: below it they would be a 45 cm wall to whoever drives on from the
 *  side (R17 finding: "you get stuck on track pieces when driving from the ground onto the track"). */
export const CURB_MIN_Y = 0.5;
/** The frames whose height(f) is at least CURB_MIN_Y (first to last such frame); default height: the road centre. */
function raised(fr: Frame[], height = (f: Frame) => f.p[1]): Frame[] {
  const a = fr.findIndex((f) => height(f) >= CURB_MIN_Y);
  if (a < 0) return [];
  let b = fr.length - 1;
  while (height(fr[b]) < CURB_MIN_Y) b--;
  return fr.slice(a, b + 1);
}
/** Curbs on both edges of the raised part of a road. */
function curbs(B: Builder, mat: MatKey, fr: Frame[], w: number): void {
  const r = raised(fr);
  if (r.length < 2) return;
  sweep(B.solid(mat), r, curbL(w));
  sweep(B.solid(mat), r, curbR(w));
}

/** Deck with curbs and pillars every ~10 m down to the ground. */
function elevatedDeck(B: Builder, fr: Frame[], w = ROAD_W, pillars = true): void {
  sweep(B.solid('concrete'), fr, deck(w));
  curbs(B, 'curb', fr, w);
  if (!pillars) return;
  let s = 5, acc = 0;
  for (let k = 0; k + 1 < fr.length; k++) {
    acc += Math.hypot(...sub(fr[k + 1].p, fr[k].p));
    if (acc >= s && fr[k].p[1] > 2) {
      s += 10;
      const p = fr[k].p, h = p[1] - DECK_T;
      box(B.solid('concrete'), [p[0] - 0.6, -0.5, p[2] - 0.6], [p[0] + 0.6, h, p[2] + 0.6]);
    }
  }
}

const T = TILE_M, H = T / 2;
const line = (x0: number, z0: number, x1: number, z1: number, y = 0) => (s: number): V => [x0 + (x1 - x0) * s, y, z0 + (z1 - z0) * s];
/** Quarter arc from (H, 0) heading +z to (cx, r) heading +x, centre (H + r, 0). */
const arc = (r: number, y = 0, x0 = H) => (s: number): V => { const a = s * Math.PI / 2; return [x0 + r - r * Math.cos(a), y, r * Math.sin(a)]; };

// ---------------------------------------------------------------- pieces
const BUILD: Record<PartType, (B: Builder, opt?: number) => void> = {
  road(B) { groundRoad(B, frames(line(H, 0, H, T), 4)); },
  curve(B) { groundRoad(B, frames(arc(H), 16)); },
  curve_wide(B) { groundRoad(B, frames(arc(T + H), 32)); },
  start(B) {
    const fr = frames(line(H, 0, H, T), 4);
    groundRoad(B, fr);
    // chequered start/finish line across the road at z = H
    for (let a = 0; a < 10; a++) for (let b = 0; b < 2; b++) if ((a + b) % 2 === 0) {
      const x0 = H - ROAD_W / 2 + a * (ROAD_W / 10), z0 = H - 0.6 + b * 0.6;
      const d = B.decal('paint');
      tri(d, [x0, 0.04, z0], [x0 + ROAD_W / 10, 0.04, z0], [x0 + ROAD_W / 10, 0.04, z0 + 0.6], [0, 1, 0]);
      tri(d, [x0, 0.04, z0], [x0 + ROAD_W / 10, 0.04, z0 + 0.6], [x0, 0.04, z0 + 0.6], [0, 1, 0]);
    }
    // gantry: two legs outside the road, a beam at 7 m, a light strip under it
    box(B.solid('steel'), [H - ROAD_W / 2 - 1.4, 0, H - 0.4], [H - ROAD_W / 2 - 0.6, 7.6, H + 0.4]);
    box(B.solid('steel'), [H + ROAD_W / 2 + 0.6, 0, H - 0.4], [H + ROAD_W / 2 + 1.4, 7.6, H + 0.4]);
    box(B.solid('red'), [H - ROAD_W / 2 - 1.4, 7.6, H - 0.5], [H + ROAD_W / 2 + 1.4, 8.8, H + 0.5]);
    paintBox(B.decal('glow'), [H - ROAD_W / 2, 7.55, H - 0.3], [H + ROAD_W / 2, 7.6, H + 0.3]);
  },
  ramp_up(B) {
    // ground -> elevated deck over 2 tiles (smooth start and end, max slope ≈ 13°)
    const fr = frames((s) => [H, ELEVATED_Y * sstep(s), 2 * T * s], 40, (s, t) => norm(cross(t, cross([0, 1, 0], t))));
    elevatedDeck(B, fr, ROAD_W, true);
  },
  elevated(B) { elevatedDeck(B, frames(line(H, 0, H, T, ELEVATED_Y), 4)); },
  elevated_curve(B) { elevatedDeck(B, frames(arc(H, ELEVATED_Y), 16)); },
  banked(B) {
    // wide curve banked up to 28°, inner edge on the ground; banking eases in and out over the first/last 20 %
    const R = T + H, bank = 28 * Math.PI / 180, w = ROAD_W;
    const k = (s: number) => sstep(s / 0.2) * sstep((1 - s) / 0.2);
    const pos = (s: number): V => { const a = s * Math.PI / 2, b = bank * k(s); return [H + R - R * Math.cos(a), Math.sin(b) * w / 2, R * Math.sin(a)]; };
    const fr = frames(pos, 48, (s, t) => {
      const a = s * Math.PI / 2, inward: V = [Math.cos(a), 0, -Math.sin(a)], b = bank * k(s);
      return norm(add(mul([0, 1, 0], Math.cos(b)), mul(inward, Math.sin(b))));
    });
    sweep(B.solid('concrete'), fr, [[-w / 2, -1.5], [w / 2, -1.5], [w / 2, 0], [-w / 2, 0]]);
    // outer edge only where it is raised (its height is twice the centre's: the inner edge stays on the ground)
    const outer = raised(fr, (f) => 2 * f.p[1]);
    if (outer.length > 1) sweep(B.solid('curb'), outer, curbL(w));
  },
  kicker(B) {
    // jump ramp: y = 3 (z/T)² -> lip 3 m high at ≈ 17°, open towards +z
    const fr = frames((s) => [H, 3 * s * s, T * s], 24, (s, t) => norm(cross(t, cross([0, 1, 0], t))));
    sweep(B.solid('concrete'), fr, [[-ROAD_W / 2, -4], [ROAD_W / 2, -4], [ROAD_W / 2, 0], [-ROAD_W / 2, 0]]);
    curbs(B, 'red', fr, ROAD_W);
  },
  landing(B) {
    // long landing slope from 4 m down to the ground towards +z (land on it coming from -z)
    const fr = frames((s) => [H, 4 * (1 - sstep(s)), 2 * T * s], 40, (s, t) => norm(cross(t, cross([0, 1, 0], t))));
    sweep(B.solid('concrete'), fr, [[-ROAD_W / 2 - 1, -5], [ROAD_W / 2 + 1, -5], [ROAD_W / 2 + 1, 0], [-ROAD_W / 2 - 1, 0]]);
  },
  loop(B) {
    // vertical loop, radius 8 m, centred at z = T; the lane shifts 7 m sideways so that entry and exit pass
    const R = 8, w = 6.5, zc = T, xa = H - 3.5, xb = H + 3.5;
    groundRoad(B, frames((s) => [H + (xa - H) * sstep(s), 0, (zc - 1.5) * s], 12), w + 1);
    groundRoad(B, frames((s) => [xb + (H - xb) * sstep(s), 0, zc + 1.5 + (2 * T - zc - 1.5) * s], 12), w + 1);
    const pos = (s: number): V => { const a = s * Math.PI * 2; return [xa + (xb - xa) * sstep(s * 1.1 - 0.05), R - R * Math.cos(a), zc - 1.5 + 3 * s + R * Math.sin(a)]; };
    const fr = frames(pos, 96, (s) => { const a = s * Math.PI * 2; return [0, Math.cos(a), -Math.sin(a)]; });
    sweep(B.solid('concrete'), fr, deck(w, 0.5));
    curbs(B, 'curb', fr, w);
    // A-frame supports at the top of the loop
    box(B.solid('steel'), [xa - 6, 0, zc - 0.4], [xa - 5.2, 2 * R, zc + 0.4]);
    box(B.solid('steel'), [xb + 5.2, 0, zc - 0.4], [xb + 6, 2 * R, zc + 0.4]);
    box(B.solid('steel'), [xa - 6, 2 * R, zc - 0.4], [xb + 6, 2 * R + 0.8, zc + 0.4]);
  },
  halfpipe(B) {
    // road between two curved walls (radius 6 m, vertical to 7.5 m): ride up the sides with the fans on
    const L = 2 * T, r = 6, top = 7.5, w = 7;
    groundRoad(B, frames(line(H, 0, H, L), 8), w);
    for (const side of [-1, 1]) {
      const sec: [number, number][] = [];
      const x0 = side * w / 2;
      for (let k = 0; k <= 12; k++) { const a = k / 12 * Math.PI / 2; sec.push([x0 + side * r * Math.sin(a), r - r * Math.cos(a)]); }
      sec.push([x0 + side * r, top]);
      sec.push([x0 + side * (r + 0.8), top]);
      sec.push([x0 + side * (r + 0.8), -0.3]);
      sec.push([x0, -0.3]);
      sweep(B.solid('concrete'), frames(line(H, 0, H, L), 2), side < 0 ? sec.map(([a, b]) => [a, b] as [number, number]).reverse() : sec);
    }
  },
  wallramp(B) {
    // the stream's wall ramp (R15 fit): one arc of R 10.9 m to 170°, then a 10 m straight overhang; dead end
    const R = 10.9, aEnd = 170 * Math.PI / 180, Ls = 10, w = 6;
    const run = 8, arcLen = R * aEnd, total = run + arcLen + Ls;  // 8 m run-up keeps the overhang inside the footprint
    const pos = (s: number): V => {
      const d = s * total;
      if (d < run) return [H, 0, d];
      if (d < run + arcLen) { const a = (d - run) / R; return [H, R - R * Math.cos(a), run + R * Math.sin(a)]; }
      const a = aEnd, e = d - run - arcLen;
      return [H, R - R * Math.cos(a) + Math.sin(a) * e, run + R * Math.sin(a) + Math.cos(a) * e];
    };
    const fr = frames(pos, 90, (s) => {
      const d = s * total;
      const a = d < run ? 0 : Math.min(aEnd, (d - run) / R);
      return [0, Math.cos(a), -Math.sin(a)];
    });
    sweep(B.solid('concrete'), fr, deck(w, 0.6));
    curbs(B, 'red', fr, w);
    // back truss: vertical frame behind the ramp
    box(B.solid('steel'), [H - w / 2 - 0.8, 0, run + R + 0.8], [H - w / 2, 2 * R + 2, run + R + 1.6]);
    box(B.solid('steel'), [H + w / 2, 0, run + R + 0.8], [H + w / 2 + 0.8, 2 * R + 2, run + R + 1.6]);
  },
  ring(B) {
    // ring to fly through: centre 14 m up, inner radius 6 m, facing ±z
    const Rr = 6.6, cy = 14, n = 48;
    const fr = frames((s) => { const a = s * Math.PI * 2; return [H + Rr * Math.cos(a), cy + Rr * Math.sin(a), H]; }, n, () => [0, 0, 1]);
    fr[n].p = fr[0].p;
    const tube: [number, number][] = [];
    for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; tube.push([0.55 * Math.cos(a), 0.55 * Math.sin(a)]); }
    sweep(B.solid('red'), fr, tube);
    // two masts
    box(B.solid('steel'), [H - Rr - 0.3, 0, H - 0.3], [H - Rr + 0.3, cy, H + 0.3]);
    box(B.solid('steel'), [H + Rr - 0.3, 0, H - 0.3], [H + Rr + 0.3, cy, H + 0.3]);
  },
  air_station(B) {
    groundRoad(B, frames(line(H, 0, H, T), 4));
    paintBox(B.decal('pad'), [H - 4, 0.035, H - 4], [H + 4, 0.04, H + 4]);
    // two compressor towers with hoses, outside the road
    box(B.solid('steel'), [H - ROAD_W / 2 - 2.4, 0, H - 1.2], [H - ROAD_W / 2 - 0.8, 3.2, H + 1.2]);
    box(B.solid('steel'), [H + ROAD_W / 2 + 0.8, 0, H - 1.2], [H + ROAD_W / 2 + 2.4, 3.2, H + 1.2]);
    paintBox(B.decal('glow'), [H - ROAD_W / 2 - 2.45, 2.6, H - 1.25], [H - ROAD_W / 2 - 0.75, 2.9, H + 1.25]);
    paintBox(B.decal('glow'), [H + ROAD_W / 2 + 0.75, 2.6, H - 1.25], [H + ROAD_W / 2 + 2.45, 2.9, H + 1.25]);
  },
  boost(B) {
    groundRoad(B, frames(line(H, 0, H, T), 4));
    for (let k = 0; k < 3; k++) {   // three chevrons pointing along +z
      const z = 5 + k * 4, d = B.decal('glow');
      tri(d, [H - 3, 0.04, z], [H, 0.04, z + 2.2], [H, 0.04, z + 1.2], [0, 1, 0]);
      tri(d, [H - 3, 0.04, z], [H - 3, 0.04, z - 1], [H, 0.04, z + 1.2], [0, 1, 0]);
      tri(d, [H + 3, 0.04, z], [H, 0.04, z + 1.2], [H, 0.04, z + 2.2], [0, 1, 0]);
      tri(d, [H + 3, 0.04, z], [H, 0.04, z + 1.2], [H + 3, 0.04, z - 1], [0, 1, 0]);
    }
  },
  launch(B) {
    groundRoad(B, frames(line(H, 0, H, T), 4));
    // launch clearance: a console with a big red button beside the road and a warning beacon mast
    box(B.solid('steel'), [H + ROAD_W / 2 + 0.8, 0, H - 1], [H + ROAD_W / 2 + 2.6, 1.1, H + 1]);
    box(B.solid('red'), [H + ROAD_W / 2 + 1.3, 1.1, H - 0.5], [H + ROAD_W / 2 + 2.1, 1.35, H + 0.5]);
    box(B.solid('steel'), [H - ROAD_W / 2 - 1.2, 0, H - 0.2], [H - ROAD_W / 2 - 0.8, 6, H + 0.2]);
    paintBox(B.decal('glow'), [H - ROAD_W / 2 - 1.3, 6, H - 0.3], [H - ROAD_W / 2 - 0.7, 6.6, H + 0.3]);
    paintBox(B.decal('pad'), [H - ROAD_W / 2, 0.035, H - 1.5], [H + ROAD_W / 2, 0.04, H + 1.5]);
  },
};

/** Closed, outward-wound box as a triangle soup (decoration colliders). */
export function boxTris(min: [number, number, number], max: [number, number, number]): Float32Array {
  const t: number[] = [];
  box(t, min, max);
  return new Float32Array(t);
}

/** Closed box as render-only triangles (glow strips, pads). */
function paintBox(dst: number[], min: V, max: V): void { box(dst, min, max); }

/** Geometry of a piece in its own frame (see top). */
export function buildPart(t: PartType, opt?: number): PartMesh {
  const B = new Builder();
  BUILD[t](B, opt);
  return B.done();
}

// ---------------------------------------------------------------- placement

/** Piece frame -> build-area frame for a footprint w × d at tile (i, j), rotated by rot quarter turns (ccw from above). */
export function placeTransform(def: Pick<PartDef, 'w' | 'd'>, i: number, j: number, rot: number, tileM = TILE_M): (x: number, z: number) => [number, number] {
  const W = def.w * tileM, D = def.d * tileM;
  const fw = rot % 2 === 0 ? W : D, fd = rot % 2 === 0 ? D : W;     // rotated footprint size
  return (x, z) => {
    // rotate about the footprint centre
    const u = x - W / 2, v = z - D / 2;
    let a = u, b = v;
    if (rot === 1) { a = v; b = -u; } else if (rot === 2) { a = -u; b = -v; } else if (rot === 3) { a = -v; b = u; }
    return [i * tileM + fw / 2 + a, j * tileM + fd / 2 + b];
  };
}

/** Transform a triangle soup from piece frame to the build area (y + base). */
export function placeTris(src: Float32Array, def: Pick<PartDef, 'w' | 'd'>, i: number, j: number, rot: number, baseY: number, tileM = TILE_M): Float32Array {
  const f = placeTransform(def, i, j, rot, tileM);
  const out = new Float32Array(src.length);
  for (let k = 0; k < src.length; k += 3) {
    const [x, z] = f(src[k], src[k + 2]);
    out[k] = x; out[k + 1] = src[k + 1] + baseY; out[k + 2] = z;
  }
  return out;
}

/** Directions in build-area tile coordinates: 0 = −z, 1 = +x, 2 = +z, 3 = −x. */
export const DIRS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const SIDE_VEC: Record<Side, [number, number]> = { S: [0, -1], E: [1, 0], N: [0, 1], W: [-1, 0] };

/** Connectors of a placed piece: the tile that owns the road end, the direction it leaves in (index into DIRS), level. */
export function placedConnectors(def: PartDef, i: number, j: number, rot: number, lv: 0 | 1 = 0): { ti: number; tj: number; dir: number; lv: 0 | 1 }[] {
  const out: { ti: number; tj: number; dir: number; lv: 0 | 1 }[] = [];
  const f = placeTransform(def, 0, 0, rot, 1);
  for (const c of def.conn) {
    let lx = 0, lz = 0;
    if (c.side === 'S') { lx = c.at; lz = 0; } else if (c.side === 'N') { lx = c.at; lz = def.d - 1; } else if (c.side === 'E') { lx = def.w - 1; lz = c.at; } else { lx = 0; lz = c.at; }
    const [cx, cz] = f(lx + 0.5, lz + 0.5);
    const [vx, vz] = SIDE_VEC[c.side];
    const [ex, ez] = f(lx + 0.5 + vx * 0.5, lz + 0.5 + vz * 0.5);
    const dx = Math.round((ex - cx) * 2), dz = Math.round((ez - cz) * 2);
    const dir = DIRS.findIndex(([a, b]) => a === dx && b === dz);
    out.push({ ti: i + Math.floor(cx), tj: j + Math.floor(cz), dir, lv: (c.lv + lv) > 0 ? 1 : 0 });
  }
  return out;
}
