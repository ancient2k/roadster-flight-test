// Feasibility analysis: attainable wrench set of the 10 nozzles (positive duties only) and per-stunt
// air budgets computed with the shared propulsion kernel (tank cooling + regulator included).
// Used by tests, by docs/PHYSICS.md and by the Autopilot's pre-launch air check.
import { G0 } from '@shared/math';
import { ROADSTER } from '@shared/roadster';
import type { StuntId } from '@shared/types';
import { Propulsion } from '../core/propulsion';
import { Allocator } from './allocator';
import { nominalMassProps, type MassProps } from './massProps';
import { N_NOZ, WRENCH_DIM, applyEffectiveness, buildEffectiveness, supportAlong } from './wrench';

export interface Envelope {
  airKg: number;
  massKg: number;
  /** Max body-up force (N) and the corresponding thrust-to-weight. */
  maxLiftN: number; liftTW: number;
  /** Max forward force (mains, N). */
  maxForwardN: number;
  /** Max |moment| per axis about the CoM with no force constraint (N·m), [Mx+, Mx−, My+, My−, Mz+, Mz−]. */
  maxMoment: number[];
  /** Max |moment| per axis while delivering lift = k·m·g with the other moments held at 0 (k = 1 and 1.8). */
  momentAtHover: number[]; momentAtBrake: number[];
  /** Angular acceleration authority (rad/s²) at hover [pitch, yaw, roll]. */
  alphaAtHover: number[];
  regulated: boolean;
}

const axisDir = (r: number, s: number): number[] => { const u = [0, 0, 0, 0, 0, 0]; u[r] = s; return u; };

function scaleFor(mp: MassProps): number[] {
  const mg = mp.mass * G0;
  return [mg, mg, mg, mp.inertia.x, mp.inertia.y, mp.inertia.z];
}

/**
 * Largest |M_axis| reachable while holding body-up force = Fy and the other two moments at 0
 * (bisection on the moment magnitude; each candidate is checked with the allocator).
 */
function momentWithLift(B: Float64Array, mp: MassProps, axis: number, Fy: number): number {
  const sc = scaleFor(mp);
  const a = new Allocator(); a.fuelWeight = 0; a.rateWeight = 0; a.ridge = 0;
  const ok = (M: number): boolean => {
    const w = [0, Fy, 0, 0, 0, 0]; w[3 + axis] = M;
    a.reset();
    const d = a.solve(B, w, sc, [-1, 0, -1, 0, 0, 0]);
    const ach = applyEffectiveness(B, d);
    for (let r = 3; r < 6; r++) if (Math.abs(ach[r] - w[r]) > 1e-3 * sc[r]) return false;
    return Math.abs(ach[1] - Fy) <= 1e-3 * sc[1];
  };
  let best = Infinity;
  for (const s of [1, -1]) {
    let lo = 0, hi = 2e5;
    if (!ok(0)) return 0;
    for (let k = 0; k < 40; k++) { const mid = 0.5 * (lo + hi); if (ok(s * mid)) lo = mid; else hi = mid; }
    best = Math.min(best, lo);
  }
  return best;
}

export function wrenchEnvelope(airKg: number = ROADSTER.tank.fullMassKg): Envelope {
  const prop = new Propulsion(); prop.reset(airKg);
  const thr = prop.availableThrust();
  const mp = nominalMassProps(airKg);
  const B = buildEffectiveness(mp.com, thr);
  const mg = mp.mass * G0;
  const maxLiftN = supportAlong(B, axisDir(1, 1));
  const maxForwardN = supportAlong(B, axisDir(2, 1));
  const maxMoment: number[] = [];
  for (let r = 3; r < WRENCH_DIM; r++) { maxMoment.push(supportAlong(B, axisDir(r, 1))); maxMoment.push(supportAlong(B, axisDir(r, -1))); }
  const momentAtHover = [0, 1, 2].map((ax) => momentWithLift(B, mp, ax, mg));
  const momentAtBrake = [0, 1, 2].map((ax) => momentWithLift(B, mp, ax, 1.8 * mg));
  const I = [mp.inertia.x, mp.inertia.y, mp.inertia.z];
  return {
    airKg, massKg: mp.mass, maxLiftN, liftTW: maxLiftN / mg, maxForwardN, maxMoment,
    momentAtHover, momentAtBrake, alphaAtHover: momentAtHover.map((m, i) => m / I[i]),
    regulated: prop.tank.pressure >= ROADSTER.tank.regulatorSetpointPa,
  };
}

