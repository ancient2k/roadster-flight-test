// Kickflip over the Semi and the car row: kicker (3.5 g) -> 360° roll about the longitudinal axis
// in the climb -> wheels-down landing burn -> rollout. Reference: RECHERCHE §2C, TRACK site 'kickflip'.
import { DEG, v3 } from '@shared/math';
import { TRACK, headingToForward, profileLength } from '@shared/track';
import type { RoadsterSim } from '../core/roadsterSim';
import { LineFollower, RampTracker } from '../gnc/drive';
import { requiredAirKg } from '../gnc/feasibility';
import { Stunt, type ResultCheck, type StuntOptions } from './base';
import { LEVELS } from '../gnc/allocator';
import { MASK_NO_MAINS } from '../gnc/guidance';
import { landingPhase, rotatePhase, LIFT_JETS, valveTestPhases } from './flightPhases';
import { TUNING } from './tuning';

const P = TUNING.kickflip;

export class KickflipStunt extends Stunt {
  readonly kicker = TRACK.ramps.find((r) => r.kind === 'kicker')!;
  readonly line = new LineFollower(this.kicker.origin, this.kicker.headingDeg);
  readonly tracker = new RampTracker(this.kicker);
  readonly fwd = headingToForward(this.kicker.headingDeg);
  readonly lipZ = profileLength(this.kicker.profile);
  private offGround = 0;
  private climbQ = { x: 0, y: 0, z: 0, w: 1 };

  constructor(sim: RoadsterSim, opts: StuntOptions = {}) {
    super('kickflip', sim, opts);
    this.timeoutS = opts.timeoutS ?? 45;
    this.lander.params.decel = P.landingDecel;
    const st = this;
    this.phases = {
      aircheck: {
        update: () => (this.est.airKg >= requiredAirKg('kickflip') ? 'approach' : 'abort_air'),
      },
      approach: {
        enter: () => { this.systems.fanMode = 'off'; this.systems.aeroMode = 'lowDrag'; this.speed.reset(); },
        update: () => {
          // distance to the kicker entry along the approach line
          const d = (this.kicker.origin.x - this.est.pos.x) * this.fwd.x + (this.kicker.origin.z - this.est.pos.z) * this.fwd.z;
          const v = this.est.speed;
          // ramp up with approachAccel (reference leads the car by 0.5 s), then hold the entry speed
          const vRef = Math.min(P.entrySpeedMs, v + 0.5 * P.approachAccelMs2);
          this.holdSpeed(Math.max(vRef, 1), vRef < P.entrySpeedMs ? P.approachAccelMs2 : 0);
          this.drive.steer = this.line.steer(this.est.pos, this.est.q, v);
          return d <= 0.2 ? 'kicker' : null;
        },
      },
      kicker: {
        enter: () => this.markStart(1.0), // VIDEO_REFERENCE kickflip: kicker at t = 1.0 s
        update: () => {
          this.holdSpeed(P.entrySpeedMs);
          this.drive.steer = this.line.steer(this.est.pos, this.est.q, this.est.speed);
          this.metrics.launchG = Math.max(this.metrics.launchG, this.sim.telemetry().gForce);
          this.tracker.update(this.est.pos);
          this.offGround = this.est.groundContact ? 0 : this.offGround + this.sim.dt;
          if (this.offGround >= 3 / 240 - 1e-9 && this.tracker.s > this.lipZ - 2.5) { this.markLiftoff('launch'); return 'climb'; }
          return null;
        },
      },
      climb: {
        // Kill the pitch rate the concave kicker gave the car (≈ v/R nose-up) before rolling: rolled by
        // 90° that angular momentum would have to be removed through the weak yaw axis.
        enter: () => {
          this.markLiftoff('launch');
          this.climbQ = { ...this.est.q };
        },
        update: () => {
          this.drive.throttle = 0; this.drive.brake = 0; this.drive.steer = 0;
          const c = this.cmd;
          c.att.q.x = this.climbQ.x; c.att.q.y = this.climbQ.y; c.att.q.z = this.climbQ.z; c.att.q.w = this.climbQ.w;
          c.att.w.x = c.att.w.y = c.att.w.z = 0; c.att.a.x = c.att.a.y = c.att.a.z = 0;
          c.force.x = c.force.y = c.force.z = 0;
          c.levels = LEVELS.rotate; c.hi = MASK_NO_MAINS;
          // rate damping only: follow the current attitude, demand zero body rate
          c.att.q.x = this.est.q.x; c.att.q.y = this.est.q.y; c.att.q.z = this.est.q.z; c.att.q.w = this.est.q.w;
          this.fly();
          const w = this.est.wWorld;
          return (this.phaseTime >= P.rollDelayS && Math.hypot(w.x, w.y, w.z) < 0.25) || this.phaseTime > 0.35 ? 'roll' : null;
        },
      },
      roll: rotatePhase(st, {
        axis: v3(0, 0, 1), angleRad: 2 * Math.PI, rateRadS: P.rollRate, accelRadS2: P.rollAccel,
        q0: () => ({ ...this.est.q }), next: 'land', bail: 'land', bailHeightM: P.bailHeightM, landingFwd: () => this.fwd,
        ballisticGain: P.ballisticGain,
      }),
      land: landingPhase(st, 'rollout', () => this.fwd),
      rollout: {
        enter: () => { this.speed.reset(); },
        update: () => {
          this.drive.steer = this.line.steer(this.est.pos, this.est.q, this.est.speed);
          this.rolloutBrake();
          if (this.est.speed < 0.3 || this.phaseTime > 12) { this.succeed(); return 'done'; }
          return null;
        },
      },
      abort_air: {
        enter: () => this.emit('abort', `insufficient air: ${this.est.airKg.toFixed(0)} kg < ${requiredAirKg('kickflip').toFixed(0)} kg`),
        update: () => { this.brakeToStop(); if (this.est.speed < 0.2) this.fail('aborted: insufficient air'); return null; },
      },
      done: { update: () => { this.brakeToStop(); return null; } },
      ...valveTestPhases(st, 'aircheck', LIFT_JETS),
    };
  }

