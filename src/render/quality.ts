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

/** Effects that the WebGL2 fallback drops (cost / support) on top of the chosen preset. */
export function settingsForBackend(level: QualityLevel, backend: 'webgpu' | 'webgl2'): QualitySettings {
  const s = { ...QUALITY_PRESETS[level], resolutionSteps: [...QUALITY_PRESETS[level].resolutionSteps] };
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
 */
export class DynamicResolution {
  stepIndex = 0;
  private emaMs: number;
  private cooldown: number;

  constructor(
    public steps: number[],
    public targetMs = 1000 / 60,
    /** Frames to wait after a change before reconsidering. */
    public cooldownFrames = 90,
    public smoothing = 0.06,
  ) {
    this.emaMs = targetMs * 0.8;
    this.cooldown = cooldownFrames * 2; // let shader compilation hitches pass first
  }

  get scale(): number { return this.steps[this.stepIndex] ?? 1; }
  get averageMs(): number { return this.emaMs; }

  reset(steps?: number[]): void {
    if (steps) this.steps = steps;
    this.stepIndex = 0;
    this.cooldown = this.cooldownFrames;
    this.emaMs = this.targetMs * 0.8;
  }

  /** Feed one frame time (ms). Returns true when the scale changed. */
  update(frameMs: number): boolean {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return false;
    // Ignore hitches (tab switch, GC) so a single spike does not drop resolution.
    const clamped = Math.min(frameMs, this.targetMs * 3);
    this.emaMs += (clamped - this.emaMs) * this.smoothing;
    if (this.cooldown > 0) { this.cooldown--; return false; }
    if (this.emaMs > this.targetMs * 1.12 && this.stepIndex < this.steps.length - 1) {
      this.stepIndex++;
      this.cooldown = this.cooldownFrames;
      return true;
    }
    if (this.emaMs < this.targetMs * 0.72 && this.stepIndex > 0) {
      this.stepIndex--;
      this.cooldown = this.cooldownFrames * 2;
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
