// On-screen touch controls -> analog values per ControlId. Pure state (no DOM): the overlay in
// src/ui/touchControls.ts writes it, InputManager.poll() hands it to the mapper as RawInput.touch.
// Routing by ControlId (not by key code) keeps the touch layout independent of user rebinding.
import type { ControlId } from './types';

export type StickAxes = { x: number; y: number };

/** A virtual stick maps each half-axis to one control (x: left/right, y: up/down on screen). */
export interface StickMap { left?: ControlId; right?: ControlId; up?: ControlId; down?: ControlId }

/** Left stick: steer, push = throttle, pull = brake. */
export const DRIVE_STICK: StickMap = { left: 'steerLeft', right: 'steerRight', up: 'throttle', down: 'brake' };
/** Right stick: yaw, pull = nose up (flight convention, same as the gamepad's right stick). */
export const ATTITUDE_STICK: StickMap = { left: 'yawLeft', right: 'yawRight', up: 'pitchDown', down: 'pitchUp' };

/** Fraction of the stick radius that reads as zero (finger jitter around the touch-down point). */
export const TOUCH_DEADZONE = 0.12;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Stick deflection (-1..1 per axis, screen y down) -> control values with a radial deadzone. */
export function stickValues(map: StickMap, { x, y }: StickAxes, dz = TOUCH_DEADZONE): Partial<Record<ControlId, number>> {
  const m = Math.hypot(x, y);
  const out: Partial<Record<ControlId, number>> = {};
  for (const id of [map.left, map.right, map.up, map.down]) if (id) out[id] = 0;
  if (m <= dz) return out;
  const s = clamp01((Math.min(1, m) - dz) / (1 - dz)) / m;
  const sx = x * s, sy = y * s;
  if (map.left && sx < 0) out[map.left] = -sx;
  if (map.right && sx > 0) out[map.right] = sx;
  if (map.up && sy < 0) out[map.up] = -sy;
  if (map.down && sy > 0) out[map.down] = sy;
  return out;
}

export class TouchState {
  /** Current value per control (0..1). Buttons are 0/1, sticks analog. */
  readonly values: Partial<Record<ControlId, number>> = {};
  /** Touch controls were used since the last reset (HUD glyphs, hints). */
  active = false;

  set(id: ControlId, v: number): void {
    this.values[id] = clamp01(v);
    if (v > 0) this.active = true;
  }

  setStick(map: StickMap, axes: StickAxes): void {
    const v = stickValues(map, axes);
    for (const id of Object.keys(v) as ControlId[]) this.set(id, v[id]!);
  }

  /** Release everything (context switch, pointer cancel, page hidden). */
  clear(): void { for (const id of Object.keys(this.values) as ControlId[]) this.values[id] = 0; }
}
