// Stunt phase machines: shared runtime (estimator, flight control, drive controllers, metrics).
// A stunt only issues the same commands a driver could (drive/systems/valve duties) to the same
// RoadsterSim. No force injection, no kinematic paths.
import { DEG, qrot, qrotInv, v3, type Vec3 } from '@shared/math';
import { ROADSTER } from '@shared/roadster';
import { siteFor } from '@shared/track';
import {
  NOZZLE_COUNT, neutralDrive, neutralSystems,
  type DriveInput, type StuntId, type SystemsInput, type TelemetryFrame, type ThrusterCommand,
} from '@shared/types';
import type { RoadsterSim } from '../core/roadsterSim';
import { FlightControl, newFlightCommand, type FlightCommand } from '../gnc/flight';
import { Estimator, type StateEstimate } from '../gnc/estimator';
import { Lander } from '../gnc/guidance';
import { SpeedController, forwardSpeed } from '../gnc/drive';
import { videoFit, videoFitMetrics, type VideoFit } from './validation';

export type GncEventKind = 'phase' | 'launch' | 'liftoff' | 'apex' | 'touchdown' | 'abort' | 'success' | 'failure' | 'info';
export interface GncEvent { t: number; kind: GncEventKind; phase: string; message: string }

export interface ResultCheck { name: string; value: number; target: string; ok: boolean }

export interface StuntResult {
  stunt: StuntId;
  success: boolean;
  reason: string;
  /** Measured key figures (SI unless the name says otherwise). */
  metrics: Record<string, number>;
  /** Reference values from TRACK.sites[].reference (video). */
  reference: Record<string, number>;
  checks: ResultCheck[];
  /** Telemetry trace (20 Hz). */
  trace: TelemetryFrame[];
  airUsedKg: number;
  durationS: number;
  /** Sim time of the manoeuvre start the video curves (VIDEO_REFERENCE, t = 0) are aligned to. */
  startT: number;
  /** Time-aligned comparison with VIDEO_REFERENCE (ramp_hang, ramp_launch, kickflip); also flattened into metrics.video_*. */
  video?: VideoFit | null;
}

export interface StuntOptions {
  /** Start directly in this phase (tests: airborne spawns before the ground physics exist). */
  startPhase?: string;
  /** Sensor noise seed; null/undefined = perfect state. */
  noiseSeed?: number | null;
  /** Abort the stunt when one phase lasts longer than this many seconds (hung-phase guard; default per stunt). */
  timeoutS?: number;
}

export interface Phase {
  enter?(): void;
  /** Returns the next phase name to switch, or null to stay. */
  update(): string | null;
}

/** Running metrics, updated every control step. */
export class Metrics {
  maxAltitudeM = 0;
  maxG = 0;
  launchG = 0;
  touchdownG = 0;
  /** Peak g during the landing burn (airborne, landing guidance thrusting), before the touchdown impact. */
  landingBurnG = 0;
  touchdownSinkMs = NaN;
  touchdownSpeedMs = NaN;
  touchdownUpY = NaN;
  rollDeg = 0;         // unwrapped rotation about body Z while airborne
  pitchRotDeg = 0;     // unwrapped rotation about body X while airborne
  maxPitchDeg = -999;
  maxDownforceKg = 0;
  airborneS = 0;
  liftoffT = NaN;
  touchdownT = NaN;
  apexT = NaN;
  obstacleContact = false;
  rampContactInFlight = false;
  holdS = 0;
  zeroToSixtyS = NaN;
  air0 = 0;
  minAirKg = 0;
}

export abstract class Stunt {
  readonly id: StuntId;
  readonly sim: RoadsterSim;
  readonly estimator: Estimator;
  readonly fc: FlightControl;
  readonly lander = new Lander();
  readonly speed = new SpeedController();
  readonly cmd: FlightCommand = newFlightCommand();
  readonly drive: DriveInput = neutralDrive();
  readonly systems: SystemsInput = neutralSystems();
  readonly thrust: ThrusterCommand = { duty: new Float32Array(NOZZLE_COUNT) };
  readonly events: GncEvent[] = [];
  readonly metrics = new Metrics();
  readonly trace: TelemetryFrame[] = [];
  est!: StateEstimate;
  phase = '';
  phaseT0 = 0;
  t = 0;
  /** Thrusters active this step (otherwise all duties are zero). */
  flying = false;
  airborne = false;
  finished: StuntResult | null = null;
  protected phases: Record<string, Phase> = {};
  protected timeoutS = 60;
  private lastTrace = -1;
  private prevVy = 0;
  private prevQ = { x: 0, y: 0, z: 0, w: 1 };
  private tdWindow = -1;
  private stepEvents: GncEvent[] = [];
  readonly opts: StuntOptions;

