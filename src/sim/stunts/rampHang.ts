// Wall ramp hang: crawl up the curved wall on fan suction to ≈170° pitch / ≈21 m, hang ≈10 s,
// crawl back down in reverse. No thrusters (video). Traction = tyre friction under fan suction.
import { DEG, hudPitchDeg, v3 } from '@shared/math';
import { VIDEO_REFERENCE } from '@shared/reference';
import { TRACK, headingToForward } from '@shared/track';
import type { RoadsterSim } from '../core/roadsterSim';
import { LineFollower, RampTracker, forwardSpeed } from '../gnc/drive';
import { Stunt, type ResultCheck, type StuntOptions } from './base';
import { rescuePhases } from './flightPhases';
import { TUNING } from './tuning';

const P = TUNING.rampHang;

/**
 * Choreography from the stream: HUD pitch over time (VIDEO_REFERENCE ramp_hang), piecewise linear.
 * The driver crawls the wall along this pitch-time profile; the stunt follows it with a speed
 * command (feedforward ds/dt = R·dθ/dt plus position feedback), so the run is time-aligned with the
 * video instead of only matching its peak values. t = 0: the reference start (ramp entry at t = 5 s).
 */
const PITCH_REF = (VIDEO_REFERENCE.ramp_hang ?? []).filter((r) => r.pitchDeg !== undefined).map((r) => ({ t: r.t, deg: r.pitchDeg! }));
/** Reference time of the ramp entry in VIDEO_REFERENCE ramp_hang ('enters the ramp'). */
export const RAMP_HANG_ENTRY_T = 5;
/** Reference time when the car starts back down ('starts back down' at 27 s, pitch 169° at 26 s). */
export const RAMP_HANG_DESCEND_T = 25.6;
/** Reference time when the car is back at the bottom of the wall (pitch 2.6° at 36 s). */
export const RAMP_HANG_BOTTOM_T = 36;

export function rampHangPitchRef(t: number): { deg: number; rateDegS: number } {
  const r = PITCH_REF;
  if (!r.length) return { deg: 0, rateDegS: 0 };
  if (t <= r[0].t) return { deg: r[0].deg, rateDegS: 0 };
  for (let i = 1; i < r.length; i++) {
    if (t <= r[i].t) {
      const a = r[i - 1], b = r[i], u = (t - a.t) / (b.t - a.t);
      return { deg: a.deg + (b.deg - a.deg) * u, rateDegS: (b.deg - a.deg) / (b.t - a.t) };
    }
  }
  return { deg: r[r.length - 1].deg, rateDegS: 0 };
}

export class RampHangStunt extends Stunt {
  readonly wall = TRACK.ramps.find((r) => r.kind === 'wallRamp')!;
  readonly line = new LineFollower(this.wall.origin, this.wall.headingDeg);
  readonly tracker = new RampTracker(this.wall);
  readonly fwd = headingToForward(this.wall.headingDeg);
  private holdAltSum = 0;
  private holdN = 0;

