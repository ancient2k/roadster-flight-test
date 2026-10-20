// Ring-gauge geometry and scales, measured from the Tesla stream (1920x1080 frames,
// stream reference frames and the wall-ramp frames). DOM-free, unit tested.
//
// Measured: radius ≈ 74 px, stroke ≈ 4 px, arc spans 245° with the gap centred at the bottom
// (ends 57.5° either side of straight down), white fill grows clockwise from the lower-left end.
// Scales were fitted to readouts in the frames (0.2/0.7/1.2 g, 0.1/20.8/23.3/69.0 ft, 210/4697 kg, 2.1/170°).
import { FT } from '../../shared/math';

export const REF_W = 1920;
export const REF_H = 1080;

/** Layout in reference pixels (1080p). Everything scales with viewport height. */
export const LAYOUT = {
  ringR: 74,
  ringStroke: 3.6,
  ringY: 979,
  leftRingX: 172,
  sphereX: 356,
  sphereR: 74,
  topViewX: 1564,
  rightRingX: 1748,
  edgeInset: 172, // distance of the outer ring centre from the screen edge
} as const;

export const ARC_SWEEP_DEG = 245;
/** Start of the arc in canvas convention (0° = +x, clockwise positive because canvas y points down). */
export const ARC_START_DEG = 90 + (360 - ARC_SWEEP_DEG) / 2; // 147.5°
export const ARC_END_DEG = ARC_START_DEG + ARC_SWEEP_DEG;    // 392.5° (= 32.5°)

export interface GaugeScale { min: number; max: number }

export const SCALES = {
  gForce: { min: 0, max: 4 } as GaugeScale,
  altitudeM: { min: 0, max: 75 * FT } as GaugeScale,     // 75 ft ≈ 22.9 m full scale
  downforceKg: { min: 0, max: 5000 } as GaugeScale,
  pitchDeg: { min: 0, max: 180 } as GaugeScale,
  speedMs: { min: 0, max: 103 } as GaugeScale,           // 230 mph top speed
};

/** Fill fraction 0..1 (pitch gauge uses |value|). */
export function fraction(value: number, s: GaugeScale): number {
  if (!Number.isFinite(value)) return 0;
  const f = (value - s.min) / (s.max - s.min);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** Canvas angle (radians) of the fill end for a fraction. */
export function fillAngleRad(f: number): number {
  return ((ARC_START_DEG + ARC_SWEEP_DEG * Math.min(1, Math.max(0, f))) * Math.PI) / 180;
}

/** Point on the ring for a fraction (reference px, relative to ring centre). */
export function ringPoint(f: number, r: number = LAYOUT.ringR): { x: number; y: number } {
  const a = fillAngleRad(f);
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

/**
 * Viewport scale: reference px -> CSS px. Driven by height so the HUD keeps the stream's
 * proportions on 16:9, 16:10 and 21:9; clamped so very narrow windows do not overlap the groups.
 */
export function hudScale(cssW: number, cssH: number): number {
  // Width term only bites on narrow aspect ratios (< 16:11.25); both groups need ~2*430 ref px.
  return Math.max(0.45, Math.min(cssH / REF_H, cssW / 1536));
}

/**
 * Critically-damped follower used for needle/arc smoothing (frame-rate independent).
 * Returns the new value; `tau` is the time constant in seconds.
 */
export function follow(current: number, target: number, dt: number, tau: number): number {
  if (!Number.isFinite(current)) return target;
  if (tau <= 0) return target;
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}
