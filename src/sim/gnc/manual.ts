// Manual thruster assistance for free play, independent of gravity and atmosphere.
import { DEG, clamp, qaxisAngle, qmul, qrot, qrotInv, v3, type Quat, type Vec3 } from '@shared/math';
import { ROADSTER } from '@shared/roadster';
import { NOZZLE_COUNT, type AssistLevel, type ThrusterCommand } from '@shared/types';
import { NO_GROUND_M, type RoadsterSim } from '../core/roadsterSim';
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
/** Air the tank must gain after the automatic landing latched before the pilot gets the controls back (kg). */
const AUTOLAND_RELEASE_KG = 25;
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
 * Rate band per body axis (rad/s: pitch X, yaw Y, roll Z) in which the car counts as calm (free-space
 * ASSIST takes the attitude it comes to rest in as the held one). One minimum valve pulse (15 ms) changes
 * the pitch rate by ≈ 0.16 rad/s (corner jet), the roll rate by ≈ 0.22 rad/s and the yaw rate by
 * ≈ 0.03 rad/s (yaw jet): the single-pulse selection (fine()) ends within half of that.
 */
const COAST_RATE = { x: 0.12, y: 0.06, z: 0.18 };
/** STABILIZED damps a rate with centred sticks only after this long without ground contact (s). */
const STAB_AIR_S = 0.3;
/**
 * Rate errors up to which the single-pulse selection handles a no-thrust correction (≈ 3 pulses);
 * larger ones go through the continuous controller (FlightControl), which brings them into this range.
 */
const FINE_MAX = { x: 0.5, y: 0.15, z: 0.7 };
/** A pulse must lower the cost by at least this fraction (prediction error of the impulse). */
const FINE_MARGIN = 0.15;
/**
 * Cost of a pulse's translation: (rad/s)² per (m/s)². 0.25 → a corner pulse (≈ 0.12 m/s along the roof)
 * must buy ≈ 0.06 rad/s of rate error.
 */
const FINE_LAMBDA = 0.25;
/**
 * Pulse options of the selection: single corner / yaw jets and the corner pairs fired together (pure
 * pitch: front or rear pair, pure roll: one side). The mains are left out (they would push the car forward).
 */
const FINE_OPTIONS: ReadonlyArray<readonly number[]> = [
  [4], [5], [6], [7], [8], [9], [4, 5], [6, 7], [4, 6], [5, 7],
];
/**
 * Stick rates without gravity (rad/s). Every pitch/roll rotation is started and stopped by corner jets
 * that both push along the roof: Δv ≈ 2·I·ω/(lever·m) ≈ 1.5 m/s per rad/s of pitch rate (R14). Yaw uses
 * the yaw jets only (yawJetsOnly), whose start and stop impulses cancel.
 */
const SPACE_RATE = { pitch: 0.6, roll: 1.0, yaw: 0.8 };
/** Free-space attitude hold: return rate = HOLD_K · attitude error (1/s), at most HOLD_W · COAST_RATE. */
const HOLD_K = 0.5;
const HOLD_W = 0.6;
/** Free-space attitude band (per body axis): outside it the car must be returning, else the jets fire. */
const SPACE_ATT_BAND = 6 * DEG;
/**
 * Rate band of the free-space attitude hold (rad/s). Wider than COAST_RATE: a pure pitch or roll
 * correction fires a corner PAIR (front/rear or one side), i.e. two minimum pulses ≈ 0.32 rad/s pitch,
 * ≈ 0.45 rad/s roll; the band must hold the rate that is left after such a pair. Narrower bands, a
 * phase-plane test and a single-pulse selection (fine()) with proportional or step return rates were
 * all tried (R14 sweeps, 6 random tumbles, 15 s hands-off): they ping-pong 3–14 pulses/s.
 */
const HOLD_RATE = { x: 0.2, y: 0.06, z: 0.28 };
const clampAbs = (x: number, lim: number): number => (x > lim ? lim : x < -lim ? -lim : x);

