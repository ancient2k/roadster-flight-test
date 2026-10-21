// Automatic reverse gear as in most driving games (pure, no DOM; tests/ui/autoGear.test.ts):
//   forward gear: W = throttle, S = brake; S pressed at standstill -> reverse gear. S held through the stop keeps
//                 braking (parking on a pyramid face must not back the car down): release and press S again.
//   reverse gear: S = throttle backwards (speed limit in the chassis), W = brake; W at standstill -> forward
// The reverse toggle (G / touch REV) still flips the gear directly.
import type { DriveInput } from '../shared/types';

/** Below this speed (m/s) the car counts as standing. */
export const GEAR_STANDSTILL_MS = 0.6;
/** The pedal must be held this long at standstill before the gear changes (s): a short brake tap does not reverse. */
export const GEAR_HOLD_S = 0.25;
const PEDAL_ON = 0.1, PEDAL_OFF = 0.05;

export class AutoGear {
  reverse = false;
  private holdS = 0;
  private lastToggle: boolean | null = null;
  /** Forward gear: S was released at standstill since the car last moved, so S may engage reverse. */
  private armed = true;

  reset(): void { this.reverse = false; this.holdS = 0; this.lastToggle = null; this.armed = true; }

  /**
   * @param input driver input (throttle = W/RT, brake = S/LT, reverse = state of the reverse toggle)
   * @param vFwdMs signed speed along the car's forward axis (m/s, < 0 = rolling backwards)
   * @returns the drive command for the chassis (pedals swapped in reverse)
   */
  update(input: Readonly<DriveInput>, vFwdMs: number, dt: number): DriveInput {
    // the toggle flips the gear (its first value only sets the reference)
    if (this.lastToggle !== null && input.reverse !== this.lastToggle) { this.reverse = !this.reverse; this.holdS = 0; }
    this.lastToggle = input.reverse;
    // the pedal that means "go the other way" in the current gear
    const away = this.reverse ? input.throttle : input.brake;
    const toward = this.reverse ? input.brake : input.throttle;
    const standing = this.reverse ? vFwdMs > -GEAR_STANDSTILL_MS : vFwdMs < GEAR_STANDSTILL_MS;
    if (!this.reverse) {
      if (!standing) this.armed = false;
      else if (input.brake < PEDAL_OFF) this.armed = true;
    }
    if (standing && away > PEDAL_ON && toward < PEDAL_OFF && (this.reverse || this.armed)) {
      this.holdS += dt;
      if (this.holdS >= GEAR_HOLD_S) { this.reverse = !this.reverse; this.holdS = 0; }
    } else this.holdS = 0;
    return this.reverse
      ? { ...input, throttle: input.brake, brake: input.throttle, reverse: true }
      : { ...input, reverse: false };
  }
}
