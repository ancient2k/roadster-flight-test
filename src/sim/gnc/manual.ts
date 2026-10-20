// Manual thruster assistance for free play, independent of gravity and atmosphere.
import { DEG, clamp, qaxisAngle, qmul, qrot, qrotInv, v3, type Quat, type Vec3 } from '@shared/math';
import { ROADSTER } from '@shared/roadster';
import { NOZZLE_COUNT, type AssistLevel, type ThrusterCommand } from '@shared/types';
import type { RoadsterSim } from '../core/roadsterSim';
import { LEVELS } from './allocator';
import { quatFromUpForward } from './attitude';
import { Estimator, type StateEstimate } from './estimator';
import { FlightControl, newFlightCommand } from './flight';
import { Lander, MASK_NO_MAINS, landingVref } from './guidance';
import { DEFAULT_DECEL, estimateReserve, type ReserveEstimate } from './reserve';
import { relativeAxisAngle } from './trajectory';

export interface ManualAxes { lift: number; boost: number; pitch: number; roll: number; yaw: number }

/** Read by the HUD every frame. */
export interface ManualStatus {
  /** Remaining air is close to what a safe landing needs (warning). */
  lowAir: boolean;
  /** ASSIST took over and is landing (lift requests ignored until touchdown). */
  autoLand: boolean;
  /** Free space: part of the velocity error the jets cannot reach in the held attitude (turn the car). */
  unreachableDvMs: number;
  /** No usable gravity: ASSIST holds attitude AND velocity. */
  zeroG: boolean;
  airKg: number;
  reserveKg: number;
  /** Highest wheel height the remaining air still covers (ASSIST climb limit). */
  maxAltitudeM: number;
  /** HUD phase id (translated by the UI, see phase.* in src/i18n) also written to sim.setPhaseLabel. */
  label: '' | 'LOW_AIR' | 'AUTOLAND' | 'ROTATE';
}

const ZERO_G = 0.05;           // m/s²
const LOW_AIR_FACTOR = 1.3;    // warn below 1.3 · reserve + 10 kg
const LOW_AIR_ADD_KG = 10;
const TRANSLATE_ACCEL = 2.0;   // m/s² per full stick, free-space ASSIST
/** Free-space deadbands (minimum impulse bit of the valves, see space()). */
const ATT_DEADBAND = 5 * DEG;
/**
 * Below the rate resolution of one minimum valve pulse (15 ms: ≈ 0.16–0.3 rad/s pitch, ≈ 0.45 rad/s
 * roll for a side pair), so the attitude hold is a limit cycle; every pulse also pushes along the
 * roof: ≈ 0.15–0.2 m/s per second of velocity drift while holding attitude (R1 measurement,
 * tools/gnc/space.tool.ts; 8° / 0.3 rad/s bands give the same drift). Hardware limit, see
 * docs/PHYSICS.md (vernier pressure stage or small RCS jets proposed).
 */
const RATE_DEADBAND = 0.15;    // rad/s
const VEL_DEADBAND = 0.12;     // m/s

/**
 * Manual thruster assistance.
 *  RAW:        direct nozzle groups (lift = 4 corner jets, boost = 4 mains, pitch/roll = corner
 *              differential, yaw = front yaw jets). No protection.
 *  STABILIZED: rate command (stick = body rate), lift/boost = body force, allocator does the mixing.
 *              Low-air warning only.
 *  ASSIST with gravity: attitude hold + auto-righting (pitch/roll stick = tilt, yaw stick = heading
 *              rate), lift stick = climb-rate command with automatic soft landing near the ground,
 *              climb limited to the height the remaining air can still land from, and automatic
 *              landing when the air reaches the landing reserve (+25 %).
 *  ASSIST in free space (|g| < 0.05 m/s²): attitude hold + velocity hold over the jets (lift/boost
 *              sticks move the velocity target) inside RCS-style deadbands (5°, 0.15 rad/s, 0.12 m/s).
 *              Velocity errors the jets cannot reach in the held attitude (−Y, −Z) are reported
 *              (status.unreachableDvMs, label 'ROTATE'); the pilot turns the car (see space()).
 * Axes: lift/pitch/roll/yaw in −1..1, boost 0..1. pitch +1 = nose up, roll +1 = right side down,
 * yaw +1 = nose right.
 */
