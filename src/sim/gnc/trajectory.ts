// Reference trajectories with a CONTINUOUS winding angle (no shortest-path slerp): a 360° roll is a
// rotation θ(t): 0 → 2π about a fixed body axis, with θ̇ and θ̈ as rate/acceleration feedforward.
import { qaxisAngle, qmul, v3, v3norm, type Quat, type Vec3 } from '@shared/math';
import type { AttitudeRef } from './attitude';

export interface AngleSample { theta: number; rate: number; acc: number }

/**
 * Rest-to-rest trapezoidal rate profile ("torque pulse → coast → counter pulse").
 * Covers |total| with |θ̇| ≤ wMax, |θ̈| ≤ aMax; degenerates to a triangle for short moves.
 */
export class AngleProfile {
  readonly total: number;
  readonly sign: number;
  readonly tAcc: number;
  readonly tCoast: number;
  readonly wPeak: number;
  readonly aMax: number;
  readonly duration: number;

  constructor(total: number, wMax: number, aMax: number) {
    this.total = total;
    this.sign = total >= 0 ? 1 : -1;
    const A = Math.abs(total);
    this.aMax = aMax;
    let tAcc = wMax / aMax;
    if (aMax * tAcc * tAcc > A) tAcc = Math.sqrt(A / aMax); // triangle
    this.tAcc = tAcc;
    this.wPeak = aMax * tAcc;
    this.tCoast = this.wPeak > 0 ? (A - aMax * tAcc * tAcc) / this.wPeak : 0;
    this.duration = 2 * tAcc + this.tCoast;
  }

  sample(t: number, out: AngleSample = { theta: 0, rate: 0, acc: 0 }): AngleSample {
    const { tAcc, tCoast, wPeak, aMax, sign } = this;
    let th: number, w: number, a: number;
    if (t <= 0) { th = 0; w = 0; a = 0; }
    else if (t < tAcc) { th = 0.5 * aMax * t * t; w = aMax * t; a = aMax; }
    else if (t < tAcc + tCoast) { const u = t - tAcc; th = 0.5 * aMax * tAcc * tAcc + wPeak * u; w = wPeak; a = 0; }
    else if (t < this.duration) {
      const u = t - tAcc - tCoast;
      th = 0.5 * aMax * tAcc * tAcc + wPeak * tCoast + wPeak * u - 0.5 * aMax * u * u;
      w = wPeak - aMax * u; a = -aMax;
    } else { th = Math.abs(this.total); w = 0; a = 0; }
    out.theta = sign * th; out.rate = sign * w; out.acc = sign * a;
    return out;
  }
}

/** q_d(t) = q0 ⊗ exp(axis · θ(t)), axis fixed in the body frame. */
export class RotationTrajectory {
  readonly q0: Quat;
  readonly axis: Vec3;
  readonly profile: AngleProfile;
  readonly t0: number;
  private readonly s: AngleSample = { theta: 0, rate: 0, acc: 0 };

  constructor(q0: Quat, axisBody: Vec3, profile: AngleProfile, t0: number) {
    this.q0 = { ...q0 };
    this.axis = v3norm(axisBody);
    this.profile = profile;
    this.t0 = t0;
  }

  get endTime(): number { return this.t0 + this.profile.duration; }
  done(t: number): boolean { return t >= this.endTime; }
  /** Unwrapped rotation angle reached at time t. */
  theta(t: number): number { return this.profile.sample(t - this.t0, this.s).theta; }

  sample(t: number, ref: AttitudeRef): AttitudeRef {
    const s = this.profile.sample(t - this.t0, this.s);
    const dq = qaxisAngle(this.axis, s.theta);
    qmul(this.q0, dq, ref.q);
    ref.w.x = this.axis.x * s.rate; ref.w.y = this.axis.y * s.rate; ref.w.z = this.axis.z * s.rate;
    ref.a.x = this.axis.x * s.acc; ref.a.y = this.axis.y * s.acc; ref.a.z = this.axis.z * s.acc;
    return ref;
  }
}

/** Axis (body frame of qa) and angle in [0, π] of the rotation qa -> qb. */
export function relativeAxisAngle(qa: Quat, qb: Quat): { axis: Vec3; angle: number } {
  // qr = qa⁻¹ qb
  const ax = -qa.x, ay = -qa.y, az = -qa.z, aw = qa.w;
  let x = aw * qb.x + ax * qb.w + ay * qb.z - az * qb.y;
  let y = aw * qb.y - ax * qb.z + ay * qb.w + az * qb.x;
  let z = aw * qb.z + ax * qb.y - ay * qb.x + az * qb.w;
  let w = aw * qb.w - ax * qb.x - ay * qb.y - az * qb.z;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return { axis: v3(0, 0, 1), angle: 0 };
  return { axis: v3(x / s, y / s, z / s), angle: 2 * Math.atan2(s, w) };
}
