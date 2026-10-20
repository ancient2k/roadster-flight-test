// Ground autopilot: Stanley path follower on straight track lines (also valid on the wall ramp,
// whose centreline lies in a vertical plane), a PI speed controller, and a ramp arc-length tracker.
import { DEG, clamp, qrot, v3, type Quat, type Vec3 } from '@shared/math';
import { ROADSTER } from '@shared/roadster';
import { headingToForward, profileLength, sampleRamp, type CurvedRamp, type ProfileSample } from '@shared/track';
import type { DriveInput } from '@shared/types';

/** World "left" unit vector for a heading (body +X at that heading). */
export function headingLeft(headingDeg: number): Vec3 {
  const h = headingDeg * DEG;
  return { x: Math.cos(h), y: 0, z: -Math.sin(h) };
}

/** Straight line through p0 along a heading (lateral error measured along the heading's left axis). */
export class LineFollower {
  readonly p0: Vec3;
  readonly fwd: Vec3;
  readonly left: Vec3;
  kHeading = 1.6;      // steer per rad of heading error
  kCross = 0.9;        // Stanley cross-track gain (1/s)
  /** Diagnostics */
  eLat = 0; eHead = 0;

  constructor(p0: Vec3, headingDeg: number) {
    this.p0 = { ...p0 };
    this.fwd = headingToForward(headingDeg);
    this.left = headingLeft(headingDeg);
  }

  /** Steering command −1 (left) .. +1 (right). `reverse` = driving backwards along the line. */
  steer(pos: Vec3, q: Quat, speedMs: number, reverse = false): number {
    const L = this.left;
    this.eLat = (pos.x - this.p0.x) * L.x + (pos.y - this.p0.y) * L.y + (pos.z - this.p0.z) * L.z;
    const f = qrot(q, v3(0, 0, 1));
    // positive = nose points to the left of the line direction
    this.eHead = Math.asin(clamp(f.x * L.x + f.y * L.y + f.z * L.z, -1, 1));
    const maxSteer = ROADSTER.steering.maxAngleDeg * DEG;
    const v = Math.abs(speedMs);
    // Reversing: steering right yaws the car left, so the heading term flips sign; the cross-track
    // term keeps its sign (yawing left points the tail, i.e. the direction of travel, to the right).
    const head = (reverse ? -1 : 1) * this.kHeading * this.eHead;
    const delta = head + Math.atan2(this.kCross * this.eLat, v + 1.5);
    return clamp(delta / maxSteer, -1, 1);
  }
}

/** PI speed controller -> throttle/brake (signed speed along the body forward axis). */
export class SpeedController {
  kp = 0.35;       // per m/s
  ki = 0.25;       // per m
  /** Feedforward per m/s² of desired acceleration (≈ m / F_drive_max). */
  kff = 0.06;
  private integ = 0;

  reset(): void { this.integ = 0; }

  update(vRef: number, v: number, dt: number, out: DriveInput, aRef = 0): void {
    const e = vRef - v;
    let u = this.kp * e + this.integ + this.kff * aRef;
    // anti-windup: only integrate while unsaturated or when the error pulls back
    if ((u < 1 && u > -1) || u * e < 0) this.integ = clamp(this.integ + this.ki * e * dt, -0.6, 0.6);
    u = clamp(this.kp * e + this.integ + this.kff * aRef, -1, 1);
    out.throttle = u > 0 ? u : 0;
    out.brake = u < 0 ? -u : 0;
  }
}

/** Signed speed along the body forward axis. */
export function forwardSpeed(vel: Vec3, q: Quat): number {
  const f = qrot(q, v3(0, 0, 1));
  return vel.x * f.x + vel.y * f.y + vel.z * f.z;
}

/** Ramp arc-length tracker: world position -> (s, surface tangent angle, distance to centreline). */
export class RampTracker {
  readonly ramp: CurvedRamp;
  readonly length: number;
  readonly samples: ProfileSample[];
  s = 0; theta = 0; dist = 0; onRamp = false;

  constructor(ramp: CurvedRamp, step = 0.05) {
    this.ramp = ramp;
    this.length = profileLength(ramp.profile);
    this.samples = sampleRamp(ramp, step);
  }

  /** Ramp-local coordinates (x left-across, y up, z along the approach). */
  toLocal(p: Vec3): Vec3 {
    const h = this.ramp.headingDeg * DEG, c = Math.cos(h), s = Math.sin(h);
    const dx = p.x - this.ramp.origin.x, dy = p.y - this.ramp.origin.y, dz = p.z - this.ramp.origin.z;
    // inverse of rampLocalToWorld: x' = dx c − dz s, z' = dx s + dz c
    return { x: dx * c - dz * s, y: dy, z: dx * s + dz * c };
  }

  update(pos: Vec3): this {
    const l = this.toLocal(pos);
    let best = Infinity, bi = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const sm = this.samples[i];
      const d = (sm.y - l.y) ** 2 + (sm.z - l.z) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    const sm = this.samples[bi];
    this.s = sm.s; this.theta = sm.thetaRad; this.dist = Math.sqrt(best);
    this.onRamp = l.z > -0.5 && this.dist < 1.5 && Math.abs(l.x) < this.ramp.width / 2 + 0.5;
    return this;
  }
}
