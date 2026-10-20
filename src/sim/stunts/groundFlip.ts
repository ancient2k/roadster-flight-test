// Finale: lift off the flat pad on the corner jets alone, 360° roll at the top, landing burn.
import { DEG, G0, qrot, v3 } from '@shared/math';
import { ROADSTER } from '@shared/roadster';
import type { RoadsterSim } from '../core/roadsterSim';
import { LEVELS } from '../gnc/allocator';
import { quatFromUpForward } from '../gnc/attitude';
import { requiredAirKg } from '../gnc/feasibility';
import { MASK_NO_MAINS } from '../gnc/guidance';
import { Stunt, type ResultCheck, type StuntOptions } from './base';
import { landingPhase, levelAttitude, rotatePhase, LIFT_JETS, valveTestPhases } from './flightPhases';
import { TUNING } from './tuning';

const P = TUNING.groundFlip;
/** Lateral lever arm of the corner jets for roll (≈ |x| of the lift nozzles + cant contribution). */
const ROLL_ARM_M = 0.85;

export class GroundFlipStunt extends Stunt {
  private fwd = v3(0, 0, 1);

  constructor(sim: RoadsterSim, opts: StuntOptions = {}) {
    super('ground_flip', sim, opts);
    this.timeoutS = opts.timeoutS ?? 30;
    this.lander.params.decel = P.landingDecel;
    const st = this;
    this.phases = {
      aircheck: {
        enter: () => {
          const f = qrot(this.sim.getState().quat, v3(0, 0, 1));
          const n = Math.hypot(f.x, f.z) || 1;
          this.fwd = v3(f.x / n, 0, f.z / n);
          this.systems.fanMode = 'off';
        },
        update: () => {
          this.brakeToStop();
          if (this.phaseTime < 0.25) return null;
          return this.est.airKg >= requiredAirKg('ground_flip') ? 'liftoff' : 'abort_air';
        },
      },
      liftoff: {
        update: () => {
          const m = this.fc.mp.mass;
          quatFromUpForward(v3(0, 1, 0), this.fwd, this.cmd.att.q);
          this.cmd.att.w.x = this.cmd.att.w.y = this.cmd.att.w.z = 0;
          this.cmd.att.a.x = this.cmd.att.a.y = this.cmd.att.a.z = 0;
          // climb acceleration of the Earth design (T/W 2.9), but never more than 85 % of the reserve
          const g = this.fc.gMag;
          const aClimb = Math.min((P.climbTW - 1) * G0, 0.85 * this.fc.liftReserveAccel());
          this.cmd.force.x = 0; this.cmd.force.y = m * (g + aClimb); this.cmd.force.z = 0;
          this.cmd.levels = LEVELS.ascent;
          this.cmd.hi = MASK_NO_MAINS;
          this.drive.brake = 0; this.drive.throttle = 0;
          this.fly();
          if (!this.airborne && !this.est.groundContact && this.wheelsHeight() > 0.05) { this.markLiftoff('liftoff'); this.markStart(); }
          // burnout when the ballistic apex reaches the target altitude (CoG = altitude + rest CoG height)
          // the first roll pulse (one side pair, wheels still down) adds ≈ F·t_acc of upward impulse
          const tAcc = Math.min(P.rollRate / P.rollAccel, Math.sqrt(Math.PI / P.rollAccel));
          const dvRoll = ((this.fc.mp.inertia.z * P.rollAccel) / ROLL_ARM_M) * tAcc / m;
          const vy = this.est.vel.y + dvRoll;
          const apexCog = this.est.pos.y + (vy > 0 ? (vy * vy) / (2 * Math.max(g, 0.1)) : 0);
          if (apexCog >= P.apexAltM + ROADSTER.restCogHeightM) { this.markLiftoff('liftoff'); return 'roll'; }
          return this.phaseTime > 2.5 ? 'land' : null;
        },
      },
      roll: rotatePhase(st, {
        axis: v3(0, 0, 1), angleRad: 2 * Math.PI, rateRadS: P.rollRate, accelRadS2: P.rollAccel,
        q0: () => levelAttitude(st, this.fwd), next: 'land', bail: 'land', bailHeightM: P.bailHeightM, landingFwd: () => this.fwd,
      }),
      land: landingPhase(st, 'rollout', () => this.fwd),
      rollout: {
        update: () => {
          this.rolloutBrake(1);
          if (this.phaseTime > 1.0 && this.est.speed < 0.3) { this.succeed(); return 'done'; }
          if (this.phaseTime > 6) { this.succeed('settled'); return 'done'; }
          return null;
        },
      },
      abort_air: {
        enter: () => this.emit('abort', `insufficient air: ${this.est.airKg.toFixed(0)} kg < ${requiredAirKg('ground_flip').toFixed(0)} kg`),
        update: () => { this.brakeToStop(); this.fail('aborted: insufficient air'); return null; },
      },
      done: { update: () => { this.brakeToStop(); return null; } },
      ...valveTestPhases(st, 'aircheck', LIFT_JETS),
    };
  }

  protected initialPhase(): string { return 'precheck'; }

  protected referenceMetrics(): Record<string, number> {
    return { rollDeg: Math.abs(this.metrics.rollDeg), apexAltitudeM: this.metrics.maxAltitudeM };
  }

  protected evaluate(): ResultCheck[] {
    const m = this.metrics, r = this.reference;
    return [
      { name: 'lifted off from the flat pad', value: Number.isNaN(m.liftoffT) ? 0 : 1, target: '1', ok: !Number.isNaN(m.liftoffT) },
      { name: 'apex altitude 8 m ±15 %', value: m.maxAltitudeM, target: `${(r.apexAltitudeM * 0.85).toFixed(1)}..${(r.apexAltitudeM * 1.15).toFixed(1)}`, ok: Math.abs(m.maxAltitudeM - r.apexAltitudeM) <= 0.15 * r.apexAltitudeM },
      { name: 'full roll 360°', value: Math.abs(m.rollDeg), target: '360 ±25', ok: Math.abs(Math.abs(m.rollDeg) - 360) <= 25 },
      { name: 'touchdown sink ≤ 2 m/s', value: m.touchdownSinkMs, target: '≤ 2.0', ok: m.touchdownSinkMs <= 2.0 },
      { name: 'wheels down at touchdown', value: m.touchdownUpY, target: '> cos 10°', ok: m.touchdownUpY > Math.cos(10 * DEG) },
      { name: 'touchdown g ≤ 2.5', value: m.touchdownG, target: '≤ 2.5', ok: m.touchdownG <= 2.5 },
      { name: 'not crashed', value: this.sim.getState().crashed ? 1 : 0, target: '0', ok: !this.sim.getState().crashed },
    ];
  }
}
