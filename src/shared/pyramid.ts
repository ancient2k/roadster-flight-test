// Drivable pyramid geometry, shared by the physics (colliders) and the renderer (talus mesh).
//
// The rendered pyramids have a stepped core (0.6–0.8 m courses): wheels would catch on every step, so the
// physics uses the smooth convex frustum through the outer step edges instead. Two transitions are added so a
// car with a 16° approach angle and ~9 cm floor clearance can actually drive up:
//  - foot: a concave talus (sand/rubble fillet, radius TALUS_R) from the ground into the 52° face. Rendered as
//    a sand mesh; debris and drift sand at the foot are real at Giza (esp. Menkaure, the queens' pyramids).
//  - crest: the face-to-platform edge is rounded (radius up to CREST_R, per axis capped by the platform
//    half-width, so a narrow platform becomes a low dome). The floor sags L²/8R below the wheels on a convex
//    arc (L = 2.65 m wheelbase): 15 cm at R 6 m – more than the 10 cm ride height, which is less again under
//    full suction – so the car grounded on the crest, the front wheels lifted, the fan demand control backed
//    off (scraping) and a player who arrived at walking pace or stopped on the edge hung there at full
//    throttle. R 12 m: 7 cm. Game simplification: the collider edge lies up to R (sec(θ/2) - 1) ≈ 1.3 m
//    inside the sharp frustum edge of the (ruined, stepped) summit. Pointed tops stay pointed.
// Local frame: rotate world by -heading about the landmark centre; faces are ±x / ±z.

export interface PyramidFit {
  cx: number; cz: number; heading: number;
  /** lowest point (embedded below the ground) and summit height, world y */
  y0: number; yTop: number;
  /** half-widths at y0 and at the summit, local x / z */
  ax: number; az: number; bx: number; bz: number;
  /** face angle from horizontal (rad), mean of both axes */
  slope: number;
  /**
   * Face profile of a stepped model: half-widths per axis at heights y0 + i·dy, following the outer step edges course
   * by course (smoothed, never overhanging, never outside the face lines). Without it the faces are the straight
   * lines (synthetic frustums). The straight lines enclose every point, so one proud course – or the smooth casing
   * on Khafre's top, 1.6 m in front of the stepped core – held the car up to a metre above the steps below.
   */
  prof?: { dy: number; hx: Float32Array; hz: Float32Array };
}

export const TALUS_R = 14; // m: front lip (16° approach angle) clears the transition by ≥ 8 cm (tests/sim/vehicle/pyramid.test.ts)
export const CREST_R = 12; // m: breakover on the summit edge, see above (tests/sim/vehicle/pyramid_player.test.ts)

const rot = (x: number, z: number, c: number, s: number): [number, number] => [c * x - s * z, s * x + c * z];

