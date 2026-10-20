// Synthetic telemetry for the UI sandbox and UI tests: scenarios rebuilt from the stream values
// (src/shared/reference.ts). Not physics: smooth curves that exercise every HUD/audio input.
import { DEG, FT, MPH, qaxisAngle, qmul, smoothstep, type Quat } from '../shared/math';
import { VIDEO_REFERENCE, type RefSample } from '../shared/reference';
import { ROADSTER } from '../shared/roadster';
import { NOZZLE_COUNT, WHEEL_IDS, type FanMode, type TelemetryFrame, type VehicleState } from '../shared/types';

export interface SynthInput {
  t: number;
  altitudeM: number; pitchDeg: number; rollDeg: number; headingDeg: number;
  gForce: number; downforceKg: number; speedMs: number;
  tankPressureBar: number; airMassKg: number;
  duty: number[];
  fanMode: FanMode; fanRpm: number; groundContact: boolean;
  slip: number; motorPowerW: number; phase: string;
  /** Optional continuous attitude (overrides pitch/roll Euler build), for flips. */
  quat?: Quat;
}

export function neutralSynth(): SynthInput {
  return {
    t: 0, altitudeM: 0, pitchDeg: 0, rollDeg: 0, headingDeg: 0, gForce: 1, downforceKg: 0, speedMs: 0,
    tankPressureBar: 690, airMassKg: 250, duty: new Array(NOZZLE_COUNT).fill(0),
    fanMode: 'off', fanRpm: 0, groundContact: true, slip: 0, motorPowerW: 0, phase: '',
  };
}

export function attitudeQuat(pitchDeg: number, rollDeg: number, headingDeg = 0): Quat {
  const yaw = qaxisAngle({ x: 0, y: 1, z: 0 }, headingDeg * DEG);
  const pitch = qaxisAngle({ x: -1, y: 0, z: 0 }, pitchDeg * DEG); // nose up = negative about +X
  const roll = qaxisAngle({ x: 0, y: 0, z: 1 }, rollDeg * DEG);    // right side down = positive about +Z
  return qmul(qmul(yaw, pitch), roll);
}

/** Build matching VehicleState + TelemetryFrame from synthetic values. */
export function synthFrame(s: SynthInput): { state: VehicleState; tel: TelemetryFrame } {
  const quat = s.quat ?? attitudeQuat(s.pitchDeg, s.rollDeg, s.headingDeg);
  const pressurePa = s.tankPressureBar * 1e5;
  const regulated = pressurePa > ROADSTER.tank.regulatorSetpointPa;
  const pr = Math.min(pressurePa, ROADSTER.tank.regulatorSetpointPa) / 101325;
  const nozzles = ROADSTER.nozzles.map((n, i) => {
    const d = s.duty[i] ?? 0;
    return { open: d > 0.5, thrustN: n.nominalThrustN * d * Math.min(1, pressurePa / ROADSTER.tank.regulatorSetpointPa), massFlowKgS: n.nominalThrustN * d / 650, exitPressureRatio: d > 0 ? pr / Math.pow(n.expansionRatio, 1.4) * 0.6 : 0 };
  });
  const fanForce = s.downforceKg * 9.80665;
  const wheels = WHEEL_IDS.map((id) => {
    const spec = ROADSTER.wheels.find((w) => w.id === id)!;
    return {
      id, contact: s.groundContact, compression: s.groundContact ? 0.03 : 0, suspensionForceN: s.groundContact ? 4500 : 0,
      slipRatio: s.slip, slipAngleRad: s.slip * 0.2, angularVel: s.speedMs / spec.radius, steerRad: 0, normalLoadN: s.groundContact ? 4500 + fanForce / 4 : 0,
      contactPoint: { x: 0, y: 0, z: 0 }, surfaceNormal: { x: 0, y: 1, z: 0 },
    };
  });
  const state: VehicleState = {
    t: s.t,
    pos: { x: 0, y: s.altitudeM + ROADSTER.restCogHeightM, z: 0 },
    quat,
    linVel: { x: 0, y: 0, z: s.speedMs },
    angVel: { x: 0, y: 0, z: 0 },
    specificForce: { x: 0, y: s.gForce * 9.80665, z: 0 },
    massKg: ROADSTER.dryMassKg + s.airMassKg,
    wheels,
    tank: { airMassKg: s.airMassKg, pressurePa, gasTempK: 288 - (250 - s.airMassKg) * 0.2, wallTempK: 288, feedPressurePa: Math.min(pressurePa, ROADSTER.tank.regulatorSetpointPa), regulated },
    nozzles,
    fans: { mode: s.fanMode, deltaPPa: fanForce / ROADSTER.fans.floorAreaM2, flowM3s: s.fanRpm * 3, powerW: s.fanRpm * 80_000, forceN: fanForce, gapM: 0.006, rpmNorm: s.fanRpm },
    aero: { mode: 'auto', wingAngleDeg: 12, dragN: 0.5 * 1.2 * 0.35 * 1.85 * s.speedMs ** 2, downforceN: 0 },
    speedMs: s.speedMs,
    motorPowerW: s.motorPowerW,
    brakeInput: 0,
    groundContact: s.groundContact,
    bodyContact: false,
    heightAboveGroundM: s.altitudeM + ROADSTER.restCogHeightM,
    crashed: false,
  };
  const tel: TelemetryFrame = {
    t: s.t, altitudeM: s.altitudeM, pitchDeg: s.pitchDeg, rollDeg: s.rollDeg, gForce: s.gForce, downforceKg: s.downforceKg,
    speedMs: s.speedMs, tankPressureBar: s.tankPressureBar, airMassKg: s.airMassKg, thrusterDuty: s.duty.slice(),
    fanDeltaPKPa: fanForce / ROADSTER.fans.floorAreaM2 / 1000, phase: s.phase,
  };
  return { state, tel };
}

