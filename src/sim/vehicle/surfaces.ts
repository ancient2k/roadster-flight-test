// ground materials. Tire characteristic per SurfaceKind plus a simplified Bekker/Wong
// terramechanics model for deformable soils (sand, lunar regolith, Martian soil):
//   pressure-sinkage      p = (kc/b + kphi) z^n                              (Bekker)
//   static sinkage        rigid-wheel mode z = [3W / ((3-n)(kc + b kphi) sqrt(2r))]^(2/(2n+1)),
//                         capped by the pneumatic (elastic) mode z = (p_gr / (kc/b + kphi))^(1/n)
//   compaction resist.    Rc = (kc + b kphi) z^(n+1) / (n+1)                (Bekker)
//   bulldozing resist.    Rb = b (0.67 c z Kpc + 0.5 z^2 gamma Kpgamma)     (Bekker/Wong, Terzaghi factors)
//   slip sinkage          z = z0 (1 + i) / (1 - 0.5 i)                      (Lyasko 2010)
//   shear (traction)      F = (A c + W tan phi) [1 - K/j (1 - e^(-j/K))], j = s L   (Janosi-Hanamoto)
// Sources and the derivation of every number: docs/PHYSICS.md.
import type { SurfaceKind } from '@shared/environment';
import { ROADSTER } from '@shared/roadster';
import { ASPHALT_TIRE, LAT, LONG, mf, mfPeakSlip, peakForce, type MFShape, type TireProfile } from './tire';

const T = ROADSTER.tire;
const DEG = Math.PI / 180;

/** Bekker/Wong terrain values (SI: kc in N/m^(n+1), kphi in N/m^(n+2)). */
export interface SoilParams {
  n: number;
  kc: number;
  kphi: number;
  cohesionPa: number;
  phiDeg: number;
  /** Janosi-Hanamoto shear deformation modulus (m). */
  shearK: number;
  /** Bulk density of the surface layer (kg/m³) for the bulldozing weight term. */
  densityKgM3: number;
}

export interface SurfaceParams {
  kind: SurfaceKind;
  tire: TireProfile;
  /** null = rigid surface (no sinkage, no compaction/bulldozing). */
  soil: SoilParams | null;
  /** Extra effective skirt leak height on this surface (m): grass blades, ripples, loose grains. */
  skirtLeakM: number;
  /** 0..1 how readily the surface throws dust (graphics hint). */
  dustiness: number;
}

/** Tire ground-pressure limit p_i + p_c (inflation + carcass stiffness) for the elastic mode [EST 2.4 + 0.4 bar]. */
export const TIRE_GROUND_PRESSURE_PA = 280_000;
/** Shear contact length of the tire on soil (footprint + sinkage arc) for the Janosi curve [EST]. */
export const SOIL_SHEAR_LENGTH_M = 0.25;
/** Footprint length on a rigid surface used for the cohesion area (m) [EST]. */
export const FOOTPRINT_M = 0.12;
/** Slip distance over which a spinning tire excavates to its slip-sinkage depth (m) [EST]. */
export const DIG_LENGTH_M = 2.0;
/**
 * Load sinkage follows the (low-passed) wheel load with this time constant (s). The soil yields
 * only as fast as the sprung mass can follow it down (at 1/6 g, 3 cm take ≈ 0.2 s of free fall);
 * a faster yield would unload the wheel, let the car drop and dig deeper with every landing.
 */
export const SINK_LOAD_TAU_S = 0.1;
/**
 * Low-pass of the rut depth the suspension sees (s). Rut depth changes act like road roughness on
 * the sprung mass; at 1/6 g the static spring compression is only 3.6 mm, so unfiltered mm-steps of
 * the slip sinkage would unload a wheel and start a dig-in / yaw cascade.
 */
export const SINK_GEOM_TAU_S = 0.1;
/** Maximum sinkage as a fraction of the wheel radius (beyond that the body rests on the ground anyway). */
export const MAX_SINK_FRACTION = 0.6;

/** Janosi-Hanamoto mean shear mobilisation over the contact: 1 - (1 - e^-x)/x, x = j/K. */
export function janosi(x: number): number {
  if (x < 1e-6) return x / 2;
  return 1 + Math.expm1(-x) / x;
}