export class ManualAssist {
  maxRate = { pitch: 1.5, roll: 3.0, yaw: 1.0 };      // rad/s (STABILIZED, free-space ASSIST)
  maxTilt = 25 * DEG;                                   // ASSIST
  maxClimb = 6;                                         // m/s (ASSIST)
  maxSink = 5;
  readonly status: ManualStatus = {
    lowAir: false, autoLand: false, unreachableDvMs: 0, zeroG: false, airKg: 0, reserveKg: 0, maxAltitudeM: Infinity, label: '',
  };
  private fc: FlightControl | null = null;
  private sim: RoadsterSim | null = null;
  private readonly est = new Estimator(null);
  private readonly cmd = newFlightCommand();
  private readonly lander = new Lander();
  private readonly out: ThrusterCommand = { duty: new Float32Array(NOZZLE_COUNT) };
  private readonly reserve: ReserveEstimate = { reserveKg: 0, floorKg: 0, veMs: 0, maxHeightM: Infinity };
  private headingQ: Quat | null = null;
  private heldQ: Quat | null = null;
  private vRef: Vec3 | null = null;
  private level: AssistLevel | null = null;
  private belowReserveS = 0;
  private heldSettled = false;
  private calmS = 0;
  /** ASSIST: lift/boost was commanded since the last ground contact (height hold active). */
  private flying = true;

  reset(): void {
    this.headingQ = null; this.heldQ = null; this.vRef = null; this.level = null; this.heldSettled = false; this.calmS = 0; this.flying = true;
    this.status.autoLand = false; this.status.unreachableDvMs = 0;
    this.fc?.reset();
  }

  update(sim: RoadsterSim, axes: ManualAxes, level: AssistLevel): ThrusterCommand {
    if (this.sim !== sim || !this.fc) { this.sim = sim; this.fc = new FlightControl(sim); this.reset(); }
    if (level !== this.level) {
      // a mode switch is a deliberate pilot action: in the air ASSIST takes over at once (on the ground the
      // parked branch clears `flying` again)
      this.level = level; this.headingQ = null; this.heldQ = null; this.vRef = null; this.heldSettled = false; this.calmS = 0; this.flying = true;
      this.status.autoLand = false; this.status.unreachableDvMs = 0;
      this.fc.reset();
    }
    const fc = this.fc;
    const d = this.out.duty;
    d.fill(0);
    const a: ManualAxes = {
      lift: clamp(axes.lift || 0, -1, 1), boost: clamp(axes.boost || 0, 0, 1),
      pitch: clamp(axes.pitch || 0, -1, 1), roll: clamp(axes.roll || 0, -1, 1), yaw: clamp(axes.yaw || 0, -1, 1),
    };
    const e = this.est.update(sim.getState());
    fc.refresh(e);
    this.updateStatus(e, level);
    if (level === 'RAW') this.raw(a);
    else if (level === 'STABILIZED') this.stabilized(e, a);
    else if (this.status.zeroG) this.space(e, a);
    else this.assist(e, a);
    fc.observe(d);
    sim.setPhaseLabel(this.status.label);
    return this.out;
  }

  // ---------------------------------------------------------------- status / reserve

  private updateStatus(e: StateEstimate, level: AssistLevel): void {
    const fc = this.fc!, st = this.status;
    const g = fc.gMag;
    st.zeroG = g < ZERO_G;
    st.airKg = e.airKg;
    if (st.zeroG) {
      st.reserveKg = 0; st.maxAltitudeM = Infinity; st.lowAir = e.airKg < LOW_AIR_ADD_KG; st.autoLand = false;
    } else {
      const decel = Math.min(DEFAULT_DECEL, 0.6 * Math.max(0.1, fc.liftReserveAccel()));
      const h = Math.max(0, e.height - ROADSTER.restCogHeightM);
      estimateReserve(this.sim!, fc.mp.mass, g, decel, h, e.vel.y, this.reserve);
      st.reserveKg = this.reserve.reserveKg;
      st.maxAltitudeM = this.reserve.maxHeightM;
      st.lowAir = e.airKg < LOW_AIR_FACTOR * st.reserveKg + LOW_AIR_ADD_KG;
      // latch after 0.25 s below the reserve (a single noisy estimate must not trigger it)
      this.belowReserveS = e.airKg < st.reserveKg && !e.groundContact ? this.belowReserveS + this.sim!.dt : 0;
      if (e.groundContact) st.autoLand = false;
      else if (level === 'ASSIST' && this.belowReserveS > 0.25) st.autoLand = true;
    }
    st.label = level === 'RAW' ? ''
      : st.autoLand && level === 'ASSIST' ? 'AUTOLAND'
        : st.zeroG && level === 'ASSIST' && st.unreachableDvMs > 0.5 ? 'ROTATE'
          : st.lowAir ? 'LOW_AIR' : '';
  }

