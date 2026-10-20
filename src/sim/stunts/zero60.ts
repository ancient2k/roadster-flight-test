// 0–60 mph launch: fans in grip (full), launch control with the 3.4 g "retina limit", the four rear
// main jets add thrust on top of what the rear tyres can transmit. Reference: 0.81 s.
import { G0, MPH } from '@shared/math';
import { ROADSTER } from '@shared/roadster';
import { headingToForward, siteFor } from '@shared/track';
import type { RoadsterSim } from '../core/roadsterSim';
import { LineFollower } from '../gnc/drive';
import { requiredAirKg } from '../gnc/feasibility';
import { Stunt, type ResultCheck, type StuntOptions } from './base';
import { MAIN_JETS, valveTestPhases } from './flightPhases';
import { TUNING } from './tuning';

const P = TUNING.zero60;

export class Zero60Stunt extends Stunt {
  readonly site = siteFor('zero60');
  readonly line = new LineFollower(this.site.spawn.pos, this.site.spawn.headingDeg);
  readonly fwd = headingToForward(this.site.spawn.headingDeg);
  private tLaunch = 0;
  private readonly mainThrust = new Float64Array(10);

  constructor(sim: RoadsterSim, opts: StuntOptions = {}) {
    super('zero60', sim, opts);
    this.timeoutS = opts.timeoutS ?? 20;
    const st = this;
    this.phases = {
      staging: {
        enter: () => { this.systems.fanMode = 'grip'; this.systems.fanLevel = 1; this.systems.aeroMode = 'highDownforce'; },
        update: () => {
          this.brakeToStop();
          this.drive.launchMode = true;
          if (this.phaseTime < 2.0) return null;
          return this.est.airKg >= requiredAirKg('zero60') ? 'launch' : 'launch_no_jets';
        },
      },
      launch: {
        enter: () => { this.tLaunch = this.t; this.markStart(); },
        update: () => this.run(true),
      },
      launch_no_jets: {
        enter: () => { this.tLaunch = this.t; this.markStart(); this.emit('info', 'not enough air for the jets: tyres + fans only'); },
        update: () => this.run(false),
      },
      stop: {
        enter: () => { this.systems.aeroMode = 'highDownforce'; },
        update: () => {
          this.drive.throttle = 0; this.drive.brake = 0.8; this.drive.launchMode = false; this.drive.accelLimitG = null;
          this.drive.steer = this.line.steer(this.est.pos, this.est.q, this.est.speed);
          if (this.est.speed < 0.3) { this.succeed(); return 'done'; }
          return null;
        },
      },
      done: { update: () => { this.brakeToStop(); return null; } },
      ...valveTestPhases(st, 'staging', MAIN_JETS),
    };
  }

  private run(jets: boolean): string | null {
    const d = this.drive;
    d.brake = 0; d.throttle = 1; d.launchMode = true; d.accelLimitG = P.accelLimitG;
    d.steer = this.line.steer(this.est.pos, this.est.q, this.est.speed);
    if (jets) {
      // Valve PWM would make the jet thrust jump between 0 and 4.3 g, and the 3.4 g governor can only
      // trim the peaks (regen), not fill the gaps. So whole nozzle pairs run fully open (symmetric
      // about the centre line -> no yaw): the inner pair ≈ 2.1 g on top of ≈ 1.3–1.4 g from the tyres.
      this.sim.propulsion.availableThrust(this.mainThrust);
      const m = ROADSTER.dryMassKg + this.est.airKg; // nominal mass (GNC never reads the plant's true mass)
      const pairG = (this.mainThrust[1] + this.mainThrust[2]) / (m * G0);
      const pairs = Math.max(1, Math.min(2, Math.round(P.mainsThrustG / pairG)));
      this.thrust.duty[1] = 1; this.thrust.duty[2] = 1;
      if (pairs > 1) { this.thrust.duty[0] = 1; this.thrust.duty[3] = 1; }
    }
    const v = this.est.vel.x * this.fwd.x + this.est.vel.z * this.fwd.z;
    if (v >= P.targetMs) {
      this.metrics.zeroToSixtyS = this.t - this.tLaunch;
      this.emit('info', `0-60 mph in ${this.metrics.zeroToSixtyS.toFixed(3)} s`);
      return 'stop';
    }
    return null;
  }

  protected initialPhase(): string { return 'precheck'; }

  protected referenceMetrics(): Record<string, number> { return { zeroToSixtyS: this.metrics.zeroToSixtyS }; }

  protected evaluate(): ResultCheck[] {
    const m = this.metrics, r = this.reference;
    return [
      { name: '0–60 mph 0.81 s ±0.1 s', value: m.zeroToSixtyS, target: `${(r.zeroToSixtyS - 0.1).toFixed(2)}..${(r.zeroToSixtyS + 0.1).toFixed(2)}`, ok: Math.abs(m.zeroToSixtyS - r.zeroToSixtyS) <= 0.1 },
      { name: 'not crashed', value: this.sim.getState().crashed ? 1 : 0, target: '0', ok: !this.sim.getState().crashed },
    ];
  }
}

export const SIXTY_MPH = 60 * MPH;
