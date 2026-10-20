// Records telemetry (for the result chart) and pose snapshots (for replays) at a fixed rate.
import type { TelemetryFrame, VehicleState } from '@shared/types';
import { cloneState } from './interp';

export interface ReplayFrame { state: VehicleState; telemetry: TelemetryFrame }

export class Recorder {
  readonly telemetry: TelemetryFrame[] = [];
  readonly frames: ReplayFrame[] = [];
  private nextT = 0;

  constructor(readonly hz = 60, readonly maxSeconds = 120) {}

  clear(): void { this.telemetry.length = 0; this.frames.length = 0; this.nextT = 0; }

  /** Call after each sim step; samples at `hz`. */
  push(state: Readonly<VehicleState>, tel: TelemetryFrame): void {
    if (state.t + 1e-9 < this.nextT) return;
    // advance on a fixed grid (no drift): next sample at the first grid point after t
    const period = 1 / this.hz;
    this.nextT = this.nextT === 0 ? state.t + period : this.nextT + period * Math.max(1, Math.floor((state.t - this.nextT) / period) + 1);
    this.telemetry.push(tel);
    this.frames.push({ state: cloneState(state), telemetry: tel });
    const max = this.hz * this.maxSeconds;
    if (this.frames.length > max) { this.frames.shift(); this.telemetry.shift(); }
  }

  get duration(): number {
    return this.frames.length ? this.frames[this.frames.length - 1].state.t - this.frames[0].state.t : 0;
  }

  /** Frame pair + alpha for replay time t (seconds from the first frame). */
  sample(t: number): { a: ReplayFrame; b: ReplayFrame; alpha: number } | null {
    const f = this.frames;
    if (!f.length) return null;
    const t0 = f[0].state.t, target = t0 + t;
    // binary search on the stored timestamps
    let lo = 0, hi = f.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (f[mid].state.t <= target) lo = mid; else hi = mid; }
    const i = f[hi].state.t <= target ? hi : lo;
    const j = Math.min(f.length - 1, i + 1);
    const span = f[j].state.t - f[i].state.t || 1;
    const alpha = Math.max(0, Math.min(1, (t + t0 - f[i].state.t) / span));
    return { a: f[i], b: f[j], alpha };
  }
}
