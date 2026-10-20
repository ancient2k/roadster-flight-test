// Kinematic fake VehicleState for the render sandbox (no physics). A looping show reel:
// kickflip over the vehicle row, inverted hang on the wall ramp, 0-60 launch, flat-ground flip.
import type { NozzleState, VehicleState, WheelState } from '../shared/types';
import { NOZZLE_COUNT } from '../shared/types';
import { ROADSTER } from '../shared/roadster';
import { TRACK, profileLength, sampleProfile, rampLocalToWorld } from '../shared/track';
import { DEG, G0, qaxisAngle, qmul, qrot, qident, clamp, smoothstep, type Quat, type Vec3 } from '../shared/math';

export interface Segment { id: string; label: string; t0: number; t1: number }

const wall = TRACK.ramps.find((r) => r.kind === 'wallRamp')!;
const kicker = TRACK.ramps.find((r) => r.kind === 'kicker')!;
const COG = ROADSTER.restCogHeightM;

// ---------------------------------------------------------------- timeline
const KF = { t0: 0, accelEnd: 4.6 };
export const SEGMENTS: Segment[] = [
  { id: 'kickflip', label: 'Kickflip über die Fahrzeugreihe', t0: 0, t1: 13 },
  { id: 'ramp_hang', label: 'Wandrampe kopfüber', t0: 13, t1: 33 },
  { id: 'zero60', label: '0–60 mit Heckdüsen', t0: 33, t1: 41 },
  { id: 'ground_flip', label: 'Finale: Flip vom Boden', t0: 41, t1: 52 },
];
export const LOOP_S = SEGMENTS[SEGMENTS.length - 1].t1;

interface Pose { pos: Vec3; quat: Quat; vel: Vec3; angVel: Vec3; speed: number; ground: boolean; nozzle: number[]; slip: number; brake: boolean; fan: number; wing: number; accelZ: number }

const yawQ = (h: number) => qaxisAngle({ x: 0, y: 1, z: 0 }, h * DEG);
const pitchQ = (rad: number) => qaxisAngle({ x: 1, y: 0, z: 0 }, rad);   // + = nose down
const rollQ = (rad: number) => qaxisAngle({ x: 0, y: 0, z: 1 }, rad);    // + = right side down

function rampPose(r: typeof wall, s: number): { pos: Vec3; quat: Quat; theta: number } {
  const p = sampleProfile(r.profile, s);
  const n = { y: Math.cos(p.thetaRad), z: -Math.sin(p.thetaRad) };
  const local = { x: 0, y: p.y + n.y * COG, z: p.z + n.z * COG };
  return { pos: rampLocalToWorld(r, local), quat: qmul(yawQ(r.headingDeg), pitchQ(-p.thetaRad)), theta: p.thetaRad };
}

const zero = (): number[] => new Array(NOZZLE_COUNT).fill(0);