  constructor(sim: RoadsterSim, opts: StuntOptions = {}) {
    super('ramp_hang', sim, opts);
    this.timeoutS = opts.timeoutS ?? 120;
    const st = this;
    this.phases = {
      spool: {
        // demand-controlled fans: idle suction on the flat, rising with the wall angle like the
        // stream HUD (251 kg at the ramp entry, 4700 kg inverted). A held foot brake (> 0.5) would
        // request full suction, so the car is held with a light brake on the flat pad.
        enter: () => { this.systems.fanMode = 'grip'; this.systems.fanLevel = P.fanLevel; this.systems.aeroMode = P.aeroMode; },
        update: () => {
          this.drive.throttle = 0; this.drive.brake = 0.4; this.drive.steer = 0;
          return this.phaseTime >= P.spoolS ? 'approach' : null;
        },
      },
      approach: {
        enter: () => this.speed.reset(),
        update: () => {
          const d = (this.wall.origin.x - this.est.pos.x) * this.fwd.x + (this.wall.origin.z - this.est.pos.z) * this.fwd.z;
          // brake down to the crawl speed in front of the wall (1.5 m/s² profile)
          // gentle run-up (reference leads by P.approachLeadMs): a floored throttle would make the demand
          // control request full suction on the flat (video: ≈ 50–250 kg before the ramp)
          const vRef = Math.min(P.approachSpeedMs, this.est.speed + P.approachLeadMs, Math.sqrt(P.climbSpeedMs ** 2 + 2 * 1.5 * Math.max(0, d - 2)));
          this.holdSpeed(vRef);
          this.drive.steer = this.line.steer(this.est.pos, this.est.q, this.est.speed);
          return d <= 0.5 ? 'climb' : null;
        },
      },
      climb: {
        enter: () => this.markStart(RAMP_HANG_ENTRY_T),
        update: () => {
          this.tracker.update(this.est.pos);
          const pitch = hudPitchDeg(this.est.q);
          const v = this.followPitchRef(1);
          this.holdSpeed(v);
          this.drive.steer = this.line.steer(this.est.pos, this.est.q, this.est.speed);
          this.drive.reverse = false;
          if (this.tracker.s > 1 && this.lostWall()) return 'rescue';
          // hang where the stream car stops: on the straight overhang, hangOnLipM past the end of the arc
          const atHang = pitch >= P.holdPitchDeg - 0.5 && this.tracker.s >= this.sAtPitch(P.holdPitchDeg) - 0.15;
          if ((atHang && this.refT >= RAMP_HANG_DESCEND_T - P.holdS) || this.tracker.s >= this.tracker.length - 1.4) return 'hold';
          return null;
        },
      },
      hold: {
        update: () => {
          this.drive.throttle = 0; this.drive.brake = 1; this.drive.steer = 0;
          if (this.lostWall()) return 'rescue';
          const tel = this.sim.telemetry();
          if (tel.pitchDeg >= 165) { this.metrics.holdS += this.sim.dt; this.holdAltSum += tel.altitudeM; this.holdN++; }
          return this.refT >= RAMP_HANG_DESCEND_T && this.phaseTime >= P.holdS - 1 ? 'descend' : null;
        },
      },
      descend: {
        enter: () => this.speed.reset(),
        update: () => {
          this.tracker.update(this.est.pos);
          this.drive.reverse = true;
          // speed controller on the backward speed
          const back = -forwardSpeed(this.est.vel, this.est.q);
          // video: full suction while the car is past vertical (4700 kg down to 91°), then a gradual
          // reduction with the wall angle (4520 kg at 73° ... 1623 kg at 3°): fan level ≈ √(F/F_max)
          // fitted to the HUD, 0.58 + 0.0063·pitch[deg] (suction ∝ rpm²)
          const pd = hudPitchDeg(this.est.q);
          this.systems.fanLevel = pd > 90 ? 1 : Math.max(P.descendFanMin, Math.min(1, P.descendFanMin + P.descendFanPerDeg * pd));
          // follow the video pitch profile back down, then keep reversing off the wall
          const vRef = this.refT < RAMP_HANG_BOTTOM_T ? this.followPitchRef(-1) : P.descendSpeedMs;
          this.speed.update(vRef, back, this.sim.dt, this.drive);
          this.drive.steer = this.line.steer(this.est.pos, this.est.q, this.est.speed, true);
          if (this.tracker.s > 1 && this.lostWall()) return 'rescue';
          const local = this.tracker.toLocal(this.est.pos);
          return local.z < -4 && Math.abs(hudPitchDeg(this.est.q)) < 3 ? 'stop' : null;
        },
      },
      stop: {
        update: () => {
          this.brakeToStop(); this.drive.reverse = false;
          this.systems.fanLevel = null;
          if (this.est.speed < 0.2) { this.succeed(); return 'done'; }
          return null;
        },
      },
      done: { update: () => { this.brakeToStop(); return null; } },
      ...rescuePhases(st, 'lost the wall', () => v3(-this.fwd.x, 0, -this.fwd.z)),
    };
  }

  protected initialPhase(): string { return 'spool'; }

  /** Time on the VIDEO_REFERENCE clock. */
  get refT(): number { return Number.isNaN(this.startT) ? -1 : this.t - this.startT; }