/** Fits a square frustum to a point cloud (world xyz…) of a pyramid placed at (cx, cz) with heading (rad). */
export function fitPyramid(pts: ArrayLike<number>, cx: number, cz: number, heading: number): PyramidFit {
  const c = Math.cos(-heading), s = Math.sin(-heading);
  const n = Math.floor(pts.length / 3);
  const lx = new Float32Array(n), lz = new Float32Array(n);
  let y0 = Infinity, ax = 0, az = 0;
  for (let i = 0; i < n; i++) {
    [lx[i], lz[i]] = rot(pts[i * 3] - cx, pts[i * 3 + 2] - cz, c, s);
    y0 = Math.min(y0, pts[i * 3 + 1]);
    ax = Math.max(ax, Math.abs(lx[i])); az = Math.max(az, Math.abs(lz[i]));
  }
  // summit: ignore thin things on top (Khufu's survey mast) – the top is the highest point at least 1.5 m
  // (or 1.5 % of the base) off the vertical axis, i.e. the corner of the summit platform or the apex block
  const off = Math.max(1.5, 0.015 * Math.max(ax, az));
  let yTop = -Infinity;
  for (let i = 0; i < n; i++) if (Math.max(Math.abs(lx[i]), Math.abs(lz[i])) >= off) yTop = Math.max(yTop, pts[i * 3 + 1]);
  if (!Number.isFinite(yTop)) for (let i = 0; i < n; i++) yTop = Math.max(yTop, pts[i * 3 + 1]);
  // faces: least-squares line through the upper envelope (outermost point per height band, 5–95 % of the
  // height), shifted outward until it encloses every band. Robust against eroded top courses (which made
  // the queens' faces 4–6° too shallow) and single bulges near the base.
  const H = Math.max(1e-3, yTop - y0);
  const bands = 48, ex = new Float32Array(bands).fill(-1), ez = new Float32Array(bands).fill(-1);
  for (let i = 0; i < n; i++) {
    const t = (pts[i * 3 + 1] - y0) / H;
    if (t < 0 || t > 1) continue;
    const b = Math.min(bands - 1, Math.floor(t * bands));
    ex[b] = Math.max(ex[b], Math.abs(lx[i])); ez[b] = Math.max(ez[b], Math.abs(lz[i]));
  }
  const envelope = (e: Float32Array, a0: number, b0: number): [number, number] => {
    // slope k of r = c - k y over the bands 5..95 % (fallback: base and summit width)
    let sy = 0, sr = 0, syy = 0, syr = 0, m = 0;
    for (let b = Math.floor(0.05 * bands); b < Math.ceil(0.95 * bands); b++) {
      if (e[b] < 0) continue;
      const y = ((b + 0.5) / bands) * H;
      sy += y; sr += e[b]; syy += y * y; syr += y * e[b]; m++;
    }
    if (m < 3) return [(a0 - b0) / H, 1];
    const k = -(m * syr - sy * sr) / Math.max(1e-9, m * syy - sy * sy);
    return [k, 0];
  };
  // shift each face line outward until it encloses every point (exact, not just the band centres)
  const enclose = (k: number, coord: Float32Array): number => {
    let c = -Infinity;
    for (let i = 0; i < n; i++) {
      const y = pts[i * 3 + 1] - y0;
      if (y < 0 || y > H + 1e-3) continue;
      c = Math.max(c, Math.abs(coord[i]) + k * y);
    }
    return c;
  };
  // fallback (no points between base and summit, e.g. a bare 8-corner frustum): summit width
  let tx = 0, tz = 0;
  for (let i = 0; i < n; i++) {
    const y = pts[i * 3 + 1];
    if (y > yTop - 0.35 && y <= yTop + 1e-3) { tx = Math.max(tx, Math.abs(lx[i])); tz = Math.max(tz, Math.abs(lz[i])); }
  }
  const [kx0] = envelope(ex, ax, tx), [kz0] = envelope(ez, az, tz);
  ax = enclose(kx0, lx); az = enclose(kz0, lz);
  const bx = Math.max(0.05, ax - kx0 * H), bz = Math.max(0.05, az - kz0 * H);
  const slope = (Math.atan2(H, ax - bx) + Math.atan2(H, az - bz)) / 2;
  const fit: PyramidFit = { cx, cz, heading, y0, yTop, ax, az, bx, bz, slope };
  fit.prof = faceProfile(fit, pts, lx, lz, kx0, kz0);
  return fit;
}

const PROF_DY = 0.5;      // m between profile heights
const PROF_WIN = 0.6;     // m: points within ± this height count for a profile height (covers the gap to the next one)
const PROF_GRAD = 0.04;   // how fast the set-back from the face line may change per metre of height (≈ 2° of slope; 7° made
                          // the face so uneven that the hull scraped and the car stuck halfway up Khafre)
const PROF_MIN_H = 50;    // m: profile only on the large pyramids

/**
 * The outer step edges course by course (see PyramidFit.prof); undefined for sparse point clouds. Per height the
 * set-back d of the outermost stone behind the straight face line is taken, then only ever reduced: the smallest d
 * within reach (every stone stays inside: the car rides on the edges, never in them), changing by at most PROF_GRAD
 * per metre (gentle slope changes the car can drive), running out to 0 at the summit (the rounded crest) and below
 * the talus top (the fillet meets the straight face).
 */