function kickflip(t: number): Pose {
  const nz = zero();
  const v0 = 23.5;
  const startZ = kicker.origin.z - 55;
  const a = (v0 * v0) / (2 * (kicker.origin.z - startZ)); // constant accel to reach the kicker
  const tAccel = v0 / a;
  const L = profileLength(kicker.profile);
  const tRamp = L / v0;
  const x = kicker.origin.x;
  if (t < tAccel) {
    const z = startZ + 0.5 * a * t * t, v = a * t;
    return { pos: { x, y: COG, z }, quat: qident(), vel: { x: 0, y: 0, z: v }, angVel: { x: 0, y: 0, z: 0 }, speed: v, ground: true, nozzle: nz, slip: t < 1.2 ? 0.25 : 0.03, brake: false, fan: 1, wing: 4, accelZ: a };
  }
  if (t < tAccel + tRamp) {
    const s = (t - tAccel) * v0;
    const rp = rampPose(kicker, s);
    return { pos: rp.pos, quat: rp.quat, vel: { x: 0, y: v0 * Math.sin(rp.theta), z: v0 * Math.cos(rp.theta) }, angVel: { x: -v0 / 20, y: 0, z: 0 }, speed: v0, ground: true, nozzle: nz, slip: 0, brake: false, fan: 1, wing: 6, accelZ: 0 };
  }
  // ballistic flight from the lip, 360° roll with lift nozzles
  const lip = rampPose(kicker, L);
  const th = lip.theta;
  const vy0 = v0 * Math.sin(th), vz0 = v0 * Math.cos(th);
  const tf = t - tAccel - tRamp;
  const yLand = COG;
  const tAir = (vy0 + Math.sqrt(vy0 * vy0 + 2 * G0 * (lip.pos.y - yLand))) / G0;
  if (tf < tAir) {
    const y = lip.pos.y + vy0 * tf - 0.5 * G0 * tf * tf;
    const z = lip.pos.z + vz0 * tf;
    const f = tf / tAir;
    const roll = 2 * Math.PI * smoothstep(0.12, 0.82, f);
    const pitch = -th * (1 - smoothstep(0, 0.5, f)) + 0.12 * Math.sin(f * Math.PI);
    const q = qmul(pitchQ(pitch), rollQ(roll));
    // lift nozzles on one side drive the roll; all four brake the fall before touchdown
    const rollRate = f > 0.1 && f < 0.85 ? 1 : 0;
    nz[4] = nz[6] = rollRate * 0.9; nz[5] = nz[7] = rollRate * 0.15;
    if (f > 0.84) nz[4] = nz[5] = nz[6] = nz[7] = 0.85;
    if (f < 0.12) nz[0] = nz[1] = nz[2] = nz[3] = 0.5;
    return { pos: { x, y, z }, quat: q, vel: { x: 0, y: vy0 - G0 * tf, z: vz0 }, angVel: { x: 0, y: 0, z: 0 }, speed: v0, ground: false, nozzle: nz, slip: 0, brake: false, fan: 0.2, wing: 20, accelZ: 0 };
  }
  // roll-out and braking
  const tb = tf - tAir;
  const dec = 9;
  const v = Math.max(0, vz0 - dec * tb);
  const z = lip.pos.z + vz0 * tAir + (vz0 * vz0 - v * v) / (2 * dec);
  return { pos: { x, y: COG - 0.02 * Math.exp(-tb * 6), z }, quat: qident(), vel: { x: 0, y: 0, z: v }, angVel: { x: 0, y: 0, z: 0 }, speed: v, ground: true, nozzle: nz, slip: tb < 0.4 ? 0.35 : 0.05, brake: v > 0.1, fan: 0.4, wing: 28, accelZ: v > 0.1 ? -dec : 0 };
}

function rampHang(t: number): Pose {
  const nz = zero();
  const L = profileLength(wall.profile);
  const sHold = L - 0.6;
  // 0..3 s approach from the spawn, 3..6 climb, 6..14 hold inverted, 14..20 slide back down and roll out
  const approach = 45;
  const startZ = wall.origin.z - approach;
  const vRamp = 22;
  const aApp = (vRamp * vRamp) / (2 * approach);
  const tUp0 = vRamp / aApp;
  if (t < tUp0) {
    const a = aApp;
    const z = startZ + 0.5 * a * t * t;
    return { pos: { x: wall.origin.x, y: COG, z }, quat: qident(), vel: { x: 0, y: 0, z: a * t }, angVel: { x: 0, y: 0, z: 0 }, speed: a * t, ground: true, nozzle: nz, slip: 0.04, brake: false, fan: 1, wing: 10, accelZ: a };
  }
  const tc = t - tUp0;
  let s: number;
  let speed: number;
  const climbT = 2.6;
  if (tc < climbT) {
    // decelerating climb: s = vRamp*t - k t²
    const k = (vRamp * climbT - sHold) / (climbT * climbT);
    s = vRamp * tc - k * tc * tc; speed = vRamp - 2 * k * tc;
  } else if (tc < climbT + 8) { s = sHold; speed = 0; }
  else {
    const td = tc - climbT - 8;
    s = Math.max(0, sHold - 0.5 * 4.5 * td * td); speed = 4.5 * td;
    if (s === 0) {
      const extra = td - Math.sqrt(sHold / 2.25);
      const v = Math.max(0, Math.sqrt(2 * 4.5 * sHold) - 8 * extra);
      const pz = wall.origin.z - (Math.sqrt(2 * 4.5 * sHold) * extra - 4 * extra * extra);
      return { pos: { x: wall.origin.x, y: COG, z: pz }, quat: yawQ(180 + 0), vel: { x: 0, y: 0, z: -v }, angVel: { x: 0, y: 0, z: 0 }, speed: v, ground: true, nozzle: nz, slip: 0.04, brake: v > 0.1, fan: 0.6, wing: 20, accelZ: v > 0.1 ? -8 : 0 };
    }
  }
  const rp = rampPose(wall, Math.max(0, s));
  const hold = tc >= climbT && tc < climbT + 8;
  if (hold) { nz[4] = nz[5] = nz[6] = nz[7] = 0.12 + 0.1 * Math.max(0, Math.sin(tc * 5)); }
  const dir = tc < climbT ? 1 : -1;
  return { pos: rp.pos, quat: rp.quat, vel: { x: 0, y: dir * speed * Math.sin(rp.theta), z: dir * speed * Math.cos(rp.theta) }, angVel: { x: 0, y: 0, z: 0 }, speed, ground: true, nozzle: nz, slip: 0, brake: false, fan: 1, wing: 28, accelZ: 0 };
}