  // ---------------------------------------------------------------- RAW

  private raw(a: ManualAxes): void {
    const d = this.out.duty;
    const lift = Math.max(0, a.lift);
    // corner jets: 4 FL, 5 FR, 6 RL, 7 RR (+X = left). pitch +1 = nose up -> more front lift.
    const corner = (front: number, left: number) => clamp(lift + 0.5 * a.pitch * front + 0.5 * a.roll * left, 0, 1);
    d[4] = corner(1, 1); d[5] = corner(1, -1); d[6] = corner(-1, 1); d[7] = corner(-1, -1);
    for (let i = 0; i < 4; i++) d[i] = a.boost;
    // YAW_L (8) pushes the nose right
    d[8] = Math.max(0, a.yaw); d[9] = Math.max(0, -a.yaw);
  }

  // ---------------------------------------------------------------- STABILIZED

  private stabilized(e: StateEstimate, a: ManualAxes): void {
    const fc = this.fc!, cmd = this.cmd;
    // rate command: reference = current attitude, desired body rate from the sticks
    cmd.att.q.x = e.q.x; cmd.att.q.y = e.q.y; cmd.att.q.z = e.q.z; cmd.att.q.w = e.q.w;
    cmd.att.w.x = -a.pitch * this.maxRate.pitch;   // nose up = −X
    cmd.att.w.y = -a.yaw * this.maxRate.yaw;       // nose right = −Y
    cmd.att.w.z = a.roll * this.maxRate.roll;      // right side down = +Z
    cmd.att.a.x = cmd.att.a.y = cmd.att.a.z = 0;
    const liftMax = this.liftMaxN(), mainMax = this.mainMaxN();
    const fw = qrot(e.q, v3(0, Math.max(0, a.lift) * liftMax, a.boost * mainMax));
    cmd.force.x = fw.x; cmd.force.y = fw.y; cmd.force.z = fw.z;
    cmd.levels = LEVELS.balanced;
    cmd.hi = null;
    if (a.lift <= 0 && a.boost <= 0 && Math.abs(a.pitch) + Math.abs(a.roll) + Math.abs(a.yaw) < 0.02) return;
    fc.compute(e, cmd, this.out.duty);
  }

  // ---------------------------------------------------------------- ASSIST with gravity