  constructor(id: StuntId, sim: RoadsterSim, opts: StuntOptions = {}) {
    this.id = id;
    this.sim = sim;
    this.opts = opts;
    this.estimator = new Estimator(opts.noiseSeed ?? null);
    this.fc = new FlightControl(sim);
    this.lander.dt = sim.dt;
    this.lander.surfaceY = 0; // stunt landings: on the McGregor pad (ground plane y = 0, TRACK)
    if (opts.timeoutS) this.timeoutS = opts.timeoutS;
  }

  get reference(): Record<string, number> { return siteFor(this.id).reference; }
  get phaseTime(): number { return this.t - this.phaseT0; }

  /** First phase when no startPhase is given. */
  protected abstract initialPhase(): string;
  /** Pass/fail checks at the end. */
  protected abstract evaluate(): ResultCheck[];
  /** Key figures under exactly the keys of TRACK.sites[].reference (result screen). */
  protected abstract referenceMetrics(): Record<string, number>;
  /** Manoeuvre start for aligning with the video reference (see StuntResult.startT). */
  startT = NaN;
  abortReason = '';
  markStart(offsetS = 0): void { if (Number.isNaN(this.startT)) this.startT = this.t - offsetS; }

  start(): void {
    const s = this.sim.getState();
    this.metrics.air0 = s.tank.airMassKg;
    this.metrics.minAirKg = s.tank.airMassKg;
    this.prevVy = s.linVel.y;
    this.prevQ = { ...s.quat };
    this.t = s.t;
    this.est = this.estimator.update(s);
    this.fc.refresh(this.est);
    this.goto(this.opts.startPhase ?? this.initialPhase(), 'start');
  }

  goto(name: string, why = ''): void {
    if (!this.phases[name]) throw new Error(`${this.id}: unknown phase ${name}`);
    this.phase = name;
    this.phaseT0 = this.t;
    this.sim.setPhaseLabel(name);
    this.emit('phase', why ? `${name} (${why})` : name);
    this.phases[name].enter?.();
  }

  emit(kind: GncEventKind, message: string): void {
    const e = { t: this.t, kind, phase: this.phase, message };
    this.events.push(e);
    this.stepEvents.push(e);
  }

  /** One control step: read state, run the phase machine, produce commands. */
  step(): { events: GncEvent[] } {
    this.stepEvents = [];
    const s = this.sim.getState();
    this.t = s.t;
    this.est = this.estimator.update(s);
    // defaults for this step
    this.flying = false;
    this.thrust.duty.fill(0);
    if (!this.finished) {
      if (this.t - (this.phaseT0 - 0) > this.timeoutS && this.phase !== 'done') this.fail(`timeout in ${this.phase}`);
      else {
        for (let guard = 0; guard < 4; guard++) {
          const next = this.phases[this.phase].update();
          if (!next || next === this.phase) break;
          this.goto(next);
        }
      }
    } else {
      // after the result: hold still
      this.drive.throttle = 0; this.drive.brake = 1; this.drive.steer = 0;
    }
    if (this.flying) this.fc.compute(this.est, this.cmd, this.thrust.duty);
    this.fc.observe(this.thrust.duty);
    this.track(s);
    return { events: this.stepEvents };
  }

  /** Set the flight command and mark thrusters active for this step. */
  fly(): void { this.flying = true; }

  /** Speed control along the body forward axis. */
  holdSpeed(vRef: number, aRef = 0): void {
    this.speed.update(vRef, forwardSpeed(this.est.vel, this.est.q), this.sim.dt, this.drive, aRef);
  }

  /** After touchdown: let the suspension settle (0.7 s) before braking progressively. */
  rolloutBrake(maxBrake = 0.8): void {
    const t = this.phaseTime;
    this.drive.throttle = 0; this.drive.launchMode = false;
    this.drive.brake = t < 0.7 ? 0 : Math.min(maxBrake, 0.2 + (t - 0.7));
  }

  brakeToStop(): void { this.drive.throttle = 0; this.drive.brake = 1; this.drive.launchMode = false; }

  /** True once wheels (or, without a wheel model, the chassis box) touch a surface. */
  get touching(): boolean { return this.est.groundContact || this.est.bodyContact; }

  wheelsHeight(): number { return this.est.height - ROADSTER.restCogHeightM; }

  upY(): number { return qrot(this.est.q, v3(0, 1, 0)).y; }

  succeed(reason = 'ok'): void { this.finish(true, reason); }
  fail(reason: string): void { this.finish(false, reason); }

