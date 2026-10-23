// Tilt steering (DOM part): DeviceOrientation permission + events, screen angle, recentering.
// The mapping itself is pure (gyro.ts). Off by default; switched on from Settings -> Controls or the
// touch HUD's TILT button, both of which call enable() inside the tap (iOS requestPermission needs
// a user gesture). InputManager.poll() adds output() to the touch values while driving.
import { GyroMapper, type AttitudeStick, type TiltSample } from './gyro';

export type GyroResult = 'ok' | 'denied' | 'unsupported';

/** Without a first sample this long after permission, the device has no usable sensor. */
const SIGNAL_TIMEOUT_MS = 1500;

type OrientationCtor = { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> };

/** Current screen rotation (deg, counter-clockwise from the natural orientation), 0/90/180/270. */
export function screenAngle(): number {
  try {
    const a = screen.orientation?.angle ?? (window as Window & { orientation?: number }).orientation ?? 0;
    return ((Number(a) % 360) + 360) % 360;
  } catch { return 0; }
}

export class GyroInput {
  readonly mapper = new GyroMapper();
  /** Tilt steering is on (sensor granted and delivering, or resumed from settings). */
  enabled = false;
  private sample: TiltSample | null = null;
  private listening = false;
  private waiters: Array<() => void> = [];
  private disposers: Array<() => void> = [];
  private statusListeners = new Set<(r: GyroResult) => void>();

  static supported(): boolean {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  /**
   * Switch on from a tap. Asks for permission synchronously (iOS), then waits for a first real sample.
   * Resolves 'ok' (calibrated to the current pose), 'denied' or 'unsupported' (stays off).
   */
  enable(): Promise<GyroResult> {
    if (!GyroInput.supported()) return Promise.resolve('unsupported');
    const req = (window.DeviceOrientationEvent as unknown as OrientationCtor).requestPermission;
    let perm: Promise<string>;
    try { perm = typeof req === 'function' ? req.call(window.DeviceOrientationEvent) : Promise.resolve('granted'); } catch { perm = Promise.resolve('denied'); }
    return perm.catch(() => 'denied').then((p) => (p === 'granted' ? this.waitForSignal() : 'denied' as const)).then((r) => {
      if (r === 'ok') { this.enabled = true; this.recenter(); } else this.disable();
      this.report(r);
      return r;
    });
  }

  /**
   * Switch on without a tap (setting stored as on, page load). Android delivers right away; iOS needs
   * the permission again, which is asked on the next tap anywhere. Failures are reported via onStatus().
   */
  resume(): void {
    if (this.enabled || !GyroInput.supported()) { if (!GyroInput.supported()) this.report('unsupported'); return; }
    this.enabled = true;
    this.mapper.reset();
    const req = (window.DeviceOrientationEvent as unknown as OrientationCtor).requestPermission;
    if (typeof req !== 'function') { this.verify(); return; }
    const ask = () => {
      window.removeEventListener('touchend', ask, true); window.removeEventListener('click', ask, true);
      if (!this.enabled) return;
      Promise.resolve().then(() => req.call(window.DeviceOrientationEvent)).catch(() => 'denied').then((p) => {
        if (!this.enabled) return; // switched off by that very tap
        if (p === 'granted') this.verify(); else { this.disable(); this.report('denied'); }
      });
    };
    window.addEventListener('touchend', ask, true); window.addEventListener('click', ask, true);
    this.disposers.push(() => { window.removeEventListener('touchend', ask, true); window.removeEventListener('click', ask, true); });
  }

  disable(): void {
    this.enabled = false;
    this.sample = null;
    this.mapper.reset();
    this.detach();
  }

  /** Hold the current pose as zero (enable, run start/restart, "Recenter" button, screen rotation). */
  recenter(): void {
    if (this.sample) this.mapper.calibrate(this.sample); else this.mapper.reset();
  }

  /** Smoothed stick for this frame (zero while off or without samples). */
  output(dt: number): Readonly<AttitudeStick> {
    if (!this.enabled) return { pitch: 0, roll: 0 };
    return this.mapper.step(this.sample, dt);
  }

  /** Results of enable() and resume() failures, for the UI: confirm, or switch the setting off with a hint. */
  onStatus(l: (r: GyroResult) => void): () => void { this.statusListeners.add(l); return () => this.statusListeners.delete(l); }

  dispose(): void { this.disable(); this.statusListeners.clear(); }

  // ------------------------------------------------------------------ internals
  private report(r: GyroResult): void { for (const l of this.statusListeners) l(r); }

  private verify(): void {
    void this.waitForSignal().then((r) => { if (r !== 'ok' && this.enabled) { this.disable(); this.report(r); } });
  }

  private waitForSignal(): Promise<GyroResult> {
    this.attach();
    if (this.sample) return Promise.resolve('ok');
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve('ok'); };
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== done); resolve('unsupported'); }, SIGNAL_TIMEOUT_MS);
      this.waiters.push(done);
    });
  }

  private attach(): void {
    if (this.listening) return;
    this.listening = true;
    const onOrient = (e: DeviceOrientationEvent) => {
      // desktop browsers without a sensor fire once with null angles
      if (typeof e.beta !== 'number' || typeof e.gamma !== 'number' || !Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
      this.sample = { beta: e.beta, gamma: e.gamma, screenAngle: screenAngle() };
      const w = this.waiters; this.waiters = [];
      for (const f of w) f();
    };
    // a rotated screen swaps the axes: the pose after rotating is the new zero
    const onRotate = () => { this.sample = null; this.mapper.reset(); };
    window.addEventListener('deviceorientation', onOrient);
    window.addEventListener('orientationchange', onRotate);
    const so = typeof screen !== 'undefined' ? screen.orientation : undefined;
    so?.addEventListener?.('change', onRotate);
    this.disposers.push(() => {
      window.removeEventListener('deviceorientation', onOrient);
      window.removeEventListener('orientationchange', onRotate);
      so?.removeEventListener?.('change', onRotate);
    });
  }

  private detach(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.listening = false; // pending waiters run into their timeout
  }
}