/** Static sinkage (m) of a wheel (load W, width b, radius r) in soil s. */
export function staticSinkage(W: number, b: number, r: number, s: SoilParams): number {
  if (W <= 0) return 0;
  const zRigid = Math.pow((3 * W) / ((3 - s.n) * (s.kc + b * s.kphi) * Math.sqrt(2 * r)), 2 / (2 * s.n + 1));
  const zElastic = Math.pow(TIRE_GROUND_PRESSURE_PA / (s.kc / b + s.kphi), 1 / s.n);
  return Math.min(zRigid, zElastic);
}

/** Bekker compaction resistance (N) for sinkage z (or the work between z0 and z for a following wheel). */
export function compactionResistance(z: number, b: number, s: SoilParams, zPrev = 0): number {
  if (z <= zPrev) return 0;
  const k = s.kc + b * s.kphi, e = s.n + 1;
  return (k * (Math.pow(z, e) - (zPrev > 0 ? Math.pow(zPrev, e) : 0))) / e;
}

/** Terzaghi/Vesic bearing factors -> passive earth pressure coefficients Kpc, Kpgamma (Wong). */
export function bulldozingCoeffs(phiDeg: number): { Kpc: number; Kpg: number } {
  const t = Math.tan(phiDeg * DEG), c2 = Math.cos(phiDeg * DEG) ** 2;
  const Nq = Math.exp(Math.PI * t) * Math.tan((45 + phiDeg / 2) * DEG) ** 2;
  const Nc = (Nq - 1) / t, Ng = 2 * (Nq + 1) * t;
  return { Kpc: (Nc - t) * c2, Kpg: ((2 * Ng) / t + 1) * c2 };
}

/** Bekker bulldozing resistance (N) of a wheel of width b pushing a soil wedge of height z at gravity g. */
export function bulldozingResistance(z: number, b: number, s: SoilParams, g: number, coeffs = bulldozingCoeffs(s.phiDeg)): number {
  if (z <= 0) return 0;
  const gamma = s.densityKgM3 * g;
  return b * (0.67 * s.cohesionPa * z * coeffs.Kpc + 0.5 * z * z * gamma * coeffs.Kpg);
}

/** Slip-sinkage multiplier (Lyasko 2010) for terramechanics slip i in [-1, 1] (drive > 0, skid < 0). */
export function slipSinkageFactor(i: number): number {
  const a = Math.min(Math.abs(i), 0.95);
  return i >= 0 ? (1 + a) / (1 - 0.5 * a) : 1 + 0.5 * a;
}

// ------------------------------------------------------------------ tire profiles

/** Rubber on a paved/firm surface: Magic Formula shapes, load-sensitive mu (same form as asphalt). */
function rubberProfile(mu0: number, loadExponent: number, long: MFShape, lat: MFShape, rr: number): TireProfile {
  const sxp = mfPeakSlip(long), syp = mfPeakSlip(lat);
  return {
    fx: (s) => mf(s, long), fy: (s) => mf(s, lat), sxN: sxp, syN: syp,
    cLong: long.B * long.C, cLat: lat.B * lat.C, tcSlip: sxp, absSlip: sxp,
    rollingResistance: rr, muNominal: mu0,
    peak: (fz) => peakForce(fz, mu0, loadExponent),
  };
}

/** Tire on deformable soil: Mohr-Coulomb peak (A c + W tan phi), Janosi-Hanamoto shear curve. */
function soilProfile(s: SoilParams, tcSlip: number, absSlip: number): TireProfile {
  const k = SOIL_SHEAR_LENGTH_M / s.shearK, tphi = Math.tan(s.phiDeg * DEG);
  const curve = (x: number): number => janosi(x * k);
  return {
    fx: curve, fy: curve, sxN: tcSlip, syN: tcSlip, cLong: k / 2, cLat: k / 2, tcSlip, absSlip,
    rollingResistance: T.rollingResistance, muNominal: tphi,
    peak: (fz, area) => (fz > 0 ? Math.min(fz, T.maxLoadN) * tphi + s.cohesionPa * area : 0),
  };
}