function faceProfile(f: PyramidFit, pts: ArrayLike<number>, lx: Float32Array, lz: Float32Array, kx: number, kz: number): PyramidFit['prof'] {
  const H = f.yTop - f.y0, L = Math.floor(H / PROF_DY) + 1;
  const ex = new Float32Array(L).fill(-1), ez = new Float32Array(L).fill(-1);
  for (let i = 0; i < lx.length; i++) {
    const y = pts[i * 3 + 1] - f.y0;
    const k0 = Math.max(0, Math.ceil((y - PROF_WIN) / PROF_DY)), k1 = Math.min(L - 1, Math.floor((y + PROF_WIN) / PROF_DY));
    for (let k = k0; k <= k1; k++) { ex[k] = Math.max(ex[k], Math.abs(lx[i])); ez[k] = Math.max(ez[k], Math.abs(lz[i])); }
  }
  let filled = 0;
  for (let k = 0; k < L; k++) if (ex[k] >= 0) filled++;
  // the queens' pyramids (≈ 20–30 m) keep the straight faces: between the talus and the crest there is too little
  // face for the set-back to run in and out gently (the faces got steeper near the top and the car stalled 3 m short)
  if (filled < 0.3 * L || H < PROF_MIN_H) return undefined;     // sparse clouds: synthetic frustums
  // the talus (src: pyramidTalus) merges into the straight face up to ≈ 2 m (ground over the embedded foot) + its arc
  const footTop = 2 + TALUS_R * (1 - Math.cos(f.slope)) + 1;
  const profile = (e: Float32Array, a0: number, k: number) => {
    const d = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      const y = i * PROF_DY, line = a0 - k * y;
      d[i] = e[i] < 0 ? 0 : Math.max(0, line - e[i]);         // no stones at this height (Khafre's smooth casing: corners only): on the line
      d[i] = Math.min(d[i], Math.max(0, y - footTop) * PROF_GRAD, Math.max(0, H - y) * PROF_GRAD);
    }
    for (let i = 1; i < L; i++) d[i] = Math.min(d[i], d[i - 1] + PROF_GRAD * PROF_DY);
    for (let i = L - 2; i >= 0; i--) d[i] = Math.min(d[i], d[i + 1] + PROF_GRAD * PROF_DY);
    const out = new Float32Array(L);
    for (let i = 0; i < L; i++) out[i] = a0 - k * i * PROF_DY - d[i];
    return out;
  };
  return { dy: PROF_DY, hx: profile(ex, f.ax, kx), hz: profile(ez, f.az, kz) };
}

/** Half-widths of the face lines at height y (no rounding). */
export function halfWidthAt(f: PyramidFit, y: number): [number, number] {
  const t = (y - f.y0) / Math.max(1e-3, f.yTop - f.y0);
  const line: [number, number] = [f.ax + (f.bx - f.ax) * t, f.az + (f.bz - f.az) * t];
  const p = f.prof;
  if (!p) return line;
  const u = Math.min(p.hx.length - 1, Math.max(0, (y - f.y0) / p.dy)), i = Math.min(p.hx.length - 2, Math.floor(u)), w = u - i;
  return [Math.min(line[0], p.hx[i] + (p.hx[i + 1] - p.hx[i]) * w), Math.min(line[1], p.hz[i] + (p.hz[i + 1] - p.hz[i]) * w)];
}

/** Height at which the profile of one axis has half-width u (the profile narrows upward; y0 … yTop). */
function profileHeight(f: PyramidFit, h: Float32Array, u: number): number {
  const dy = f.prof!.dy;
  if (u >= h[0]) return f.y0;
  let lo = 0, hi = h.length - 1;
  if (u <= h[hi]) return f.yTop;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (h[m] >= u) lo = m; else hi = m; }
  const w = h[lo] - h[hi] > 1e-6 ? (h[lo] - u) / (h[lo] - h[hi]) : 0;
  return Math.min(f.yTop, f.y0 + (lo + w) * dy);
}

