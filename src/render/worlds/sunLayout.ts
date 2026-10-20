// Sun scene layout (compressed scale) and the heat model shared by render and game logic. Pure (Vitest).
//
// Scene frame (space_sun/meta.json suggestedSceneFrame): +X = vernal equinox, +Y = ecliptic north,
// +Z = X × Y. The player spawns at the origin facing +Z, the Sun sits ahead on +Z.
import { blackbodyLuminance } from './colorScience';

export const SUN_SCENE = {
  /** Sun centre and radius (scene metres). Angular radius from the spawn ≈ 5.7° (≈ 11× the real 1-AU view). */
  sunCenter: { x: 0, y: 0, z: 9000 },
  sunRadius: 900,
  /** Roadster 1 + Starman drifts here, tumbling (rad/s about body axes). */
  roadster1: { pos: { x: -7, y: 1.2, z: 34 }, spin: { x: 0.045, y: 0.11, z: 0.03 }, drift: { x: 0.02, y: 0, z: 0.05 } },
  /** Far discs (direction from the origin, distance, radius in scene metres → angular size). */
  earth: { dir: { x: -0.55, y: 0.06, z: -0.83 }, dist: 60000, radius: 220 },
  mars: { dir: { x: 0.78, y: -0.03, z: -0.62 }, dist: 60000, radius: 95 },
  /** Real radius of the Sun (m) and 1 AU (m) for the distance mapping. */
  realSunRadius: 6.957e8,
  au: 1.495978707e11,
} as const;

/** Distance (scene m) of a point from the sun centre. */
export function sunDistance(p: { x: number; y: number; z: number }): number {
  const c = SUN_SCENE.sunCenter;
  return Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
}

/**
 * Map a scene distance from the sun centre to a physical heliocentric distance (m): power law so the
 * surface maps to the surface and the spawn maps to 1 AU (ln 215 / ln 10 ≈ 2.33).
 */
export function physicalDistance(dScene: number): number {
  const R = SUN_SCENE.sunRadius;
  const d0 = sunDistance({ x: 0, y: 0, z: 0 });
  const k = Math.log(SUN_SCENE.au / SUN_SCENE.realSunRadius) / Math.log(d0 / R);
  return SUN_SCENE.realSunRadius * Math.pow(Math.max(dScene, R) / R, k);
}

/** Irradiance (W/m²) at a scene distance (1361 W/m² at 1 AU). */
export function irradianceAt(dScene: number): number {
  const r = physicalDistance(dScene);
  return 1361 * (SUN_SCENE.au / r) ** 2;
}

/**
 * Radiative-equilibrium surface temperature (K) of a flat plate facing the sun with absorptivity α and
 * emissivity ε radiating from both sides (heat-shield-less car body). Reference for the game logic.
 */
export function equilibriumTempK(dScene: number, alpha = 0.6, eps = 0.8, radiatingSides = 2): number {
  const E = irradianceAt(dScene);
  return Math.pow((alpha * E) / (eps * 5.670374419e-8 * radiatingSides), 0.25);
}

// ------------------------------------------------------------------ heat ↔ temperature ↔ glow

export const HEAT_T0 = 300;
export const HEAT_T1 = 3200;

export const heatToTempK = (h: number) => HEAT_T0 + (HEAT_T1 - HEAT_T0) * Math.min(1, Math.max(0, h));
export const tempToHeat = (T: number) => Math.min(1, Math.max(0, (T - HEAT_T0) / (HEAT_T1 - HEAT_T0)));

/**
 * Display radiance of a glowing surface at T (scene units): physically ∝ visible black-body luminance, but
 * compressed with a square root so dull red (~900 K) is visible while white heat stays within half-float.
 * ≈ 0.02 at 1000 K, ≈ 1 at 1500 K, ≈ 8 at 2000 K, ≈ 70 at 3000 K.
 */
export function glowRadiance(T: number): number {
  if (T < 650) return 0;
  const ref = blackbodyLuminance(1000);
  return 0.02 * Math.sqrt(blackbodyLuminance(T) / ref);
}
