// Sky/light parameters per SiteDef.look and a CPU reference of the single-scattering atmosphere that the
// TSL sky shader evaluates (same coefficients, so sun colour, sky radiance and ambient light agree).
// Pure (Vitest). Units: lengths in metres, "irradiance units" = three.js light intensity (sun ≈ lux / 25 000).

import type { SiteDef } from '../../shared/worlds';
import type { ExposureParams } from '../quality';
import { blackbodyRGB } from './colorScience';

export type RGB = [number, number, number];
export type Look = SiteDef['look'];

export interface AtmosphereParams {
  planetRadius: number;
  /** Atmosphere thickness (m). */
  height: number;
  /** Rayleigh scattering at sea level (1/m) and scale height. */
  rayleigh: RGB;
  rayleighH: number;
  /** Aerosol/dust scattering + absorption at the ground (1/m) and scale height. */
  mieScatter: RGB;
  mieAbsorb: RGB;
  mieH: number;
  /** Henyey–Greenstein asymmetry per channel (Mars dust: blue forward peak → blue sun halo). */
  mieG: RGB;
  /** Multiple-scattering approximation: isotropic share added to the Rayleigh / Mie phase (×1/4π). */
  msRayleigh: number;
  msMie: number;
}

export interface LookParams {
  look: Look;
  sky: 'atmosphere' | 'black' | 'space';
  atmosphere: AtmosphereParams | null;
  /** Sun irradiance outside the atmosphere (light units) and its colour (linear, luminance 1). */
  sunIrradiance: number;
  sunColorTop: RGB;
  /** Angular radius of the sun disc (rad). */
  sunAngularRadius: number;
  /** Stars/Milky Way brightness (0 = invisible: daylight sky or adapted eye). */
  starBrightness: number;
  /** Ground albedo tint used for bounce light (linear). */
  groundAlbedo: RGB;
  /** Lunar regolith BRDF approximation (Lommel–Seeliger + opposition surge). */
  regolith: boolean;
  /** Opposition surge amplitude/width (Hapke B0, h). */
  oppositionB0: number;
  oppositionH: number;
  /** Shadow penumbra softness (PCF radius in texels). */
  shadowRadius: number;
  /** Exposure the auto-exposure should adapt within (AgX input). */
  exposure: ExposureParams;
  /** Static exposure for a fixed camera (sandbox / screenshots). */
  exposureFixed: number;
  /** Earth disc in the sky (Moon): direction and angular radius. */
  earth: { dir: [number, number, number]; angularRadius: number } | null;
  /** Fog colour/density override for skies without atmosphere (dust in space is none). */
}

/** Solar irradiance at 1 AU in light units (≈ 128 klux / 25 000). */
export const SUN_IRRADIANCE_1AU = 5.1;
export const SUN_ANGULAR_RADIUS_1AU = 0.004654;

export const EARTH_ATMOSPHERE: AtmosphereParams = {
  planetRadius: 6_371_000, height: 80_000,
  rayleigh: [5.802e-6, 13.558e-6, 33.1e-6], rayleighH: 8000,
  mieScatter: [3.996e-6, 3.996e-6, 3.996e-6], mieAbsorb: [0.444e-6, 0.444e-6, 0.444e-6], mieH: 1200,
  mieG: [0.8, 0.8, 0.8], msRayleigh: 1.2, msMie: 0.5,
};

/** Mars: thin CO2 (Rayleigh ≈ 1 % of Earth), dust τ ≈ 0.5 with H ≈ 11 km, blue absorbed, blue forward peak. */
export const MARS_ATMOSPHERE: AtmosphereParams = {
  planetRadius: 3_389_500, height: 80_000,
  rayleigh: [0.06e-6, 0.14e-6, 0.33e-6], rayleighH: 11_100,
  mieScatter: [40e-6, 29e-6, 17e-6], mieAbsorb: [1.5e-6, 9e-6, 23e-6], mieH: 11_000,
  mieG: [0.64, 0.66, 0.74], msRayleigh: 1, msMie: 1.6,
};

const scaled = (a: AtmosphereParams, mieK: number): AtmosphereParams => ({
  ...a, mieScatter: a.mieScatter.map((v) => v * mieK) as RGB, mieAbsorb: a.mieAbsorb.map((v) => v * mieK) as RGB,
});

const SUN_COLOR = blackbodyRGB(5772);

const DAY_EXPOSURE: ExposureParams = { key: 0.16, min: 0.25, max: 3, speedUp: 2.5, speedDown: 1.2 };
const MOON_EXPOSURE: ExposureParams = { key: 0.16, min: 0.25, max: 4, speedUp: 2.5, speedDown: 1.0 };
const SPACE_EXPOSURE: ExposureParams = { key: 0.12, min: 0.02, max: 2, speedUp: 3, speedDown: 1.0 };

