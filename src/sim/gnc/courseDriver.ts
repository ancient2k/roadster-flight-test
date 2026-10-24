// A driver for track-editor courses: pure pursuit along the course line (src/shared/lanes.ts) and a speed profile
// from the pieces (curve limits ahead, the run-up speed a loop or a jump needs). It only produces what a player
// would: throttle, brake, steering (ASSIST does the rest, e.g. the fans in the loop). Used by the drivability tests
// of the editor pieces and tracks, and for the trailer's test drive.
import type { LanePoint } from '../../shared/lanes';
import type { DriveInput } from '../../shared/types';
import type { Quat, Vec3 } from '../../shared/math';
import { ROADSTER } from '../../shared/roadster';

export interface DriverCar { pos: Vec3; quat: Quat; linVel: Vec3 }

const WHEELBASE = 2.65;
const BRAKE_DECEL = 5;     // m/s² planned for slowing down toward a curve
const D = Math.PI / 180;

export class CourseDriver {
  /** Index of the line point the car is at (moves forward only, so that self-crossing lines – the loop – work). */
  i = 0;
  /** Distance (m) from the car to the line at the last update. */
  offLine = 0;
  /** Speed the driver aimed for at the last update (m/s). */
  targetMs = 0;
  constructor(readonly line: LanePoint[], readonly closed = false, private speedScale = 1) {}

  /** Line point k (wrapping on a closed course). */
  private at(k: number): LanePoint {
    const n = this.line.length;
    return this.closed ? this.line[((k % n) + n) % n] : this.line[Math.min(Math.max(k, 0), n - 1)];
  }

  /** True once the car has passed the end of an open line (or completed a lap on a closed one). */
  get done(): boolean { return this.i >= this.line.length - 1; }

  update(car: DriverCar): DriveInput {
    const { pos, quat: q, linVel: v } = car;
    const speed = Math.hypot(v.x, v.y, v.z);
    // progress: nearest point in a window ahead (3-D distance: the loop passes over its own entry)
    let best = this.i, bd = Infinity;
    for (let k = Math.max(0, this.i - 2); k < this.i + 40; k++) {
      if (!this.closed && k >= this.line.length) break;
      const p = this.at(k), d = (p.x - pos.x) ** 2 + (p.y - pos.y) ** 2 + (p.z - pos.z) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    this.i = Math.max(this.i, best);
    this.offLine = Math.sqrt(bd);
    // look-ahead point along the line
    const look = Math.min(22, Math.max(7, 0.55 * speed));
    let k = this.i, acc = 0;
    while (acc < look && (this.closed || k < this.line.length - 1)) {
      const a = this.at(k), b = this.at(k + 1);
      acc += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      k++;
      if (k - this.i > 400) break;
    }
    const tgt = this.at(k);
    // target in the car frame (q⁻¹ · d); car frame: +z forward, +x left, +y up
    const dx = tgt.x - pos.x, dy = tgt.y - pos.y, dz = tgt.z - pos.z;
    const lx = rotInv(q, dx, dy, dz);
    const alpha = Math.atan2(lx[0], Math.max(0.1, lx[2]));
    const ld = Math.max(1, Math.hypot(lx[0], lx[2]));
    const delta = Math.atan((2 * WHEELBASE * Math.sin(alpha)) / ld);         // pure pursuit steering angle (left +)
    const st = ROADSTER.steering;
    const maxDeg = st.maxAngleDeg + (st.highSpeedAngleDeg - st.maxAngleDeg) * Math.min(1, speed / st.highSpeedMs);
    const airborne = this.at(this.i).air || this.at(this.i + 1).air;
    const steer = airborne ? 0 : Math.max(-1, Math.min(1, -delta / (maxDeg * D)));
    // speed: the lowest of the limits ahead (braking distance); the run-up a loop or jump needs counts from where its
    // piece begins, and only if nothing slower lies between (a curve before the jump comes first)
    let vt = 40 * this.speedScale, dist = 0, need = 0, slowest = Infinity;
    for (let m = this.i; m < this.i + 260; m++) {
      if (!this.closed && m >= this.line.length - 1) break;
      const a = this.at(m), b = this.at(m + 1), prev = this.at(m - 1);
      if (a.vMax > 0) { vt = Math.min(vt, Math.sqrt(a.vMax * a.vMax * this.speedScale ** 2 + 2 * BRAKE_DECEL * dist)); slowest = Math.min(slowest, a.vMax); }
      if (a.vMin > 0 && prev.part !== a.part && m > this.i && slowest >= a.vMin && dist < 150) need = Math.max(need, a.vMin);
      dist += Math.hypot(b.x - a.x, b.z - a.z);
      if (dist > 160) break;
    }
    vt = Math.max(vt, need);
    const err = vt - speed;
    // on a jump ramp: full power up to its limit (the take-off speed decides where the car lands)
    const here = this.at(this.i);
    const push = !!here.takeoff && speed < here.vMax * this.speedScale;
    const throttle = push ? 1 : err > 0 ? Math.min(1, 0.25 + err * 0.25) : 0;
    const brake = !push && err < -1.5 ? Math.min(1, -err * 0.15) : 0;
    this.targetMs = vt;
    return { throttle, brake, steer, handbrake: false, reverse: false, launchMode: false, accelLimitG: null };
  }
}

/** Rotate (x, y, z) by the inverse of q. */
function rotInv(q: Quat, x: number, y: number, z: number): [number, number, number] {
  // v' = q* v q
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}
