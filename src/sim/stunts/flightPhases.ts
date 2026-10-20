// Reusable airborne phases: continuous-angle rotation, landing burn, rollout.
import { DEG, qrot, v3, type Quat, type Vec3 } from '@shared/math';
import { ROADSTER } from '@shared/roadster';
import { LEVELS } from '../gnc/allocator';
import { quatFromUpForward } from '../gnc/attitude';
import { MASK_NO_MAINS } from '../gnc/guidance';
import { newFlightCommand } from '../gnc/flight';
import { AngleProfile, RotationTrajectory, relativeAxisAngle } from '../gnc/trajectory';
import type { Phase, Stunt } from './base';

export interface RotateOptions {
  /** Body axis of the rotation (e.g. +Z = roll / kickflip). */
  axis: Vec3;
  angleRad: number;
  rateRadS: number;
  accelRadS2: number;
  /** Reference attitude at θ = 0 (evaluated on phase entry). */
  q0: () => Quat;
  /**
   * Optional end attitude: the rotation then starts at the CURRENT attitude and turns about the
   * single body axis that reaches `target` (shortest rotation; axis/angle/q0 above are ignored
   * except for the sign convention of `axis`, which picks the turning direction near 180°).
   */
  target?: () => Quat;
  next: string;
  /** Give up the rotation (go straight to `bail`) below this wheel height while far from done. */
  bailHeightM?: number;
  bail?: string;
  /** Phase is complete when the trajectory is done and the attitude error is below this. */
  doneErrRad?: number;
  /**
   * Hold the ballistic velocity of the phase entry (gain 1/s). The torque pulses of a roll come with
   * jet force; while the car is upside down the same jets can push down and cancel the extra lift.
   */
  ballisticGain?: number;
  /**
   * Landing overlay: in the last part of the rotation (wheels within ≈ 90° of down) the landing
   * guidance may already brake, so a late rotation never eats the braking height. World heading.
   */
  landingFwd?: () => Vec3;
}

const scratch = newFlightCommand();

/** Rotation about a fixed body axis with a continuous winding angle (torque pulse, coast, counter pulse). */
export function rotatePhase(st: Stunt, o: RotateOptions): Phase {
  let tr: RotationTrajectory | null = null;
  let totalAngle = o.angleRad;
  const v0 = v3(), t0 = { t: 0 };
  return {
    enter() {
      if (o.target) {
        const r = relativeAxisAngle(st.est.q, o.target());
        // near 180° both directions are equally short: turn the way `axis` points
        const flip = r.axis.x * o.axis.x + r.axis.y * o.axis.y + r.axis.z * o.axis.z < 0 && r.angle > 150 * DEG;
        const axis = flip ? v3(-r.axis.x, -r.axis.y, -r.axis.z) : r.axis;
        const angle = flip ? 2 * Math.PI - r.angle : r.angle;
        tr = new RotationTrajectory(st.est.q, axis, new AngleProfile(angle, o.rateRadS, o.accelRadS2), st.t);
        totalAngle = angle;
      } else {
        tr = new RotationTrajectory(o.q0(), o.axis, new AngleProfile(o.angleRad, o.rateRadS, o.accelRadS2), st.t);
        totalAngle = o.angleRad;
      }
      v0.x = st.est.vel.x; v0.y = st.est.vel.y; v0.z = st.est.vel.z; t0.t = st.t;
    },
    update() {
      const traj = tr!;
      traj.sample(st.t, st.cmd.att);
      st.cmd.force.x = st.cmd.force.y = st.cmd.force.z = 0;
      if (o.ballisticGain) {
        const k = o.ballisticGain * st.fc.mp.mass, dt = st.t - t0.t;
        const g = st.fc.g;
        st.cmd.force.x = k * (v0.x + g.x * dt - st.est.vel.x);
        st.cmd.force.y = k * (v0.y + g.y * dt - st.est.vel.y);
        st.cmd.force.z = k * (v0.z + g.z * dt - st.est.vel.z);
      }
      st.cmd.levels = LEVELS.rotate;
      st.cmd.hi = MASK_NO_MAINS;
      st.drive.throttle = 0; st.drive.brake = 0;
      const frac = Math.abs(traj.theta(st.t)) / Math.abs(totalAngle);
      if (o.landingFwd && Math.abs(totalAngle) - Math.abs(traj.theta(st.t)) < Math.PI / 2 && st.est.vel.y < 0) {
        const f = o.landingFwd();
        st.lander.fwd.x = f.x; st.lander.fwd.y = 0; st.lander.fwd.z = f.z;
        st.lander.horizTarget = null;
        st.lander.maxDecel = st.fc.liftReserveAccel();
        st.lander.g = st.fc.gMag;
        st.lander.update(st.est, st.fc.mp, scratch);
        if (st.lander.burning) { st.cmd.force.x = scratch.force.x; st.cmd.force.y = scratch.force.y; st.cmd.force.z = scratch.force.z; }
      }
      st.fly();
      if (o.bail && o.bailHeightM !== undefined && frac < 0.85 && st.wheelsHeight() < o.bailHeightM && st.est.vel.y < 0) {
        st.emit('abort', `rotation bailed at ${(frac * 100).toFixed(0)} %: too low`);
        return o.bail;
      }
      if (traj.done(st.t) && st.fc.att.errAngle < (o.doneErrRad ?? 12 * DEG)) return o.next;
      if (traj.done(st.t) && st.t > traj.endTime + 1.0) return o.next; // never hang in this phase
      return null;
    },
  };
}

