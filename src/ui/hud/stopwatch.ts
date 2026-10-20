// 0–60 stopwatch of the stream HUD. Pure (no DOM), so it is testable in Node.
import { MPH } from '../../shared/math';

const SIXTY_MPH = 60 * MPH;
const LAUNCH_PHASES = new Set(['launch', 'launch_no_jets']);

export class ZeroSixtyWatch {
  running = false;
  done = false;
  t0 = 0;
  value = 0;
  private prevSpeed = 0;
  private prevT = 0;

  reset(): void {
    this.running = false; this.done = false; this.t0 = 0; this.value = 0; this.prevSpeed = 0; this.prevT = 0;
  }

  /**
   * One HUD frame. With a GNC phase (autopilot) only the launch phase starts the watch – the car creeps
   * while staging – at `launchT0` (stunt clock = telemetry clock) or else at the previous frame. Without
   * a phase (free play) the first creep from standstill starts it.
   */
  update(t: number, speedMs: number, phase: string, launchT0?: number): number {
    if (!this.running && !this.done) {
      if (phase) {
        if (LAUNCH_PHASES.has(phase)) {
          this.running = true;
          this.t0 = launchT0 !== undefined && Number.isFinite(launchT0) ? launchT0 : this.prevT;
        }
      } else if (speedMs > 0.05 && this.prevSpeed <= 0.05) { this.running = true; this.t0 = this.prevT; }
    }
    if (this.running) {
      if (speedMs >= SIXTY_MPH) {
        // interpolate the crossing inside the last frame
        const f = (SIXTY_MPH - this.prevSpeed) / Math.max(1e-6, speedMs - this.prevSpeed);
        this.value = this.prevT + (t - this.prevT) * Math.max(0, Math.min(1, f)) - this.t0;
        this.running = false; this.done = true;
      } else this.value = t - this.t0;
    }
    this.prevSpeed = speedMs; this.prevT = t;
    return this.value;
  }
}
