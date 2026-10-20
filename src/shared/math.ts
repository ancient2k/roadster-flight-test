// Minimal, allocation-aware vector/quaternion helpers shared by sim, GNC, render and UI.
// Plain objects so they serialize cleanly (replays, workers, tests).

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export const DEG = Math.PI / 180;
export const G0 = 9.80665;
export const FT = 0.3048;
export const MPH = 0.44704;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const v3copy = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const v3set = (o: Vec3, x: number, y: number, z: number): Vec3 => { o.x = x; o.y = y; o.z = z; return o; };
export const v3add = (a: Vec3, b: Vec3, o: Vec3 = v3()): Vec3 => v3set(o, a.x + b.x, a.y + b.y, a.z + b.z);
export const v3sub = (a: Vec3, b: Vec3, o: Vec3 = v3()): Vec3 => v3set(o, a.x - b.x, a.y - b.y, a.z - b.z);
export const v3scale = (a: Vec3, s: number, o: Vec3 = v3()): Vec3 => v3set(o, a.x * s, a.y * s, a.z * s);
export const v3dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const v3cross = (a: Vec3, b: Vec3, o: Vec3 = v3()): Vec3 =>
  v3set(o, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const v3len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const v3norm = (a: Vec3, o: Vec3 = v3()): Vec3 => {
  const l = v3len(a);
  return l > 1e-12 ? v3scale(a, 1 / l, o) : v3set(o, 0, 0, 0);
};

export const qident = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
export const qcopy = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });
export const qmul = (a: Quat, b: Quat, o: Quat = qident()): Quat => {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  o.x = x; o.y = y; o.z = z; o.w = w;
  return o;
};
export const qconj = (q: Quat, o: Quat = qident()): Quat => { o.x = -q.x; o.y = -q.y; o.z = -q.z; o.w = q.w; return o; };
export const qnorm = (q: Quat, o: Quat = qident()): Quat => {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  o.x = q.x / l; o.y = q.y / l; o.z = q.z / l; o.w = q.w / l;
  return o;
};
export const qaxisAngle = (axis: Vec3, angle: number): Quat => {
  const n = v3norm(axis); const s = Math.sin(angle / 2);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(angle / 2) };
};
/** Rotate vector v by quaternion q (body -> world when q is the body orientation). */
export const qrot = (q: Quat, v: Vec3, o: Vec3 = v3()): Vec3 => {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return v3set(o,
    v.x + q.w * tx + (q.y * tz - q.z * ty),
    v.y + q.w * ty + (q.z * tx - q.x * tz),
    v.z + q.w * tz + (q.x * ty - q.y * tx));
};
/** Inverse rotation (world -> body). */
export const qrotInv = (q: Quat, v: Vec3, o: Vec3 = v3()): Vec3 => qrot({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v, o);
export const qslerp = (a: Quat, b: Quat, t: number): Quat => {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (cos > 0.9995) return qnorm({ x: a.x + (bx - a.x) * t, y: a.y + (by - a.y) * t, z: a.z + (bz - a.z) * t, w: a.w + (bw - a.w) * t });
  const th = Math.acos(cos), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return { x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb };
};

/**
 * Vehicle attitude angles in the convention of the Tesla stream HUD.
 * Body frame (right-handed): +X LEFT, +Y up, +Z forward.
 * pitchDeg: angle of the body +Z axis above the horizon, continued past 90° when the
 *   car goes over the top (0 = level, 90 = nose straight up, 170 = nearly inverted on the wall).
 *   Computed in the vertical plane spanned by world-up and the heading, range (-180, 180].
 * rollDeg: bank angle, positive = right side down.
 */
export function hudPitchDeg(q: Quat): number {
  const fwd = qrot(q, { x: 0, y: 0, z: 1 });
  const up = qrot(q, { x: 0, y: 1, z: 0 });
  // Use body up to disambiguate past-vertical: horizontal component of fwd may flip sign.
  const horiz = Math.hypot(fwd.x, fwd.z);
  const pitch = Math.atan2(fwd.y, horiz) / DEG;
  if (up.y >= 0) return pitch;
  return pitch >= 0 ? 180 - pitch : -180 - pitch;
}
/**
 * Continuous HUD pitch. Inverted attitudes are ambiguous (pitch 170° on the wall ramp vs. a 180° roll of the
 * kickflip describe nearly the same orientation), so the branch is chosen when the car turns over: if the
 * body rotates mainly about its lateral axis it went "over the top" (pitch continues past 90°), if mainly
 * about its longitudinal axis it rolled (pitch stays near the geometric value).
 */
export class PitchTracker {
  private overTop = false;
  private wasInverted = false;
  update(q: Quat, angVelWorld: Vec3): number {
    const fwd = qrot(q, { x: 0, y: 0, z: 1 });
    const up = qrot(q, { x: 0, y: 1, z: 0 });
    const raw = Math.atan2(fwd.y, Math.hypot(fwd.x, fwd.z)) / DEG;
    const inverted = up.y < 0;
    if (inverted && !this.wasInverted) {
      const w = qrotInv(q, angVelWorld);
      this.overTop = Math.abs(w.x) >= Math.abs(w.z);   // body X = lateral (pitch), body Z = longitudinal (roll)
    }
    this.wasInverted = inverted;
    if (!inverted || !this.overTop) return raw;
    return raw >= 0 ? 180 - raw : -180 - raw;
  }
  reset(): void { this.overTop = false; this.wasInverted = false; }
}

export function rollDeg(q: Quat): number {
  const right = qrot(q, { x: -1, y: 0, z: 0 }); // body +X is LEFT
  const up = qrot(q, { x: 0, y: 1, z: 0 });
  return Math.atan2(-right.y, up.y) / DEG;
}

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