  private finish(success: boolean, reason: string): void {
    if (this.finished) return;
    const checks = success ? this.evaluate() : this.evaluate().concat([{ name: 'stunt completed', value: 0, target: reason, ok: false }]);
    const ok = success && checks.every((c) => c.ok);
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    const m = this.metrics;
    const metrics: Record<string, number> = {};
    for (const [k, v] of Object.entries(m)) if (typeof v === 'number') metrics[k] = v;
    metrics.airUsedKg = m.air0 - this.sim.getState().tank.airMassKg;
    Object.assign(metrics, this.referenceMetrics());
    const startT = Number.isNaN(this.startT) ? 0 : this.startT;
    const video = videoFit(this.id, this.trace, startT);
    Object.assign(metrics, videoFitMetrics(video));
    this.finished = {
      stunt: this.id, success: ok,
      reason: ok ? reason : success ? `checks failed: ${failed.join(', ')}` : reason,
      metrics, reference: { ...this.reference }, checks, trace: this.trace,
      airUsedKg: metrics.airUsedKg, durationS: this.t, startT, video,
    };
    this.emit(ok ? 'success' : 'failure', this.finished.reason);
    this.phase = 'done';
    this.sim.setPhaseLabel('done');
  }

  /** Metrics bookkeeping (true state, not the noisy estimate). */
  private track(s: ReturnType<RoadsterSim['getState']>): void {
    const tel = this.sim.telemetry();
    const m = this.metrics, dt = this.sim.dt;
    if (this.t - this.lastTrace >= 0.05 - 1e-9) { this.trace.push(tel); this.lastTrace = this.t; }
    m.maxG = Math.max(m.maxG, tel.gForce);
    m.maxDownforceKg = Math.max(m.maxDownforceKg, tel.downforceKg);
    m.maxPitchDeg = Math.max(m.maxPitchDeg, tel.pitchDeg);
    m.minAirKg = Math.min(m.minAirKg, s.tank.airMassKg);
    for (const c of this.sim.contacts) {
      if (c.kind === 'obstacle') m.obstacleContact = true;
      if (c.kind === 'ramp' && this.airborne) m.rampContactInFlight = true;
    }
    if (this.airborne) {
      if (this.lander.burning && this.flying) m.landingBurnG = Math.max(m.landingBurnG, tel.gForce);
      m.airborneS += dt;
      m.maxAltitudeM = Math.max(m.maxAltitudeM, tel.altitudeM);
      if (Number.isNaN(m.apexT) && s.linVel.y < 0 && this.prevVy >= 0) { m.apexT = this.t; this.emit('apex', `apex ${tel.altitudeM.toFixed(2)} m`); }
      // unwrapped body rotation: integrate the body rate
      const wb = qrotInv(s.quat, s.angVel);
      m.rollDeg += (wb.z * dt) / DEG;
      m.pitchRotDeg += (wb.x * dt) / DEG;
    }
    if (this.tdWindow >= 0) {
      m.touchdownG = Math.max(m.touchdownG, tel.gForce);
      if (this.t - this.tdWindow > 0.6) this.tdWindow = -1;
    }
    this.prevVy = s.linVel.y;
    this.prevQ.x = s.quat.x; this.prevQ.y = s.quat.y; this.prevQ.z = s.quat.z; this.prevQ.w = s.quat.w;
  }

  /** Call when the car leaves the surface. */
  markLiftoff(kind: 'launch' | 'liftoff' = 'liftoff'): void {
    if (this.airborne) return;
    this.airborne = true;
    this.metrics.liftoffT = this.t;
    this.emit(kind, `${kind} at ${this.sim.telemetry().altitudeM.toFixed(2)} m, ${this.est.speed.toFixed(1)} m/s`);
  }

  /** Call when the car touches down. Records sink rate (previous step, pre-impact) and starts the g window. */
  markTouchdown(): void {
    if (!this.airborne) return;
    this.airborne = false;
    const m = this.metrics;
    m.touchdownT = this.t;
    m.touchdownSinkMs = -this.prevVy;
    m.touchdownSpeedMs = this.est.speed;
    m.touchdownUpY = this.upY();
    this.tdWindow = this.t;
    this.emit('touchdown', `sink ${m.touchdownSinkMs.toFixed(2)} m/s, speed ${m.touchdownSpeedMs.toFixed(1)} m/s`);
  }

  /** True when the wheels have lost the surface for > 0.15 s (e.g. fell off the wall). */
  lostWall(): boolean {
    this.noContactS = this.est.groundContact ? 0 : this.noContactS + this.sim.dt;
    return this.noContactS > 0.15;
  }
  private noContactS = 0;

  /** Thrust/weight helpers for phases. */
  get weightN(): number { return this.fc.mp.mass * this.fc.gMag; }
}

export const vecLen = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
