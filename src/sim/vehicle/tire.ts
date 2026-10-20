// Tire force model (pure functions, no Rapier): Pacejka Magic Formula for pure slip, combined
// slip via normalized-slip similarity (friction circle on mu*Fz), load sensitivity
// mu = mu0 (Fz/Fz0)^-n, structural load cap and the transient (relaxation length) slip states.
//
// Sign convention (contact frame ex = wheel heading in the ground plane, ey = n x ex = wheel LEFT):
//   sx = (omega r - vx)/|vx|   > 0 -> drive force along +ex
//   sy = -vy/|vx|              > 0 -> force along +ey (opposes lateral sliding)
// The transient states obey  sigma ds/dt + |vx| s = V  (V = omega r - vx or -vy), which at
// |vx| -> 0 turns into a tire "spring" (s = deflection/sigma) instead of a singular slip.
import { ROADSTER } from '@shared/roadster';

export interface MFShape { B: number; C: number; E: number }

/** Normalized Magic Formula (D = 1). */
export function mf(x: number, s: MFShape): number {
  const bx = s.B * x;
  return Math.sin(s.C * Math.atan(bx - s.E * (bx - Math.atan(bx))));
}

/** Slip at the peak of the normalized MF (C > 1: where C*atan(..) = pi/2). Bisection, monotone. */
export function mfPeakSlip(s: MFShape): number {
  if (s.C <= 1) return 1 / s.B * 10; // no interior peak: effectively saturating
  const target = Math.tan(Math.PI / 2 / s.C);
  let lo = 0, hi = 50 / s.B;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2, bx = s.B * mid;
    const arg = bx - s.E * (bx - Math.atan(bx));
    if (arg < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const T = ROADSTER.tire;
export const LAT: MFShape = T.pacejkaLat;
export const LONG: MFShape = T.pacejkaLong;
export const SX_PEAK = mfPeakSlip(LONG);
export const SY_PEAK = mfPeakSlip(LAT);

/** Load-sensitive friction coefficient (rubber on a paved surface; defaults = asphalt). */
export function muLoad(fz: number, mu0: number = T.mu0, loadExponent: number = T.loadExponent): number {
  if (fz <= 0) return mu0;
  return mu0 * Math.pow(Math.max(fz, 50) / T.fz0N, -loadExponent);
}

/** Peak force D = mu(Fz) * Fz with the structural tire load cap applied. */
export function peakForce(fz: number, mu0: number = T.mu0, loadExponent: number = T.loadExponent): number {
  const f = Math.min(Math.max(fz, 0), T.maxLoadN);
  return muLoad(f, mu0, loadExponent) * f;
}

/** Cornering / longitudinal slip stiffness per unit D (N per unit slip = this * D). */
export const C_LONG = LONG.B * LONG.C;
export const C_LAT = LAT.B * LAT.C;

/**
 * Tire-on-surface characteristic (one per SurfaceKind, see surfaces.ts). Normalised force curves
 * fx/fy (D = 1, argument = |slip| >= 0), the slips used to normalise the combined-slip vector,
 * the linear-region stiffness per unit D, the controller target slips and the peak force D.
 * ASPHALT_TIRE reproduces the original single-surface model exactly.
 */
export interface TireProfile {
  fx(s: number): number;
  fy(s: number): number;
  /** Normalisation slips of the combined-slip vector (peak slip of a rubber curve, target slip of a soil curve). */
  readonly sxN: number;
  readonly syN: number;
  /** dF/ds at s = 0 per unit D (low-speed damping, stiffness). */
  readonly cLong: number;
  readonly cLat: number;
  /** Traction-control / launch target slip (pure longitudinal) and ABS target slip. */
  readonly tcSlip: number;
  readonly absSlip: number;
  /** Tire hysteresis rolling resistance coefficient (soil compaction / bulldozing come on top). */
  readonly rollingResistance: number;
  /** Nominal friction coefficient at fz0 (fan demand control scales its reference with it). */
  readonly muNominal: number;
  /** Peak force D (N) at normal load fz and contact area (m², used by cohesive soils). */
  peak(fz: number, areaM2: number): number;
}

const fxAsphalt = (s: number): number => mf(s, LONG);
const fyAsphalt = (s: number): number => mf(s, LAT);

export const ASPHALT_TIRE: TireProfile = {
  fx: fxAsphalt, fy: fyAsphalt, sxN: SX_PEAK, syN: SY_PEAK, cLong: C_LONG, cLat: C_LAT,
  tcSlip: SX_PEAK, absSlip: SX_PEAK, rollingResistance: T.rollingResistance, muNominal: T.mu0,
  peak: (fz) => peakForce(fz),
};

/**
 * Combined-slip force. Normalized slip rho = |(sx/sxN, sy/syN)|; magnitude D * f(rho) with the
 * curve blended by direction; force direction along the normalized slip vector. Pure slip
 * reduces exactly to the respective curve, |F| <= D always (friction circle).
 */
export function combinedForce(sx: number, sy: number, D: number, out: { fx: number; fy: number }, p: TireProfile = ASPHALT_TIRE): { fx: number; fy: number } {
  const sxN = p.sxN, syN = p.syN;
  const nx = sx / sxN, ny = sy / syN;
  const rho = Math.hypot(nx, ny);
  if (rho < 1e-12 || D <= 0) { out.fx = 0; out.fy = 0; return out; }
  const cx = nx / rho, cy = ny / rho;
  const wx = cx * cx, wy = cy * cy;
  const f = wx * p.fx(rho * sxN) + wy * p.fy(rho * syN);
  // direction in physical slip space: keep linear-region stiffness of each axis
  out.fx = D * f * cx;
  out.fy = D * f * cy;
  return out;
}

/**
 * Exact integration of  sigma ds/dt + a s = V  over h with constant a = |vx|, V:
 * s(h) = s e^{-a h/sigma} + V/a (1 - e^{-a h/sigma});  a -> 0: s + V h / sigma.
 */
export function relax(s: number, V: number, a: number, sigma: number, h: number): number {
  const kh = (a / sigma) * h;
  const g = kh < 1e-9 ? 1 - kh / 2 : -Math.expm1(-kh) / kh; // (1 - e^-kh)/kh, robust at kh -> 0
  return s * Math.exp(-kh) + (V / sigma) * h * g;
}
