// Shared helpers for the vehicle tests (headless).
import { createRoadsterSim, vehicleModules } from '../../../src/sim/vehicle';
import type { RoadsterSim } from '../../../src/sim/core/roadsterSim';
import { TRACK, profileLength, rampLocalToWorld, sampleProfile, type CurvedRamp } from '../../../src/shared/track';
import { ROADSTER } from '../../../src/shared/roadster';
import { qaxisAngle, type Quat, type Vec3 } from '../../../src/shared/math';
import {
  neutralDrive, neutralSystems, zeroThrust, type DriveInput, type SpawnPose, type SystemsInput, type ThrusterCommand,
} from '../../../src/shared/types';

export interface Rig {
  sim: RoadsterSim;
  drive: DriveInput;
  systems: SystemsInput;
  thr: ThrusterCommand;
  vm: ReturnType<typeof vehicleModules>;
  /** Steps for `seconds`; the callback runs before each step (controllers) and may return true to stop. */
  run(seconds: number, cb?: (t: number) => boolean | void): number;
}

export async function rig(opts: { dt?: number } = {}): Promise<Rig> {
  const sim = await createRoadsterSim(opts);
  const drive = neutralDrive(), systems = neutralSystems(), thr = zeroThrust();
  const r: Rig = {
    sim, drive, systems, thr, vm: vehicleModules(sim),
    run(seconds, cb) {
      const n = Math.round(seconds / sim.dt);
      for (let i = 0; i < n; i++) {
        if (cb && cb(sim.getState().t)) return i;
        sim.step(drive, systems, thr);
      }
      return n;
    },
  };
  return r;
}

export function resetInputs(r: Rig): void {
  Object.assign(r.drive, neutralDrive());
  Object.assign(r.systems, neutralSystems());
  r.systems.fanLevel = null;
  r.thr.duty.fill(0);
}

export const wallRamp = (): CurvedRamp => TRACK.ramps.find((x) => x.id === 'wall')!;
export const kicker = (): CurvedRamp => TRACK.ramps.find((x) => x.id === 'kicker')!;

const FRONT = ROADSTER.wheels[0].pos.z, REAR = -ROADSTER.wheels[2].pos.z;

/** Chord pose of the car standing on a ramp with its wheel contacts at arc lengths s0+FRONT / s0-REAR. */
function chordAt(ramp: CurvedRamp, s0: number): { pitch: number; pos: Vec3 } {
  const f = sampleProfile(ramp.profile, s0 + FRONT), b = sampleProfile(ramp.profile, s0 - REAR);
  let pitch = Math.atan2(f.y - b.y, f.z - b.z);
  if (pitch < -0.5) pitch += 2 * Math.PI;
  const k = REAR / (FRONT + REAR);
  return { pitch, pos: { x: 0, y: b.y + (f.y - b.y) * k, z: b.z + (f.z - b.z) * k } };
}

/**
 * Spawn pose on a ramp (heading 0 ramps only) with the given body pitch (deg, 0..~175) or the highest
 * reachable one (front wheels 0.3 m before the ramp end). Returns the pose and the pitch achieved.
 */
export function rampPose(ramp: CurvedRamp, pitchDeg: number): { spawn: SpawnPose; pitchDeg: number } {
  const L = profileLength(ramp.profile);
  let lo = REAR + 0.01, hi = L - FRONT - 0.3;
  const target = (pitchDeg * Math.PI) / 180;
  if (chordAt(ramp, hi).pitch > target) {
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (chordAt(ramp, mid).pitch < target) lo = mid; else hi = mid; }
  }
  const c = chordAt(ramp, hi);
  const quat: Quat = qaxisAngle({ x: 1, y: 0, z: 0 }, -c.pitch);
  return { spawn: { pos: rampLocalToWorld(ramp, c.pos), quat }, pitchDeg: (c.pitch * 180) / Math.PI };
}

/** Spin the fans up instantly (test shortcut instead of waiting spoolTimeS). */
export function prespinFans(r: Rig, rpm = 1): void { r.vm.fans.rpm = rpm; }

export const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
