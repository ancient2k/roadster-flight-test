// TSL sky for the world looks: single-scattering atmosphere (same integral as skyParams.skyRadiance),
// HDR sun disc with limb darkening, stars/Milky Way, Earth disc for the lunar sky, and the matching
// aerial-perspective fog. Background radiance is in the same units as the sun light (irradiance units).
import * as THREE from 'three/webgpu';
import type { UFloat, UVec3, UColor } from './types';
import type { Node } from 'three/webgpu';
import {
  Fn, vec3, float, positionWorldDirection, floor, fract, dot, sin, smoothstep, pow, max, min, mix, abs, exp, sqrt,
  mx_noise_float, clamp, positionWorld, cameraPosition, length, fog, uniform, cross, normalize, select, acos, time,
} from 'three/tsl';
import type { AtmosphereParams, LookParams } from './skyParams';

type N3 = Node<'vec3'>;
type NF = Node<'float'>;

export interface SkyUniforms {
  sunDir: UVec3;
  /** Sun irradiance outside the atmosphere × colour (linear). */
  sunTop: UColor;
  /** Direct sun at the ground (after extinction) – used by the fog's in-scatter. */
  sunGround: UColor;
  earthDir: UVec3;
  starGain: UFloat;
  /** Extra multiplier on the sky dome (look comparison / tuning). */
  skyGain: UFloat;
  fogGain: UFloat;
}

export function makeSkyUniforms(): SkyUniforms {
  return {
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    sunTop: uniform(new THREE.Color(1, 1, 1)),
    sunGround: uniform(new THREE.Color(1, 1, 1)),
    earthDir: uniform(new THREE.Vector3(0, 1, 0)),
    starGain: uniform(0),
    skyGain: uniform(1),
    fogGain: uniform(1),
  };
}

const v3 = (a: readonly number[]) => vec3(a[0], a[1], a[2]);
const hash3 = (p: N3) => fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
const PI = Math.PI;

/** Henyey–Greenstein phase per channel. */
const hgPhase = (c: NF, g: N3) => {
  const g2 = g.mul(g);
  return g2.oneMinus().div(pow(g2.add(1).sub(g.mul(c).mul(2)), vec3(1.5)).mul(4 * PI));
};
/** Kasten–Young air mass (matches skyParams.airmass). */
export const airmassNode = (mu: NF) => {
  const deg = acos(clamp(mu, -1, 1)).mul(-180 / PI).add(90).max(-4.5);
  return float(1).div(sin(deg.mul(PI / 180)).max(-0.08).add(pow(deg.add(6.07995), float(-1.6364)).mul(0.50572)));
};

/**
 * In-scattered radiance (per unit sun irradiance) along dir from height h, plus the view transmittance.
 * Unrolled ray march with `steps` samples; numerically stable sphere intersections in float32.
 */
function scatter(a: AtmosphereParams, dir: N3, h: NF, sunDir: N3, steps: number) {
  const R = a.planetRadius, H = a.height;
  const mu = dir.y;
  const rr = h.add(R);
  const b = rr.mul(mu);
  // top of atmosphere: c = rr² − (R+H)² = (h − H)(2R + h + H)
  const cTop = h.sub(H).mul(h.add(2 * R + H));
  const tTop = b.negate().add(sqrt(b.mul(b).sub(cTop).max(0)));
  // ground: c = rr² − R² = h(2R + h); stable root c / (−b + √disc)
  const cG = h.mul(h.add(2 * R));
  const discG = b.mul(b).sub(cG);
  const hitsGround = mu.lessThan(0).and(discG.greaterThan(0));
  const tG = cG.div(b.negate().add(sqrt(discG.max(0))).max(1e-3));
  const L = select(hitsGround, tG, tTop).min(400_000);
  const ds = L.div(steps);
  const cosT = dot(dir, sunDir);
  const pR = cosT.mul(cosT).add(1).mul(3 / (16 * PI)).add(a.msRayleigh / (4 * PI));
  const pM = hgPhase(cosT, v3(a.mieG)).add(a.msMie / (4 * PI));
  const am = airmassNode(sunDir.y);
  const bR = v3(a.rayleigh), bMs = v3(a.mieScatter);
  const bMe = v3([a.mieScatter[0] + a.mieAbsorb[0], a.mieScatter[1] + a.mieAbsorb[1], a.mieScatter[2] + a.mieAbsorb[2]]);
  let tau: N3 = vec3(0, 0, 0);
  let sum: N3 = vec3(0, 0, 0);
  const rr2 = rr.mul(rr);
  for (let i = 0; i < steps; i++) {
    const t = ds.mul(i + 0.5);
    const q = t.mul(t).add(rr.mul(t).mul(mu).mul(2));
    // height of the sample, stable: (t² + 2 rr t mu + h(2R + h)) / (√(rr² + t² + 2 rr t mu) + R)
    const hh = q.add(cG).div(sqrt(rr2.add(q)).add(R)).max(0);
    const dR = exp(hh.div(-a.rayleighH)), dM = exp(hh.div(-a.mieH));
    const ext = bR.mul(dR).add(bMe.mul(dM));
    const tauMid = tau.add(ext.mul(ds).mul(0.5));
    const sunOD = bR.mul(dR.mul(a.rayleighH)).add(bMe.mul(dM.mul(a.mieH))).mul(am);
    const tr = exp(tauMid.add(sunOD).negate());
    sum = sum.add(bR.mul(dR.mul(pR)).add(bMs.mul(pM).mul(dM)).mul(tr).mul(ds)) as N3;
    tau = tau.add(ext.mul(ds)) as N3;
  }
  return { inscatter: sum, transmittance: exp(tau.negate()), hitsGround, length: L };
}