  private assist(e: StateEstimate, a: ManualAxes): void {
    const fc = this.fc!, cmd = this.cmd, st = this.status, m = fc.mp.mass, g = fc.gMag;
    const onGround = e.groundContact;
    const f = qrot(e.q, v3(0, 0, 1));
    if (!this.headingQ) {
      const n = Math.hypot(f.x, f.z);
      this.headingQ = quatFromUpForward(v3(0, 1, 0), n > 0.2 ? v3(f.x / n, 0, f.z / n) : v3(0, 0, 1));
    }
    if (st.autoLand) {
      // automatic landing: the landing guidance of the stunts, heading kept, sticks ignored
      const hf = qrot(this.headingQ, v3(0, 0, 1));
      this.lander.fwd.x = hf.x; this.lander.fwd.y = 0; this.lander.fwd.z = hf.z;
      this.lander.horizTarget = null;
      this.lander.g = g;
      this.lander.maxDecel = fc.liftReserveAccel();
      this.lander.update(e, fc.mp, cmd);
      fc.compute(e, cmd, this.out.duty);
      return;
    }
    if (onGround && a.lift <= 0.05 && a.boost <= 0) { this.headingQ = null; this.flying = false; return; } // parked: no jets
    // Driving over a crest or a bump lifts the wheels for a moment: that is not a flight. The height hold only
    // engages once the pilot has used the lift, boost or attitude controls since the last ground contact (else the car would
    // hover across the summit of a pyramid instead of settling back onto its wheels).
    if (Math.abs(a.lift) > 0.05 || a.boost > 0 || Math.abs(a.pitch) + Math.abs(a.roll) + Math.abs(a.yaw) > 0.05) this.flying = true;
    if (!this.flying) { this.headingQ = null; return; }
    // integrate heading from the yaw stick
    this.headingQ = qmul(qaxisAngle(v3(0, 1, 0), -a.yaw * this.maxRate.yaw * this.sim!.dt), this.headingQ);
    const tilt = qmul(qaxisAngle(v3(1, 0, 0), -a.pitch * this.maxTilt), qaxisAngle(v3(0, 0, 1), a.roll * this.maxTilt));
    qmul(this.headingQ, tilt, cmd.att.q);
    cmd.att.w.x = cmd.att.w.y = cmd.att.w.z = 0;
    cmd.att.a.x = cmd.att.a.y = cmd.att.a.z = 0;
    // climb-rate command with automatic soft landing and the air-based height limit
    const h = Math.max(0, e.height - ROADSTER.restCogHeightM);
    // climb rate a coast can stop within ≈ 3 m (no downward jets: only gravity brakes a climb)
    const climbMax = Math.min(this.maxClimb, Math.sqrt(2 * g * 3));
    let vyRef = a.lift >= 0 ? a.lift * climbMax : a.lift * this.maxSink;
    if (vyRef < 0) vyRef = Math.max(vyRef, landingVref(h, { decel: 0.7 * Math.min(g, 9.81), vTouch: 0.6, hFlare: 0.8, kv: 4 }));
    const hMax = st.maxAltitudeM;
    const vyMax = h < hMax ? Math.sqrt(2 * g * (hMax - h)) : -0.5;   // ballistic stop at hMax
    vyRef = Math.min(vyRef, vyMax);
    const up = qrot(cmd.att.q, v3(0, 1, 0));
    const fy = m * (g + 4 * (vyRef - e.vel.y));
    const thrustMag = Math.max(0, fy) / Math.max(0.3, up.y);
    const fwdBody = qrot(e.q, v3(0, 0, 1));
    const boost = a.boost * this.mainMaxN();
    cmd.force.x = up.x * thrustMag + fwdBody.x * boost;
    cmd.force.y = up.y * thrustMag + fwdBody.y * boost;
    cmd.force.z = up.z * thrustMag + fwdBody.z * boost;
    cmd.levels = LEVELS.landing;
    cmd.hi = a.boost > 0 ? null : MASK_NO_MAINS;
    // Coasting (no lift wanted, e.g. braking a climb in low gravity): attitude pulses of the corner
    // jets would all push UP (minimum impulse ≈ 250 N·s), so hold attitude inside a deadband instead.
    if (thrustMag < 0.05 * m * Math.max(g, 0.5) && boost === 0) {
      const wb = qrotInv(e.q, e.wWorld);
      if (relativeAxisAngle(e.q, cmd.att.q).angle < ATT_DEADBAND && Math.hypot(wb.x, wb.y, wb.z) < RATE_DEADBAND) return;
    }
    fc.compute(e, cmd, this.out.duty);
  }

  // ---------------------------------------------------------------- ASSIST in free space