/** Look parameters; siteId refines (Giza: dusty desert haze, Stonehenge: clean morning air). */
export function lookParams(look: Look, siteId?: string): LookParams {
  const base = {
    look, sunIrradiance: SUN_IRRADIANCE_1AU, sunColorTop: SUN_COLOR, sunAngularRadius: SUN_ANGULAR_RADIUS_1AU,
    starBrightness: 0, regolith: false, oppositionB0: 0, oppositionH: 0.06, shadowRadius: 2, earth: null,
  };
  switch (look) {
    case 'day': {
      const giza = siteId === 'earth_giza';
      return {
        ...base, sky: 'atmosphere',
        atmosphere: scaled(EARTH_ATMOSPHERE, giza ? 3.0 : 2.0),
        groundAlbedo: giza ? [0.42, 0.33, 0.22] : [0.12, 0.16, 0.07],
        shadowRadius: 2.5, exposure: DAY_EXPOSURE, exposureFixed: giza ? 0.62 : 0.75,
      };
    }
    case 'mars_day':
      return {
        ...base, sky: 'atmosphere', atmosphere: MARS_ATMOSPHERE,
        sunIrradiance: SUN_IRRADIANCE_1AU / (1.524 ** 2), sunAngularRadius: SUN_ANGULAR_RADIUS_1AU / 1.524,
        groundAlbedo: [0.3, 0.17, 0.09], shadowRadius: 3, exposure: DAY_EXPOSURE, exposureFixed: 1.25,
      };
    case 'lunar_day':
    case 'lunar_low_sun':
      return {
        ...base, sky: 'black', atmosphere: null, groundAlbedo: [0.12, 0.115, 0.11], regolith: true,
        oppositionB0: 1.0, oppositionH: 0.06, shadowRadius: 1, exposure: MOON_EXPOSURE,
        exposureFixed: look === 'lunar_low_sun' ? 1.4 : 1.15, starBrightness: 0,
        earth: { dir: [-0.4, 0.917, 0], angularRadius: 0.0166 },
      };
    case 'deep_space':
      return {
        ...base, sky: 'space', atmosphere: null, groundAlbedo: [0, 0, 0], shadowRadius: 1,
        exposure: SPACE_EXPOSURE, exposureFixed: 0.5, starBrightness: 1,
      };
    case 'night':
    default:
      return {
        ...base, sky: 'atmosphere', atmosphere: EARTH_ATMOSPHERE, sunIrradiance: 0, groundAlbedo: [0.1, 0.1, 0.1],
        exposure: DAY_EXPOSURE, exposureFixed: 1, starBrightness: 1,
      };
  }
}

/** Earth direction in the lunar sky per site (Earth stays fixed in the sky; libration ignored). */
export function earthDirForSite(siteId: string): [number, number, number] {
  const el = (deg: number, azDeg: number): [number, number, number] => {
    // azimuth from north (−Z) clockwise toward east (+X)
    const e = deg * Math.PI / 180, a = azDeg * Math.PI / 180;
    return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)];
  };
  switch (siteId) {
    case 'moon_tranquility': return el(66.5, 268);   // 0.67° N 23.47° E → Earth 66° high in the west
    case 'moon_hadley': return el(63.4, 186);        // 26.1° N 3.6° E → high in the south
    case 'moon_shackleton': return el(4.5, 300);     // south pole: Earth skims the horizon
    default: return [-0.4, 0.917, 0];
  }
}

// ------------------------------------------------------------------ CPU reference of the atmosphere

const hg = (c: number, g: number) => (1 - g * g) / (4 * Math.PI * Math.pow(1 + g * g - 2 * g * c, 1.5));
const rayPhase = (c: number) => (3 / (16 * Math.PI)) * (1 + c * c);

/** Distance along a ray from height h (above the surface) with direction cosine mu to the sphere of radius r. */
export function raySphere(R: number, h: number, mu: number, r: number): number {
  const rr = R + h;
  const b = rr * mu, c = rr * rr - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t1 = -b - s, t2 = -b + s;
  return t1 > 0 ? t1 : t2 > 0 ? t2 : -1;
}

/** Relative air mass for a sun at sin(elevation) mu (Kasten–Young 1989), clamped a few degrees below the horizon. */
export function airmass(mu: number): number {
  const deg = Math.asin(Math.max(-1, Math.min(1, mu))) * 180 / Math.PI;
  const d = Math.max(deg, -4.5);
  return 1 / (Math.max(Math.sin(d * Math.PI / 180), -0.08) + 0.50572 * Math.pow(d + 6.07995, -1.6364));
}

/** Optical depth (per channel) from height h toward direction cosine mu to the top of the atmosphere. */
export function opticalDepth(a: AtmosphereParams, h: number, mu: number, steps = 24): RGB {
  const R = a.planetRadius;
  if (raySphere(R, h, mu, R) > 0 && mu < 0) return [Infinity, Infinity, Infinity];
  const L = raySphere(R, h, mu, R + a.height);
  if (L <= 0) return [0, 0, 0];
  let dr = 0, dm = 0;
  const ds = L / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * ds;
    const rr = Math.sqrt((R + h) ** 2 + t * t + 2 * (R + h) * t * mu);
    const hh = Math.max(0, rr - R);
    dr += Math.exp(-hh / a.rayleighH) * ds;
    dm += Math.exp(-hh / a.mieH) * ds;
  }
  return [0, 1, 2].map((k) => a.rayleigh[k] * dr + (a.mieScatter[k] + a.mieAbsorb[k]) * dm) as RGB;
}