/** Steps a fresh propulsion model with a constant duty until `impulseNs` (sum |F|·dt) is delivered. */
export function burnForImpulse(airKg: number, duty: ArrayLike<number>, impulseNs: number): { massKg: number; timeS: number; delivered: number } {
  const p = new Propulsion(); p.reset(airKg);
  const dt = 1 / 240;
  let J = 0, t = 0;
  const m0 = p.tank.m;
  while (J < impulseNs && t < 30 && p.tank.m > 1) {
    p.step(dt, duty, false);
    let F = 0;
    for (let i = 0; i < N_NOZ; i++) F += p.states[i].thrustN;
    J += F * dt; t += dt;
  }
  return { massKg: m0 - p.tank.m, timeS: t, delivered: J };
}

/** Effective exhaust velocity at a given tank state (lift nozzles, regulated feed). */
export function effectiveExhaustVelocity(airKg: number): number {
  const p = new Propulsion(); p.reset(airKg);
  const n = p.nozzles[4];
  const pf = Math.min(p.tank.pressure, ROADSTER.tank.regulatorSetpointPa);
  const o = n.compute(pf, p.tank.T);
  return o.thrustN / Math.max(1e-9, o.mdot);
}

export interface PhaseBudget { phase: string; impulseNs: number; airKg: number; note: string }
export interface StuntBudget { stunt: StuntId; phases: PhaseBudget[]; totalKg: number; reserveKg: number; withinRegulated: boolean; withinTotal: boolean }

/** Design parameters of the flight phases (shared with the stunt automata). */
export const FLIGHT_DESIGN = {
  rollAccel: 12,                 // rad/s² roll pulse (≈ 9 kN·m)
  rollRate: 5.0,                 // rad/s coast (impulse ∝ Iz·ω, so the coast rate sets the air cost)
  landingDecel: 1.0 * G0,        // net braking decel of the landing profile (≈ 2 g specific, video 1.4–2.0 g)
  groundFlipApexM: 8.0,          // TRACK reference apexAltitudeM
  groundFlipClimbTW: 2.9,        // lift T/W used for the take-off burn (full lift minus trim reserve)
  kickflipApexM: 7.7,
  rampLaunchLeaveM: 19.6,        // altitude when leaving the wall ramp top (video 64.4 ft)
  rampLaunchLandingDecel: 0.40 * G0, // ramp_launch burns softer: ≈ 1.4 g specific like the video (TUNING.rampLaunch)
  rampLaunchTranslateM: 13.0,    // horizontal move away from the ramp face
  regulatedBudgetKg: 165,
};

/**
 * Analytic air budget per stunt from impulse requirements, converted to air mass by stepping the real
 * propulsion model (tank cools -> exhaust velocity drops). 30 % of the remaining regulated air is
 * expected to stay unused as the landing reserve.
 */