/** Stars: one candidate per direction cell; tint by temperature. */
function stars(d: N3, scale: number, thresh: number, gain: number, twinkle: boolean) {
  const p = d.mul(scale);
  const cell = floor(p);
  const r = hash3(cell);
  const off = vec3(hash3(cell.add(1.3)), hash3(cell.add(7.1)), hash3(cell.add(3.7))).sub(0.5).mul(0.7);
  const dist = length(fract(p).sub(0.5).sub(off));
  const on = smoothstep(float(thresh), float(1), r);
  const mag = pow(on, float(3));
  const tint = mix(vec3(1.0, 0.78, 0.55), vec3(0.72, 0.84, 1.0), hash3(cell.add(11.1)));
  const tw = twinkle ? sin(time.mul(r.mul(3).add(1)).add(r.mul(40))).mul(0.2).add(0.8) : float(1);
  return tint.mul(mag.mul(smoothstep(float(0.075), float(0.0), dist)).mul(gain).mul(tw));
}

/** Milky Way band with dust lanes (galactic plane tilted ~60° to the ecliptic). */
function milkyWay(d: N3, gain: number) {
  const band = vec3(0.35, 0.82, 0.45).normalize();
  const bd = dot(d, band);
  const core = vec3(0.86, -0.2, -0.47).normalize();      // galactic centre direction
  const mw = exp(bd.mul(bd).mul(-30));
  const bulge = pow(max(dot(d, core), float(0)), float(6)).mul(exp(bd.mul(bd).mul(-12)));
  const n1 = mx_noise_float(d.mul(7)).mul(0.5).add(0.5);
  const n2 = mx_noise_float(d.mul(23)).mul(0.5).add(0.5);
  const dust = smoothstep(float(0.35), float(0.7), n1.mul(0.7).add(n2.mul(0.3)));
  const lane = smoothstep(float(0.0), float(0.08), abs(bd.add(n1.sub(0.5).mul(0.05))));
  const glow = mw.mul(dust.mul(0.7).add(0.3)).mul(lane.mul(0.6).add(0.4)).add(bulge.mul(1.5));
  const col = mix(vec3(0.75, 0.8, 1.0), vec3(1.0, 0.85, 0.65), bulge.min(1));
  const dense = stars(d, 900, 0.82, 0.5, false).mul(mw.add(bulge));
  return col.mul(glow).mul(gain).add(dense.mul(gain * 4));
}