/**
 * Landing burn until touchdown, then a short "settle": the jets keep carrying what the suspension
 * does not yet carry (load-cell feedback) and brake the remaining sink, fading out over SETTLE_S.
 * This hands the weight over to the wheels smoothly instead of a damper spike.
 */
export function landingPhase(st: Stunt, next: string, fwd: () => Vec3, horiz?: () => { x: number; z: number } | null): Phase {
  let touchT = -1;
  return {
    enter() {
      const f = fwd();
      st.lander.fwd.x = f.x; st.lander.fwd.y = 0; st.lander.fwd.z = f.z;
      touchT = -1;
    },
    update() {
      st.lander.horizTarget = horiz ? horiz() : null;
      st.lander.maxDecel = st.fc.liftReserveAccel();
      st.lander.g = st.fc.gMag;
      st.lander.update(st.est, st.fc.mp, st.cmd);
      st.drive.throttle = 0; st.drive.brake = 0;
      if (touchT < 0) {
        // touchdown: wheels on a surface while roughly upright, or the body touching close to the ground
        if ((st.est.groundContact && st.upY() > 0.3) || (st.est.bodyContact && st.wheelsHeight() < 0.3)) {
          st.markTouchdown();
          touchT = st.t;
        }
      }
      if (touchT >= 0) {
        const u = (st.t - touchT) / SETTLE_S;
        if (u >= 1 || !st.est.groundContact) return next;
        const m = st.fc.mp.mass;
        const g = st.fc.gMag;
        // carry the weight the springs do not carry yet; the remaining sink is left to the
        // suspension (a jet sink-brake term on top of the rising wheel load made the impact peak)
        const fy = (m * (g + SETTLE_KV * (0 - st.est.vel.y)) - st.est.wheelLoadN) * (1 - u);
        const fyc = Math.max(0, Math.min(1.5 * m * Math.max(g, 1), fy));
        st.cmd.force.x = 0; st.cmd.force.y = fyc; st.cmd.force.z = 0;
        if (fyc <= 0) return null;
      }
      st.fly();
      return null;
    },
  };
}

const SETTLE_S = 0.35;
const SETTLE_KV = 0.5;

/** Level, upright attitude with the current heading (or a given forward). */
export function levelAttitude(st: Stunt, fwd?: Vec3): Quat {
  const f = fwd ?? qrot(st.est.q, v3(0, 0, 1));
  const h = Math.hypot(f.x, f.z) > 0.1 ? v3(f.x, 0, f.z) : qrot(st.est.q, v3(0, 1, 0)); // nose straight up/down: use roof
  return quatFromUpForward(v3(0, 1, 0), h);
}

/**
 * Safety net: the car left the surface unplanned (fell off the wall, bounced). Auto-righting +
 * landing guidance, then the stunt is reported as failed (but the car is saved).
 */
