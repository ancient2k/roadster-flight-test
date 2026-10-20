// Fixed-step simulation loop with render interpolation, time scaling and a spiral-of-death guard.

export interface LoopHooks {
  /** Advance the simulation exactly one fixed step. */
  step(): void;
  /** Render with interpolation factor alpha in [0,1) between the previous and current step. */
  render(alpha: number, frameDt: number): void;
}

export class FixedStepLoop {
  readonly dt: number;
  timeScale = 1;
  paused = false;
  /** Max sim steps per rendered frame (prevents runaway after tab switches). */
  maxStepsPerFrame = 24;
  private acc = 0;
  private last = -1;
  private raf = 0;
  private running = false;
  stepsLastFrame = 0;

  constructor(dt: number, private hooks: LoopHooks) { this.dt = dt; }

  /** Pure accumulator advance (testable without rAF). Returns steps taken. */
  advance(frameDtSec: number): number {
    const clamped = Math.min(Math.max(frameDtSec, 0), 0.25);
    if (!this.paused) this.acc += clamped * this.timeScale;
    let n = 0;
    while (this.acc >= this.dt && n < this.maxStepsPerFrame) {
      this.hooks.step();
      this.acc -= this.dt;
      n++;
    }
    if (n === this.maxStepsPerFrame && this.acc > this.dt) this.acc = this.acc % this.dt; // drop backlog
    this.stepsLastFrame = n;
    this.hooks.render(this.acc / this.dt, clamped);
    return n;
  }

  /** Single manual step while paused (frame advance). */
  stepOnce(): void { this.hooks.step(); this.hooks.render(1, 0); } // alpha 1 = the state just computed

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = (now: number) => {
      if (!this.running) return;
      const t = now / 1000;
      const dt = this.last < 0 ? 0 : t - this.last;
      this.last = t;
      this.advance(dt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void { this.running = false; cancelAnimationFrame(this.raf); this.last = -1; }
  resetAccumulator(): void { this.acc = 0; }
}
