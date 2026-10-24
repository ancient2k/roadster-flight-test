// On/off solenoid valves driven by requested duty cycles.
// Impulse-error accumulation (sigma-delta) turns a duty request into open/closed decisions that
// respect a minimum on-time, then opening/closing delays shift the actual valve state.
// At duty 0 the valve stays shut (error reset), at duty 1 it stays open.
import { ROADSTER } from '@shared/roadster';
import { NOZZLE_COUNT } from '@shared/types';

export type ValveCfg = { openDelayS: number; closeDelayS: number; minOnTimeS: number; pwmPeriodS: number };

export class ValveBank {
  /** Timing in use: the configured one, or without the switching delays (setting "Valve delays" off). */
  cfg: ValveCfg;
  private readonly baseCfg: ValveCfg;
  readonly n: number;
  /** Requested (commanded) state after sigma-delta. */
  readonly cmdOpen: Uint8Array;
  /** Actual state after delays. */
  readonly open: Uint8Array;
  private readonly err: Float64Array;
  private readonly onTime: Float64Array;   // time since commanded open
  private readonly sinceChange: Float64Array; // time since last commanded state change
  private readonly openFrac: Float64Array; // actual open time over the last step (0..1)
  private readonly faults: Int8Array;      // -1 stuck closed, 1 stuck open, 0 ok

  constructor(n = NOZZLE_COUNT, cfg: ValveCfg = ROADSTER.valves) {
    this.n = n; this.cfg = cfg; this.baseCfg = cfg;
    this.cmdOpen = new Uint8Array(n); this.open = new Uint8Array(n);
    this.err = new Float64Array(n); this.onTime = new Float64Array(n);
    this.sinceChange = new Float64Array(n).fill(1e9); this.openFrac = new Float64Array(n);
    this.faults = new Int8Array(n);
  }

  reset(): void {
    this.cmdOpen.fill(0); this.open.fill(0); this.err.fill(0); this.onTime.fill(0);
    this.sinceChange.fill(1e9); this.openFrac.fill(0);
  }

  setFault(i: number, f: -1 | 0 | 1): void { this.faults[i] = f; }

  /** Setting "Valve delays": on = the configured opening/closing delays, off = ideal valves (min on-time kept). */
  setDelays(on: boolean): void {
    this.cfg = on ? this.baseCfg : { ...this.baseCfg, openDelayS: 0, closeDelayS: 0 };
  }

  /** Advance one step; returns per-valve open fraction for this step (for thrust integration). */
  step(dt: number, duty: ArrayLike<number>): Float64Array {
    const { minOnTimeS, openDelayS, closeDelayS } = this.cfg;
    for (let i = 0; i < this.n; i++) {
      const d = Math.min(1, Math.max(0, Number(duty[i]) || 0));
      let cmd = this.cmdOpen[i];
      if (d <= 1e-4) {
        this.err[i] = 0;
        if (cmd && this.onTime[i] >= minOnTimeS) cmd = 0;
      } else if (d >= 0.9999) {
        cmd = 1; this.err[i] = 0;
      } else {
        // impulse error: desired open time minus DELIVERED open time (the delivered fraction of the
        // previous step is added below, after the delays) -> delays do not bias the average duty
        // Predictive: account for what the valve will still (not) deliver during its switching delay.
        //  - opening now: nothing flows for openDelay while the demand keeps accruing  -> + d·openDelay
        //  - closing now: it keeps flowing for closeDelay while only d of that is wanted -> − (1−d)·closeDelay
        const { closeDelayS } = this.cfg;
        // (With zero delays this reduces exactly to the plain sigma-delta thresholds.)
        if (!cmd && this.err[i] + d * openDelayS > 0.5 * minOnTimeS) cmd = 1;
        else if (cmd && this.onTime[i] >= minOnTimeS && this.err[i] - (1 - d) * closeDelayS < -0.5 * dt) cmd = 0;
      }
      if (cmd !== this.cmdOpen[i]) { this.cmdOpen[i] = cmd; this.sinceChange[i] = 0; this.onTime[i] = 0; }
      else { this.sinceChange[i] += dt; }
      if (cmd) this.onTime[i] += dt;

      // Actual state follows the command after the corresponding delay; fractional within the step.
      const delay = cmd ? openDelayS : closeDelayS;
      const t = this.sinceChange[i];
      let frac: number;
      if (t >= delay) frac = cmd ? 1 : 0;
      else if (t + dt <= delay) frac = cmd ? 0 : 1; // still in delay: previous state persists
      else { const part = (t + dt - delay) / dt; frac = cmd ? part : 1 - part; }
      // when no change has happened recently, fall back to the steady state
      if (this.sinceChange[i] > 1e8) frac = cmd ? 1 : 0;
      if (this.faults[i] === 1) frac = 1; else if (this.faults[i] === -1) frac = 0;
      this.openFrac[i] = frac;
      this.open[i] = frac >= 0.5 ? 1 : 0;
      if (d > 1e-4 && d < 0.9999) {
        this.err[i] += (d - frac) * dt;
        this.err[i] = Math.max(-2 * minOnTimeS, Math.min(minOnTimeS * 3, this.err[i]));
      }
    }
    return this.openFrac;
  }
}