/** Local (x, z) → world (x, z). */
export function toWorld(f: PyramidFit, lx: number, lz: number): [number, number] {
  const [x, z] = rot(lx, lz, Math.cos(f.heading), Math.sin(f.heading));
  return [f.cx + x, f.cz + z];
}

/**
 * Crest profile of one axis: half-width at height y of the frustum with the face-to-platform edge rounded to
 * radius R (capped so the arc ends on the platform, i.e. at most the whole platform half-width b).
 */
function crestHalfWidth(b: number, th: number, yTop: number, R: number, y: number): number {
  const face = b + (yTop - y) / Math.tan(th);
  if (R < 0.05) return face;
  const t = R * Math.tan(th / 2);
  const yc = yTop - R, dy = y - yc;
  if (y < yc + R * Math.cos(th)) return face;
  return b - t + Math.sqrt(Math.max(0, R * R - dy * dy));
}

/**
 * Face angles (rad) of the ±x and ±z faces. `slope` is their mean; the eroded queens' pyramids differ by up
 * to 8° between the axes (G3-c 53° / 46°), and a talus or crest built with the mean angle met the steeper or
 * shallower face with a step – the talus top stood 0.5 m proud of G3-c's north face and the car hung on it.
 */
export function axisSlopes(f: PyramidFit): [number, number] {
  const H = Math.max(1e-3, f.yTop - f.y0);
  return [Math.atan2(H, Math.max(1e-3, f.ax - f.bx)), Math.atan2(H, Math.max(1e-3, f.az - f.bz))];
}

/** Crest radii (x, z) actually used: CREST_R capped by each axis' summit half-width. */
export function crestRadii(f: PyramidFit, crestR = CREST_R): [number, number] {
  const [tx, tz] = axisSlopes(f);
  return [Math.max(0, Math.min(crestR, f.bx / Math.tan(tx / 2))), Math.max(0, Math.min(crestR, f.bz / Math.tan(tz / 2)))];
}

/** Convex hull points (world xyz…) of the frustum with a rounded crest (rings of 4 corners, bottom to top). */
export function pyramidHullPoints(f: PyramidFit, crestR = CREST_R, segs = 12): Float32Array {
  const [thx, thz] = axisSlopes(f);
  const [Rx, Rz] = crestRadii(f, crestR);
  // ring heights: the arc of each axis sampled evenly in angle (both axes share the rings, so merge them)
  const ys = new Set<number>([f.yTop]);
  for (const [R, th] of [[Rx, thx], [Rz, thz]]) {
    if (R < 0.05) continue;
    for (let k = 0; k < segs; k++) ys.add(f.yTop - R + R * Math.cos(th * (1 - k / segs)));
  }
  // (rings closer than 5 cm merged: equal axes give near-identical heights → degenerate slivers)
  // a stepped model's face profile: a ring every profile height below the crest
  if (f.prof) for (let k = 1; k * f.prof.dy < f.yTop - f.y0; k++) ys.add(f.y0 + k * f.prof.dy);
  const levels = [...ys].sort((a, b) => a - b).filter((y, i, l) => i === l.length - 1 || l[i + 1] - y > 0.05);
  const out: number[] = [];
  const ring = (hx: number, hz: number, y: number) => {
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const [x, z] = toWorld(f, sx * hx, sz * hz);
      out.push(x, y, z);
    }
  };
  const [px0, pz0] = halfWidthAt(f, f.y0);
  ring(px0, pz0, f.y0);
  for (const y of levels) {
    const [px, pz] = halfWidthAt(f, y);
    ring(Math.max(0.05, Math.min(px, crestHalfWidth(f.bx, thx, f.yTop, Rx, y))), Math.max(0.05, Math.min(pz, crestHalfWidth(f.bz, thz, f.yTop, Rz, y))), y);
  }
  return new Float32Array(out);
}

/**
 * Talus ring around the foot (world triangles xyz×3…): a concave fillet of radius R from the ground into the
 * face, following the terrain; swept around the corners so there are no gaps or side walls.
 */
