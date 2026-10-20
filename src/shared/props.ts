// movable, breakable landmarks ("props"): Apollo LM descent stage, LRV, Perseverance, Curiosity, Roadster 1.
// Data contract shared by the physics (src/sim/core/props.ts, rigid bodies + breakable joints) and the renderer
// (src/render/worlds/landmarks.ts splits the landmark GLB into the same parts). Pure, no Rapier/three imports.
//
// Frames: a landmark is placed like every landmark (src/render/worlds/landmarks.ts landmarkMatrix: translate to
// (x, y, z), rotate headingDeg about +Y, uniform scale). Inside the GLB frame an object has its own frame
// (origin + yaw about +Y), in which all part shapes, anchors and graphics regions are given. Units: m, kg, J.
import type { Vec3 } from './math';

export type V3 = [number, number, number];

export type PropShape =
  /** Box: centre c, half extents h, optional rotation (Euler XYZ, degrees). */
  | { kind: 'box'; c: V3; h: V3; rotDeg?: V3 }
  /** Cylinder: centre c, radius r, half height hh along the axis. */
  | { kind: 'cyl'; c: V3; r: number; hh: number; axis: 'x' | 'y' | 'z' }
  /** Convex hull of points (flat x, y, z …). */
  | { kind: 'hull'; pts: number[] };

export interface PropJointDef {
  /** fixed = welded/bolted (also parked wheels: drives and brakes hold them); revolute = free hinge about `axis`. */
  type: 'fixed' | 'revolute';
  /** Joint point in the object frame (both bodies start in the same frame). */
  anchor: V3;
  axis?: V3;
  /**
   * Break capacity (J): the joint fails when the collision energy that reaches this part in a short window exceeds
   * it (see src/sim/core/props.ts). LM legs: strut crush load × stroke; rover parts [EST].
   */
  breakEnergyJ: number;
}

export interface PropPartDef {
  id: string;
  /** German label (HUD/report). */
  name?: string;
  massKg: number;
  shapes: PropShape[];
  /** Centre of mass (object frame); default = volume-weighted centroid of the shapes. */
  com?: V3;
  /** Attachment to the object's first part (the main body). Absent on the main body itself. */
  joint?: PropJointDef;
  /** Graphics: GLB triangles whose centroid lies in one of these boxes (object frame) belong to this part.
   *  Default: the shapes' bounding boxes grown by 5 cm. Earlier parts win; the main body takes the rest of
   *  `meshes` – unless it has a region itself (then triangles outside every region stay static). */
  region?: { min: V3; max: V3 }[];
  friction?: number;
  restitution?: number;
}

export interface PropObjectDef {
  id: string;
  name: string;
  /** GLB node names whose triangles belong to this object (the rest of the GLB stays a static landmark). */
  meshes: string[];
  /** Object frame inside the GLB frame. */
  origin: V3;
  yawDeg: number;
  /** parts[0] = main body; others carry a joint to it. */
  parts: PropPartDef[];
  /** Sources / estimates (report). */
  note?: string;
  /**
   * Set in the ground (Stonehenge uprights): the body is held fixed until a blow's energy exceeds what the
   * socket can take; then it is free (and topples). The stone rotates about the bottom of its buried butt
   * (object frame (0, −depthM, 0)); the buried part has the cross-section of parts[0].shapes[0].
   */
  anchor?: { depthM: number; breakEnergyJ: number; buriedMassKg: number };
}

/** A prop placed in the world: GLB frame pose (landmark placement) + object definition. */
export interface PropPlacement {
  /** Landmark id the object belongs to (e.g. 'apollo_lm_descent#0'). */
  landmarkId: string;
  pos: Vec3;
  headingDeg: number;
  scale?: number;
  def: PropObjectDef;
  /** Initial velocities (world frame), e.g. the drifting Roadster 1; default at rest (asleep). */
  linVel?: Vec3;
  angVel?: Vec3;
}

const shapeVolume = (s: PropShape): number => {
  if (s.kind === 'box') return 8 * s.h[0] * s.h[1] * s.h[2];
  if (s.kind === 'cyl') return Math.PI * s.r * s.r * 2 * s.hh;
  const b = hullBounds(s.pts);
  return Math.max(1e-6, (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2])) * 0.6;
};

function hullBounds(pts: number[]): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < pts.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pts[i + k]); max[k] = Math.max(max[k], pts[i + k]); }
  return { min, max };
}

/** Euler XYZ (degrees) → quaternion (x, y, z, w). */
export function eulerQuat(d: V3): { x: number; y: number; z: number; w: number } {
  const [a, b, c] = d.map((v) => (v * Math.PI) / 360);
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // three.js 'XYZ' order
  return {
    x: sa * cb * cc + ca * sb * sc, y: ca * sb * cc - sa * cb * sc,
    z: ca * cb * sc + sa * sb * cc, w: ca * cb * cc - sa * sb * sc,
  };
}

