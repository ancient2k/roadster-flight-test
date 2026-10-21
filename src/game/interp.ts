// Snapshot + interpolation of VehicleState for smooth rendering between fixed steps.
import type { VehicleState } from '@shared/types';
import { lerp, qslerp } from '@shared/math';

/** Deep copy of the parts of the state the renderer/HUD/audio read. */
export function cloneState(s: Readonly<VehicleState>): VehicleState {
  return structuredClone(s) as VehicleState;
}

/** Copy `src` into an existing snapshot without allocating (hot path). */
export function copyStateInto(dst: VehicleState, s: Readonly<VehicleState>): void {
  dst.t = s.t;
  dst.pos.x = s.pos.x; dst.pos.y = s.pos.y; dst.pos.z = s.pos.z;
  dst.quat.x = s.quat.x; dst.quat.y = s.quat.y; dst.quat.z = s.quat.z; dst.quat.w = s.quat.w;
  dst.linVel.x = s.linVel.x; dst.linVel.y = s.linVel.y; dst.linVel.z = s.linVel.z;
  dst.angVel.x = s.angVel.x; dst.angVel.y = s.angVel.y; dst.angVel.z = s.angVel.z;
  dst.specificForce.x = s.specificForce.x; dst.specificForce.y = s.specificForce.y; dst.specificForce.z = s.specificForce.z;
  dst.massKg = s.massKg;
  for (let i = 0; i < s.wheels.length; i++) {
    const a = dst.wheels[i], b = s.wheels[i];
    a.contact = b.contact; a.compression = b.compression; a.suspensionForceN = b.suspensionForceN;
    a.slipRatio = b.slipRatio; a.slipAngleRad = b.slipAngleRad; a.angularVel = b.angularVel; a.steerRad = b.steerRad;
    a.normalLoadN = b.normalLoadN;
    a.contactPoint.x = b.contactPoint.x; a.contactPoint.y = b.contactPoint.y; a.contactPoint.z = b.contactPoint.z;
    a.surfaceNormal.x = b.surfaceNormal.x; a.surfaceNormal.y = b.surfaceNormal.y; a.surfaceNormal.z = b.surfaceNormal.z;
  }
  Object.assign(dst.tank, s.tank);
  for (let i = 0; i < s.nozzles.length; i++) Object.assign(dst.nozzles[i], s.nozzles[i]);
  Object.assign(dst.fans, s.fans);
  Object.assign(dst.aero, s.aero);
  dst.speedMs = s.speedMs; dst.motorPowerW = s.motorPowerW; dst.brakeInput = s.brakeInput;
  dst.groundContact = s.groundContact; dst.bodyContact = s.bodyContact;
  dst.heightAboveGroundM = s.heightAboveGroundM; dst.crashed = s.crashed;
  dst.damage = s.damage; // shared, mutated in place by the sim (discrete, not interpolated)
}

/** out = interpolation between prev and cur (pose, wheels; discrete fields from cur). */
export function interpolateState(out: VehicleState, prev: VehicleState, cur: VehicleState, alpha: number): VehicleState {
  alpha = Math.min(1, Math.max(0, alpha));
  copyStateInto(out, cur);
  out.t = lerp(prev.t, cur.t, alpha);
  out.pos.x = lerp(prev.pos.x, cur.pos.x, alpha);
  out.pos.y = lerp(prev.pos.y, cur.pos.y, alpha);
  out.pos.z = lerp(prev.pos.z, cur.pos.z, alpha);
  const q = qslerp(prev.quat, cur.quat, alpha);
  out.quat.x = q.x; out.quat.y = q.y; out.quat.z = q.z; out.quat.w = q.w;
  for (let i = 0; i < cur.wheels.length; i++) {
    out.wheels[i].compression = lerp(prev.wheels[i].compression, cur.wheels[i].compression, alpha);
    out.wheels[i].steerRad = lerp(prev.wheels[i].steerRad, cur.wheels[i].steerRad, alpha);
  }
  out.aero.wingAngleDeg = lerp(prev.aero.wingAngleDeg, cur.aero.wingAngleDeg, alpha);
  return out;
}