/**
 * Manual thruster assistance.
 *  RAW:        direct nozzle groups (lift = 4 corner jets, boost = 4 mains, pitch/roll = corner
 *              differential, yaw = front yaw jets), nothing else: no feedback, nothing fires without a
 *              stick. Only the lift split is trimmed (static, from the geometry and the current CoM) so
 *              that the lift stick alone does not pitch the car over (wet CoM behind the jets' midpoint).
 *  STABILIZED: rate command (stick = body rate), lift/boost = body force, allocator does the mixing.
 *              Centred sticks in the air = rate 0 (inside COAST_RATE). Low-air warning only.
 *  ASSIST with gravity: attitude hold + auto-righting (pitch/roll stick = tilt, yaw stick = heading
 *              rate), lift stick = climb-rate command with automatic soft landing near the ground,
 *              climb limited to the height the remaining air can still land from, and automatic
 *              landing when the air reaches the landing reserve (+25 %).
 *  ASSIST in free space (|g| < 0.05 m/s²): sticks = body rates (SPACE_RATE), centred sticks hold the
 *              attitude the car comes to rest in (rate bands HOLD_RATE, attitude band SPACE_ATT_BAND) and
 *              the velocity over the jets (lift/boost sticks move the velocity target; +Y and +Z only).
 *              Velocity errors the jets cannot reach in the held attitude (±X, −Y, −Z) are reported
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
  /** Air in the tank when the automatic landing latched (kg). */
  private autoLandAirKg = 0;
  private heldSettled = false;
  private calmS = 0;
  /** fine(): time until which the last single pulse is still being delivered (no new decision). */
  private pulseUntil = -1;
  /** Time since the last ground contact (s): STABILIZED does not damp a mere bump or crest. */
  private airS = 0;
  private readonly wZero = v3();
  /** ASSIST: lift/boost was commanded since the last ground contact (height hold active). */
  private flying = true;

  reset(): void {
    this.headingQ = null; this.heldQ = null; this.vRef = null; this.level = null; this.heldSettled = false; this.calmS = 0; this.flying = true;
    this.pulseUntil = -1; this.airS = 0;
    this.status.autoLand = false; this.status.unreachableDvMs = 0;
    this.fc?.reset();
  }

  update(sim: RoadsterSim, axes: ManualAxes, level: AssistLevel): ThrusterCommand {
    if (this.sim !== sim || !this.fc) { this.sim = sim; this.fc = new FlightControl(sim); this.reset(); }
    if (level !== this.level) {
      // a mode switch is a deliberate pilot action: in the air ASSIST takes over at once (on the ground the
      // parked branch clears `flying` again)
      this.level = level; this.headingQ = null; this.heldQ = null; this.vRef = null; this.heldSettled = false; this.calmS = 0; this.flying = true;
      this.pulseUntil = -1;
      this.status.autoLand = false; this.status.unreachableDvMs = 0;
      this.fc.reset();
    }
    const fc = this.fc;
    const d = this.out.duty;
    d.fill(0);
    this.cmd.yawJetsOnly = false;
    const a: ManualAxes = {
      lift: clamp(axes.lift || 0, -1, 1), boost: clamp(axes.boost || 0, 0, 1),
      pitch: clamp(axes.pitch || 0, -1, 1), roll: clamp(axes.roll || 0, -1, 1), yaw: clamp(axes.yaw || 0, -1, 1),
    };
    const e = this.est.update(sim.getState());
    this.airS = e.groundContact ? 0 : this.airS + sim.dt;
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
    // No ground below (off the edge of a terrain world, or far above it): the height is unknown, not 10 km. Taken at
    // face value it made the landing reserve enormous, so a full tank showed LOW_AIR and the automatic landing
    // latched and fired the jets at nothing.
    const noGround = e.height >= 0.5 * NO_GROUND_M;
    if (st.zeroG || noGround) {
      st.reserveKg = 0; st.maxAltitudeM = Infinity; st.lowAir = e.airKg < LOW_AIR_ADD_KG; st.autoLand = false;
      this.belowReserveS = 0;
    } else {
      const decel = Math.min(DEFAULT_DECEL, 0.6 * Math.max(0.1, fc.liftReserveAccel()));
      const h = Math.max(0, e.height - ROADSTER.restCogHeightM);
      estimateReserve(this.sim!, fc.mp.mass, g, decel, h, e.vel.y, this.reserve);
      st.reserveKg = this.reserve.reserveKg;
      st.maxAltitudeM = this.reserve.maxHeightM;
      st.lowAir = e.airKg < LOW_AIR_FACTOR * st.reserveKg + LOW_AIR_ADD_KG;
      // latch after 0.25 s below the reserve (a single noisy estimate must not trigger it)
      this.belowReserveS = e.airKg < st.reserveKg && !e.groundContact ? this.belowReserveS + this.sim!.dt : 0;
      // released on the ground, or once the compressor (or infinite air) has refilled the tank in the air: the
      // reserve itself shrinks during the descent, so only air gained since the latch counts
      if (e.groundContact || (st.autoLand && !st.lowAir && e.airKg > this.autoLandAirKg + AUTOLAND_RELEASE_KG)) st.autoLand = false;
      else if (!st.autoLand && level === 'ASSIST' && this.belowReserveS > 0.25) { st.autoLand = true; this.autoLandAirKg = e.airKg; }
    }
    st.label = level === 'RAW' ? ''
      : st.autoLand && level === 'ASSIST' ? 'AUTOLAND'
        : st.zeroG && level === 'ASSIST' && st.unreachableDvMs > 0.5 ? 'ROTATE'
          : st.lowAir ? 'LOW_AIR' : '';
  }

  // ---------------------------------------------------------------- RAW

  private raw(a: ManualAxes): void {
    const d = this.out.duty, B = this.fc!.B, n = NOZZLE_COUNT;
    const lift = Math.max(0, a.lift);
    // Static lift trim: the wet CoM lies behind the corner jets' midpoint, so equal duty on all four
    // pitches the nose up (≈ 2 rad/s after 1 s of full lift, then a somersault). The pair with the longer
    // pitch lever (Mx row of the effectiveness matrix) is scaled down; same for left/right (roll, Mz).
    // Pure feed-forward from the geometry: no sensors, no firing without a stick.
    const mF = Math.abs(B[3 * n + 4] + B[3 * n + 5]), mR = Math.abs(B[3 * n + 6] + B[3 * n + 7]);
    const mL = Math.abs(B[5 * n + 4] + B[5 * n + 6]), mRt = Math.abs(B[5 * n + 5] + B[5 * n + 7]);
    const wF = mF > mR && mF > 0 ? mR / mF : 1, wR = mR > mF && mR > 0 ? mF / mR : 1;
    const wL = mL > mRt && mL > 0 ? mRt / mL : 1, wRt = mRt > mL && mRt > 0 ? mL / mRt : 1;
    // corner jets: 4 FL, 5 FR, 6 RL, 7 RR (+X = left). pitch +1 = nose up -> more front lift.
    const corner = (front: number, left: number) =>
      clamp(lift * (front > 0 ? wF : wR) * (left > 0 ? wL : wRt) + 0.5 * a.pitch * front + 0.5 * a.roll * left, 0, 1);
    d[4] = corner(1, 1); d[5] = corner(1, -1); d[6] = corner(-1, 1); d[7] = corner(-1, -1);
    for (let i = 0; i < 4; i++) d[i] = a.boost;
    // YAW_L (8) pushes the nose right
    d[8] = Math.max(0, a.yaw); d[9] = Math.max(0, -a.yaw);
  }

  // ---------------------------------------------------------------- STABILIZED

  private stabilized(e: StateEstimate, a: ManualAxes): void {
    const fc = this.fc!, cmd = this.cmd;
    const sticks = Math.abs(a.pitch) + Math.abs(a.roll) + Math.abs(a.yaw) >= 0.02;
    const thrust = a.lift > 0 || a.boost > 0;
    // parked / rolling, or wheels off the ground for a moment (bump, crest): no jets
    if (!sticks && !thrust && (e.groundContact || this.airS < STAB_AIR_S)) return;
    const r = this.status.zeroG ? SPACE_RATE : this.maxRate;
    // rate command: reference = current attitude, desired body rate from the sticks
    cmd.att.q.x = e.q.x; cmd.att.q.y = e.q.y; cmd.att.q.z = e.q.z; cmd.att.q.w = e.q.w;
    cmd.att.w.x = -a.pitch * r.pitch;   // nose up = −X
    cmd.att.w.y = -a.yaw * r.yaw;       // nose right = −Y
    cmd.att.w.z = a.roll * r.roll;      // right side down = +Z
    cmd.att.a.x = cmd.att.a.y = cmd.att.a.z = 0;
    const liftMax = this.liftMaxN(), mainMax = this.mainMaxN();
    const fw = qrot(e.q, v3(0, Math.max(0, a.lift) * liftMax, a.boost * mainMax));
    cmd.force.x = fw.x; cmd.force.y = fw.y; cmd.force.z = fw.z;
    cmd.levels = LEVELS.balanced;
    cmd.hi = thrust ? null : MASK_NO_MAINS;
    // no thrust bias: yaw with the yaw jets (the corner cant would push the car along its roof)
    cmd.yawJetsOnly = !thrust;
    // Centred sticks in the air hold rate 0 (before R14 nothing fired at all, so a rate left over from
    // the last input or a bump persisted until the next key press, which then fired the whole correction
    // at once). Without thrust the jets can only pulse: small rates are removed by single pulses (fine()).
    if (!sticks && !thrust && this.fine(e, this.wZero)) return;
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
   * deadbands) and the velocity components the jets can reach in that attitude (+Y; +Z with the boost
   * stick); the rest is reported as `status.unreachableDvMs` so the pilot can turn the car.
   */
  private space(e: StateEstimate, a: ManualAxes): void {
    const fc = this.fc!, cmd = this.cmd, st = this.status, m = fc.mp.mass, dt = this.sim!.dt;
    if (!this.vRef) this.vRef = { ...e.vel };
    // attitude: sticks command body rates (as STABILIZED); centred sticks hold the attitude the car comes to rest in
    const w = v3(-a.pitch * SPACE_RATE.pitch, -a.yaw * SPACE_RATE.yaw, a.roll * SPACE_RATE.roll);
    const rotating = Math.hypot(w.x, w.y, w.z) > 1e-3;
    const wb = qrotInv(e.q, e.wWorld);
    // yaw only with the yaw jets: their start and stop impulses cancel, the corner cant would push along the roof
    cmd.yawJetsOnly = true;
    cmd.att.q.x = e.q.x; cmd.att.q.y = e.q.y; cmd.att.q.z = e.q.z; cmd.att.q.w = e.q.w;
    cmd.att.a.x = cmd.att.a.y = cmd.att.a.z = 0;
    cmd.hi = a.boost > 0 ? null : MASK_NO_MAINS;
    if (rotating) { this.heldSettled = false; this.calmS = 0; this.heldQ = null; }
    // a tumble (or the end of a stick rotation) is first damped; the attitude where it comes to rest is held
    if (!rotating && !this.heldSettled) {
      const calm = Math.abs(wb.x) < COAST_RATE.x && Math.abs(wb.y) < COAST_RATE.y && Math.abs(wb.z) < COAST_RATE.z;
      this.calmS = calm ? this.calmS + dt : 0;
      if (this.calmS > 0.2) { this.heldSettled = true; this.heldQ = { ...e.q }; }
    }
    // rate reference: stick rate, or a slow return to the held attitude
    const hq = this.heldQ;
    const eg = v3();   // attitude error, body frame, actual -> held ("still to go")
    if (hq) {
      const ra = relativeAxisAngle(e.q, hq);
      eg.x = ra.axis.x * ra.angle; eg.y = ra.axis.y * ra.angle; eg.z = ra.axis.z * ra.angle;
      cmd.att.w.x = clampAbs(HOLD_K * eg.x, HOLD_W * COAST_RATE.x);
      cmd.att.w.y = clampAbs(HOLD_K * eg.y, HOLD_W * COAST_RATE.y);
      cmd.att.w.z = clampAbs(HOLD_K * eg.z, HOLD_W * COAST_RATE.z);
    } else { cmd.att.w.x = w.x; cmd.att.w.y = w.y; cmd.att.w.z = w.z; }
    // translation: lift/boost move the velocity target along the body axes
    const q = hq ?? e.q;
    const up = qrot(q, v3(0, 1, 0)), fwd = qrot(q, v3(0, 0, 1));
    const vr = this.vRef;
    vr.x += (up.x * a.lift + fwd.x * a.boost) * TRANSLATE_ACCEL * dt;
    vr.y += (up.y * a.lift + fwd.y * a.boost) * TRANSLATE_ACCEL * dt;
    vr.z += (up.z * a.lift + fwd.z * a.boost) * TRANSLATE_ACCEL * dt;
    const dv = v3(vr.x - e.vel.x, vr.y - e.vel.y, vr.z - e.vel.z);
    // reachable part: +Y, +Z only with the boost stick (mains). ±X is not chased: the only lateral jets are
    // the yaw jets at the nose (a lateral push is mostly a yaw couple), so an X error – e.g. the old
    // velocity after a turn – kept them and the corner jets firing hands-off (R14).
    const dvb = qrotInv(q, dv);
    const reach = v3(0, Math.max(0, dvb.y), a.boost > 0 ? Math.max(0, dvb.z) : 0);
    st.unreachableDvMs = Math.hypot(dvb.x - reach.x, dvb.y - reach.y, dvb.z - reach.z);
    // while a rotation is still being damped nothing is translated (its pulses already push along the roof)
    const dvn = hq ? Math.hypot(reach.x, reach.y, reach.z) : 0;
    const reachW = hq ? qrot(q, reach) : v3();
    const k = 1.2 * m;
    cmd.force.x = k * reachW.x; cmd.force.y = k * reachW.y; cmd.force.z = k * reachW.z;
    cmd.levels = hq ? LEVELS.ascent : LEVELS.rotate;   // attitude first, then translation
    // Without gravity there is no hover bias around which to modulate: one minimum valve pulse changes the
    // pitch rate by ≈ 0.16 rad/s and every corner pulse also pushes along the roof. Like a spacecraft RCS,
    // ASSIST coasts while the body rate is inside the band around the reference and, outside the attitude
    // band, the car is returning. Before R14 a 5° / 0.15 rad/s deadband (narrower than one pulse) made the
    // jets ping-pong: 10–20 pulses/s, 10–25 m/s of drift and 40–100 kg of air per 15 s hands-off; now a
    // slow limit cycle of ≈ 1 pulse/s is left (15 ms minimum impulse, docs/PHYSICS.md). This also covers
    // an UNREACHABLE translation request (lift −1 with the roof up): nothing reachable is wanted (dvn ≈ 0),
    // so nothing pushes the car the wrong way.
    const coastAxis = (wa: number, wr: number, err: number, band: number) =>
      Math.abs(wa - wr) < band && (Math.abs(err) < SPACE_ATT_BAND || wa * Math.sign(err) > 0.25 * band);
    const rb = hq ? HOLD_RATE : COAST_RATE;
    const coast = coastAxis(wb.x, cmd.att.w.x, eg.x, rb.x) && coastAxis(wb.y, cmd.att.w.y, eg.y, rb.y)
      && coastAxis(wb.z, cmd.att.w.z, eg.z, rb.z);
    if (!rotating && coast && dvn < VEL_DEADBAND) return;
    fc.compute(e, cmd, this.out.duty);
  }

  /**
   * Single-pulse jet selection (RCS style) for corrections without a thrust bias: of the pulse options
   * (FINE_OPTIONS), the one that lowers |ω − ω_ref|² (all axes alike, as the pilot sees them) plus
   * FINE_LAMBDA · Δv² the most gets one minimum pulse; nothing fires when no option lowers the rate error
   * by FINE_MARGIN. Every pulse strictly reduces the cost, so it cannot ping-pong.
   * @returns false when the error is too large for single pulses (the caller uses the continuous controller).
   */
  private fine(e: StateEstimate, wRef: Vec3): boolean {
    const fc = this.fc!, B = fc.B, n = NOZZLE_COUNT, I = fc.mp.inertia, m = fc.mp.mass, sim = this.sim!;
    const wb = qrotInv(e.q, e.wWorld);
    const ex = wb.x - wRef.x, ey = wb.y - wRef.y, ez = wb.z - wRef.z;
    if (Math.abs(ex) > FINE_MAX.x || Math.abs(ey) > FINE_MAX.y || Math.abs(ez) > FINE_MAX.z) return false;
    if (e.t < this.pulseUntil) return true;   // the last pulse is still being delivered
    const v = ROADSTER.valves;
    // commanded open time (whole steps, ≥ min. on-time) plus the closing minus the opening delay
    const tOpen = Math.ceil(v.minOnTimeS / sim.dt - 1e-9) * sim.dt + v.closeDelayS - v.openDelayS;
    let best: readonly number[] | null = null, bestC = (ex * ex + ey * ey + ez * ez) * (1 - FINE_MARGIN);
    for (const opt of FINE_OPTIONS) {
      let fx = 0, fy = 0, fz = 0, mx = 0, my = 0, mz = 0, ok = true;
      for (const j of opt) {
        if (fc.valveFault[j] !== 0) { ok = false; break; }
        fx += B[j]; fy += B[n + j]; fz += B[2 * n + j]; mx += B[3 * n + j]; my += B[4 * n + j]; mz += B[5 * n + j];
      }
      if (!ok) continue;
      const wx = ex + mx * tOpen / I.x, wy = ey + my * tOpen / I.y, wz = ez + mz * tOpen / I.z;
      const dv = Math.hypot(fx, fy, fz) * tOpen / m;
      const c = wx * wx + wy * wy + wz * wz + FINE_LAMBDA * dv * dv;
      if (c < bestC) { bestC = c; best = opt; }
    }
    if (best) {
      for (const j of best) this.out.duty[j] = 1;   // one step fully open: the valve stays open for its minimum on-time
      this.pulseUntil = e.t + v.minOnTimeS + v.closeDelayS + 2 * sim.dt;
    }
    return true;
  }

  private liftMaxN(): number { const t = this.fc!.thrust; return (t[4] + t[5] + t[6] + t[7]) * Math.cos(12 * DEG); }
  private mainMaxN(): number { const t = this.fc!.thrust; return t[0] + t[1] + t[2] + t[3]; }
}