export function stuntAirBudget(stunt: StuntId): StuntBudget {
  const D = FLIGHT_DESIGN;
  const mp = nominalMassProps(ROADSTER.tank.fullMassKg);
  const m = mp.mass, g = G0;
  const lift = [0, 0, 0, 0, 1, 1, 1, 1, 0, 0];
  const mains = [1, 1, 1, 1, 0, 0, 0, 0, 0, 0];
  const phases: PhaseBudget[] = [];
  let air = ROADSTER.tank.fullMassKg;
  const add = (phase: string, impulseNs: number, duty: number[], note: string) => {
    const b = burnForImpulse(air, duty, impulseNs);
    air -= b.massKg;
    phases.push({ phase, impulseNs, airKg: b.massKg, note });
  };
  // roll pulse impulse: each pulse needs M = Iz·α for t = ω/α, one side pair at arm ≈ 0.85 m
  const rollImpulse = (angle: number) => {
    const tAcc = Math.min(D.rollRate / D.rollAccel, Math.sqrt(angle / D.rollAccel));
    const M = mp.inertia.z * D.rollAccel;
    return 2 * (M / 0.85) * tAcc;
  };
  // landing from a CoG drop H with profile decel a: free fall to the intersection, then braking
  const landingImpulse = (H: number, v0 = 0, a = D.landingDecel) => {
    const Etop = 0.5 * v0 * v0 + g * H;      // specific energy relative to touchdown
    const hi = Etop / (g + a);               // profile intersection height
    const vb = Math.sqrt(2 * a * hi);
    return m * (g + a) * (vb / a) + m * g * 0.5; // + flare at 1 m/s from 0.5 m
  };
  switch (stunt) {
    case 'ground_flip': {
      const aN = (D.groundFlipClimbTW - 1) * g;
      const vb = Math.sqrt((2 * D.groundFlipApexM) / (1 / g + 1 / aN));
      add('take-off burn', m * D.groundFlipClimbTW * g * (vb / aN), lift, `T/W ${D.groundFlipClimbTW}, burnout ${vb.toFixed(1)} m/s`);
      add('360° roll', rollImpulse(2 * Math.PI), lift, `α ${D.rollAccel} rad/s², ω ${D.rollRate} rad/s`);
      add('landing burn', landingImpulse(D.groundFlipApexM), lift, `${(D.landingDecel / g).toFixed(2)} g net decel`);
      break;
    }
    case 'kickflip': {
      add('360° roll', rollImpulse(2 * Math.PI), lift, 'ballistic after the kicker (3.5 g)');
      add('landing burn', landingImpulse(D.kickflipApexM + 0.6), lift, 'from apex 7.7 m (+0.6 m roll lift)');
      break;
    }
    case 'ramp_launch': {
      add('half roll', rollImpulse(Math.PI), lift, 'inverted -> upright');
      phases.push({ phase: 'move away from the ramp', impulseNs: 0, airKg: 0, note: `${D.rampLaunchTranslateM} m: the exit velocity along the overhang (≈ 4 m/s backwards) carries the car clear` });
      add('landing burn', landingImpulse(D.rampLaunchLeaveM, 0, D.rampLaunchLandingDecel), lift, `from ${D.rampLaunchLeaveM} m, ${(D.rampLaunchLandingDecel / g).toFixed(2)} g net decel`);
      break;
    }
    case 'zero60': {
      // 26.8 m/s in 0.81 s at the 3.4 g cap: tires+fans supply ≈ 1.6 g, mains the rest
      const aTot = 26.82 / 0.81, aTire = 1.6 * g;
      add('main thrust boost', m * Math.max(0, aTot - aTire) * 0.81, mains, 'tires ≈ 1.6 g, mains the rest');
      break;
    }
    case 'ramp_hang':
      phases.push({ phase: 'fan suction only', impulseNs: 0, airKg: 0, note: 'no thrusters (video: no jets visible)' });
      break;
  }
  const totalKg = phases.reduce((s, p) => s + p.airKg, 0);
  return {
    stunt, phases, totalKg,
    reserveKg: D.regulatedBudgetKg - totalKg,
    withinRegulated: totalKg <= D.regulatedBudgetKg,
    withinTotal: totalKg <= ROADSTER.tank.fullMassKg,
  };
}

/**
 * Minimum air the Autopilot demands before committing to a thruster stunt: budget + 20 % plus a
 * 40 kg floor so that the landing burn never runs on a nearly empty (low-thrust) tank.
 */
export function requiredAirKg(stunt: StuntId): number {
  const b = stuntAirBudget(stunt).totalKg;
  return b > 0 ? b * 1.2 + 40 : 0;
}
