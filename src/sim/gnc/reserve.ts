// Air reserve for a safe landing from the current state, for any gravity / ambient pressure.
// Used by ManualAssist (auto-landing, altitude limit, low-air warning).
import { G0 } from '@shared/math';
import { ROADSTER } from '@shared/roadster';
import type { RoadsterSim } from '../core/roadsterSim';

export interface ReserveEstimate {
  /** Air needed to land from the current state (incl. margin and the pressure floor), kg. */
  reserveKg: number;
  /** Air below which the corner jets can no longer give `FLOOR_TW`·m·g (blowdown), kg. */
  floorKg: number;
  /** Effective exhaust velocity of the corner jets now, m/s. */
  veMs: number;
  /** Highest wheel height from which a landing is still covered by the remaining air, m. */
  maxHeightM: number;
}

/** Margin on the landing burn (+ 25 %). */
export const RESERVE_MARGIN = 1.25;
/** Thrust/weight the corner jets must still reach at the end of the landing. */
const FLOOR_TW = 1.5;
const FLARE_S = 1.0;
const BUFFER_KG = 3;

/**
 * Air for a landing burn from wheel height h with vertical speed vy (up positive), braking with
 * net deceleration a after a free fall to the profile (same shape as the landing guidance).
 */
export function landingImpulseNs(massKg: number, g: number, a: number, h: number, vy: number): number {
  if (g < 0.05) return 0;
  // energy relative to touchdown (a climb is first converted into height)
  const E = g * Math.max(0, h) + 0.5 * vy * vy;
  const hi = E / (g + a);
  const vb = Math.sqrt(2 * a * hi);
  return massKg * (g + a) * (vb / a) + massKg * g * FLARE_S;
}

export function estimateReserve(sim: RoadsterSim, massKg: number, g: number, decel: number, h: number, vy: number, out?: ReserveEstimate): ReserveEstimate {
  const p = sim.propulsion, tank = p.tank;
  const nz = p.nozzles[4];
  const pf = Math.min(tank.pressure, ROADSTER.tank.regulatorSetpointPa);
  const o = nz.compute(pf, tank.T, p.ambientPressure);
  const ve = o.mdot > 1e-9 ? o.thrustN / o.mdot : 600;
  // pressure floor: feed pressure for FLOOR_TW at the regulator-limited thrust scaling (thrust ∝ p_feed)
  const liftNominal = 4 * nz.compute(ROADSTER.tank.regulatorSetpointPa, tank.T, p.ambientPressure).thrustN * Math.cos(12 * Math.PI / 180);
  const pNeed = ROADSTER.tank.regulatorSetpointPa * Math.min(1, (FLOOR_TW * massKg * Math.max(g, 0)) / Math.max(1, liftNominal));
  const pNow = tank.pressure;
  // isentropic estimate of the air mass left when the tank reaches pNeed
  const floorKg = pNow <= pNeed ? tank.m : tank.m * Math.pow(pNeed / pNow, 1 / 1.4);
  const burnKg = landingImpulseNs(massKg, g, decel, h, vy) / ve;
  const reserveKg = RESERVE_MARGIN * burnKg + floorKg + BUFFER_KG;
  // highest height still covered (bisection on h with vy = 0)
  let lo = 0, hi = 500;
  const usable = tank.m - floorKg - BUFFER_KG;
  if (g < 0.05) lo = hi = Infinity;
  else if (usable <= 0) hi = 0;
  else {
    for (let k = 0; k < 30; k++) {
      const mid = 0.5 * (lo + hi);
      if ((RESERVE_MARGIN * landingImpulseNs(massKg, g, decel, mid, 0)) / ve <= usable) lo = mid; else hi = mid;
    }
  }
  const r = out ?? { reserveKg: 0, floorKg: 0, veMs: 0, maxHeightM: 0 };
  r.reserveKg = reserveKg; r.floorKg = floorKg; r.veMs = ve; r.maxHeightM = lo;
  return r;
}

export const DEFAULT_DECEL = 1.0 * G0;
