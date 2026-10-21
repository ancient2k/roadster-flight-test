// Shared contracts between sim (physics + GNC), game integration, render and UI.
// Shared contracts between simulation, renderer and UI: change with care, all layers depend on them.
import type { Quat, Vec3 } from './math';
import type { DamageState } from './damage';

export const NOZZLE_COUNT = 10;
export type NozzleGroup = 'main' | 'lift' | 'yaw';
export type WheelId = 'FL' | 'FR' | 'RL' | 'RR';
export const WHEEL_IDS: readonly WheelId[] = ['FL', 'FR', 'RL', 'RR'];

export type FanMode = 'off' | 'grip' | 'highspeed';
export type AeroMode = 'lowDrag' | 'highDownforce' | 'auto';
export type AssistLevel = 'ASSIST' | 'STABILIZED' | 'RAW';
export type StuntId = 'ramp_hang' | 'ramp_launch' | 'kickflip' | 'zero60' | 'ground_flip';

/** Driver / autopilot inputs for the ground vehicle. All normalized. */
export interface DriveInput {
  throttle: number;   // 0..1
  brake: number;      // 0..1
  steer: number;      // -1 (left) .. +1 (right)
  handbrake: boolean;
  reverse: boolean;
  launchMode: boolean;            // launch control (traction + accel limit)
  /**
   * Longitudinal acceleration governor on the specific force (e.g. 3.4 "retina limit").
   * The powertrain feeds forward thruster + aero forces and may regenerate (negative torque)
   * to hold the limit. null = no limit.
   */
  accelLimitG: number | null;
}

export interface SystemsInput {
  fanMode: FanMode;
  aeroMode: AeroMode;
  wingAngleDeg: number | null;    // null = automatic
  /** Fan power demand 0..1 in grip mode; null/undefined = automatic demand control. */
  fanLevel?: number | null;
  refill: boolean;                // run onboard compressor
}

/**
 * Valve commands. `duty` is the requested time-average opening (0..1) per nozzle for the
 * coming control period. The valve layer (sigma-delta / impulse-error accumulation with
 * min-on-time and opening delay) turns it into actual open/closed states.
 */
export interface ThrusterCommand { duty: Float32Array } // length NOZZLE_COUNT

export interface WheelState {
  id: WheelId;
  contact: boolean;
  compression: number;        // m (0 = fully extended)
  suspensionForceN: number;
  slipRatio: number;
  slipAngleRad: number;
  angularVel: number;         // rad/s
  steerRad: number;
  normalLoadN: number;
  contactPoint: Vec3;         // world
  surfaceNormal: Vec3;        // world
}

export interface TankState {
  airMassKg: number;
  pressurePa: number;
  gasTempK: number;
  wallTempK: number;
  feedPressurePa: number;     // downstream of regulator
  regulated: boolean;         // feed pressure held at setpoint
}

export interface NozzleState {
  open: boolean;              // actual valve state this step
  thrustN: number;            // actual thrust magnitude this step
  massFlowKgS: number;
  exitPressureRatio: number;  // pe/pa, drives Mach-diamond visuals
}

export interface FanState {
  mode: FanMode;
  deltaPPa: number;           // underbody pressure deficit
  flowM3s: number;
  powerW: number;
  forceN: number;             // suction force magnitude (body -Y)
  gapM: number;               // effective skirt gap
  rpmNorm: number;            // 0..1 spool-up for audio/visuals
}

export interface AeroState {
  mode: AeroMode;
  wingAngleDeg: number;
  dragN: number;
  downforceN: number;
}

/** Full simulation snapshot (render reads it, GNC reads it, telemetry records it). */
export interface VehicleState {
  t: number;                  // sim time s
  pos: Vec3;                  // CoG world position
  quat: Quat;                 // body -> world
  linVel: Vec3;               // world m/s
  angVel: Vec3;               // world rad/s
  specificForce: Vec3;        // body frame, m/s^2 (accelerometer reading incl. gravity reaction)
  massKg: number;
  wheels: WheelState[];
  tank: TankState;
  nozzles: NozzleState[];     // length NOZZLE_COUNT
  fans: FanState;
  aero: AeroState;
  speedMs: number;
  motorPowerW: number;
  /** Brake demand applied this step, 0..1 (service brake or handbrake) – drives the brake lights. */
  brakeInput: number;
  groundContact: boolean;     // any wheel in contact
  bodyContact: boolean;       // chassis touching geometry (crash indicator)
  heightAboveGroundM: number; // CoG to nearest surface below (world -Y ray)
  crashed: boolean;
  /** Vehicle damage (only with the setting "Vehicle damage: Realistic", see src/shared/damage.ts). */
  damage?: DamageState;
}

/** Values in the style of the Tesla stream HUD (+ extras). */
export interface TelemetryFrame {
  t: number;
  altitudeM: number;          // lowest body point above ground plane (y=0), like the stream ALTITUDE
  pitchDeg: number;           // hudPitchDeg
  rollDeg: number;
  gForce: number;             // |specific force| / g0, 10 Hz low-pass
  downforceKg: number;        // (fan suction + aero downforce) / g0
  speedMs: number;
  tankPressureBar: number;
  airMassKg: number;
  thrusterDuty: number[];     // actual open fraction over the last frame, per nozzle
  fanDeltaPKPa: number;
  phase: string;              // GNC phase label ('' in manual)
}

export interface SpawnPose { pos: Vec3; quat: Quat; speedMs?: number }

/** Contract the physics layer implements. One instance = one car in one world. */
export interface VehicleSim {
  reset(spawn: SpawnPose, opts?: { airMassKg?: number }): void;
  /** Advance exactly one fixed step (dt = SIM_DT). */
  step(drive: DriveInput, systems: SystemsInput, thrusters: ThrusterCommand): void;
  getState(): Readonly<VehicleState>;
  telemetry(): TelemetryFrame;
  dispose(): void;
}

export const SIM_HZ = 240;
export const SIM_DT = 1 / SIM_HZ;

/**
 * Tick order (binding for every implementation):
 *  1. read state (previous step result)
 *  2. GNC / input -> DriveInput, SystemsInput, ThrusterCommand
 *  3. valves update (delay, min-on, sigma-delta) -> actual open states
 *  4. tank + feed + nozzle flow -> thrust per nozzle, mass removed
 *  5. force modules (suspension/tires, powertrain, fans, aero, thrusters) -> forces at points
 *  6. Rapier step (gravity applied by Rapier only, mass/inertia set explicitly)
 *  7. derive VehicleState + telemetry
 */
export const TICK_ORDER = 'state>gnc>valves>tank>forces>rapier>telemetry';

export const neutralDrive = (): DriveInput => ({
  throttle: 0, brake: 0, steer: 0, handbrake: false, reverse: false, launchMode: false, accelLimitG: null,
});
export const neutralSystems = (): SystemsInput => ({ fanMode: 'off', aeroMode: 'auto', wingAngleDeg: null, refill: false });
export const zeroThrust = (): ThrusterCommand => ({ duty: new Float32Array(NOZZLE_COUNT) });