/** Direct-sun transmittance at height h for sun elevation sinEl (sin of elevation). */
export function sunTransmittance(a: AtmosphereParams | null, sinEl: number, h = 2): RGB {
  if (!a) return [1, 1, 1];
  const t = opticalDepth(a, h, sinEl);
  return t.map((v) => Math.exp(-v)) as RGB;
}

/**
 * Single-scattered sky radiance seen from height h in direction (cosine to zenith muV, cosine to the sun
 * cosTheta), sun at sinEl, for unit sun irradiance. Same integral as the TSL shader.
 */
export function skyRadiance(a: AtmosphereParams, h: number, muV: number, cosTheta: number, sinEl: number, steps = 16): RGB {
  const R = a.planetRadius;
  const ground = raySphere(R, h, muV, R);
  const L = ground > 0 ? ground : raySphere(R, h, muV, R + a.height);
  if (L <= 0) return [0, 0, 0];
  const out: RGB = [0, 0, 0];
  const pR = rayPhase(cosTheta) + a.msRayleigh / (4 * Math.PI);
  const pM = a.mieG.map((g) => hg(cosTheta, g) + a.msMie / (4 * Math.PI));
  const ds = L / steps;
  const tau: RGB = [0, 0, 0];
  // sun direction relative to the zenith at the sample point is approximated by the camera's (flat-earth
  // within 100 km), which keeps the shader cheap and matches it exactly
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * ds;
    const rr = Math.sqrt((R + h) ** 2 + t * t + 2 * (R + h) * t * muV);
    const hh = Math.max(0, rr - R);
    const dR = Math.exp(-hh / a.rayleighH), dM = Math.exp(-hh / a.mieH);
    for (let k = 0; k < 3; k++) tau[k] += (a.rayleigh[k] * dR + (a.mieScatter[k] + a.mieAbsorb[k]) * dM) * ds * 0.5;
    const am = airmass(sinEl);
    for (let k = 0; k < 3; k++) {
      const sun = (a.rayleigh[k] * a.rayleighH * dR + (a.mieScatter[k] + a.mieAbsorb[k]) * a.mieH * dM) * am;
      const tr = Math.exp(-(tau[k] + sun));
      out[k] += (a.rayleigh[k] * dR * pR + a.mieScatter[k] * dM * pM[k]) * tr * ds;
    }
    for (let k = 0; k < 3; k++) tau[k] += (a.rayleigh[k] * dR + (a.mieScatter[k] + a.mieAbsorb[k]) * dM) * ds * 0.5;
  }
  return out;
}

/** Sun light colour × intensity at the ground for a look and sun direction (y = sin elevation). */
export function sunLightAtGround(p: LookParams, sunY: number): { color: RGB; intensity: number } {
  const T = sunTransmittance(p.atmosphere, sunY);
  const c = [0, 1, 2].map((k) => p.sunColorTop[k] * T[k]) as RGB;
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  if (lum <= 1e-6) return { color: [0, 0, 0], intensity: 0 };
  return { color: c.map((v) => v / lum) as RGB, intensity: p.sunIrradiance * lum };
}

/**
 * Hemisphere ambient (sky dome irradiance from above, bounce from below) for the WebGL2 fallback and
 * for tests: cosine-weighted integral of skyRadiance over the upper hemisphere.
 */
export function skyIrradiance(p: LookParams, sun: [number, number, number]): { sky: RGB; ground: RGB } {
  const a = p.atmosphere;
  const sunL = sunLightAtGround(p, sun[1]);
  const bounce = (k: number) => p.groundAlbedo[k] * sunL.color[k] * sunL.intensity * Math.max(0, sun[1]) / Math.PI;
  if (!a) return { sky: [0, 0, 0], ground: [bounce(0), bounce(1), bounce(2)] };
  const sky: RGB = [0, 0, 0];
  const nT = 6, nP = 12;
  for (let i = 0; i < nT; i++) {
    const mu = (i + 0.5) / nT;          // cos zenith
    const st = Math.sqrt(1 - mu * mu);
    for (let j = 0; j < nP; j++) {
      const ph = (j / nP) * 2 * Math.PI;
      const d = [st * Math.cos(ph), mu, st * Math.sin(ph)];
      const c = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2];
      const L = skyRadiance(a, 2, mu, c, sun[1], 10);
      // ∫ L cosθ dω with dω = dμ dφ
      for (let k = 0; k < 3; k++) sky[k] += L[k] * p.sunIrradiance * p.sunColorTop[k] * mu * (1 / nT) * (2 * Math.PI / nP);
    }
  }
  return { sky, ground: [bounce(0), bounce(1), bounce(2)] };
}
