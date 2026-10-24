// SimSession: one run of the game (an auto stunt or free manual testing). DOM-free and headless-capable,
// so the whole game logic (sim + controller + recorder + outcome) is testable in Node.
import type { RoadsterSim } from '@sim/core/roadsterSim';
import { spawnPose } from '@sim/core/roadsterSim';
import { siteFor } from '@shared/track';
import type {
  SpawnPose,
  AeroMode, AssistLevel, DriveInput, FanMode, StuntId, SystemsInput, TelemetryFrame, ThrusterCommand, VehicleState,
} from '@shared/types';
import { neutralDrive, neutralSystems, zeroThrust } from '@shared/types';
import { ROADSTER } from '@shared/roadster';
import { Recorder } from './recorder';
import { AutoGear } from '../input/autoGear';
import { qrot } from '@shared/math';

export interface ControlOutput {
  drive: DriveInput;
  systems: SystemsInput;
  thrust: ThrusterCommand;
  phase: string;
  events?: readonly object[];
}

/** Anything that turns the current sim state into commands once per fixed step. */
export interface Controller {
  update(): ControlOutput;
  /** Final outcome for auto stunts (null while running / for manual). */
  result?(): unknown | null;
}

export interface ManualAxes { lift: number; boost: number; pitch: number; roll: number; yaw: number }
export interface ManualAssistLike { update(sim: RoadsterSim, axes: ManualAxes, level: AssistLevel): ThrusterCommand }

/** Free-play controller: driver inputs + toggles + assisted thrust. */
export class ManualController implements Controller {
  drive: DriveInput = neutralDrive();
  axes: ManualAxes = { lift: 0, boost: 0, pitch: 0, roll: 0, yaw: 0 };
  assist: AssistLevel = 'ASSIST';
  fanMode: FanMode = 'off';
  aeroMode: AeroMode = 'auto';
  refill = false;
  constructor(private sim: RoadsterSim, private assistImpl: ManualAssistLike | null) {}

  cycleFan(): FanMode { this.fanMode = this.fanMode === 'off' ? 'grip' : this.fanMode === 'grip' ? 'highspeed' : 'off'; return this.fanMode; }
  cycleAero(): AeroMode { this.aeroMode = this.aeroMode === 'auto' ? 'highDownforce' : this.aeroMode === 'highDownforce' ? 'lowDrag' : 'auto'; return this.aeroMode; }
  cycleAssist(): AssistLevel { this.assist = this.assist === 'ASSIST' ? 'STABILIZED' : this.assist === 'STABILIZED' ? 'RAW' : 'ASSIST'; return this.assist; }

  /** After a spawn the car first settles onto its wheels (≥ 3 in contact, at least 1.5 s, at most 5 s);
   *  the assist would otherwise treat the not-yet-landed car as airborne and hold or climb. */
  settleMinS = 1.5;
  settleMaxS = 5;
  private settled = false;
  readonly gear = new AutoGear();

  update(): ControlOutput {
    const st0 = this.sim.getState();
    if (!this.settled) {
      const onWheels = st0.wheels.filter((w) => w.contact).length >= 3;
      const anyInput = Math.abs(this.axes.lift) + this.axes.boost + Math.abs(this.axes.pitch) + Math.abs(this.axes.roll) + Math.abs(this.axes.yaw) > 0.05;
      if ((st0.t >= this.settleMinS && (onWheels || anyInput)) || st0.t >= this.settleMaxS || st0.heightAboveGroundM > 3) this.settled = true;
    }
    const settling = !this.settled;
    const thrust = settling ? zeroThrust() : this.assistImpl ? this.assistImpl.update(this.sim, this.axes, this.assist) : rawGroups(this.axes);
    const systems: SystemsInput = { ...neutralSystems(), fanMode: this.fanMode, aeroMode: this.aeroMode, refill: this.refill };
    // Auto-hold (as on Tesla cars): standing still on the wheels without pedal input holds the brakes.
    const st = this.sim.getState();
    // automatic reverse gear: S held at standstill reverses, W at standstill goes forward again
    const fwd = qrot(st.quat, { x: 0, y: 0, z: 1 });
    let drive = this.gear.update(this.drive, st.linVel.x * fwd.x + st.linVel.y * fwd.y + st.linVel.z * fwd.z, this.sim.dt);
    if (st.groundContact && st.speedMs < 0.6 && drive.throttle < 0.02 && drive.brake < 0.02) drive = { ...drive, brake: 0.6 };
    return { drive, systems, thrust, phase: '' };
  }
}

