// Shared lighting for the participating media (jet plumes, condensation, ground clouds): the three
// spotlights that light the car's surroundings best, an ambient term and a red LED term that
// depends on the distance to the LED bars. Condensation droplets scatter strongly forward, so a
// plume between the camera and a flood glows (Henyey-Greenstein phase with g ≈ 0.6).
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  uniform, uniformArray, float, vec3, vec4, smoothstep, exp, normalize, dot, pow, max, abs, clamp, cameraPosition,
  Loop, int,
} from 'three/tsl';

export const FX_LIGHTS = 3;
const MAX_LED = 8;
/** Gaussian density blobs that approximate the ground clouds as a whole (see CloudField). */
export const CLOUD_BLOBS = 6;

/** Light uniforms; GameRenderer.updateLights() fills them every frame. */
export const fxLight = {
  /** xyz = position, w = intensity [scene cd]. */
  pos: uniformArray(Array.from({ length: FX_LIGHTS }, () => new THREE.Vector4(0, 30, 0, 0)), 'vec4'),
  /** xyz = unit direction, w = cos(outer half angle). */
  dir: uniformArray(Array.from({ length: FX_LIGHTS }, () => new THREE.Vector4(0, -1, 0, 0.9)), 'vec4'),
  /** cos(inner half angle) per light (penumbra). */
  inner: uniformArray(Array.from({ length: FX_LIGHTS }, () => new THREE.Vector4(0.95, 0, 0, 0)), 'vec4'),
  colour: uniform(new THREE.Color(0.9, 0.94, 1.0)),
  ambient: uniform(new THREE.Color(0.008, 0.009, 0.012)),
  /** Converts illuminance into scattered radiance (overall medium brightness). */
  scatter: uniform(0.22),
  /** LED bars: (x, z0, z1, gain) – all bars run along world Z. */
  leds: uniformArray(Array.from({ length: MAX_LED }, () => new THREE.Vector4(0, 0, 0, 0)), 'vec4'),
  ledColour: uniform(new THREE.Color(1.0, 0.03, 0.015)),
  /** Sun-like directional key for the worlds (w = illuminance); 0 on the McGregor pad. */
  sunDir: uniform(new THREE.Vector4(0, 1, 0, 0)),
  /**
   * Diffuse flood fill for the dense blast cloud: the pad is lit by far more
   * floods than the three modelled spots, and a dense cloud gathers their light from above. It is
   * shadowed by the cloud field (bright crowns, dark bellies) and does not apply to the thin haze.
   */
  cloudFill: uniform(new THREE.Color(0.36, 0.37, 0.41)),
  /** Cloud density field: xyz = centre, w = horizontal sigma [m]. */
  cloudA: uniformArray(Array.from({ length: CLOUD_BLOBS }, () => new THREE.Vector4(0, -100, 0, 1)), 'vec4'),
  /** x = vertical sigma [m], y = optical depth of a full horizontal chord through the centre. */
  cloudB: uniformArray(Array.from({ length: CLOUD_BLOBS }, () => new THREE.Vector4(1, 0, 0, 0)), 'vec4'),
};

/**
 * Optical depth from `p` towards +infinity along the unit direction `l` through the cloud field:
 * sum over the Gaussian ellipsoids of the closed-form line integral
 *   tau = m / a · e^(-d²/2) · sqrt(pi/2) · (1 + erf(t0 / sqrt 2))
 * in the blob's normalised space (u = (x - c) / sigma, a = |l / sigma|, t0 = -u0·n, d² = |u0|² - t0²),
 * with m chosen so a full horizontal chord through the centre has depth D. erf ≈ tanh(1.128x + 0.1x³).
 * Evaluated per vertex (sprites), a few dozen ALU ops per blob.
 */
export function cloudDepth(p: Node<'vec3'>, l: Node<'vec3'>): Node<'float'> {
  let tau = float(0) as unknown as Node<'float'>;
  for (let i = 0; i < CLOUD_BLOBS; i++) {
    const A = el(fxLight.cloudA, i), B = el(fxLight.cloudB, i);
    const inv = vec3(float(1).div(A.w), float(1).div(B.x), float(1).div(A.w));
    const u0 = p.sub(A.xyz).mul(inv);
    const lp = l.mul(inv);
    const a = max(lp.length(), float(1e-4));
    const n = lp.div(a);
    const t0 = dot(u0, n).negate();
    const d2 = max(dot(u0, u0).sub(t0.mul(t0)), float(0));
    const x = t0.mul(0.70710678);
    const y = x.mul(1.1283792).add(x.mul(x).mul(x).mul(0.1009)).clamp(-9, 9);
    const onePlusErf = float(2).div(float(1).add(exp(y.mul(-2))));
    const m = B.y.div(A.w.mul(2.5066283));
    tau = tau.add(m.div(a).mul(exp(d2.mul(-0.5))).mul(1.2533141).mul(onePlusErf)) as unknown as Node<'float'>;
  }
  return tau;
}

