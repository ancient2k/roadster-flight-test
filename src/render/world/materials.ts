// Shared PBR materials for the McGregor scene. Textures come from public/assets/env (Poly Haven,
// CC0); every material has a procedural fallback so the scene renders even if a file is missing.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  texture, uv, vec2, vec3, float, mix, positionWorld, mx_noise_float, smoothstep, clamp, normalMap, fract, uniform,
} from 'three/tsl';

export interface TextureSet { diff: THREE.Texture; nor: THREE.Texture; arm: THREE.Texture }

const loader = new THREE.TextureLoader();

function placeholderTex(rgb: [number, number, number]): THREE.DataTexture {
  const d = new Uint8Array([rgb[0], rgb[1], rgb[2], 255]);
  const t = new THREE.DataTexture(d, 1, 1);
  t.needsUpdate = true;
  return t;
}

function loadTex(url: string, srgb: boolean, fallback: [number, number, number], anisotropy: number): THREE.Texture {
  const tex = loader.load(url, undefined, undefined, () => {
    console.warn(`[render] Textur fehlt: ${url} (prozeduraler Ersatz)`);
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  // DataTexture fallback colour until loaded
  void fallback;
  return tex;
}

export function loadTextureSet(base: string, name: string, anisotropy = 8): TextureSet {
  return {
    diff: loadTex(`${base}${name}_diff.jpg`, true, [80, 80, 80], anisotropy),
    nor: loadTex(`${base}${name}_nor.jpg`, false, [128, 128, 255], anisotropy),
    arm: loadTex(`${base}${name}_arm.jpg`, false, [255, 160, 0], anisotropy),
  };
}

export { placeholderTex };

// ------------------------------------------------------------------ baked pad mask
function hash2(x: number, y: number, seed: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, seed: number, oct = 5): number {
  let f = 0, amp = 0.5, n = 0;
  for (let o = 0; o < oct; o++) { f += amp * vnoise(x, y, seed + o * 13); n += amp; x *= 2.03; y *= 2.03; amp *= 0.5; }
  return f / n;
}

export interface PadMask { tex: THREE.DataTexture; min: { x: number; z: number }; max: { x: number; z: number } }

/**
 * Bakes a 1024² mask over the pad: R = standing water (puddles), G = rubber (tyre tracks along the
 * stunt lanes, burnout patches), B = macro albedo variation, A = damp film (overall wetness).
 */
export function bakePadMask(min: { x: number; z: number }, max: { x: number; z: number }, lanes: { x: number; z0: number; z1: number }[], patches: { x: number; z: number; r: number }[]): PadMask {
  const N = 1024;
  const data = new Uint8Array(N * N * 4);
  const W = max.x - min.x, L = max.z - min.z;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = min.x + ((i + 0.5) / N) * W, z = min.z + ((j + 0.5) / N) * L;
    const macro = fbm(x * 0.02, z * 0.02, 1, 4);
    // puddles: low, flat spots -> thresholded fbm, plus finer breakup at the shoreline
    const p = fbm(x * 0.045, z * 0.045, 7, 5) + (fbm(x * 0.6, z * 0.6, 3, 3) - 0.5) * 0.12;
    const puddle = smooth(0.66, 0.72, p); // small, scattered puddles (the stream pad is damp, not flooded)
    // mostly dry, matte asphalt (stream); damp patches only where the fbm says so
    const damp = 0.12 + 0.55 * smooth(0.45, 0.7, fbm(x * 0.03, z * 0.03, 11, 3));
    let rubber = 0;
    for (const ln of lanes) {
      if (z < ln.z0 || z > ln.z1) continue;
      for (const off of [-0.86, 0.86]) {
        const d = Math.abs(x - (ln.x + off + (fbm(z * 0.05, ln.x, 5, 2) - 0.5) * 0.5));
        const w = 0.16 + 0.1 * fbm(z * 0.2, 1, 9, 2);
        rubber = Math.max(rubber, smooth(w, w * 0.4, d) * (0.4 + 0.6 * fbm(z * 0.4, x, 2, 3)));
      }
    }
    for (const pt of patches) {
      const d = Math.hypot(x - pt.x, z - pt.z) / pt.r;
      if (d < 1.3) {
        // swirly burnout donuts
        const a = Math.atan2(z - pt.z, x - pt.x);
        const swirl = 0.5 + 0.5 * Math.sin(a * 3 + d * 14 + fbm(x * 0.3, z * 0.3, 4, 2) * 6);
        rubber = Math.max(rubber, smooth(1.2, 0.5, d) * (0.35 + 0.5 * swirl));
      }
    }
    const k = (j * N + i) * 4;
    data[k] = puddle * 255; data[k + 1] = Math.min(1, rubber) * 255; data[k + 2] = macro * 255; data[k + 3] = damp * 255;
  }
  const tex = new THREE.DataTexture(data, N, N);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return { tex, min, max };
}
function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------------ baked floodlight illuminance
export interface FloodSource { pos: { x: number; y: number; z: number }; aim: { x: number; y: number; z: number }; intensityCd: number; halfAngleDeg: number }
export interface LightMap { tex: THREE.DataTexture; min: { x: number; z: number }; max: { x: number; z: number }; maxLux: number }

/**
 * Diffuse illuminance (lux) of the floodlight towers on the ground plane, baked once (the towers
 * never move). Ground materials add albedo·E/π as radiance, so the pad is lit evenly like the real
 * venue without a dozen real-time spotlights. Encoded sqrt(E/maxLux) in 8 bit.
 */
export function bakeFloodLightmap(src: FloodSource[], min: { x: number; z: number }, max: { x: number; z: number }, N = 512): LightMap {
  const data = new Uint8Array(N * N * 4);
  const W = max.x - min.x, L = max.z - min.z;
  const vals = new Float32Array(N * N);
  let maxLux = 0;
  const dirs = src.map((s) => {
    const d = { x: s.aim.x - s.pos.x, y: s.aim.y - s.pos.y, z: s.aim.z - s.pos.z };
    const l = Math.hypot(d.x, d.y, d.z);
    return { x: d.x / l, y: d.y / l, z: d.z / l, cosOuter: Math.cos(s.halfAngleDeg * Math.PI / 180) };
  });
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = min.x + ((i + 0.5) / N) * W, z = min.z + ((j + 0.5) / N) * L;
    let E = 0;
    src.forEach((s, k) => {
      const dx = x - s.pos.x, dy = -s.pos.y, dz = z - s.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
      const cosAx = (dx * dirs[k].x + dy * dirs[k].y + dz * dirs[k].z) / d;
      // flat-top beam with soft shoulder plus a little spill outside the cone
      const t = Math.min(1, Math.max(0, (cosAx - dirs[k].cosOuter) / (1 - dirs[k].cosOuter) * 2.2));
      const profile = t * t * (3 - 2 * t) * 0.92 + 0.08 * Math.max(0, cosAx) ** 6;
      const cosInc = s.pos.y / d;
      E += (s.intensityCd * profile * cosInc) / d2;
    });
    vals[j * N + i] = E;
    if (E > maxLux) maxLux = E;
  }
  for (let p = 0; p < N * N; p++) {
    const v = Math.round(Math.sqrt(vals[p] / maxLux) * 255);
    data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = v; data[p * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return { tex, min, max, maxLux };
}

/**
 * Share of the baked floodlight illuminance that is added as radiance. The direct light comes from
 * the real tower spots (lighting.ts); the bake only stands in for the indirect bounce (~5-15 %).
 */
export const LIGHTMAP_WEIGHT = uniform(0.12);

/** Simulation time for scene shaders (haze drift, LED walls): pauses and slows with the sim. */
export const SCENE_TIME = uniform(0);

/** Radiance contribution w·albedo·E/π of the baked floodlights. */
export function floodRadiance(lm: LightMap, albedo: Node<'vec3'>) {
  const luv = positionWorld.xz.sub(vec2(lm.min.x, lm.min.z)).div(vec2(lm.max.x - lm.min.x, lm.max.z - lm.min.z));
  const e = texture(lm.tex, luv).r;
  // spill of the many stage, row and tower fixtures that are not modelled as lights: the stream's
  // asphalt never drops to black (≈ 20/255 between the pools), large soft patches, fading off the pad
  const patch = mx_noise_float(positionWorld.xz.mul(0.018)).mul(0.5).add(0.5);
  const onPad = smoothstep(float(320), float(150), positionWorld.xz.length());
  const fill = GROUND_FILL.mul(patch.mul(0.7).add(0.55)).mul(onPad.mul(0.85).add(0.15));
  return albedo.mul(e.mul(e).mul(lm.maxLux / Math.PI).mul(LIGHTMAP_WEIGHT).add(fill));
}

/** Uniform illuminance (scene units) of unmodelled stray light on the pad, see floodRadiance(). */
export const GROUND_FILL = uniform(0.6);

/**
 * Wet asphalt: Poly Haven asphalt at 5 m tiling plus a 1.3 m detail layer, baked mask for puddles,
 * rubber tracks and damp film. Standing water is near-mirror (roughness 0.02, flattened normal) so
 * floodlights and LED strips reflect via SSR and the specular lobe; damp asphalt stays glossy-rough.
 */
/** Solid lane centre lines (world x, z range): kicker run-up, 0-60 strip, wall-ramp run-up. */
const LANE_LINES = [{ x: -45, z0: -199, z1: -41.5 }, { x: 0, z0: -199, z1: 199 }, { x: 60, z0: -199, z1: 40 }];

export function makeAsphaltMaterial(t: TextureSet, mask: PadMask, lm: LightMap | null, wetness = 1): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const wuv = positionWorld.xz.div(5.0);
  const duv = positionWorld.xz.div(1.3).add(vec2(0.37, 0.71));
  const muv = positionWorld.xz.sub(vec2(mask.min.x, mask.min.z)).div(vec2(mask.max.x - mask.min.x, mask.max.z - mask.min.z));
  const mk = texture(mask.tex, muv);
  const puddle = mk.r.mul(wetness);
  const rubber = mk.g;
  const macro = mk.b;
  const damp = mk.a.mul(wetness);
  // linear albedo 0.035-0.07 (dry asphalt), macro variation ±12 %, fine grain from the detail layer
  const tex = texture(t.diff, wuv).rgb;
  const lum = tex.dot(vec3(0.2126, 0.7152, 0.0722)).max(0.01);
  const base = tex.div(lum).mul(0.052).mul(texture(t.diff, duv).rgb.dot(vec3(0.333)).div(lum).clamp(0.6, 1.4).mul(0.35).add(0.65));
  let albedo: Node<'vec3'> = base.mul(mix(float(0.88), float(1.12), macro)).mul(mix(float(1), float(0.6), rubber));
  albedo = albedo.mul(mix(float(1), float(0.75), damp.mul(0.7))).mul(mix(float(1), float(0.7), puddle));
  // painted lane lines (stream: solid white centre lines along the run-ups, worn by the tyres)
  let paint = float(0) as unknown as Node<'float'>;
  for (const ln of LANE_LINES) {
    const across = positionWorld.x.sub(ln.x).abs();
    const inZ = smoothstep(float(ln.z0 - 0.3), float(ln.z0), positionWorld.z).mul(smoothstep(float(ln.z1 + 0.3), float(ln.z1), positionWorld.z));
    paint = paint.add(smoothstep(float(0.065), float(0.055), across).mul(inZ)) as unknown as Node<'float'>;
  }
  const wear = mx_noise_float(positionWorld.xz.mul(vec2(2.2, 0.35))).mul(0.5).add(0.5);
  paint = paint.clamp(0, 1).mul(smoothstep(float(0.15), float(0.55), wear).mul(0.6).add(0.4)) as unknown as Node<'float'>;
  albedo = mix(albedo, vec3(0.55, 0.55, 0.52), paint.mul(float(1).sub(rubber.mul(0.5))));
  m.colorNode = albedo;
  if (lm) m.emissiveNode = floodRadiance(lm, albedo as Node<'vec3'>);
  // roughness: dry 0.7-0.9, damp driving lanes 0.3-0.5, small puddles 0.06-0.15
  const arm = texture(t.arm, wuv);
  const dryRough = arm.g.mul(0.2).add(0.7);
  const dampRough = mix(dryRough, float(0.4), damp.mul(0.85));
  const lanes = mix(dampRough, float(0.35), rubber.mul(0.7));
  m.roughnessNode = mix(lanes, mix(float(0.15), float(0.06), puddle), smoothstep(float(0.3), float(0.8), puddle));
  m.metalnessNode = float(0);
  m.aoNode = arm.r;
  const nScale = mix(float(1.0), float(0.05), puddle).mul(mix(float(1), float(0.7), rubber));
  m.normalNode = normalMap(texture(t.nor, wuv), vec2(nScale, nScale));
  return m;
}

/**
 * Cast-in-place concrete for the ramps: formwork panel seams and tie holes (2.4 × 1.2 m panels),
 * rubber marks along the wheel paths, dirt/streaks near the foot. uv = (across m, along m).
 */
export function makeConcreteMaterial(t: TextureSet, opts: { tileM?: number; tint?: number; wheelTrack?: number; albedo?: number; grime?: number; seams?: number; calm?: boolean } = {}): THREE.MeshStandardNodeMaterial {
  const tileM = opts.tileM ?? 4;
  const m = new THREE.MeshStandardNodeMaterial();
  const u = uv();
  const cuv = u.mul(1 / tileM);
  const macro = mx_noise_float(u.mul(0.11)).mul(0.5).add(0.5);
  // formwork seams
  const pu = u.x.div(2.4), pv = u.y.div(1.2);
  const seamU = smoothstep(float(0.012), float(0.0), fract(pu).sub(0.5).abs().sub(0.5).abs());
  const seamV = smoothstep(float(0.02), float(0.0), fract(pv).sub(0.5).abs().sub(0.5).abs());
  const seam = clamp(seamU.add(seamV), 0, 1);
  const tie = smoothstep(float(0.035), float(0.02), vec2(fract(pu.mul(2)).sub(0.5).mul(2.4 / 2), fract(pv).sub(0.5).mul(1.2)).length());
  // panel-to-panel tone variation
  const panel = mx_noise_float(vec2(pu.floor(), pv.floor()).mul(0.73)).mul(0.5).add(0.5);
  // rubber along the wheel paths
  const half = opts.wheelTrack ?? 0;
  const tr = half > 0 ? smoothstep(float(0.28), float(0.05), u.x.sub(half).abs().sub(0.86).abs()).mul(mx_noise_float(u.mul(vec2(0.8, 0.15))).mul(0.4).add(0.6)) : float(0);
  const gk = opts.grime ?? 1, sk = opts.seams ?? 1;
  const grime = smoothstep(float(3.5), float(0), u.y).mul(0.35 * gk).add(mx_noise_float(u.mul(vec2(0.3, 0.05))).mul(0.12 * gk));
  const tint = new THREE.Color(opts.tint ?? 0xf2efe9);
  let tex: Node<'vec3'> = texture(t.diff, cuv).rgb;
  if (opts.albedo !== undefined) {
    // the Poly Haven texture is a brownish, dark concrete (linear mean luminance ≈ 0.115). The
    // stream ramp is a light, neutral grey cast concrete: keep the texture's luminance detail, mostly
    // drop its colour and scale it to the requested mean linear albedo
    const l = tex.dot(vec3(0.2126, 0.7152, 0.0722));
    // half of the texture's luminance contrast: the stream concrete is smooth and evenly mottled
    tex = mix(vec3(l), tex, 0.2).div(l.max(0.01)).mul(l.mul(0.5).add(0.115 * 0.5)).mul(opts.albedo / 0.115) as unknown as Node<'vec3'>;
  }
  // calm: large, soft mottling only (stream wall ramp), no panel-to-panel steps
  let col = tex.mul(mix(float(opts.calm ? 0.78 : 0.72), float(1.0), macro)).mul(mix(float(opts.calm ? 0.98 : 0.9), float(opts.calm ? 1.01 : 1.05), panel)).mul(vec3(tint.r, tint.g, tint.b));
  col = col.mul(float(1).sub(seam.mul(0.45 * sk))).mul(float(1).sub(tie.mul(0.6 * sk))).mul(float(1).sub(tr.mul(0.6))).mul(float(1).sub(grime));
  m.colorNode = col;
  const arm = texture(t.arm, cuv);
  m.roughnessNode = mix(arm.g.mul(0.85).add(0.1), float(0.45), tr);
  m.metalnessNode = float(0);
  m.aoNode = arm.r.mul(float(1).sub(seam.mul(0.5)));
  // grazing foot washes turn the full-strength normal map into horizontal streaks on the light concrete
  const ns = opts.albedo !== undefined ? 0.2 : 0.9;
  m.normalNode = normalMap(texture(t.nor, cuv), vec2(ns, ns));
  return m;
}

export function makePrairieMaterial(t: TextureSet, lm: LightMap | null = null): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const wuv = positionWorld.xz.div(9.0);
  const macro = mx_noise_float(positionWorld.xz.mul(0.01)).mul(0.5).add(0.5);
  const grass = mx_noise_float(positionWorld.xz.mul(0.25)).mul(0.5).add(0.5);
  const tint = mix(vec3(0.55, 0.47, 0.34), vec3(0.42, 0.40, 0.27), grass);
  const pc = texture(t.diff, wuv).rgb.mul(tint).mul(mix(float(0.55), float(1.0), macro));
  m.colorNode = pc;
  if (lm) m.emissiveNode = floodRadiance(lm, pc as Node<'vec3'>);
  m.roughnessNode = float(0.95);
  m.metalnessNode = float(0);
  m.normalNode = normalMap(texture(t.nor, wuv), vec2(1.2, 1.2));
  return m;
}