function zero60(t: number): Pose {
  const nz = zero();
  const sp = TRACK.sites.find((s) => s.stunt === 'zero60')!.spawn.pos;
  const hold = 1.2;
  if (t < hold) return { pos: { x: sp.x, y: COG, z: sp.z }, quat: qident(), vel: { x: 0, y: 0, z: 0 }, angVel: { x: 0, y: 0, z: 0 }, speed: 0, ground: true, nozzle: nz, slip: 0, brake: false, fan: t > 0.4 ? 1 : 0, wing: 0, accelZ: 0 };
  const tl = t - hold;
  const a = 3.4 * G0;
  const tBoost = 1.1;
  if (tl < tBoost) nz[0] = nz[1] = nz[2] = nz[3] = 1;
  const v = tl < tBoost ? a * tl : a * tBoost - 6 * (tl - tBoost);
  const vv = Math.max(0, v);
  const z = tl < tBoost ? 0.5 * a * tl * tl : 0.5 * a * tBoost * tBoost + a * tBoost * (tl - tBoost) - 3 * (tl - tBoost) ** 2;
  return { pos: { x: sp.x, y: COG - 0.015, z: sp.z + z }, quat: qmul(pitchQ(tl < tBoost ? -0.012 : 0.01), qident()), vel: { x: 0, y: 0, z: vv }, angVel: { x: 0, y: 0, z: 0 }, speed: vv, ground: true, nozzle: nz, slip: tl < 0.5 ? 0.3 : 0.05, brake: tl > tBoost, fan: 1, wing: tl > tBoost ? 28 : 0, accelZ: tl < tBoost ? a : -6 };
}

function groundFlip(t: number): Pose {
  const nz = zero();
  const sp = TRACK.sites.find((s) => s.stunt === 'ground_flip')!.spawn.pos;
  const tUp = 1.0, tAir = 3.4;
  if (t < tUp) return { pos: { x: sp.x, y: COG, z: sp.z }, quat: qident(), vel: { x: 0, y: 0, z: 0 }, angVel: { x: 0, y: 0, z: 0 }, speed: 0, ground: true, nozzle: nz, slip: 0, brake: false, fan: 0.6, wing: 0, accelZ: 0 };
  const tf = t - tUp;
  if (tf < tAir) {
    const f = tf / tAir;
    const h = 8 * Math.sin(Math.PI * f) ** 1.2;
    const roll = 2 * Math.PI * smoothstep(0.2, 0.75, f);
    // all four lift nozzles at lift-off, asymmetric for the roll, full again for the landing burn
    if (f < 0.25) nz[4] = nz[5] = nz[6] = nz[7] = 1;
    else if (f < 0.75) { nz[4] = nz[6] = 0.8; nz[5] = nz[7] = 0.1; }
    else nz[4] = nz[5] = nz[6] = nz[7] = 0.9;
    return { pos: { x: sp.x, y: COG + h, z: sp.z + 2 * f }, quat: rollQ(roll), vel: { x: 0, y: 8 * Math.PI / tAir * Math.cos(Math.PI * f), z: 2 / tAir }, angVel: { x: 0, y: 0, z: 0 }, speed: 0.6, ground: false, nozzle: nz, slip: 0, brake: false, fan: 0, wing: 28, accelZ: 0 };
  }
  return { pos: { x: sp.x, y: COG, z: sp.z + 2 }, quat: qident(), vel: { x: 0, y: 0, z: 0 }, angVel: { x: 0, y: 0, z: 0 }, speed: 0, ground: true, nozzle: nz, slip: 0, brake: false, fan: 0.3, wing: 28, accelZ: 0 };
}

