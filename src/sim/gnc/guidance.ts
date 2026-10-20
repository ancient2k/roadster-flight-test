// Translational guidance: landing ("suicide burn with reserve"), boost/climb, hover hold.
// Produces a FlightCommand (attitude reference + desired world thrust force) for FlightControl.
import { DEG, G0, qrot, v3, v3norm, type Vec3 } from '@shared/math';
import { ROADSTER } from '@shared/roadster';
import { LEVELS } from './allocator';
import { quatFromUpForward } from './attitude';
import type { StateEstimate } from './estimator';
import type { FlightCommand } from './flight';
import type { MassProps } from './massProps';

export interface LandingParams {
  /** Design net deceleration of the braking profile (m/s²). */
  decel: number;
  /** Target sink rate at touchdown (m/s, positive). */
  vTouch: number;
  /** Height (wheel bottom above surface) where the constant-sink flare begins. */
  hFlare: number;
  /** Velocity-loop gain (1/s). */
  kv: number;
  /**
   * Integral gain on the velocity error (1/s², 0 = off) once the profile is intercepted: removes the
   * steady sink-rate error of a mass/thrust mismatch (Monte Carlo ±10 % mass with a soft kv).
   */
  ki?: number;
}

export const DEFAULT_LANDING: LandingParams = { decel: 1.0 * G0, vTouch: 0.6, hFlare: 0.5, kv: 5.0 };

/** Reference vertical velocity (negative = down) over wheel height above the surface. */
export function landingVref(h: number, p: LandingParams): number {
  if (h <= p.hFlare) return -p.vTouch;
  return -Math.sqrt(p.vTouch * p.vTouch + 2 * p.decel * (h - p.hFlare));
}

/**
 * Desired world vertical acceleration: coasts (result < −g ⇒ no thrust) while the car is slower than
 * the braking profile, then tracks the profile with feedforward = profile deceleration.
 * The design decel is ≈ 1 g net while the lift jets can give ≈ 2 g net: the difference is the reserve.
 */
export function landingAccelY(h: number, vy: number, p: LandingParams, g = G0, intercepted = false): number {
  const vref = landingVref(h, p);
  // Feedforward = acceleration of the reference along the ACTUAL motion: d(vref)/dt = decel·vy/vref.
  // On the profile this is the design decel; a car that is ahead of the profile (sinking slower)
  // gets less, so it cannot be held hovering above the flare by the feedforward alone.
  const aff = h > p.hFlare ? p.decel * Math.max(0, Math.min(1.5, vy / vref)) : 0;
  const track = aff + p.kv * (vref - vy);
  // Pure coast while clearly slower than the profile (no early, gravity-loss-heavy burning);
  // blend into tracking over the last COAST_BLEND m/s before the profile is intercepted.
  // Once intercepted the profile is tracked linearly: re-blending towards coast whenever the car
  // is slightly ahead made long, low-g burns limit-cycle (dips, then catch-up peaks of +0.5 g).
  const e = vy - vref;
  if (e <= 0 || intercepted) return track;
  const w = Math.max(0, 1 - e / COAST_BLEND);
  return w * track + (1 - w) * -(g * 1.2 + 0.5); // below −g: no thrust
}

const COAST_BLEND = 0.8;
/** Clamp of the velocity-loop integrator (m/s²): covers a ±15 % thrust/mass mismatch. */
const INTEG_MAX = 2.0;

/** Wheel-bottom height above the surface below (assumes roughly upright). */
export const wheelHeight = (est: StateEstimate): number => est.height - ROADSTER.restCogHeightM;

/** Duty upper bounds: lift + yaw nozzles only (mains would push the car forward). */
export const MASK_NO_MAINS: readonly number[] = [0, 0, 0, 0, 1, 1, 1, 1, 1, 1];

export class Lander {
  params: LandingParams = { ...DEFAULT_LANDING };
  /** World forward direction to keep (heading). */
  readonly fwd = v3(0, 0, 1);
  /** Horizontal velocity target (world x/z); null = keep the along-heading speed, null the sideways drift. */
  horizTarget: { x: number; z: number } | null = null;
  kh = 1.2;
  maxTilt = 18 * DEG;
  /** Diagnostics */
  vref = 0; aCmd = 0; burning = false;
  /** The braking profile has been reached in this descent (latched until the car climbs again). */
  intercepted = false;
  /** Integral state of the velocity loop (m/s²) and the control step (s) it integrates with. */
  integ = 0;
  dt = 0;

