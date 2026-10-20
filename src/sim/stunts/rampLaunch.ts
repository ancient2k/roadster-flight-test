// Wall ramp launch: drive up the wall on fan suction, release the fans at the top so the car drops
// off the overhang (inverted, moving away from the wall), half roll to wheels-down facing away from
// the wall, landing burn on the four corner jets, drive away. Reference: RECHERCHE §2B.
import { DEG, qrot, v3 } from '@shared/math';
import { TRACK, headingToForward } from '@shared/track';
import type { RoadsterSim } from '../core/roadsterSim';
import { quatFromUpForward } from '../gnc/attitude';
import { LineFollower, RampTracker } from '../gnc/drive';
import { requiredAirKg } from '../gnc/feasibility';
import { Stunt, type ResultCheck, type StuntOptions } from './base';
import { landingPhase, rescuePhases, rotatePhase, LIFT_JETS, valveTestPhases } from './flightPhases';
import { TUNING } from './tuning';

const P = TUNING.rampLaunch;
/** CoG radius on the wall loop: surface radius minus the CoG height above the floor (≈ 0.45 m). */
const COG_INSET_M = 0.45;

/**
 * Speed reference on the curved wall. The specific force on the arc is
 * (v²/R + g cos θ) normal and (a + g sin θ) tangential; keeping |f| ≤ gLim (a ≈ 0) gives
 * v² ≤ R (√(gLim² − (g sin θ)²) − g cos θ). Video: 1.4 g at the entry, 0.8–0.9 g on the vertical.
 */
export function rampLaunchSpeedRef(s: number, theta: number, sRelease: number, g: number, R: number): number {
  const gl = P.climbGLimit * g, gs = g * Math.sin(theta);
  const vG = Math.sqrt(Math.max(0, R * (Math.sqrt(Math.max(0, gl * gl - gs * gs)) - g * Math.cos(theta))));
  const vTop = Math.sqrt(P.exitSpeedMs ** 2 + 2 * P.topDecelMs2 * Math.max(0, sRelease - s));
  return Math.max(P.exitSpeedMs, Math.min(Math.max(vG, P.entrySpeedMs), P.cruiseSpeedMs, vTop));
}

export class RampLaunchStunt extends Stunt {
  readonly wall = TRACK.ramps.find((r) => r.kind === 'wallRamp')!;
  readonly line = new LineFollower(this.wall.origin, this.wall.headingDeg);
  readonly tracker = new RampTracker(this.wall);
  readonly fwd = headingToForward(this.wall.headingDeg);
  readonly away = v3(-this.fwd.x, 0, -this.fwd.z);
  private offGround = 0;
  leaveAltitudeM = NaN;
  climbG = 0;