export function segmentAt(t: number): Segment {
  const tt = ((t % LOOP_S) + LOOP_S) % LOOP_S;
  return SEGMENTS.find((s) => tt >= s.t0 && tt < s.t1) ?? SEGMENTS[0];
}

/** Full VehicleState at show time t (seconds, loops). */
export function fakeState(t: number, prev?: VehicleState): VehicleState {
  const tt = ((t % LOOP_S) + LOOP_S) % LOOP_S;
  const seg = segmentAt(tt);
  const lt = tt - seg.t0;
  const p = seg.id === 'kickflip' ? kickflip(lt) : seg.id === 'ramp_hang' ? rampHang(lt) : seg.id === 'zero60' ? zero60(lt) : groundFlip(lt);
  void KF;
  const nozzles: NozzleState[] = ROADSTER.nozzles.map((spec, i) => {
    const d = clamp(p.nozzle[i], 0, 1);
    const thrust = d * spec.nominalThrustN;
    return { open: d > 0.02, thrustN: thrust, massFlowKgS: thrust / 650, exitPressureRatio: d > 0.02 ? 1.8 + 2.2 * d : 1 };
  });
  const wheels: WheelState[] = ROADSTER.wheels.map((w) => {
    const cp = qrot(p.quat, { x: w.pos.x, y: w.pos.y - w.radius, z: w.pos.z });
    const up = qrot(p.quat, { x: 0, y: 1, z: 0 });
    const prevW = prev?.wheels.find((x) => x.id === w.id);
    const spinVel = p.ground ? p.speed / w.radius * (w.driven ? 1 + p.slip * 3 : 1) : (prevW ? prevW.angularVel * 0.995 : 0);
    return {
      id: w.id, contact: p.ground, compression: ROADSTER.suspension.restCompressionM + (p.ground ? 0 : -0.04), suspensionForceN: p.ground ? 4500 : 0,
      slipRatio: w.driven ? p.slip : 0, slipAngleRad: 0, angularVel: spinVel, steerRad: 0, normalLoadN: p.ground ? 4500 : 0,
      contactPoint: { x: p.pos.x + cp.x, y: p.pos.y + cp.y, z: p.pos.z + cp.z }, surfaceNormal: up,
    };
  });
  const air = 250 - 40 * (tt / LOOP_S);
  return {
    t: tt, pos: p.pos, quat: p.quat, linVel: p.vel, angVel: p.angVel,
    specificForce: { x: 0, y: p.ground ? G0 : 0, z: p.accelZ },
    massKg: ROADSTER.dryMassKg + air, wheels,
    tank: { airMassKg: air, pressurePa: 690e5 * (air / 250), gasTempK: 280, wallTempK: 288, feedPressurePa: 120e5, regulated: true },
    nozzles,
    fans: { mode: p.fan > 0.1 ? 'grip' : 'off', deltaPPa: p.fan * 7000, flowM3s: p.fan * 3, powerW: p.fan * 80000, forceN: p.fan * 40000, gapM: 0.006, rpmNorm: p.fan },
    aero: { mode: 'auto', wingAngleDeg: p.wing, dragN: 0, downforceN: 0 },
    speedMs: p.speed, motorPowerW: 0, brakeInput: p.brake ? Math.min(1, Math.max(0.3, -p.accelZ / 9)) : 0, groundContact: p.ground, bodyContact: false,
    heightAboveGroundM: Math.max(0, p.pos.y - COG), crashed: false,
  };
}
