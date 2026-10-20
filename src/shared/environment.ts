// Physical environment of a world (Phase 2: Earth, Moon, Mars, deep space near the Sun).
// The sim kernel reads gravity and ambient pressure; vehicle modules read air density
// (fans/aero do nothing without an atmosphere); the compressor needs ambient air.
import type { Vec3 } from './math';

export type BodyId = 'earth' | 'moon' | 'mars' | 'space';

/** Ground material under the wheels (tire model parameters per surface: src/sim/vehicle). */
export type SurfaceKind = 'asphalt' | 'concrete' | 'grass' | 'sand' | 'regolith' | 'mars_soil';

export interface Environment {
  body: BodyId;
  gravity: Vec3;            // m/s², world frame
  ambientPressurePa: number;
  airDensity: number;       // kg/m³
  ambientTempK: number;
  /** Onboard compressor can refill the tank (needs a usable atmosphere). */
  canRefill: boolean;
}

export const EARTH: Environment = {
  body: 'earth', gravity: { x: 0, y: -9.80665, z: 0 }, ambientPressurePa: 101_325, airDensity: 1.2, ambientTempK: 288, canRefill: true,
};
export const MOON: Environment = {
  body: 'moon', gravity: { x: 0, y: -1.62, z: 0 }, ambientPressurePa: 0, airDensity: 0, ambientTempK: 250, canRefill: false,
};
/** Mars surface: ~610 Pa CO2, ρ ≈ 0.020 kg/m³ (fans/aero ~1.7 % of Earth). Compressor too weak to refill. */
export const MARS: Environment = {
  body: 'mars', gravity: { x: 0, y: -3.721, z: 0 }, ambientPressurePa: 610, airDensity: 0.020, ambientTempK: 210, canRefill: false,
};
/** Free space (Sun scene): gravity is handled by the scenario (heliocentric), not as a uniform field. */
export const SPACE: Environment = {
  body: 'space', gravity: { x: 0, y: 0, z: 0 }, ambientPressurePa: 0, airDensity: 0, ambientTempK: 3, canRefill: false,
};

export const ENVIRONMENTS: Record<BodyId, Environment> = { earth: EARTH, moon: MOON, mars: MARS, space: SPACE };