  /**
   * Speed along the wall (dir +1 up, −1 reversing down) that tracks the video pitch-time profile:
   * feedforward dsRef/dt plus feedback on the arc-length error. The reference arc length follows from the
   * wall profile (bend, vertical straight, curl): the HUD pitch dwells at ≈ 90° while the car climbs the
   * straight (89.5°/90.0° at 10/11 s), so samples within ±1° of a straight's tangent are spread along it.
   */
  private followPitchRef(dir: 1 | -1): number {
    // reversing down, the drive/speed loop lags ≈ 0.8 s behind the reference: lead it by that much
    const { s: sRef, rate } = this.sRefAt(this.refT + (dir < 0 ? P.descendLeadS : 0));
    const v = dir * rate + P.trackGain * dir * (sRef - this.tracker.s);
    return Math.max(P.minCrawlMs, Math.min(P.maxCrawlMs, v));
  }

  /**
   * Arc length on the wall where the surface tangent reaches `deg` (first time), plateau-aware. The hang
   * pitch maps onto the straight overhang: the stream car crawls ≈ 1.6 m onto it at a constant 170° and
   * back (stream 692–702 s), so the reference holds there instead of at the end of the arc.
   */
  private sAtPitch(deg: number): number {
    if (deg >= P.holdPitchDeg - 0.25) return Math.min(this.tracker.length - 1.4, this.sOnWall(P.holdPitchDeg) + P.hangOnLipM);
    return this.sOnWall(deg);
  }

  private sOnWall(deg: number): number {
    let acc = 0, theta = 0;
    for (const seg of this.wall.profile) {
      if (seg.kind === 'line') {
        const td = theta / DEG;
        if (Math.abs(deg - td) <= 1) return acc + seg.length * Math.min(1, Math.max(0, (deg - (td - 1)) / 1.5));
        acc += seg.length;
        continue;
      }
      const lo = seg.fromDeg, hi = seg.toDeg;
      if (deg <= hi) return acc + seg.radius * Math.max(0, deg - lo) * DEG;
      acc += seg.radius * (hi - lo) * DEG; theta = hi * DEG;
    }
    return acc;
  }

  private sRefAt(t: number): { s: number; rate: number } {
    const r = PITCH_REF;
    if (!r.length) return { s: 0, rate: 0 };
    const sOf = (i: number) => this.sAtPitch(r[i].deg);
    if (t <= r[0].t) return { s: sOf(0), rate: 0 };
    for (let i = 1; i < r.length; i++) {
      if (t <= r[i].t) {
        const a = sOf(i - 1), b = sOf(i), u = (t - r[i - 1].t) / (r[i].t - r[i - 1].t);
        return { s: a + (b - a) * u, rate: Math.abs(b - a) / (r[i].t - r[i - 1].t) };
      }
    }
    return { s: sOf(r.length - 1), rate: 0 };
  }

  get holdAltitudeM(): number { return this.holdN ? this.holdAltSum / this.holdN : 0; }

  protected referenceMetrics(): Record<string, number> {
    const m = this.metrics;
    return { maxPitchDeg: m.maxPitchDeg, holdAltitudeM: this.holdAltitudeM, maxDownforceKg: m.maxDownforceKg, holdSeconds: m.holdS };
  }

  protected evaluate(): ResultCheck[] {
    const m = this.metrics, r = this.reference;
    this.metrics.maxAltitudeM = Math.max(this.metrics.maxAltitudeM, this.holdAltitudeM);
    const alt = this.holdAltitudeM;
    return [
      { name: 'pitch ≥ 165°', value: m.maxPitchDeg, target: '≥ 165', ok: m.maxPitchDeg >= 165 },
      { name: 'hang altitude 21 m ±10 %', value: alt, target: `${(r.holdAltitudeM * 0.9).toFixed(1)}..${(r.holdAltitudeM * 1.1).toFixed(1)}`, ok: Math.abs(alt - r.holdAltitudeM) <= 0.1 * r.holdAltitudeM },
      { name: 'downforce 4700 kg ±10 %', value: m.maxDownforceKg, target: '4230..5170', ok: Math.abs(m.maxDownforceKg - r.maxDownforceKg) <= 0.1 * r.maxDownforceKg },
      { name: 'hang ≥ 9.5 s at ≥ 165°', value: m.holdS, target: '≥ 9.5', ok: m.holdS >= 9.5 },
      { name: 'not crashed / fallen', value: this.sim.getState().crashed ? 1 : 0, target: '0', ok: !this.sim.getState().crashed && Math.abs(hudPitchDeg(this.sim.getState().quat)) < 10 },
    ];
  }
}
