// Pure sound-model mappings (state -> synthesis parameters). DOM/WebAudio-free, unit tested.
import { ROADSTER } from '../shared/roadster';

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Thrust fraction 0..1 of one nozzle. */
export function thrustFrac(thrustN: number, nominalN: number): number {
  return nominalN > 0 ? clamp01(thrustN / nominalN) : 0;
}

/**
 * Jet loudness (linear gain) from thrust fraction. Lighthill: acoustic power ~ U^8; for a choked
 * nozzle U is ~constant and power scales roughly with mass flow, so loudness grows ~ thrust^0.75
 * (perceptual curve, keeps light PWM pulses audible without overloading at full blast).
 */
export function jetGain(frac: number): number {
  return frac <= 0 ? 0 : Math.pow(clamp01(frac), 0.75);
}

/** Crackle amount from nozzle exit pressure ratio pe/pa: strongly under-expanded jets crackle. */
export function crackleAmount(exitPressureRatio: number, frac: number): number {
  if (frac <= 0.02) return 0;
  return clamp01((exitPressureRatio - 1.6) / 3.5) * Math.sqrt(frac);
}

/**
 * Shock-cell screech frequency (Hz). Screech f ≈ 0.7 U_j / L_s, shock-cell spacing
 * L_s ≈ 1.1 D sqrt(M_j^2 - 1). We map the pressure ratio to an equivalent fully expanded Mach number.
 */
export function screechHz(exitPressureRatio: number, throatDiameterM = 0.06): number {
  const npr = Math.max(1.9, exitPressureRatio * 4); // nozzle pressure ratio pt/pa (≈ pe/pa · expansion)
  const g = 1.4;
  const mj = Math.sqrt((2 / (g - 1)) * (Math.pow(npr, (g - 1) / g) - 1));
  const ls = 1.1 * throatDiameterM * Math.sqrt(Math.max(0.05, mj * mj - 1));
  const uj = 310 * mj; // cold jet exit velocity, T_j ≈ 240 K
  return Math.min(12000, Math.max(1500, (0.7 * uj) / ls));
}

/** Fan blade-passing frequency (Hz) at a normalised spool (10 blades, 18 000 rpm max). */
export function fanBpfHz(rpmNorm: number): number {
  return 10 * (18000 / 60) * clamp01(rpmNorm);
}

/** Fan loudness: spool^2, a bit more when loaded (sealed skirt = higher pressure rise). */
export function fanGain(rpmNorm: number, powerW: number): number {
  const p = clamp01(powerW / (ROADSTER.fans.count * ROADSTER.fans.powerPerFanW));
  return clamp01(rpmNorm) ** 2 * (0.65 + 0.35 * p);
}

/** Electric motor fundamental (Hz): wheel speed × gear 9:1 × 3 pole pairs. */
export function motorHz(speedMs: number, wheelRadiusM = 0.355): number {
  const wheelRps = Math.abs(speedMs) / (2 * Math.PI * wheelRadiusM);
  return wheelRps * 9 * 3;
}

/** Motor whine loudness: power dominates, a floor with speed (iron/inverter noise). */
export function motorGain(powerW: number, speedMs: number): number {
  const p = clamp01(Math.abs(powerW) / ROADSTER.powertrain.batteryPowerW);
  const v = clamp01(Math.abs(speedMs) / 60);
  return clamp01(0.15 * v + 0.85 * Math.sqrt(p)) * (speedMs > 0.3 || p > 0.01 ? 1 : 0);
}

/** Tyre squeal 0..1 from combined slip (ratio and angle) and load. */
export function squealAmount(slipRatio: number, slipAngleRad: number, contact: boolean, speedMs: number): number {
  if (!contact || speedMs < 1.5) return 0;
  const s = Math.hypot(Math.abs(slipRatio) / 0.12, Math.abs(slipAngleRad) / 0.10);
  return clamp01((s - 0.8) / 1.4);
}

/** Wind/airflow loudness from airspeed (m/s). */
export function windGain(airspeedMs: number): number {
  return clamp01(Math.pow(Math.abs(airspeedMs) / 70, 1.6));
}

/**
 * Landing impact strength 0..1 from downward speed at touchdown (m/s). 1 m/s ≈ soft, 6 m/s bottoms out
 * (ROADSTER.integrity.maxLandingSinkMs).
 */
export function impactStrength(sinkMs: number): number {
  return clamp01((Math.abs(sinkMs) - 0.4) / (ROADSTER.integrity.maxLandingSinkMs - 0.4));
}

/** Edge detector helper. */
export class Edge {
  private prev = false;
  rising(v: boolean): boolean { const r = v && !this.prev; this.prev = v; return r; }
  reset(v = false): void { this.prev = v; }
}
