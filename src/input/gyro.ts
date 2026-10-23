// Tilt steering (pure part): device orientation -> attitude stick (pitch/roll), DOM-free and unit tested
// (tests/ui/gyro.test.ts). The DOM side (permission, events, screen angle) lives in gyroSensor.ts.
//
// DeviceOrientationEvent beta/gamma (intrinsic Z-X'-Y'' angles relative to the device's natural,
// i.e. portrait, frame) are turned into the "up" vector in screen coordinates, so landscape left and
// right (screen.orientation.angle 90 / 270) tilt the same way on screen. Pitch is the forward/back
// lean of that vector, roll its sideways lean; both are measured against a calibrated zero pose.
import type { ControlId } from './types';

export interface GyroTuning {
  /** Multiplier on the tilt -> stick gain (settings slider). */
  sensitivity: number;
  /** Tilt (deg) around the zero pose that reads as zero (hand tremor, holding drift). */
  deadzoneDeg: number;
  /** Tilt (deg) beyond the dead zone that gives full deflection at sensitivity 1. */
  fullTiltDeg: number;
  /** Low-pass time constant (s) of the stick output. */
  smoothingS: number;
}

export const GYRO_DEFAULTS: GyroTuning = { sensitivity: 1, deadzoneDeg: 3, fullTiltDeg: 25, smoothingS: 0.08 };
export const GYRO_SENSITIVITY_RANGE: readonly [number, number] = [0.3, 3];

export interface TiltSample { beta: number; gamma: number; /** screen.orientation.angle (deg, counter-clockwise) */ screenAngle: number }
export interface TiltAngles { pitchDeg: number; rollDeg: number }
export interface AttitudeStick { pitch: number; roll: number }

const D2R = Math.PI / 180;
const clamp11 = (x: number): number => (x < -1 ? -1 : x > 1 ? 1 : x);
/** Wrap to (-180, 180]. */
const wrap180 = (a: number): number => { const w = ((a + 180) % 360 + 360) % 360 - 180; return w === -180 ? 180 : w; };

/** World "up" in screen coordinates (x right, y up on screen, z out of the screen). */
export function screenUp(s: TiltSample): [number, number, number] {
  const b = s.beta * D2R, g = s.gamma * D2R;
  // device frame: up = Ry(-gamma) * Rx(-beta) * (0, 0, 1)
  const dx = -Math.sin(g) * Math.cos(b), dy = Math.sin(b), dz = Math.cos(g) * Math.cos(b);
  // a screen turned counter-clockwise by `angle` sees device vectors rotated by +angle
  const a = s.screenAngle * D2R, c = Math.cos(a), sn = Math.sin(a);
  return [c * dx - sn * dy, sn * dx + c * dy, dz];
}

/** Pitch: top edge of the screen raised (+, toward the player) / lowered; roll: right edge lowered (+). */
export function tiltAngles(s: TiltSample): TiltAngles {
  const [x, y, z] = screenUp(s);
  return { pitchDeg: Math.atan2(y, z) / D2R, rollDeg: Math.asin(Math.max(-1, Math.min(1, -x))) / D2R };
}

/** Tilt away from zero (deg) -> -1..1 with a dead zone that rescales (no jump at its edge). */
export function axisFromTilt(deltaDeg: number, t: Pick<GyroTuning, 'sensitivity' | 'deadzoneDeg' | 'fullTiltDeg'>): number {
  const m = Math.abs(deltaDeg);
  if (m <= t.deadzoneDeg) return 0;
  const span = t.fullTiltDeg / Math.max(0.05, t.sensitivity);
  return clamp11(Math.sign(deltaDeg) * (m - t.deadzoneDeg) / span);
}

/** Calibrated, smoothed tilt -> stick. One instance per input device. */
export class GyroMapper {
  readonly tuning: GyroTuning;
  private zero: TiltAngles | null = null;
  private out: AttitudeStick = { pitch: 0, roll: 0 };

  constructor(tuning: Partial<GyroTuning> = {}) { this.tuning = { ...GYRO_DEFAULTS, ...tuning }; }

  get calibrated(): boolean { return this.zero !== null; }

  /** Hold `s` as the neutral pose and release the stick. */
  calibrate(s: TiltSample): void { this.zero = tiltAngles(s); this.out = { pitch: 0, roll: 0 }; }

  /** Forget the zero pose (the next sample through step() becomes it). */
  reset(): void { this.zero = null; this.out = { pitch: 0, roll: 0 }; }

  /** Unsmoothed stick for `s` (+pitch = nose up, +roll = right side down). */
  target(s: TiltSample): AttitudeStick {
    if (!this.zero) return { pitch: 0, roll: 0 };
    const a = tiltAngles(s);
    return {
      pitch: axisFromTilt(wrap180(a.pitchDeg - this.zero.pitchDeg), this.tuning),
      roll: axisFromTilt(wrap180(a.rollDeg - this.zero.rollDeg), this.tuning),
    };
  }

  /** Advance the low-pass by dt toward the stick of `s` (null = no sample: ease back to zero). */
  step(s: TiltSample | null, dt: number): Readonly<AttitudeStick> {
    if (s && !this.zero) this.calibrate(s);
    const tg = s ? this.target(s) : { pitch: 0, roll: 0 };
    const k = this.tuning.smoothingS <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dt) / this.tuning.smoothingS);
    this.out.pitch += (tg.pitch - this.out.pitch) * k;
    this.out.roll += (tg.roll - this.out.roll) * k;
    if (Math.abs(this.out.pitch) < 1e-4) this.out.pitch = 0;
    if (Math.abs(this.out.roll) < 1e-4) this.out.roll = 0;
    return this.out;
  }
}

/**
 * Add the tilt stick to the touch values (right stick pitch, roll buttons): signed sum per axis,
 * clamped, split back into the half-axis controls. Everything else passes through unchanged.
 */
export function mergeAttitude(touch: Readonly<Partial<Record<ControlId, number>>>, g: Readonly<AttitudeStick>): Partial<Record<ControlId, number>> {
  if (!g.pitch && !g.roll) return touch as Partial<Record<ControlId, number>>;
  const out = { ...touch };
  const pitch = clamp11((touch.pitchUp ?? 0) - (touch.pitchDown ?? 0) + g.pitch);
  const roll = clamp11((touch.rollRight ?? 0) - (touch.rollLeft ?? 0) + g.roll);
  out.pitchUp = Math.max(0, pitch); out.pitchDown = Math.max(0, -pitch);
  out.rollRight = Math.max(0, roll); out.rollLeft = Math.max(0, -roll);
  return out;
}
