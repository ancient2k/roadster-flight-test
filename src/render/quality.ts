// Quality presets and the dynamic-resolution controller. Pure logic (no three imports) so it
// runs under Vitest in node.

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export interface QualitySettings {
  /** Upper bound for devicePixelRatio. */
  maxPixelRatio: number;
  /** Scene-pass resolution scale steps the dynamic resolution may pick from (descending). */
  resolutionSteps: number[];
  shadowMapSize: number;
  shadows: boolean;
  ao: boolean;
  aoResolution: number;      // fraction of the scene pass
  aoSamples: number;
  ssr: boolean;
  ssrResolution: number;
  ssrQuality: number;        // 0..1 ray-march steps
  traa: boolean;
  bloom: boolean;
  motionBlur: boolean;
  motionBlurSamples: number;
  particleBudget: number;    // max live particles
  crowdCount: number;        // instanced audience silhouettes
  starCount: number;
  volumetricBeams: boolean;  // additive floodlight cones in the haze
  /** Real spotlights (FloodRig slots) and how many of them cast shadows. */
  lightSlots: number;
  shadowSlots: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    maxPixelRatio: 1, resolutionSteps: [0.85, 0.7, 0.6], shadowMapSize: 1024, shadows: true,
    ao: false, aoResolution: 0.5, aoSamples: 8, ssr: false, ssrResolution: 0.5, ssrQuality: 0.3,
    traa: false, bloom: true, motionBlur: false, motionBlurSamples: 6, particleBudget: 3000,
    crowdCount: 600, starCount: 1500, volumetricBeams: true, lightSlots: 3, shadowSlots: 1,
  },
  medium: {
    maxPixelRatio: 1, resolutionSteps: [1, 0.85, 0.7], shadowMapSize: 2048, shadows: true,
    ao: true, aoResolution: 0.5, aoSamples: 8, ssr: false, ssrResolution: 0.5, ssrQuality: 0.35,
    traa: true, bloom: true, motionBlur: false, motionBlurSamples: 8, particleBudget: 6000,
    crowdCount: 1500, starCount: 3000, volumetricBeams: true, lightSlots: 4, shadowSlots: 1,
  },
  high: {
    maxPixelRatio: 1, resolutionSteps: [1, 0.9, 0.8, 0.7], shadowMapSize: 2048, shadows: true,
    ao: true, aoResolution: 0.5, aoSamples: 12, ssr: true, ssrResolution: 0.5, ssrQuality: 0.65,
    traa: true, bloom: true, motionBlur: true, motionBlurSamples: 8, particleBudget: 12000,
    crowdCount: 2600, starCount: 5000, volumetricBeams: true, lightSlots: 6, shadowSlots: 2,
  },
  ultra: {
    maxPixelRatio: 2, resolutionSteps: [1, 0.9, 0.8, 0.7], shadowMapSize: 4096, shadows: true,
    ao: true, aoResolution: 0.5, aoSamples: 16, ssr: true, ssrResolution: 0.5, ssrQuality: 0.85,
    traa: true, bloom: true, motionBlur: true, motionBlurSamples: 12, particleBudget: 20000,
    crowdCount: 4000, starCount: 7000, volumetricBeams: true, lightSlots: 8, shadowSlots: 2,
  },
};

// ------------------------------------------------------------------ device profile (phones, tablets)
export interface DeviceInfo {
  maxTouchPoints: number;
  /** matchMedia('(pointer: coarse)') */
  coarsePointer: boolean;
  /** matchMedia('(hover: hover)') – a mouse or trackpad is present */
  canHover: boolean;
  /** Smaller CSS-pixel side of the screen. */
  minScreen: number;
  userAgent: string;
  /** navigator.deviceMemory (GB, Chromium only). */
  deviceMemory?: number;
}
export type DeviceProfile = 'desktop' | 'mobile';

/**
 * Phones and tablets: touch-first (coarse pointer, no hover) or a mobile user agent. iPadOS reports a
 * desktop Mac UA, so the touch/hover test catches it; touch laptops keep hover and stay desktop.
 */