  /**
   * Free space: hold attitude and velocity. The ten jets only push along body +Y (corner jets),
   * +Z (mains) and ±X (yaw jets, corner-jet cant); there is no −Y/−Z thrust, and every rotation is
   * made of jet pulses that also translate the car (≈ 0.7 m/s per 90° roll). An automatic
   * "turn the roof towards the velocity error" mode was tried and does not converge: the turn costs
   * about as much Δv as it is meant to remove. ASSIST therefore holds the attitude (RCS-style
   * deadbands) and the velocity components the jets can reach in that attitude (+Y, ±X; +Z with the
   * boost stick); the rest is reported as `status.unreachableDvMs` so the pilot can turn the car.
   */
  private space(e: StateEstimate, a: ManualAxes): void {
    const fc = this.fc!, cmd = this.cmd, st = this.status, m = fc.mp.mass, dt = this.sim!.dt;
    if (!this.vRef) this.vRef = { ...e.vel };
    // attitude: sticks rotate the held attitude (body rates), centred sticks hold it
    const w = v3(-a.pitch * this.maxRate.pitch, -a.yaw * this.maxRate.yaw, a.roll * this.maxRate.roll);
    const wn = Math.hypot(w.x, w.y, w.z);
    const rotating = wn > 1e-3;
    const wb = qrotInv(e.q, e.wWorld);
    // a tumble is first damped; the attitude where it comes to rest becomes the held attitude
    if (!rotating && !this.heldSettled) {
      this.heldQ = { ...e.q };
      cmd.att.q.x = e.q.x; cmd.att.q.y = e.q.y; cmd.att.q.z = e.q.z; cmd.att.q.w = e.q.w;
      cmd.att.w.x = cmd.att.w.y = cmd.att.w.z = 0; cmd.att.a.x = cmd.att.a.y = cmd.att.a.z = 0;
      cmd.force.x = cmd.force.y = cmd.force.z = 0;
      cmd.levels = LEVELS.rotate; cmd.hi = MASK_NO_MAINS;
      this.calmS = Math.hypot(wb.x, wb.y, wb.z) < RATE_DEADBAND ? this.calmS + dt : 0;
      if (this.calmS > 0.2) this.heldSettled = true;
      else { fc.compute(e, cmd, this.out.duty); return; }
    }
    if (!this.heldQ) this.heldQ = { ...e.q };
    if (rotating) { this.heldQ = qmul(this.heldQ, qaxisAngle(w, wn * dt)); this.heldSettled = true; }
    // translation: lift/boost move the velocity target along the held body axes
    const up = qrot(this.heldQ, v3(0, 1, 0)), fwd = qrot(this.heldQ, v3(0, 0, 1));
    const vr = this.vRef;
    vr.x += (up.x * a.lift + fwd.x * a.boost) * TRANSLATE_ACCEL * dt;
    vr.y += (up.y * a.lift + fwd.y * a.boost) * TRANSLATE_ACCEL * dt;
    vr.z += (up.z * a.lift + fwd.z * a.boost) * TRANSLATE_ACCEL * dt;
    const dv = v3(vr.x - e.vel.x, vr.y - e.vel.y, vr.z - e.vel.z);
    // reachable part in the held attitude: +Y, ±X, +Z only with the boost stick (mains)
    const dvb = qrotInv(this.heldQ, dv);
    const reach = v3(dvb.x, Math.max(0, dvb.y), a.boost > 0 ? Math.max(0, dvb.z) : 0);
    st.unreachableDvMs = Math.hypot(dvb.x - reach.x, dvb.y - reach.y, dvb.z - reach.z);
    const reachW = qrot(this.heldQ, reach);
    const dvn = Math.hypot(reach.x, reach.y, reach.z);
    cmd.att.q.x = this.heldQ.x; cmd.att.q.y = this.heldQ.y; cmd.att.q.z = this.heldQ.z; cmd.att.q.w = this.heldQ.w;
    cmd.att.w.x = w.x; cmd.att.w.y = w.y; cmd.att.w.z = w.z;
    cmd.att.a.x = cmd.att.a.y = cmd.att.a.z = 0;
    const k = 1.2 * m;
    cmd.force.x = k * reachW.x; cmd.force.y = k * reachW.y; cmd.force.z = k * reachW.z;
    cmd.levels = LEVELS.ascent;   // attitude first, then translation
    cmd.hi = a.boost > 0 ? null : MASK_NO_MAINS;
    // Without gravity there is no hover bias around which to modulate: one minimum valve pulse
    // (15 ms of a 15 kN corner jet) already changes the roll rate by ≈ 0.2 rad/s. Like a spacecraft
    // RCS, ASSIST coasts inside attitude/rate/velocity deadbands (limit cycle) instead of chattering.
    const err = relativeAxisAngle(e.q, cmd.att.q).angle;
    const wErr = Math.hypot(wb.x - w.x, wb.y - w.y, wb.z - w.z);
    // The deadband coast also applies while the pilot holds an UNREACHABLE translation request (e.g.
    // lift −1 with the roof up): nothing reachable is wanted (dvn ≈ 0), so firing would only run the
    // attitude limit cycle, whose pulses all push along the roof — before R1 this pumped the car the
    // wrong way at ≈ 1.6 m/s per second while the stick was held (tools/gnc/space.tool.ts).
    if (!rotating && err < ATT_DEADBAND && wErr < RATE_DEADBAND && dvn < VEL_DEADBAND) return;
    fc.compute(e, cmd, this.out.duty);
  }

  private liftMaxN(): number { const t = this.fc!.thrust; return (t[4] + t[5] + t[6] + t[7]) * Math.cos(12 * DEG); }
  private mainMaxN(): number { const t = this.fc!.thrust; return t[0] + t[1] + t[2] + t[3]; }
}