/**
 * Compacted earth beside the 0-60 lane (stream 1267 s: dry brown dirt with pebbles and tyre ruts):
 * the prairie set at 2 m tiling, de-greened to brown, linear albedo ≈ 0.05-0.1.
 */
export function makeDirtMaterial(t: TextureSet, innerX: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const wuv = positionWorld.xz.div(2.0);
  const tex = texture(t.diff, wuv).rgb;
  const l = tex.dot(vec3(0.2126, 0.7152, 0.0722));
  const macro = mx_noise_float(positionWorld.xz.mul(0.15)).mul(0.5).add(0.5);
  const pebble = smoothstep(float(0.72), float(0.8), mx_noise_float(positionWorld.xz.mul(9)).mul(0.5).add(0.5));
  const brown = vec3(0.13, 0.078, 0.042).mul(l.div(0.2).clamp(0.45, 1.6)).mul(mix(float(0.75), float(1.1), macro));
  m.colorNode = mix(brown, vec3(0.16, 0.15, 0.135), pebble.mul(0.6));
  // crumbly inner edge along the lane (|x| = innerX): coarse and fine noise, cut with alphaTest
  const edge = positionWorld.x.abs().sub(innerX)
    .add(mx_noise_float(positionWorld.xz.mul(vec2(0.2, 0.9))).mul(0.22))
    .add(mx_noise_float(positionWorld.xz.mul(6)).mul(0.07));
  m.opacityNode = smoothstep(float(-0.05), float(0.05), edge);
  m.alphaTest = 0.5;
  m.roughnessNode = float(0.97);
  m.metalnessNode = float(0);
  m.normalNode = normalMap(texture(t.nor, wuv), vec2(1.4, 1.4));
  return m;
}

export function makeSteelMaterial(color = 0x2a2d33, roughness = 0.55): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness, metalness: 0.85 });
  return m;
}

/** Emissive LED material. `intensity` > 1 drives bloom. */
export function makeLedMaterial(color: THREE.ColorRepresentation, intensity: number): THREE.MeshBasicNodeMaterial {
  const c = new THREE.Color(color).multiplyScalar(intensity);
  const m = new THREE.MeshBasicNodeMaterial({ color: c });
  m.fog = true;
  return m;
}