  constructor(sim: RoadsterSim, opts: StuntOptions = {}) {
    super('ramp_launch', sim, opts);
    this.timeoutS = opts.timeoutS ?? 90;
    this.lander.params.decel = P.landingDecel;
    this.lander.params.kv = P.landingKv;
    this.lander.params.ki = P.landingKi;
    this.lander.params.vTouch = P.touchSinkMs;
    this.lander.params.hFlare = P.flareHeightM;
    const st = this;
    this.phases = {
      aircheck: {
        enter: () => { this.systems.fanMode = 'grip'; this.systems.fanLevel = P.fanLevel; this.systems.aeroMode = 'highDownforce'; },
        update: () => {
          this.brakeToStop();
          if (this.phaseTime < 1.5) return null;
          return this.est.airKg >= requiredAirKg('ramp_launch') ? 'approach' : 'abort_air';
        },
      },
      approach: {
        enter: () => this.speed.reset(),
        update: () => {
          const d = (this.wall.origin.x - this.est.pos.x) * this.fwd.x + (this.wall.origin.z - this.est.pos.z) * this.fwd.z;
          const vRef = Math.min(P.entrySpeedMs, this.est.speed + 2.5);
          this.holdSpeed(vRef);
          this.drive.steer = this.line.steer(this.est.pos, this.est.q, this.est.speed);
          return d <= 0.3 ? 'climb' : null;
        },
      },
      climb: {
        enter: () => this.markStart(),
        update: () => {
          if (this.phaseTime < 1.5) this.climbG = Math.max(this.climbG, this.sim.telemetry().gForce);
          this.tracker.update(this.est.pos);
          const sRel = this.tracker.length - P.releaseBeforeEndM;
          const R = this.radiusAt(this.tracker.s) - COG_INSET_M;
          this.holdSpeed(rampLaunchSpeedRef(this.tracker.s, this.tracker.theta, sRel, this.fc.gMag, R));
          this.drive.steer = this.line.steer(this.est.pos, this.est.q, this.est.speed);
          if (this.lostWall()) return 'rescue';
          if (this.tracker.s >= sRel) return 'release';
          return null;
        },
      },
      release: {
        // fans off: without suction the inverted car drops off the overhang
        enter: () => { this.systems.fanMode = 'off'; this.systems.fanLevel = 0; },
        update: () => {
          this.drive.throttle = 0; this.drive.brake = 0; this.drive.steer = 0;
          this.offGround = this.est.groundContact ? 0 : this.offGround + this.sim.dt;
          if (this.offGround >= 4 / 240 - 1e-9 || this.phaseTime > 1.5) {
            this.leaveAltitudeM = this.sim.telemetry().altitudeM;
            this.markLiftoff('launch');
            return 'half_flip';
          }
          return null;
        },
      },
      half_flip: rotatePhase(st, {
        axis: v3(0, 0, 1), angleRad: Math.PI, rateRadS: P.rollRate, accelRadS2: P.rollAccel,
        // inverted, nose pointing away from the wall, level: rolling π about body Z ends wheels-down
        q0: () => quatFromUpForward(v3(0, -1, 0), this.away),
        // released before the end of the overhang the car is pitched ≈ 25° off inverted-level:
        // one shortest rotation (mostly roll) straight to wheels-down, nose away from the wall
        target: () => quatFromUpForward(v3(0, 1, 0), this.away),
        next: 'land', bail: 'land', bailHeightM: 4, landingFwd: () => this.away,
      }),
      land: landingPhase(st, 'rollout', () => this.away, () => {
        const local = this.tracker.toLocal(this.est.pos);
        // keep moving away from the wall until the car is over flat ground
        return local.z > -1.5 ? { x: this.away.x * P.awaySpeedMs, z: this.away.z * P.awaySpeedMs } : null;
      }),
      rollout: {
        update: () => {
          this.rolloutBrake();
          if ((this.phaseTime > 1 && this.est.speed < 0.3) || this.phaseTime > 8) { this.succeed(); return 'done'; }
          return null;
        },
      },
      abort_air: {
        enter: () => this.emit('abort', `insufficient air: ${this.est.airKg.toFixed(0)} kg < ${requiredAirKg('ramp_launch').toFixed(0)} kg`),
        update: () => { this.brakeToStop(); this.fail('aborted: insufficient air'); return null; },
      },
      done: { update: () => { this.brakeToStop(); return null; } },
      ...valveTestPhases(st, 'aircheck', LIFT_JETS),
      ...rescuePhases(st, 'lost the wall', () => this.away),
    };
  }

  protected initialPhase(): string { return 'precheck'; }

  /** Surface radius of the wall profile at arc length s. */
  private radiusAt(s: number): number {
    let acc = 0;
    for (const seg of this.wall.profile) {
      const len = seg.kind === 'line' ? seg.length : seg.radius * Math.abs(seg.toDeg - seg.fromDeg) * DEG;
      if (s <= acc + len) return seg.kind === 'arc' ? seg.radius : 1e6;
      acc += len;
    }
    const last = this.wall.profile[this.wall.profile.length - 1];
    return last.kind === 'arc' ? last.radius : 1e6;
  }

  protected referenceMetrics(): Record<string, number> {
    return { leaveAltitudeM: this.leaveAltitudeM, touchdownG: this.metrics.touchdownG, climbG: this.climbG };
  }

  protected evaluate(): ResultCheck[] {
    const m = this.metrics, r = this.reference;
    const up = qrot(this.sim.getState().quat, v3(0, 1, 0)).y;
    return [
      { name: 'leaves the top at ≈ 19.5 m (±15 %)', value: this.leaveAltitudeM, target: `${(r.leaveAltitudeM * 0.85).toFixed(1)}..${(r.leaveAltitudeM * 1.15).toFixed(1)}`, ok: Math.abs(this.leaveAltitudeM - r.leaveAltitudeM) <= 0.15 * r.leaveAltitudeM },
      { name: 'half flip ≈ 180°', value: Math.abs(m.rollDeg), target: '180 ±30', ok: Math.abs(Math.abs(m.rollDeg) - 180) <= 30 },
      { name: 'touchdown sink ≤ 2 m/s', value: m.touchdownSinkMs, target: '≤ 2.0', ok: m.touchdownSinkMs <= 2.0 },
      { name: 'touchdown g ≤ 2.5', value: m.touchdownG, target: '≤ 2.5', ok: m.touchdownG <= 2.5 },
      { name: 'landed upright', value: up, target: '> cos 10°', ok: up > Math.cos(10 * DEG) && m.touchdownUpY > Math.cos(10 * DEG) },
      { name: 'no ramp contact in flight', value: m.rampContactInFlight ? 1 : 0, target: '0', ok: !m.rampContactInFlight },
      { name: 'not crashed', value: this.sim.getState().crashed ? 1 : 0, target: '0', ok: !this.sim.getState().crashed },
    ];
  }
}
