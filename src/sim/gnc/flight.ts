// Flight control chain shared by every airborne phase (auto + manual assist):
//   attitude reference + desired thrust force (world) -> body wrench -> hierarchical allocator -> duty.
import { G0, qrot, qrotInv, v3, type Quat, type Vec3 } from '@shared/math';
import type { RoadsterSim } from '../core/roadsterSim';
import { Allocator, LEVELS, type Levels } from './allocator';
import { AttitudeController, newAttitudeRef, quatFromUpForward, type AttitudeRef } from './attitude';
import type { StateEstimate } from './estimator';
import { newMassProps, nominalMassProps } from './massProps';
import { N_NOZ, WRENCH_DIM, buildEffectiveness } from './wrench';

export interface FlightCommand {
  att: AttitudeRef;
  /** Desired total thruster force, WORLD frame (N). Gravity is not included. */
  force: Vec3;
  levels: Levels;
  /** Optional upper duty bound per nozzle (masking); null = all 1. */
  hi?: ArrayLike<number> | null;
  /**
   * Yaw only with the yaw jets: the yaw moment demand is clipped to what one yaw jet gives. Without a lift
   * bias (free space, coasting) the allocator would otherwise take the missing yaw moment from the 12° cant
   * of a diagonal corner pair, i.e. ≈ 30 kN along the roof for every yaw input (manual free-space control).
   */
  yawJetsOnly?: boolean;
}

export const newFlightCommand = (): FlightCommand => ({ att: newAttitudeRef(), force: v3(), levels: LEVELS.balanced, hi: null });

/** Angular acceleration (rad/s²) used to normalise moment errors. */
const ALPHA_REF = 1.0;
/**
 * Valve dynamics on the GNC side. The core valve layer turns duty into pulses by impulse-error
 * accumulation (sigma-delta) with 15 ms minimum on-time and 8/6 ms delays, which is unbiased on
 * average. GNC therefore (1) drops requests below the minimum-impulse resolution (deadband),
 * (2) smooths duty with the allocator's Δduty penalty, (3) closes the loop on measured motion and
 * (4) integrates each valve's open-fraction error (allocator duty − valve position feedback
 * propulsion.dutyActual) into a per-valve duty offset. Unequal opening/closing delays make every
 * PWM pulse shorter or longer than requested (Monte Carlo: 4–16 ms opening vs 3–12 ms closing) —
 * an additive bias that vanishes at duty 1 (no pulsing), so an offset fits better than a gain.
 * Tested alternatives (forcing duty = 1 during min-on; a multiplicative efficiency in the
 * effectiveness matrix) biased the sigma-delta or capped the thrust and were removed.
 */
const DUTY_DEADBAND = 0.02;
const UP_Y = v3(0, 1, 0), FWD_Z = v3(0, 0, 1);
/**
 * Yaw spin reference for the rear-corner-failure landing (rad/s). The pair's own yaw couple overshoots
 * it (≈ 4 rad/s at touchdown); the tyres stop the spin within ≈ 2 s (tools/gnc/fault.tool.ts).
 */
let SPIN_RATE = 2.5;
/** Tooling only (sweeps). */
export function setSpinRate(w: number): void { SPIN_RATE = w; }
/** Time constant of the per-valve offset integrator (s). */
const VALVE_OFFSET_TAU = 0.12;

export class FlightControl {
  readonly alloc = new Allocator();
  readonly att = new AttitudeController();
  readonly mp = newMassProps();
  readonly B = new Float64Array(WRENCH_DIM * N_NOZ);
  readonly thrust = new Float64Array(N_NOZ);
  readonly wrench = new Float64Array(WRENCH_DIM);
  readonly scale = new Float64Array(WRENCH_DIM);
  readonly moment = v3();
  /** Gravity of the current environment (world frame, from sim.gravity) and its magnitude. */
  readonly g = v3(0, -G0, 0);
  gMag = G0;
  private readonly fb = v3();
  private readonly sim: RoadsterSim;
  /** Valves diagnosed as stuck: -1 closed, +1 open, 0 healthy (valve position feedback). */
  readonly valveFault = new Int8Array(N_NOZ);
  private readonly faultTimer = new Float64Array(N_NOZ);
  /** Learned duty offset per valve (compensates delay-induced PWM pulse loss/gain). */
  readonly valveOffset = new Float64Array(N_NOZ);
  private readonly lastWant = new Float64Array(N_NOZ);

  constructor(sim: RoadsterSim) { this.sim = sim; }

  reset(): void {
    this.alloc.reset();
    this.valveOffset.fill(0); this.lastWant.fill(0); this.valveFault.fill(0); this.faultTimer.fill(0);
  }

  /** Lift acceleration (m/s², net of gravity) available upright with the healthy corner jets, wheels-down balanced. */
  liftReserveAccel(): number {
    let healthy = 0, T = 0;
    for (let i = 4; i < 8; i++) if (this.valveFault[i] !== -1) { healthy++; T = Math.max(T, this.thrust[i]); }
    // a lost corner leaves its diagonal partner as the only balanced pair
    const pairs = healthy === 4 ? 4 : healthy >= 2 ? 2 : 0;
    return (pairs * T * Math.cos(12 * Math.PI / 180)) / this.mp.mass - this.gMag;
  }