export function pyramidTalus(f: PyramidFit, groundAt: (x: number, z: number) => number, R = TALUS_R, station = 4, cornerSegs = 4, arcSegs = 14): Float32Array {
  // profile for face angle th: outward horizontal distance d from the foot line, height above the foot ground;
  // arc from the ground tangent (d = tf, 0) to the face tangent (d = -tf cos th, tf sin th); last point 5 cm into the face
  const profile = (th: number): [number, number][] => {
    const tf = R * Math.tan(th / 2), k = 1 / Math.tan(th); // k: horizontal inset per metre of height
    const prof: [number, number][] = [];
    for (let i = 0; i <= arcSegs; i++) {
      const phi = th * (i / arcSegs);
      prof.push([tf - R * Math.sin(phi), R - R * Math.cos(phi)]);
    }
    prof.push([prof[arcSegs][0] - 0.05 * Math.sin(th) - 0.3 * k, prof[arcSegs][1] + 0.3]);
    return prof;
  };
  const [thx, thz] = axisSlopes(f);
  // stations around the perimeter: foot point (local), outward normal (local), face angle (blended round the corners)
  type St = { px: number; pz: number; nx: number; nz: number; th: number };
  const sts: St[] = [];
  // foot ground height at a local point: two fixed-point passes (the foot line moves with the ground height)
  const footAt = (u: number, side: number): { px: number; pz: number; g: number } => {
    // side: 0 = +x, 1 = +z, 2 = -x, 3 = -z face; u runs along the face
    let g = f.y0;
    let px = 0, pz = 0;
    for (let it = 0; it < 3; it++) {
      const [hx, hz] = halfWidthAt(f, g);
      const uu = Math.max(-1, Math.min(1, u));
      [px, pz] = side === 0 ? [hx, uu * hz] : side === 1 ? [-uu * hx, hz] : side === 2 ? [-hx, -uu * hz] : [uu * hx, -hz];
      const [wx, wz] = toWorld(f, px, pz);
      g = groundAt(wx, wz);
    }
    return { px, pz, g };
  };
  const normals: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (let side = 0; side < 4; side++) {
    const len = 2 * (side % 2 === 0 ? f.az : f.ax);
    const n = Math.max(2, Math.ceil(len / station));
    const [nx, nz] = normals[side];
    const th = side % 2 === 0 ? thx : thz, thNext = side % 2 === 0 ? thz : thx;
    for (let i = 0; i < n; i++) {
      const u = -1 + (2 * i) / n;
      const p = footAt(u, side);
      sts.push({ px: p.px, pz: p.pz, nx, nz, th });
    }
    // corner (u = +1): sweep the normal from this face to the next
    const p = footAt(1, side);
    const [mx, mz] = normals[(side + 1) % 4];
    for (let j = 0; j <= cornerSegs; j++) {
      const a = (j / cornerSegs) * (Math.PI / 2);
      const ca = Math.cos(a), sa = Math.sin(a);
      const ex = nx * ca + mx * sa, ez = nz * ca + mz * sa;
      sts.push({ px: p.px, pz: p.pz, nx: ex, nz: ez, th: th * ca * ca + thNext * sa * sa });
    }
  }
  // grid of world points; the ground height follows the terrain under each profile point (outer lip sinks 10 cm)
  const W = arcSegs + 2;
  const P: number[][] = [];
  for (const st of sts) {
    const prof = profile(st.th);
    const [fx, fz] = toWorld(f, st.px, st.pz);
    const g = groundAt(fx, fz);
    const row: number[] = [];
    for (let i = 0; i < W; i++) {
      const [d, h] = prof[i];
      const [x, z] = toWorld(f, st.px + st.nx * d, st.pz + st.nz * d);
      const s = i / (W - 1);
      const gl = d > 0 ? groundAt(x, z) - 0.1 : g;
      row.push(x, g + h + (1 - s) * (gl - g), z);
    }
    P.push(row);
  }
  const tris: number[] = [];
  const v = (r: number[], i: number) => [r[i * 3], r[i * 3 + 1], r[i * 3 + 2]];
  for (let a = 0; a < P.length; a++) {
    const A = P[a], B = P[(a + 1) % P.length];
    for (let i = 0; i < W - 1; i++) {
      // winding: outward/upward normal (counter-clockwise seen from outside)
      tris.push(...v(A, i), ...v(B, i), ...v(B, i + 1));
      tris.push(...v(A, i), ...v(B, i + 1), ...v(A, i + 1));
    }
  }
  return new Float32Array(tris);
}