export function rescuePhases(st: Stunt, reason: string, fwd: () => Vec3, horiz?: () => { x: number; z: number } | null): Record<string, Phase> {
  const land = landingPhase(st, 'rescued', fwd, horiz);
  return {
    rescue: {
      enter() {
        st.emit('abort', reason);
        st.systems.fanMode = 'off';
        st.lander.surfaceY = null; // unplanned: the car may come down on the ramp itself (CoG ray)
        st.markLiftoff('liftoff');
        land.enter?.();
      },
      update: () => land.update(),
    },
    rescued: {
      update() { st.brakeToStop(); st.fail(`${reason} (car recovered)`); return null; },
    },
  };
}

/**
 * Pre-flight valve test (BIT) on the ground, brakes held: every valve gets one minimum-length pulse
 * (duty 1 for PULSE_S), one at a time, and must show an opening on the valve position
 * feedback (propulsion.dutyActual). Before the pulses all valves are checked for stuck-open.
 * Faults go to FlightControl.valveFault (the allocator masks them). If a valve in `required` fails,
 * the stunt is aborted on the ground ('abort_valve'). Cost ≈ 4 kg of air (10 pulses of ≈ 17 ms).
 */
export function valveTestPhases(st: Stunt, next: string, required: readonly number[]): Record<string, Phase> {
  const N = st.thrust.duty.length;
  let slot = -1, k = 0, seen = false;
  // step counts from times: the test must not depend on the sim rate (120/240/480 Hz convergence runs)
  const PULSE_STEPS = Math.max(1, Math.ceil(PULSE_S / st.sim.dt - 1e-9));
  const SLOT = PULSE_STEPS + Math.max(1, Math.ceil(SETTLE_S_BIT / st.sim.dt - 1e-9));
  const QUIET_STEPS = Math.max(2, Math.ceil(QUIET_S / st.sim.dt - 1e-9));
  return {
    precheck: {
      enter() { slot = -1; k = 0; seen = false; },
      update() {
        st.brakeToStop();
        const act = st.sim.propulsion.dutyActual, fault = st.fc.valveFault;
        if (slot < 0) {
          // all closed: any valve reporting open is stuck open
          if (k >= QUIET_STEPS - 1) for (let i = 0; i < N; i++) if (act[i] >= 0.999) fault[i] = 1;
          if (++k >= QUIET_STEPS) { slot = 0; k = 0; }
          return null;
        }
        if (slot >= N) {
          const bad = required.filter((i) => fault[i] !== 0);
          if (bad.length) return 'abort_valve';
          const any = Array.from(fault).some((f) => f !== 0);
          st.emit('info', any ? `valve test: faults ${Array.from(fault).join(',')} (not required, masked)` : 'valve test passed');
          return next;
        }
        if (fault[slot] === 0) {
          if (k < PULSE_STEPS) st.thrust.duty[slot] = 1;
          if (k > 0 && act[slot] > 0.5) seen = true;
        }
        if (++k >= SLOT) {
          if (fault[slot] === 0 && !seen) fault[slot] = -1;
          slot++; k = 0; seen = false;
        }
        return null;
      },
    },
    abort_valve: {
      enter() {
        const names = required.filter((i) => st.fc.valveFault[i] !== 0).map((i) => `${ROADSTER.nozzles[i].name} ${st.fc.valveFault[i] < 0 ? 'stuck closed' : 'stuck open'}`);
        st.emit('abort', `valve test failed: ${names.join(', ')}`);
        st.abortReason = `aborted: valve test failed (${names.join(', ')})`;
      },
      update() { st.brakeToStop(); if (st.est.speed < 0.2) st.fail(st.abortReason); return null; },
    },
  };
}

const PULSE_S = 1 / 60;     // 16.7 ms ≥ 15 ms minimum on-time (4 steps at 240 Hz)
const SETTLE_S_BIT = 0.025; // wait for the opening/closing delays before the next valve (6 steps at 240 Hz)
const QUIET_S = 1 / 60;     // all closed before the stuck-open check
/** Corner jets: every airborne stunt needs all four. */
export const LIFT_JETS: readonly number[] = [4, 5, 6, 7];
export const MAIN_JETS: readonly number[] = [0, 1, 2, 3];