export function classifyDevice(d: DeviceInfo): DeviceProfile {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(d.userAgent)) return 'mobile';
  if (d.maxTouchPoints > 0 && d.coarsePointer && !d.canHover) return 'mobile';
  if (d.maxTouchPoints > 1 && /Macintosh/.test(d.userAgent) && d.minScreen <= 1366) return 'mobile'; // iPadOS
  return 'desktop';
}

/** First-run quality when the player has not chosen one yet. */
export function defaultQualityFor(profile: DeviceProfile): QualityLevel {
  return profile === 'mobile' ? 'low' : 'high';
}

/** Budgets that apply on phones/tablets on top of any preset (GPU memory, fill rate, thermal limits). */
export const MOBILE_CAPS = {
  maxPixelRatio: 1, shadowMapSize: 1024, particleBudget: 1500, crowdCount: 300, starCount: 1000,
  lightSlots: 3, shadowSlots: 1, aoSamples: 8,
} as const;

let deviceProfile: DeviceProfile = 'desktop';
/** Set once at startup (src/main.ts); settingsForBackend then applies MOBILE_CAPS. */
export function setDeviceProfile(p: DeviceProfile): void { deviceProfile = p; }
export function getDeviceProfile(): DeviceProfile { return deviceProfile; }

/** Effects that the WebGL2 fallback drops (cost / support) on top of the chosen preset. */
export function settingsForBackend(level: QualityLevel, backend: 'webgpu' | 'webgl2', profile: DeviceProfile = deviceProfile): QualitySettings {
  const s = { ...QUALITY_PRESETS[level], resolutionSteps: [...QUALITY_PRESETS[level].resolutionSteps] };
  if (profile === 'mobile') {
    const c = MOBILE_CAPS;
    s.maxPixelRatio = Math.min(s.maxPixelRatio, c.maxPixelRatio);
    s.shadowMapSize = Math.min(s.shadowMapSize, c.shadowMapSize);
    s.particleBudget = Math.min(s.particleBudget, c.particleBudget);
    s.crowdCount = Math.min(s.crowdCount, c.crowdCount);
    s.starCount = Math.min(s.starCount, c.starCount);
    s.lightSlots = Math.min(s.lightSlots, c.lightSlots);
    s.shadowSlots = Math.min(s.shadowSlots, c.shadowSlots);
    s.aoSamples = Math.min(s.aoSamples, c.aoSamples);
    s.ssr = false;
    s.motionBlur = false;
    if (!s.resolutionSteps.includes(0.5)) s.resolutionSteps.push(0.5);
  }
  if (backend === 'webgl2') {
    s.ssr = false;
    s.motionBlur = false;
    s.aoSamples = Math.min(s.aoSamples, 8);
    s.particleBudget = Math.min(s.particleBudget, 6000);
    s.shadowMapSize = Math.min(s.shadowMapSize, 2048);
  }
  return s;
}

/**
 * Dynamic resolution with quantised steps and hysteresis. TRAA history restarts whenever the
 * scene-pass size changes, so the scale must not drift continuously.
 *
 * Without GPU timestamps the only measure is the frame interval, and on a 60 Hz display that is pinned
 * to the refresh (≈ 16.7 ms) whatever the headroom: the "clearly fast" threshold below could never be
 * reached, so one stretch of shader compilation or a heavy view dropped the resolution for good (70 %
 * on "high": thin geometry – tail-light strip, fences, rails – then shimmered all over while driving).
 * In that mode a scene that holds the refresh rate probes the next step up after a quiet spell; a
 * probe that cannot hold it is undone and the next one waits twice as long.
 */
export class DynamicResolution {
  stepIndex = 0;
  private emaMs: number;
  private cooldown: number;
  /** Frames in a row at the refresh rate (interval-only mode). */
  private calm = 0;
  /** Calm frames needed before a probe step up; doubles after each failed probe. */
  private probeWait: number;
  /** Frames left in which a step down counts as a failed probe. */
  private probing = 0;