/** Earth seen from the Moon: lit sphere with oceans, land, clouds and an atmosphere rim. */
function earthDisc(d: N3, e: N3, radius: number, sunDir: N3, sunTop: N3) {
  const ce = dot(d, e);
  const o = d.sub(e.mul(ce)).div(Math.sin(radius));
  const r2 = dot(o, o);
  const inside = r2.lessThan(1).and(ce.greaterThan(0));
  const n = normalize(o.sub(e.mul(sqrt(r2.oneMinus().max(0)))));
  // body-fixed coordinates for the texture (slow spin about the axis ≈ up)
  const up = vec3(0, 1, 0);
  const east = normalize(cross(up, e));
  const north = cross(e.negate(), east);
  const lp = vec3(dot(n, east), dot(n, north), dot(n, e.negate()));
  const spin = time.mul(0.003);
  const tp = vec3(lp.x.mul(spin.cos()).sub(lp.z.mul(spin.sin())), lp.y, lp.x.mul(spin.sin()).add(lp.z.mul(spin.cos())));
  const land = smoothstep(float(0.08), float(0.16), mx_noise_float(tp.mul(2.2)).add(mx_noise_float(tp.mul(6)).mul(0.25)));
  const ice = smoothstep(float(0.75), float(0.85), abs(tp.y));
  const cloud = smoothstep(float(0.05), float(0.45), mx_noise_float(tp.mul(4).add(vec3(time.mul(0.001), 0, 0))).add(mx_noise_float(tp.mul(13)).mul(0.35)));
  let alb: N3 = mix(vec3(0.02, 0.05, 0.11), vec3(0.16, 0.13, 0.08), land) as N3;
  alb = mix(alb, vec3(0.7, 0.72, 0.75), ice.max(cloud.mul(0.85))) as N3;
  const lit = max(dot(n, sunDir), float(0));
  const rim = pow(float(1).sub(max(dot(n, e.negate()), float(0))), float(3)).mul(smoothstep(float(-0.15), float(0.25), dot(n, sunDir)));
  const col = alb.mul(lit).add(vec3(0.15, 0.3, 0.7).mul(rim).mul(0.25)).mul(sunTop).div(PI);
  const aa = smoothstep(float(1), float(0.97), r2);
  return { color: col.mul(aa), mask: select(inside, aa, float(0)) };
}

export interface SkyNodes {
  background: Node;
  /** Same sky without the sun disc (PMREM source: the disc would alias in a 256² cube). */
  environment: Node;
  fog: Node | null;
}

/** radiation/valley mist hugging the ground (Stonehenge sunrise): extinction σ0·exp(−(y − y0)/H). */
export interface GroundMist { sigma0: number; heightM: number; y0: number }

