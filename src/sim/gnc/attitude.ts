// Geometric attitude control on SO(3) (unit quaternions) with inertia feedforward and ω×Jω.
//
//   q_e = q_d⁻¹ ⊗ q           (rotation desired -> actual; its axis is the same in both frames)
//   e   = axis(q_e)·angle(q_e) (shortest-path sign; magnitude saturated)
//   ω_r = R_eᵀ ω_d − K_p e     (rate reference, body frame, |·| ≤ ω_max)
//   M   = J (K_d (ω_r − ω) + R_eᵀ α_d) + ω × J ω
//
// The reference (q_d, ω_d, α_d) comes from a trajectory with a continuous winding angle, so a full
// 360° roll is tracked as a moving target rather than as "error zero" (start = end orientation).
import { qconj, qmul, qrotInv, v3, v3cross, v3norm, type Quat, type Vec3 } from '@shared/math';

export interface AttitudeRef {
  q: Quat;     // desired body->world
  w: Vec3;     // desired body rate, desired-body frame (rad/s)
  a: Vec3;     // desired body angular acceleration, desired-body frame (rad/s²)
}

export const newAttitudeRef = (q: Quat = { x: 0, y: 0, z: 0, w: 1 }): AttitudeRef => ({ q: { ...q }, w: v3(), a: v3() });

export class AttitudeController {
  /** Proportional gain on the angle error (1/s) per body axis. */
  kp = v3(3.2, 2.0, 4.0);
  /** Rate-loop gain (1/s) per body axis. */
  kd = v3(11, 7, 14);
  /** Max correction rate from the angle loop (rad/s) per axis. */
  maxCorrRate = v3(2.0, 1.2, 3.0);
  /** Diagnostics */
  readonly err = v3();
  errAngle = 0;
  private readonly qe: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly qdi: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly wb = v3(); private readonly wr = v3(); private readonly ar = v3();
  private readonly Jw = v3(); private readonly gyro = v3();

  /**
   * @param q actual orientation (body->world)
   * @param wWorld actual angular velocity, WORLD frame (as in VehicleState.angVel)
   * @param ref desired attitude reference
   * @param J principal inertia (body axes) estimate
   * @param out body-frame moment (N·m)
   */
  compute(q: Quat, wWorld: Vec3, ref: AttitudeRef, J: Vec3, out: Vec3 = v3()): Vec3 {
    qconj(ref.q, this.qdi);
    qmul(this.qdi, q, this.qe);
    const qe = this.qe;
    if (qe.w < 0) { qe.x = -qe.x; qe.y = -qe.y; qe.z = -qe.z; qe.w = -qe.w; }
    const s = Math.hypot(qe.x, qe.y, qe.z);
    const ang = 2 * Math.atan2(s, qe.w);
    this.errAngle = ang;
    if (s > 1e-12) { const k = ang / s; this.err.x = qe.x * k; this.err.y = qe.y * k; this.err.z = qe.z * k; }
    else { this.err.x = 2 * qe.x; this.err.y = 2 * qe.y; this.err.z = 2 * qe.z; }
    // body rate
    qrotInv(q, wWorld, this.wb);
    // desired rate/accel expressed in the actual body frame: R_eᵀ x = rotate by q_e⁻¹
    qrotInv(qe, ref.w, this.wr);
    qrotInv(qe, ref.a, this.ar);
    const e = this.err, kp = this.kp, mc = this.maxCorrRate;
    const cx = clampAbs(kp.x * e.x, mc.x), cy = clampAbs(kp.y * e.y, mc.y), cz = clampAbs(kp.z * e.z, mc.z);
    const wrx = this.wr.x - cx, wry = this.wr.y - cy, wrz = this.wr.z - cz;
    const wb = this.wb, kd = this.kd;
    const ax = kd.x * (wrx - wb.x) + this.ar.x;
    const ay = kd.y * (wry - wb.y) + this.ar.y;
    const az = kd.z * (wrz - wb.z) + this.ar.z;
    this.Jw.x = J.x * wb.x; this.Jw.y = J.y * wb.y; this.Jw.z = J.z * wb.z;
    v3cross(wb, this.Jw, this.gyro);
    out.x = J.x * ax + this.gyro.x;
    out.y = J.y * ay + this.gyro.y;
    out.z = J.z * az + this.gyro.z;
    return out;
  }
}

const clampAbs = (x: number, m: number): number => (x > m ? m : x < -m ? -m : x);

/**
 * Orientation whose body +Y points along `up` and whose body +Z is as close as possible to `fwdHint`.
 * Body frame: +X left, +Y up, +Z forward  (x = y × z).
 */
export function quatFromUpForward(up: Vec3, fwdHint: Vec3, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  const Y = v3norm(up);
  // Z = fwd minus its component along Y
  const d = fwdHint.x * Y.x + fwdHint.y * Y.y + fwdHint.z * Y.z;
  let Z = v3(fwdHint.x - d * Y.x, fwdHint.y - d * Y.y, fwdHint.z - d * Y.z);
  if (Math.hypot(Z.x, Z.y, Z.z) < 1e-6) Z = Math.abs(Y.y) < 0.9 ? v3(0, 1, 0) : v3(0, 0, 1);
  Z = v3norm(Z);
  const X = v3cross(Y, Z);
  return matToQuat(X, Y, Z, out);
}

/** Rotation matrix with columns X,Y,Z (body axes in world) -> quaternion. */
export function matToQuat(X: Vec3, Y: Vec3, Z: Vec3, out: Quat): Quat {
  const m00 = X.x, m01 = Y.x, m02 = Z.x, m10 = X.y, m11 = Y.y, m12 = Z.y, m20 = X.z, m21 = Y.z, m22 = Z.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    out.w = 0.25 * s; out.x = (m21 - m12) / s; out.y = (m02 - m20) / s; out.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out.w = (m21 - m12) / s; out.x = 0.25 * s; out.y = (m01 + m10) / s; out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out.w = (m02 - m20) / s; out.x = (m01 + m10) / s; out.y = 0.25 * s; out.z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out.w = (m10 - m01) / s; out.x = (m02 + m20) / s; out.y = (m12 + m21) / s; out.z = 0.25 * s;
  }
  const l = Math.hypot(out.x, out.y, out.z, out.w);
  out.x /= l; out.y /= l; out.z /= l; out.w /= l;
  return out;
}