  /**
   * Call once per step after the duty for this step was set (also when it is all zeros):
   * integrates the previous step's open-fraction error from the valve position feedback.
   */
  observe(duty: ArrayLike<number>): void {
    const act = this.sim.propulsion.dutyActual, a = this.sim.dt / VALVE_OFFSET_TAU;
    for (let i = 0; i < N_NOZ; i++) {
      const want = this.lastWant[i];
      if (want > DUTY_DEADBAND && want < 0.999) {
        this.valveOffset[i] = Math.max(-0.3, Math.min(0.5, this.valveOffset[i] + (want - act[i]) * a));
      }
      // fault detection: commanded fully open but no opening for 60 ms (or the reverse)
      const stuckClosed = this.lastSent[i] >= 0.999 && act[i] === 0;
      const stuckOpen = this.lastSent[i] === 0 && act[i] === 1;
      if (stuckClosed || stuckOpen) {
        this.faultTimer[i] += this.sim.dt;
        if (this.faultTimer[i] > 0.06 && this.valveFault[i] === 0) this.valveFault[i] = stuckClosed ? -1 : 1;
      } else this.faultTimer[i] = 0;
      this.lastSent[i] = duty[i];
      // what the allocator wanted this step (before the offset); outside a flight step: 0
      this.lastWant[i] = this.wantThisStep ? this.want[i] : duty[i];
    }
    this.wantThisStep = false;
  }
  private readonly want = new Float64Array(N_NOZ);
  private readonly freeYawQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly freeYawRef: AttitudeRef = newAttitudeRef();
  private readonly spinW = v3();
  private readonly lastSent = new Float64Array(N_NOZ);
  private wantThisStep = false;

  /** Refresh mass properties and the effectiveness matrix (call once per control step). */
  refresh(est: StateEstimate): void {
    nominalMassProps(est.airKg, this.mp);
    const sg = this.sim.gravity;
    this.g.x = sg.x; this.g.y = sg.y; this.g.z = sg.z;
    this.gMag = Math.hypot(sg.x, sg.y, sg.z);
    this.sim.propulsion.availableThrust(this.thrust);
    buildEffectiveness(this.mp.com, this.thrust, this.B);
    const mg = this.mp.mass * G0, I = this.mp.inertia; // normalisation only (Earth weight as unit)
    this.scale[0] = mg; this.scale[1] = mg; this.scale[2] = mg;
    this.scale[3] = I.x * ALPHA_REF; this.scale[4] = I.y * ALPHA_REF; this.scale[5] = I.z * ALPHA_REF;
  }

  /** A corner (lift) jet is known to be stuck closed. */
  liftFault(): boolean {
    for (let i = 4; i < 8; i++) if (this.valveFault[i] === -1) return true;
    return false;
  }

  compute(est: StateEstimate, cmd: FlightCommand, out: Float32Array): Float32Array {
    this.refresh(est);
    // Known corner-jet failure during a landing: the remaining diagonal pair's 12° cant makes a yaw
    // couple (≈ 2·T·sin 12°·1.4 m ≈ 8.7 kN·m at full lift) that the two 3 kN yaw jets (≈ 6 kN·m) cannot
    // cancel. Holding the heading would let the (lower-priority) yaw demand bend the lift force through
    // the allocator's soft lock and stall the descent. Instead the heading is released (reference yaw
    // = current yaw) and the yaw demand is clipped to what the yaw jets can do: the car lands turning
    // slowly, wheels down, at the planned sink rate.
    let ref = cmd.att;
    const faulted = cmd.levels === LEVELS.landing && this.liftFault();
    if (faulted) {
      const up = qrot(cmd.att.q, UP_Y), f = qrot(est.q, FWD_Z);
      quatFromUpForward(up, f, this.freeYawQ);
      this.freeYawRef.q = this.freeYawQ; this.freeYawRef.w = cmd.att.w; this.freeYawRef.a = cmd.att.a;
      if (this.valveFault[6] === -1 || this.valveFault[7] === -1) {
        // rear corner lost: spin up in the sense of the pair's own yaw couple (spin stabilisation)
        let my = 0;
        for (let i = 4; i < 8; i++) if (this.valveFault[i] !== -1) my += this.B[4 * N_NOZ + i];
        this.spinW.x = 0; this.spinW.y = Math.sign(my) * SPIN_RATE; this.spinW.z = 0;
        this.freeYawRef.w = this.spinW;
      }
      ref = this.freeYawRef;
    }
    this.att.compute(est.q, est.wWorld, ref, this.mp.inertia, this.moment);
    if ((faulted && !(this.valveFault[6] === -1 || this.valveFault[7] === -1)) || cmd.yawJetsOnly) {
      const n = N_NOZ, yawMax = Math.abs(this.B[4 * n + 8]) + Math.abs(this.B[4 * n + 9]);
      this.moment.y = Math.max(-0.5 * yawMax, Math.min(0.5 * yawMax, this.moment.y));
    }
    qrotInv(est.q, cmd.force, this.fb);
    const w = this.wrench;
    w[0] = this.fb.x; w[1] = this.fb.y; w[2] = this.fb.z;
    w[3] = this.moment.x; w[4] = this.moment.y; w[5] = this.moment.z;
    const hi = cmd.hi ?? null;
    for (let i = 0; i < N_NOZ; i++) {
      const f = this.valveFault[i];
      this.alloc.hi[i] = f === -1 ? 0 : f === 1 ? 1 : hi ? Math.max(0, Math.min(1, hi[i])) : 1;
      this.alloc.lo[i] = f === 1 ? 1 : 0; // a stuck-open valve is planned as a fixed force
    }
    const rearFault = faulted && (this.valveFault[6] === -1 || this.valveFault[7] === -1);
    const d = this.alloc.solve(this.B, w, this.scale, rearFault ? LEVELS.landingRearFault : cmd.levels);
    for (let i = 0; i < N_NOZ; i++) {
      const wnt = d[i] < DUTY_DEADBAND ? 0 : d[i];
      this.want[i] = wnt;
      out[i] = wnt > 0 && wnt < 0.999 ? Math.max(0, Math.min(1, wnt + this.valveOffset[i])) : wnt;
    }
    this.wantThisStep = true;
    return out;
  }
}