/** Compacted sand (LETE sand, Wong 1981/2010) – Gizeh plateau: sand over limestone, driven on daily. */
export const SAND: SoilParams = { n: 0.793, kc: 102e3, kphi: 5301e3, cohesionPa: 1300, phiDeg: 31.1, shearK: 0.012, densityKgM3: 1650 };
/** Lunar regolith, Bekker/LRV design values (n 1, kc 1.4 kN/m², kphi 820 kN/m³, c 0.17 kPa, phi 35°, K 1.78 cm). */
export const REGOLITH: SoilParams = { n: 1.0, kc: 1.4e3, kphi: 820e3, cohesionPa: 170, phiDeg: 35, shearK: 0.0178, densityKgM3: 1500 };
/** Martian "cloddy" soil: c, phi from Pathfinder (Moore et al. 1999); moduli = lunar kc, 2x kphi (moderately dense) [EST]. */
export const MARS_SOIL: SoilParams = { n: 1.0, kc: 1.4e3, kphi: 1640e3, cohesionPa: 210, phiDeg: 34.3, shearK: 0.018, densityKgM3: 1400 };
/** Loose dry dune sand (Wong, LLL dry sand) – reference only, not used by a site (≈ 8 cm sinkage, beaches the car). */
export const DRY_SAND_LOOSE: SoilParams = { n: 1.1, kc: 0.99e3, kphi: 1528.43e3, cohesionPa: 1040, phiDeg: 28, shearK: 0.025, densityKgM3: 1500 };

/** Optimum drive slip on soil (net traction max incl. slip sinkage, sx = i/(1-i) at i ≈ 0.2) and ABS slip. */
const SOIL_TC_SLIP = 0.25, SOIL_ABS_SLIP = 0.35;

export const SURFACES: Record<SurfaceKind, SurfaceParams> = {
  asphalt: { kind: 'asphalt', tire: ASPHALT_TIRE, soil: null, skirtLeakM: 0, dustiness: 0 },
  // smooth/brushed concrete: ~4 % less grip than the asphalt reference, same carcass behaviour
  concrete: { kind: 'concrete', tire: rubberProfile(1.30, T.loadExponent, LONG, LAT, T.rollingResistance), soil: null, skirtLeakM: 0, dustiness: 0 },
  // dry turf on firm chalk (Salisbury Plain): rubber on grass blades; the root mat carries the load
  grass: {
    kind: 'grass',
    tire: rubberProfile(0.55, 0.10, { B: 13, C: 1.4, E: 0.2 }, { B: 11, C: 1.3, E: 0 }, 0.05),
    soil: null, skirtLeakM: 0.010, dustiness: 0.15,
  },
  sand: { kind: 'sand', tire: soilProfile(SAND, SOIL_TC_SLIP, SOIL_ABS_SLIP), soil: SAND, skirtLeakM: 0.004, dustiness: 1 },
  regolith: { kind: 'regolith', tire: soilProfile(REGOLITH, SOIL_TC_SLIP, SOIL_ABS_SLIP), soil: REGOLITH, skirtLeakM: 0.004, dustiness: 1 },
  mars_soil: { kind: 'mars_soil', tire: soilProfile(MARS_SOIL, SOIL_TC_SLIP, SOIL_ABS_SLIP), soil: MARS_SOIL, skirtLeakM: 0.004, dustiness: 0.8 },
};

/** Surface under a world hit: McGregor ramps and stone landmarks (pyramids, Stonehenge) are concrete-like
 *  hard stone, everything else is the site material. */
export function surfaceAt(kind: string | undefined, siteSurface: SurfaceKind): SurfaceKind {
  return kind === 'ramp' || kind === 'landmark' ? 'concrete' : siteSurface;
}

/** surfaceAt plus the sim's hard-ground zones (bedrock around the pyramids) at world point p. */
export function surfaceAtPoint(
  kind: string | undefined,
  sim: { surface: SurfaceKind; hardGround: { minX: number; maxX: number; minZ: number; maxZ: number }[]; paved?: ((x: number, z: number) => boolean) | null },
  x: number, z: number,
): SurfaceKind {
  if (kind === 'ground' && sim.hardGround.some((a) => x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ)) return 'concrete';
  // roads painted onto the field (level editor): asphalt, not the sand below
  if (kind === 'ground' && sim.paved?.(x, z)) return 'asphalt';
  return surfaceAt(kind, sim.surface);
}