/**
 * Height of the frustum surface at world (x, z), -Infinity outside the base. Without crestR the sharp frustum
 * (camera/jet ground); with crestR (CREST_R as in the collider) the summit edge is rounded like the collision mesh.
 */
export function pyramidHeightAt(f: PyramidFit, x: number, z: number, crestR?: number): number {
  const c = Math.cos(-f.heading), s = Math.sin(-f.heading);
  const [lx, lz] = rot(x - f.cx, z - f.cz, c, s);
  const ux = Math.abs(lx), uz = Math.abs(lz);
  if (ux > f.ax || uz > f.az) return -Infinity;
  const H = f.yTop - f.y0;
  let yx = ux <= f.bx ? f.yTop : f.y0 + ((f.ax - ux) / Math.max(1e-3, f.ax - f.bx)) * H;
  let yz = uz <= f.bz ? f.yTop : f.y0 + ((f.az - uz) / Math.max(1e-3, f.az - f.bz)) * H;
  if (f.prof) { yx = Math.min(yx, profileHeight(f, f.prof.hx, ux)); yz = Math.min(yz, profileHeight(f, f.prof.hz, uz)); }
  if (crestR != null) {
    const [thx, thz] = axisSlopes(f), [Rx, Rz] = crestRadii(f, crestR);
    const arc = (u: number, b: number, R: number, th: number, y: number) => {
      const t = R * Math.tan(th / 2), d = u - (b - t);
      if (R < 0.05 || d > R * Math.sin(th)) return y;
      return d <= 0 ? f.yTop : Math.min(y, f.yTop - R + Math.sqrt(R * R - d * d));
    };
    yx = arc(ux, f.bx, Rx, thx, yx); yz = arc(uz, f.bz, Rz, thz, yz);
  }
  return Math.min(yx, yz);
}

/**
 * The same rounded frustum as a closed, outward-wound triangle mesh (world triangles xyz×3…). The physics uses
 * this instead of a convex-hull collider: wheel shape casts against one 230-m convex polyhedron intermittently
 * missed the face (GJK tolerance at that scale) and the car peeled off the wall; triangle casts are robust.
 */
export function pyramidHullMesh(f: PyramidFit, crestR = CREST_R, segs = 12): Float32Array {
  const p = pyramidHullPoints(f, crestR, segs);
  const levels = p.length / 12;
  const P = (k: number, i: number): [number, number, number] => { const o = (k * 4 + (i % 4)) * 3; return [p[o], p[o + 1], p[o + 2]]; };
  const cy = (f.y0 + f.yTop) / 2;
  const out: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (a[0] + b[0] + c[0]) / 3 - f.cx, my = (a[1] + b[1] + c[1]) / 3 - cy, mz = (a[2] + b[2] + c[2]) / 3 - f.cz;
    if (nx * nx + ny * ny + nz * nz < 1e-12) return;
    if (nx * mx + ny * my + nz * mz >= 0) out.push(...a, ...b, ...c); else out.push(...a, ...c, ...b);
  };
  for (let k = 0; k + 1 < levels; k++) {
    for (let i = 0; i < 4; i++) {
      const a = P(k, i), b = P(k, i + 1), c = P(k + 1, i + 1), d = P(k + 1, i);
      tri(a, b, c); tri(a, c, d);
    }
  }
  const top = levels - 1;
  tri(P(top, 0), P(top, 1), P(top, 2)); tri(P(top, 0), P(top, 2), P(top, 3));
  tri(P(0, 0), P(0, 1), P(0, 2)); tri(P(0, 0), P(0, 2), P(0, 3));
  return new Float32Array(out);
}