export function makeSkyNodes(p: LookParams, u: SkyUniforms, opts: { steps?: number; mist?: GroundMist | null } = {}): SkyNodes {
  const steps = opts.steps ?? 12;
  const build = (withSun: boolean) => Fn(() => {
    const d = positionWorldDirection.normalize();
    const sunDir = u.sunDir as unknown as N3;
    const sunTop = (u.sunTop as unknown as N3);
    const cosT = dot(d, sunDir);
    const sunR = p.sunAngularRadius;
    // sun disc: radiance E / (π r²) with limb darkening (u ≈ 0.6)
    const discR = float(1).sub(cosT).div(1 - Math.cos(sunR)).clamp(0, 2);
    const muLimb = sqrt(discR.oneMinus().max(0));
    const limb = muLimb.mul(0.6).add(0.4);
    const disc = smoothstep(float(1.05), float(0.95), discR).mul(limb).mul(1 / (PI * sunR * sunR));
    let col: N3;
    if (p.sky === 'atmosphere' && p.atmosphere) {
      const h = cameraPosition.y.max(1).add(2);
      const s = scatter(p.atmosphere, d, h, sunDir, steps);
      const sky = s.inscatter.mul(sunTop).mul(u.skyGain);
      // ground below the horizon beyond the terrain: lit ground albedo seen through the haze
      const gAlb = v3(p.groundAlbedo);
      const ground = gAlb.mul((u.sunGround as unknown as N3)).mul(sunDir.y.max(0)).div(PI).mul(s.transmittance);
      col = sky.add(select(s.hitsGround, ground, vec3(0, 0, 0))) as N3;
      if (withSun) col = col.add(sunTop.mul(s.transmittance).mul(disc).mul(select(s.hitsGround, float(0), float(1))).min(vec3(60000))) as N3;
      if (p.starBrightness > 0) col = col.add(stars(d, 260, 0.955, 0.6, true).mul(u.starGain)) as N3;
    } else {
      col = vec3(0, 0, 0) as N3;
      const sg = u.starGain;
      col = col.add(stars(d, 260, 0.95, 1.2, false).add(stars(d, 600, 0.92, 0.35, false)).mul(sg)) as N3;
      if (p.sky === 'space') col = col.add(milkyWay(d, 0.05).mul(sg)) as N3;
      if (withSun) {
        // corona / glare halo around the disc (no atmosphere: only the instrument's own scatter)
        const ang = acos(cosT.clamp(-1, 1));
        // tight aureole from lens/eye scatter only; the post bloom adds the rest
        const halo = exp(ang.div(-sunR * 2)).mul(20).add(exp(ang.div(-0.03)).mul(0.004));
        col = col.add(sunTop.mul(disc.add(halo.mul(smoothstep(float(0.9), float(1.1), discR)))).min(vec3(60000))) as N3;
      }
      if (p.earth) {
        const ed = earthDisc(d, u.earthDir as unknown as N3, p.earth.angularRadius, sunDir, sunTop);
        col = mix(col, ed.color, ed.mask) as N3;
      }
      // below the horizon on the Moon: dark regolith instead of stars (terrain normally covers it)
      if (p.sky === 'black') col = mix(v3(p.groundAlbedo).mul(sunTop).mul(sunDir.y.max(0)).div(PI), col, smoothstep(float(-0.02), float(0.0), d.y)) as N3;
    }
    return col;
  })();

  let fogNode: Node | null = null;
  if (p.sky === 'atmosphere' && p.atmosphere) {
    const a = p.atmosphere;
    const dv = positionWorld.sub(cameraPosition);
    const dist = length(dv);
    const dir = dv.div(dist.max(1e-3));
    const hAvg = cameraPosition.y.add(positionWorld.y).mul(0.5).max(0);
    const dR = exp(hAvg.div(-a.rayleighH)), dM = exp(hAvg.div(-a.mieH));
    const bR = v3(a.rayleigh), bMs = v3(a.mieScatter);
    const bMe = v3([0, 1, 2].map((k) => a.mieScatter[k] + a.mieAbsorb[k]));
    const ext = bR.mul(dR).add(bMe.mul(dM)).mul(u.fogGain);
    const T = exp(ext.mul(dist).negate());
    const cosT = dot(dir, u.sunDir as unknown as N3);
    const pR = cosT.mul(cosT).add(1).mul(3 / (16 * PI)).add(a.msRayleigh / (4 * PI));
    const pM = hgPhase(cosT, v3(a.mieG)).add(a.msMie / (4 * PI));
    const sc = bR.mul(dR).mul(pR).add(bMs.mul(dM).mul(pM)).mul(u.fogGain);
    // in-scatter of a homogeneous segment, lit by the attenuated sun, plus skylight ≈ 0.35 × sun scatter
    const ins = sc.div(ext.max(vec3(1e-9))).mul(T.oneMinus()).mul((u.sunGround as unknown as N3)).mul(1.35);
    let f: Node<'float'> = float(1).sub(dot(T, vec3(0.2126, 0.7152, 0.0722))).clamp(0, 0.995) as Node<'float'>;
    let fc: N3 = ins.div(f.max(1e-4)) as N3;
    const mist = opts.mist;
    if (mist) {
      // optical depth of the exponential layer along the segment (Simpson over the end and mid heights)
      const e = (y: Node<'float'>) => exp(y.sub(mist.y0).div(-mist.heightM).min(1.0));
      const ym = cameraPosition.y.add(positionWorld.y).mul(0.5);
      const tau = e(cameraPosition.y).add(e(ym).mul(4)).add(e(positionWorld.y)).div(6).mul(dist).mul(mist.sigma0);
      const Tm = exp(tau.negate());
      // droplets: bright forward lobe toward the low sun + diffuse sky/sun share
      const lobe = pow(cosT.max(0), float(6)).mul(1.6).add(0.32);
      const Lm = (u.sunGround as unknown as N3).mul(lobe).mul(0.55);
      const Ta = float(1).sub(f);
      const fTot = float(1).sub(Ta.mul(Tm)).clamp(0, 0.998);
      fc = ins.mul(Tm).add(Lm.mul(Tm.oneMinus())).div(fTot.max(1e-4)) as N3;
      f = fTot as Node<'float'>;
    }
    fogNode = fog(fc, f);
  }
  return { background: build(true), environment: build(false), fog: fogNode };
}

/** Utility: min() re-export to keep tree-shaking quiet. */
export { min };