// ------------------------------------------------------------------ scenario curves
function interp(ref: RefSample[], key: keyof RefSample, t: number): number {
  const pts = ref.filter((r) => typeof r[key] === 'number') as Array<RefSample & Record<string, number>>;
  if (!pts.length) return 0;
  if (t <= pts[0].t) return pts[0][key as string];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1], b = pts[i];
      const f = (t - a.t) / (b.t - a.t);
      const e = f * f * (3 - 2 * f) * 0.35 + f * 0.65; // slightly eased linear
      return a[key as string] + (b[key as string] - a[key as string]) * e;
    }
  }
  return pts[pts.length - 1][key as string];
}

const LIFT = [4, 5, 6, 7], MAIN = [0, 1, 2, 3];
const setDuty = (d: number[], ids: number[], v: number) => { for (const i of ids) d[i] = v; };

export type ScenarioId = 'kickflip' | 'ramp_hang' | 'ramp_launch' | 'zero60' | 'ground_flip';
export const SCENARIO_LENGTH: Record<ScenarioId, number> = { kickflip: 7, ramp_hang: 36.5, ramp_launch: 11.5, zero60: 4, ground_flip: 6 };

/** Air consumption bookkeeping kept simple: linear in summed duty. */
function airAt(t: number, rate: number): { air: number; bar: number } {
  const air = Math.max(5, 250 - rate * t);
  return { air, bar: 690 * Math.pow(air / 250, 1.25) };
}