  protected initialPhase(): string { return 'precheck'; }

  protected referenceMetrics(): Record<string, number> {
    const m = this.metrics;
    return { launchG: m.launchG, apexAltitudeM: m.maxAltitudeM, touchdownG: m.touchdownG, rollDeg: Math.abs(m.rollDeg), airtimeS: m.touchdownT - m.liftoffT };
  }

  protected evaluate(): ResultCheck[] {
    const m = this.metrics, r = this.reference;
    return [
      { name: 'apex altitude 7.7 m ±15 %', value: m.maxAltitudeM, target: `${(r.apexAltitudeM * 0.85).toFixed(2)}..${(r.apexAltitudeM * 1.15).toFixed(2)}`, ok: Math.abs(m.maxAltitudeM - r.apexAltitudeM) <= 0.15 * r.apexAltitudeM },
      { name: 'launch g 3.5 ±0.7', value: m.launchG, target: '2.8..4.2', ok: Math.abs(m.launchG - r.launchG) <= 0.7 },
      { name: 'touchdown g ≤ 2.5', value: m.touchdownG, target: '≤ 2.5', ok: m.touchdownG <= 2.5 },
      { name: 'touchdown sink ≤ 2 m/s', value: m.touchdownSinkMs, target: '≤ 2.0', ok: m.touchdownSinkMs <= 2.0 },
      { name: 'full roll 360°', value: Math.abs(m.rollDeg), target: '360 ±25', ok: Math.abs(Math.abs(m.rollDeg) - 360) <= 25 },
      { name: 'wheels down at touchdown', value: m.touchdownUpY, target: '> cos 10°', ok: m.touchdownUpY > Math.cos(10 * DEG) },
      { name: 'no contact with Semi / car row', value: m.obstacleContact ? 1 : 0, target: '0', ok: !m.obstacleContact },
      { name: 'not crashed', value: this.sim.getState().crashed ? 1 : 0, target: '0', ok: !this.sim.getState().crashed },
    ];
  }
}