/** CPU side of the cloud field: blobs fed by the ground-blast emission, decaying with the puffs. */
export class CloudField {
  private b = Array.from({ length: CLOUD_BLOBS }, () => ({ x: 0, y: 0, z: 0, m: 0, age: 0 }));
  /** Particles of the blast cloud (weight 1 per puff) emitted at a ground hit. */
  add(x: number, gy: number, z: number, n: number): void {
    if (n <= 0) return;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < CLOUD_BLOBS; i++) {
      const o = this.b[i]; if (o.m < 0.5) continue;
      const d = Math.hypot(o.x - x, o.z - z);
      if (d < Math.max(4, 1.1 * this.sigma(o.age)) && d < bestD) { best = i; bestD = d; }
    }
    if (best < 0) {
      // new blob in the emptiest slot
      best = 0; for (let i = 1; i < CLOUD_BLOBS; i++) if (this.b[i].m < this.b[best].m) best = i;
      Object.assign(this.b[best], { x, y: gy, z, m: 0, age: 0 });
    }
    const o = this.b[best], w = n / (o.m + n);
    o.x += (x - o.x) * w; o.z += (z - o.z) * w; o.y += (gy - o.y) * w;
    o.age *= 1 - w;
    o.m += n;
  }
  private sigma(age: number): number { return 2.2 + 3.6 * (1 - Math.exp(-age / 0.9)); }
  /** Advance the blobs and upload them (call once per effect step). */
  update(dt: number): void {
    const A = fxLight.cloudA.array as THREE.Vector4[], B = fxLight.cloudB.array as THREE.Vector4[];
    for (let i = 0; i < CLOUD_BLOBS; i++) {
      const o = this.b[i];
      o.age += dt;
      o.m *= Math.exp(-dt / 3.2);           // puffs live 2.5-5.5 s
      if (o.m < 0.5) { o.m = 0; B[i].set(1, 0, 0, 0); A[i].set(0, -100, 0, 1); continue; }
      const sy = 1.1 + 1.6 * (1 - Math.exp(-o.age / 1.4));
      // optical depth saturates with the number of live puffs (~60 puffs: a dense, opaque billow)
      const D = 9 * (1 - Math.exp(-o.m / 45));
      A[i].set(o.x, o.y + 0.5 + 0.8 * sy, o.z, this.sigma(o.age));
      B[i].set(sy, D, 0, 0);
    }
  }
  clear(): void { for (const o of this.b) o.m = 0; this.update(0); }
}

/** Register the LED bars (world X, Z range) whose red light tints nearby smoke. */
export function setLedBars(bars: { x: number; z0: number; z1: number; gain?: number }[]): void {
  const arr = fxLight.leds.array as THREE.Vector4[];
  for (let i = 0; i < MAX_LED; i++) {
    const b = bars[i];
    arr[i].set(b ? b.x : 0, b ? b.z0 : 0, b ? b.z1 : 0, b ? (b.gain ?? 1) : 0);
  }
}

const el = (a: typeof fxLight.pos, i: number) => a.element(int(i)) as unknown as Node<'vec4'>;

/** Henyey-Greenstein phase function (normalised to 1 for isotropic). */
function hg(cosT: Node<'float'>, g: number): Node<'float'> {
  const g2 = g * g;
  return float(1 - g2).div(pow(max(float(1 + g2).sub(cosT.mul(2 * g)), float(1e-3)), float(1.5)));
}

/**
 * In-scattered radiance (linear RGB) at world position `p` for a medium of unit albedo, plus the
 * view-space-independent dominant light direction (for pseudo-normal shading of sprites).
 * `forward` 0..1 blends the isotropic and the forward-scattering phase.
 */
export function mediumLight(p: Node<'vec3'>, forward = 0.65): { radiance: Node<'vec3'>; keyDir: Node<'vec3'>; red: Node<'vec3'> } {
  const view = normalize(cameraPosition.sub(p));
  let total = vec3(0, 0, 0) as unknown as Node<'vec3'>;
  let keyDir = vec3(0, 0, 0) as unknown as Node<'vec3'>;
  for (let i = 0; i < FX_LIGHTS; i++) {
    const lp = el(fxLight.pos, i);
    const ld = el(fxLight.dir, i);
    const toP = p.sub(lp.xyz);
    const d2 = max(dot(toP, toP), float(1));
    const l = normalize(toP);
    const cone = smoothstep(ld.w, el(fxLight.inner, i).x, dot(l, ld.xyz));
    const e = lp.w.mul(cone).div(d2);
    const phase = hg(dot(l, view), 0.6).mul(forward).add(1 - forward);
    total = total.add(vec3(e.mul(phase))) as unknown as Node<'vec3'>;
    keyDir = keyDir.add(l.negate().mul(e)) as unknown as Node<'vec3'>;
  }
  const sun = fxLight.sunDir;
  const sunPhase = hg(dot(sun.xyz.negate(), view), 0.6).mul(forward).add(1 - forward);
  total = total.add(vec3(sun.w.mul(sunPhase))) as unknown as Node<'vec3'>;
  keyDir = keyDir.add(sun.xyz.mul(sun.w)) as unknown as Node<'vec3'>;
  // red LED bars: ~1/(1+d²) falloff around each bar, strongest close to the ground
  let red = float(0) as unknown as Node<'float'>;
  for (let i = 0; i < MAX_LED; i++) {
    const b = el(fxLight.leds, i);
    const zc = clamp(p.z, b.y, b.z);
    const dx = p.x.sub(b.x), dz = p.z.sub(zc), dy = max(p.y.sub(0.1), float(0));
    const d2 = dx.mul(dx).add(dz.mul(dz)).add(dy.mul(dy));
    red = red.add(b.w.div(d2.add(1.5))) as unknown as Node<'float'>;
  }
  void Loop; void vec4; void abs; void exp;
  return {
    radiance: (fxLight.colour as unknown as Node<'vec3'>).mul(total.mul(fxLight.scatter)).add(fxLight.ambient as unknown as Node<'vec3'>),
    keyDir: normalize(keyDir.add(vec3(0, 1e-4, 0))),
    red: (fxLight.ledColour as unknown as Node<'vec3'>).mul(red),
  };
}