export function scenario(id: ScenarioId, t: number): SynthInput {
  const s = neutralSynth();
  s.t = t;
  const duty = s.duty;
  switch (id) {
    case 'kickflip': {
      const ref = VIDEO_REFERENCE.kickflip!;
      s.altitudeM = interp(ref, 'altitudeFt', t) * FT;
      s.gForce = interp(ref, 'g', t);
      const roll = 360 * smoothstep(1.25, 3.4, t);
      s.quat = qmul(attitudeQuat(t > 1 && t < 1.3 ? 26 * Math.sin(((t - 1) / 0.3) * Math.PI) : 0, 0), qaxisAngle({ x: 0, y: 0, z: 1 }, roll * DEG));
      s.rollDeg = ((roll + 180) % 360) - 180;
      s.speedMs = t < 1 ? 14 + t * 9 : 23 - (t - 1) * 1.4;
      s.groundContact = t < 1.15 || t > 5.45;
      s.phase = t < 1 ? 'APPROACH' : t < 1.25 ? 'KICKER' : t < 3.4 ? 'ROLL' : t < 5.45 ? 'LANDING_BURN' : 'ROLLOUT';
      if (t > 1.25 && t < 2.1) { duty[4] = duty[6] = 0.85; duty[5] = duty[7] = 0.1; }       // roll right: left lifts push
      if (t > 2.6 && t < 3.3) { duty[5] = duty[7] = 0.7; }                                   // arrest roll
      if (t > 3.4 && t < 5.4) setDuty(duty, LIFT, 0.55 + 0.4 * Math.sin((t - 3.4) * 1.6));
      const a = airAt(t, 6); s.airMassKg = a.air; s.tankPressureBar = a.bar;
      s.motorPowerW = t < 1.1 ? 600_000 : 0; s.slip = t < 1 ? 0.04 : 0;
      break;
    }
    case 'ramp_hang': {
      const ref = VIDEO_REFERENCE.ramp_hang!;
      s.altitudeM = interp(ref, 'altitudeFt', t) * FT;
      s.pitchDeg = interp(ref, 'pitchDeg', t);
      s.downforceKg = interp(ref, 'downforceKg', t);
      s.gForce = 1 + s.downforceKg / 1950 * 0.3;
      s.fanMode = 'grip'; s.fanRpm = Math.min(1, t / 0.6);
      s.speedMs = t < 5 ? 0.6 : t < 16 ? 3.2 : t < 27 ? 0 : t < 36 ? 3.0 : 0.5;
      s.phase = t < 4 ? 'SPOOL_UP' : t < 16 ? 'CLIMB' : t < 27 ? 'HANG' : 'DESCEND';
      s.motorPowerW = s.speedMs > 0.1 ? 120_000 : 15_000;
      s.airMassKg = 250; s.tankPressureBar = 690;
      break;
    }
    case 'ramp_launch': {
      const ref = VIDEO_REFERENCE.ramp_launch!;
      s.altitudeM = interp(ref, 'altitudeFt', t) * FT;
      s.gForce = interp(ref, 'g', t);
      const climbPitch = 170 * smoothstep(0, 5, t);
      const flip = t > 5 ? smoothstep(5.2, 7.0, t) : 0; // 170 -> 360
      const pitchCont = climbPitch + flip * 190;
      s.quat = attitudeQuat(pitchCont, 0);
      s.pitchDeg = pitchCont <= 180 ? pitchCont : pitchCont - 360;
      s.downforceKg = t < 5 ? 600 + 3800 * smoothstep(0, 4, t) : 0;
      s.fanMode = t < 5.2 ? 'grip' : 'off'; s.fanRpm = t < 5.2 ? 1 : Math.max(0, 1 - (t - 5.2) * 2);
      s.groundContact = t < 5.1 || t > 9.95;
      s.speedMs = t < 5 ? 16 : t < 10 ? 10 : 4;
      s.phase = t < 5 ? 'CLIMB' : t < 7 ? 'HALF_FLIP' : t < 10 ? 'LANDING_BURN' : 'ROLLOUT';
      if (t > 5.2 && t < 6.2) { duty[4] = duty[5] = 0.8; }
      if (t > 6.6 && t < 9.9) setDuty(duty, LIFT, t < 8 ? 0.95 : 0.7);
      const a = airAt(Math.max(0, t - 5), 14); s.airMassKg = a.air; s.tankPressureBar = a.bar;
      s.motorPowerW = t < 5 ? 450_000 : 0;
      break;
    }
    case 'zero60': {
      const tLaunch = 0.5;
      const tt = Math.max(0, t - tLaunch);
      const v = tt < 0.81 ? 26.8224 * (tt / 0.81) : Math.min(46, 26.8224 + (tt - 0.81) * 9);
      s.speedMs = t < tLaunch ? 0 : v;
      s.gForce = t < tLaunch ? 1 : tt < 0.85 ? Math.hypot(1, 3.37) : 1.2;
      s.pitchDeg = t < tLaunch ? 0 : tt < 0.3 ? -1.5 * (tt / 0.3) : -1.5 + Math.min(1.5, tt);
      s.fanMode = 'grip'; s.fanRpm = 1; s.downforceKg = 1600;
      s.phase = t < tLaunch ? 'STAGED' : tt < 0.81 ? 'LAUNCH' : 'COAST';
      if (t >= tLaunch && tt < 0.9) setDuty(duty, MAIN, 1);
      s.slip = t >= tLaunch && tt < 0.4 ? 0.12 : 0.02;
      s.motorPowerW = t >= tLaunch && tt < 1.5 ? 1_150_000 : 0;
      const a = airAt(Math.min(0.9, tt), 70); s.airMassKg = a.air; s.tankPressureBar = a.bar;
      break;
    }
    case 'ground_flip': {
      const up = smoothstep(0.3, 2.0, t) - smoothstep(3.0, 4.6, t);
      s.altitudeM = 8.0 * up;
      const p = 360 * smoothstep(1.0, 2.9, t);
      s.quat = attitudeQuat(p, 0);
      s.pitchDeg = p <= 180 ? p : p - 360;
      s.groundContact = t < 0.35 || t > 4.65;
      s.gForce = t < 0.3 ? 1 : t < 1.0 ? 2.6 : t < 2.9 ? 0.3 : t < 4.6 ? 1.6 : 1;
      s.phase = t < 0.3 ? 'ARM' : t < 1.0 ? 'LIFTOFF' : t < 2.9 ? 'FLIP' : t < 4.6 ? 'LANDING_BURN' : 'ROLLOUT';
      if (t > 0.3 && t < 1.0) setDuty(duty, LIFT, 1);
      if (t > 1.0 && t < 1.5) { duty[4] = duty[5] = 1; }
      if (t > 2.4 && t < 2.9) { duty[6] = duty[7] = 0.8; }
      if (t > 2.9 && t < 4.6) setDuty(duty, LIFT, 0.8);
      const a = airAt(t, 18); s.airMassKg = a.air; s.tankPressureBar = a.bar;
      break;
    }
  }
  return s;
}

/** 60 mph in m/s, handy for UI checks. */
export const SIXTY_MPH_MS = 60 * MPH;