  setHeadingFrom(q: { x: number; y: number; z: number; w: number }): void {
    const f = qrot(q, v3(0, 0, 1));
    const n = Math.hypot(f.x, f.z);
    if (n > 0.2) { this.fwd.x = f.x / n; this.fwd.y = 0; this.fwd.z = f.z / n; }
  }

  /**
   * World height of a flat landing plane (stunt sites: the pad, y = 0). When set, the profile height
   * is measured to this plane instead of the CoG ray, which also hits ramps, the Semi or car roofs
   * under the car: crossing their edges made the height jump and the burn oscillate. null = ray.
   */
  surfaceY: number | null = null;
  /** Upper bound for the profile deceleration (set from FlightControl.liftReserveAccel()). */
  maxDecel = Infinity;
  /** Local gravity magnitude (FlightControl.gMag); landing surfaces are horizontal (gravity along −Y). */
  g = G0;

  update(est: StateEstimate, mp: MassProps, cmd: FlightCommand): void {
    const h = this.surfaceY === null ? wheelHeight(est) : est.pos.y - this.surfaceY - ROADSTER.restCogHeightM;
    const design = this.params.decel;
    if (this.maxDecel < Infinity) this.params.decel = Math.max(0.15 * G0, Math.min(design, 0.6 * this.maxDecel));
    const g = this.g;
    this.vref = landingVref(h, this.params);
    if (est.vel.y > 0.5) { this.intercepted = false; this.integ = 0; }
    else if (est.vel.y <= this.vref) this.intercepted = true;
    let ay = landingAccelY(h, est.vel.y, this.params, g, this.intercepted);
    const ki = this.params.ki ?? 0;
    if (ki > 0 && this.intercepted && this.dt > 0) {
      this.integ = Math.max(-INTEG_MAX, Math.min(INTEG_MAX, this.integ + ki * (this.vref - est.vel.y) * this.dt));
      ay += this.integ;
    }
    this.params.decel = design;
    this.aCmd = ay;
    let ax: number, az: number;
    if (this.horizTarget) {
      ax = this.kh * (this.horizTarget.x - est.vel.x);
      az = this.kh * (this.horizTarget.z - est.vel.z);
    } else {
      // wheels must meet the ground without sideways slip: cancel the velocity across the heading
      const lat = est.vel.x * this.fwd.z - est.vel.z * this.fwd.x;   // component along (fwd.z, 0, −fwd.x)
      ax = -this.kh * lat * this.fwd.z;
      az = this.kh * lat * this.fwd.x;
    }
    const fy = mp.mass * (ay + g);
    cmd.levels = LEVELS.landing;
    cmd.hi = MASK_NO_MAINS;
    cmd.att.w.x = cmd.att.w.y = cmd.att.w.z = 0;
    cmd.att.a.x = cmd.att.a.y = cmd.att.a.z = 0;
    if (fy <= 0.05 * mp.mass * Math.max(g, 0.5)) {
      // coast: wheels down, no thrust
      this.burning = false;
      cmd.force.x = cmd.force.y = cmd.force.z = 0;
      quatFromUpForward(v3(0, 1, 0), this.fwd, cmd.att.q);
      return;
    }
    this.burning = true;
    // limit tilt: |a_h| ≤ tan(maxTilt)·(a_y + g)
    const ahMax = Math.tan(this.maxTilt) * (ay + g);
    const ah = Math.hypot(ax, az);
    if (ah > ahMax) { ax *= ahMax / ah; az *= ahMax / ah; }
    const F: Vec3 = v3(mp.mass * ax, fy, mp.mass * az);
    cmd.force.x = F.x; cmd.force.y = F.y; cmd.force.z = F.z;
    quatFromUpForward(v3norm(F), this.fwd, cmd.att.q);
  }
}

/** Upright attitude with a given world-forward heading, zero force (coast / attitude hold). */
export function holdUpright(fwd: Vec3, cmd: FlightCommand): void {
  quatFromUpForward(v3(0, 1, 0), fwd, cmd.att.q);
  cmd.att.w.x = cmd.att.w.y = cmd.att.w.z = 0;
  cmd.att.a.x = cmd.att.a.y = cmd.att.a.z = 0;
  cmd.force.x = cmd.force.y = cmd.force.z = 0;
  cmd.levels = LEVELS.rotate;
}