/** Fallback direct group mapping (used until/if no assist implementation is supplied). */
export function rawGroups(a: ManualAxes): ThrusterCommand {
  const c = zeroThrust();
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  for (let i = 0; i < 4; i++) c.duty[i] = clamp01(a.boost);
  // lift corners: FL 4, FR 5, RL 6, RR 7 (+X = left). pitch + = nose up -> more front; roll + = right down -> more left.
  const L = clamp01(a.lift);
  c.duty[4] = clamp01(L + 0.5 * a.pitch + 0.5 * a.roll);
  c.duty[5] = clamp01(L + 0.5 * a.pitch - 0.5 * a.roll);
  c.duty[6] = clamp01(L - 0.5 * a.pitch + 0.5 * a.roll);
  c.duty[7] = clamp01(L - 0.5 * a.pitch - 0.5 * a.roll);
  c.duty[8] = clamp01(a.yaw);    // YAW_L pushes the nose right
  c.duty[9] = clamp01(-a.yaw);
  return c;
}

export type SessionMode =
  | { kind: 'auto'; stunt: StuntId }
  | { kind: 'manual'; stunt?: StuntId; spawn?: SpawnPose; siteId?: string };

export interface SessionOutcome { status: 'running' | 'success' | 'failed'; reason?: string; result?: unknown }

export class SimSession {
  readonly recorder = new Recorder(60, 180);
  controller!: Controller;
  outcome: SessionOutcome = { status: 'running' };
  lastOutput: ControlOutput | null = null;
  private tel: TelemetryFrame | null = null;
  infiniteAir = false;

  constructor(readonly sim: RoadsterSim, readonly mode: SessionMode, private makeController: (sim: RoadsterSim, mode: SessionMode) => Controller) {
    this.restart();
  }

  restart(): void {
    if (this.mode.kind === 'manual' && this.mode.spawn) {
      this.sim.reset(this.mode.spawn);
    } else {
      const site = siteFor(this.mode.kind === 'auto' ? this.mode.stunt : this.mode.stunt ?? 'zero60');
      this.sim.reset(spawnPose(site.spawn.pos, site.spawn.headingDeg, site.spawn.speedMs));
    }
    this.controller = this.makeController(this.sim, this.mode);
    this.recorder.clear();
    this.outcome = { status: 'running' };
    this.tel = null;
    this.lastOutput = null;
  }

  step(): void {
    const out = this.controller.update();
    this.lastOutput = out;
    if (out.phase) this.sim.setPhaseLabel(out.phase);
    this.sim.step(out.drive, out.systems, out.thrust);
    // infinite air: a full tank at ambient temperature every step. Refilling the mass at the current gas temperature
    // let the expansion cooling run down to the 60 K floor, which left a "full" 250 kg tank at about 2,000 psi.
    if (this.infiniteAir) this.sim.propulsion.tank.fill(ROADSTER.tank.fullMassKg, ROADSTER.tank.ambientTempK);
    this.tel = this.sim.telemetry();
    this.recorder.push(this.sim.getState(), this.tel);
    if (this.outcome.status === 'running') {
      const r = this.controller.result?.() as { success?: boolean; reason?: string } | null | undefined;
      if (r && typeof r.success === 'boolean') this.outcome = { status: r.success ? 'success' : 'failed', reason: r.reason, result: r };
      else if (this.sim.getState().crashed && this.mode.kind === 'auto') this.outcome = { status: 'failed', reason: this.sim.getState().damage?.totalLoss ? 'totalLoss' : 'crash' };
      // vehicle damage "Full": a total loss does not end a free run — the wreck stays until the player resets
    }
  }

  state(): Readonly<VehicleState> { return this.sim.getState(); }
  telemetry(): TelemetryFrame { return this.tel ?? this.sim.telemetry(); }
}