/** Axis-aligned bounds of a shape in the object frame (rotated boxes: bounds of the 8 corners). */
export function shapeBounds(s: PropShape): { min: V3; max: V3 } {
  if (s.kind === 'hull') return hullBounds(s.pts);
  if (s.kind === 'cyl') {
    const e: V3 = [s.r, s.r, s.r];
    const ax = s.axis === 'x' ? 0 : s.axis === 'y' ? 1 : 2;
    e[ax] = s.hh;
    return { min: [s.c[0] - e[0], s.c[1] - e[1], s.c[2] - e[2]], max: [s.c[0] + e[0], s.c[1] + e[1], s.c[2] + e[2]] };
  }
  const q = eulerQuat(s.rotDeg ?? [0, 0, 0]);
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const p = rotate(q, [sx * s.h[0], sy * s.h[1], sz * s.h[2]]);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], s.c[k] + p[k]); max[k] = Math.max(max[k], s.c[k] + p[k]); }
  }
  return { min, max };
}

function rotate(q: { x: number; y: number; z: number; w: number }, v: V3): V3 {
  // v' = v + 2w (q × v) + 2 q × (q × v)
  const { x, y, z, w } = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}

type M3 = number[][];
const quatMat = (q: { x: number; y: number; z: number; w: number }): M3 => {
  const { x, y, z, w } = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
};

/** Inertia tensor of one shape about its own centre, object axes (hulls: their bounding box). */
function shapeTensor(s: PropShape, m: number): M3 {
  let d: V3, R: M3;
  if (s.kind === 'cyl') {
    const ax = m * s.r * s.r / 2, pr = (m * (3 * s.r * s.r + 4 * s.hh * s.hh)) / 12;
    d = s.axis === 'x' ? [ax, pr, pr] : s.axis === 'y' ? [pr, ax, pr] : [pr, pr, ax];
    R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  } else {
    const h: V3 = s.kind === 'box' ? s.h : (() => { const b = hullBounds(s.pts); return [0, 1, 2].map((k) => (b.max[k] - b.min[k]) / 2) as V3; })();
    d = [(m / 3) * (h[1] ** 2 + h[2] ** 2), (m / 3) * (h[0] ** 2 + h[2] ** 2), (m / 3) * (h[0] ** 2 + h[1] ** 2)];
    R = quatMat(s.kind === 'box' && s.rotDeg ? eulerQuat(s.rotDeg) : { x: 0, y: 0, z: 0, w: 1 });
  }
  // R · diag(d) · Rᵀ
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => R[i][0] * d[0] * R[j][0] + R[i][1] * d[1] * R[j][1] + R[i][2] * d[2] * R[j][2]));
}

/** Eigen decomposition of a symmetric 3×3 matrix (cyclic Jacobi): values and column eigenvectors. */
export function symEigen3(A0: M3): { values: V3; vectors: M3 } {
  const A = A0.map((r) => r.slice());
  const V: M3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = A[0][1] ** 2 + A[0][2] ** 2 + A[1][2] ** 2;
    if (off < 1e-22 * (A[0][0] ** 2 + A[1][1] ** 2 + A[2][2] ** 2 + 1e-30)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
      for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - sn * akq; A[k][q] = sn * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - sn * aqk; A[q][k] = sn * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - sn * vkq; V[k][q] = sn * vkp + c * vkq; }
    }
  }
  return { values: [A[0][0], A[1][1], A[2][2]], vectors: V };
}

/** Rotation matrix (columns = axes) → quaternion; flips one column if needed to keep it a proper rotation. */
function matQuat(V: M3): { x: number; y: number; z: number; w: number } {
  const det = V[0][0] * (V[1][1] * V[2][2] - V[1][2] * V[2][1]) - V[0][1] * (V[1][0] * V[2][2] - V[1][2] * V[2][0]) + V[0][2] * (V[1][0] * V[2][1] - V[1][1] * V[2][0]);
  const m = det < 0 ? V.map((r) => [r[0], r[1], -r[2]]) : V;
  const tr = m[0][0] + m[1][1] + m[2][2];
  let x: number, y: number, z: number, w: number;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; w = (m[2][1] - m[1][2]) / s; x = s / 4; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s; }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = s / 4; z = (m[1][2] + m[2][1]) / s; }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = s / 4; }
  const n = Math.hypot(x, y, z, w);
  return { x: x / n, y: y / n, z: z / n, w: w / n };
}

/**
 * Mass properties of a part: mass spread over its shapes by volume (uniform density), centre of mass, full
 * inertia tensor about the CoM (rotated boxes, cylinders about their own axes, parallel-axis terms), returned as
 * principal moments plus the rotation of the principal frame (object frame).
 */