  constructor(
    public steps: number[],
    public targetMs = 1000 / 60,
    /** Frames to wait after a change before reconsidering. */
    public cooldownFrames = 90,
    public smoothing = 0.06,
    /** Calm frames before the first probe step up in interval-only mode. */
    public probeFrames = 240,
  ) {
    this.emaMs = targetMs * 0.8;
    this.cooldown = cooldownFrames * 2; // let shader compilation hitches pass first
    this.probeWait = probeFrames;
  }

  get scale(): number { return this.steps[this.stepIndex] ?? 1; }
  get averageMs(): number { return this.emaMs; }

  reset(steps?: number[]): void {
    if (steps) this.steps = steps;
    this.stepIndex = 0;
    this.cooldown = this.cooldownFrames;
    this.emaMs = this.targetMs * 0.8;
    this.calm = 0;
    this.probing = 0;
    this.probeWait = this.probeFrames;
  }

  /**
   * Feed one frame time (ms): the GPU time when measured, else the frame interval (`intervalOnly`).
   * Returns true when the scale changed.
   */
  update(frameMs: number, intervalOnly = false): boolean {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return false;
    // Ignore hitches (tab switch, GC) so a single spike does not drop resolution.
    const clamped = Math.min(frameMs, this.targetMs * 3);
    this.emaMs += (clamped - this.emaMs) * this.smoothing;
    if (this.probing > 0) this.probing--;
    this.calm = intervalOnly && this.emaMs < this.targetMs * 1.06 ? this.calm + 1 : 0;
    if (this.cooldown > 0) { this.cooldown--; return false; }
    if (this.emaMs > this.targetMs * 1.12 && this.stepIndex < this.steps.length - 1) {
      this.stepIndex++;
      this.cooldown = this.cooldownFrames;
      if (this.probing > 0) { this.probeWait = Math.min(this.probeWait * 2, this.probeFrames * 16); this.probing = 0; }
      this.calm = 0;
      return true;
    }
    if (this.stepIndex > 0 && (this.emaMs < this.targetMs * 0.72 || this.calm >= this.probeWait)) {
      const probe = this.emaMs >= this.targetMs * 0.72;
      this.stepIndex--;
      this.cooldown = this.cooldownFrames * 2;
      this.probing = probe ? this.cooldownFrames * 4 : 0;
      this.calm = 0;
      return true;
    }
    return false;
  }
}

// ------------------------------------------------------------------ auto exposure (eye adaptation)
export interface ExposureParams {
  /** Target middle grey after exposure (AgX input). Night scenes sit low. */
  key: number;
  min: number;
  max: number;
  /** Adaptation speed (1/s) towards brighter / darker scenes. */
  speedUp: number;
  speedDown: number;
}
/**
 * Calibrated base exposure and eye adaptation limited to ±0.3 EV. Calibrated for the stream look
 * the exposure is set for the lit white car paint (55-85 % signal), the asphalt then sits at
 * 5-15 % and the night background at 1-4 %.
 */
export const BASE_EXPOSURE = 0.3;
/** Scene log-average luminance (pre-exposure) of the calibrated reference view (kick_broadside, roll). */
export const REF_SCENE_LUM = 0.027;
export const NIGHT_EXPOSURE: ExposureParams = { key: BASE_EXPOSURE * REF_SCENE_LUM, min: BASE_EXPOSURE * 2 ** -0.3, max: BASE_EXPOSURE * 2 ** 0.3, speedUp: 2.5, speedDown: 0.9 };

/** Exposure the eye would settle at for a log-average scene luminance. */
export function targetExposure(avgLum: number, p: ExposureParams = NIGHT_EXPOSURE): number {
  const lum = Math.max(avgLum, 1e-5);
  return Math.min(p.max, Math.max(p.min, p.key / lum));
}

/** Exponential adaptation; faster when the scene gets brighter (pupil closes quickly). */
export function adaptExposure(current: number, target: number, dt: number, p: ExposureParams = NIGHT_EXPOSURE): number {
  const speed = target < current ? p.speedUp : p.speedDown;
  return current + (target - current) * (1 - Math.exp(-speed * Math.max(0, dt)));
}