export function partMassProperties(p: PropPartDef): { mass: number; com: V3; inertia: V3; frame: { x: number; y: number; z: number; w: number }; tensor: M3 } {
  const vols = p.shapes.map(shapeVolume);
  const vSum = vols.reduce((a, b) => a + b, 0) || 1;
  const centres = p.shapes.map((s) => {
    if (s.kind !== 'hull') return s.c;
    const b = hullBounds(s.pts);
    return [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2) as V3;
  });
  const com: V3 = p.com ?? [0, 1, 2].map((k) => centres.reduce((a, c, i) => a + c[k] * vols[i], 0) / vSum) as V3;
  const T: M3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  p.shapes.forEach((s, i) => {
    const m = (p.massKg * vols[i]) / vSum;
    const Ti = shapeTensor(s, m);
    const d = [0, 1, 2].map((k) => centres[i][k] - com[k]);
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) T[r][c] += Ti[r][c] + m * ((r === c ? dd : 0) - d[r] * d[c]);
  });
  const { values, vectors } = symEigen3(T);
  return { mass: p.massKg, com, inertia: values.map((v) => Math.max(v, 1e-6)) as V3, frame: matQuat(vectors), tensor: T };
}

/**
 * Mass properties of several parts welded together (the intact assembly): total mass, centre of mass and the
 * principal moments/frame of the summed inertia tensor about it (object frame).
 */
export function assemblyMassProperties(parts: PropPartDef[]): { mass: number; com: V3; inertia: V3; frame: { x: number; y: number; z: number; w: number } } {
  const mp = parts.map(partMassProperties);
  const mass = mp.reduce((a, m) => a + m.mass, 0);
  const com = [0, 1, 2].map((k) => mp.reduce((a, m) => a + m.mass * m.com[k], 0) / mass) as V3;
  const T: M3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const m of mp) {
    const d = [0, 1, 2].map((k) => m.com[k] - com[k]);
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) T[r][c] += m.tensor[r][c] + m.mass * ((r === c ? dd : 0) - d[r] * d[c]);
  }
  const { values, vectors } = symEigen3(T);
  return { mass, com, inertia: values.map((v) => Math.max(v, 1e-6)) as V3, frame: matQuat(vectors) };
}

/** A placed object definition scaled uniformly (shapes, CoM, anchors, regions; masses unchanged). */
export function scaleObjectDef(d: PropObjectDef, s: number): PropObjectDef {
  if (s === 1) return d;
  const v = (a: V3): V3 => [a[0] * s, a[1] * s, a[2] * s];
  const shape = (sh: PropShape): PropShape => sh.kind === 'box' ? { ...sh, c: v(sh.c), h: v(sh.h) }
    : sh.kind === 'cyl' ? { ...sh, c: v(sh.c), r: sh.r * s, hh: sh.hh * s } : { ...sh, pts: sh.pts.map((x) => x * s) };
  return {
    ...d, origin: v(d.origin),
    parts: d.parts.map((p) => ({
      ...p, shapes: p.shapes.map(shape), com: p.com && v(p.com),
      joint: p.joint && { ...p.joint, anchor: v(p.joint.anchor) },
      region: p.region?.map((r) => ({ min: v(r.min), max: v(r.max) })),
    })),
  };
}

/** Default graphics regions of a part (shape bounds + margin). */
export function partRegions(p: PropPartDef, margin = 0.05): { min: V3; max: V3 }[] {
  if (p.region?.length) return p.region;
  return p.shapes.map(shapeBounds).map((b) => ({ min: b.min.map((v) => v - margin) as V3, max: b.max.map((v) => v + margin) as V3 }));
}

/** Total mass of an object (kg). */
export const objectMass = (o: PropObjectDef): number => o.parts.reduce((a, p) => a + p.massKg, 0);

/** Pose of one prop part per step (world frame; body origin = object frame origin). */
export interface PropPose { pos: Vec3; quat: { x: number; y: number; z: number; w: number } }

/**
 * Roadster 1 + Starman (Sun scene) as one rigid body. Mass: JPL Horizons -143205 "Roadster mass ~1250 kg (with
 * batteries)" – the car as shown; in reality it stays bolted to the Falcon Heavy second stage (≈ 5,9 t in all),
 * which the orbit panel states alongside (src/game/orbit.ts). Shapes from roadster1_starman.glb (holder frame:
 * body −1.03…1.03 × −0.39…0.39 × −1.98…1.98 m, Starman on the right seat up to y ≈ 0.58).
 */
export const ROADSTER1_PROP: PropObjectDef = {
  id: 'roadster1', name: 'Roadster 1 mit Starman', meshes: [], origin: [0, 0, 0], yawDeg: 0,
  parts: [{
    id: 'body', name: 'Roadster 1', massKg: 1250, com: [0, -0.05, 0], friction: 0.4, restitution: 0.1,
    shapes: [
      { kind: 'box', c: [0, -0.08, 0], h: [0.98, 0.3, 1.95] },
      { kind: 'box', c: [0, 0.3, -0.1], h: [0.85, 0.12, 0.75] },
      { kind: 'box', c: [0.45, 0.42, -0.15], h: [0.22, 0.2, 0.3] },
    ],
  }],
  note: 'Horizons -143205: ~1250 kg; Stapel mit Oberstufe ~5900 kg (Wikipedia).',
};
