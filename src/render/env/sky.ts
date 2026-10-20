// Night sky: procedural stars + Milky Way band + horizon light pollution (sharper than any HDRI),
// HDRI only for image-based lighting. Height fog for the ground haze.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import type { UFloat } from '../tslTypes';
import {
  Fn, vec3, float, normalWorld, positionWorldDirection, floor, fract, dot, sin, smoothstep, pow, max, mix, abs, exp,
  mx_noise_float, clamp, positionWorld, cameraPosition, length, fog, vec2,
} from 'three/tsl';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { SCENE_TIME } from '../world/materials';

const hash3 = (p: Node<'vec3'>) => fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453));

/** Background node: direction-based procedural sky. */
export function makeSkyNode(starDensity = 1) {
  return Fn(() => {
    const d = positionWorldDirection.normalize();
    const h = d.y;
    // base gradient: almost black zenith, faint blue-grey horizon, warm light-pollution glow toward the Raptor site
    const zen = vec3(0.0004, 0.0005, 0.0009);
    const hor = vec3(0.0045, 0.005, 0.0075);
    const base = mix(hor, zen, pow(clamp(h, 0, 1), float(0.45)));
    const raptorDir = vec3(-0.537, 0, 0.844);
    const glowDir = pow(max(dot(vec3(d.x, 0, d.z).normalize(), raptorDir), float(0)), float(6));
    const glow = vec3(0.05, 0.032, 0.018).mul(glowDir).mul(exp(h.max(0).mul(-14)));
    const town = vec3(0.006, 0.0045, 0.003).mul(exp(abs(h).mul(-40)));
    // stars: cells on a direction grid, one candidate star per cell
    const starsAt = (scale: number, thresh: number, gain: number) => {
      const p = d.mul(scale);
      const cell = floor(p);
      const r = hash3(cell);
      const off = vec3(hash3(cell.add(1.3)), hash3(cell.add(7.1)), hash3(cell.add(3.7))).sub(0.5).mul(0.7);
      const dist = length(fract(p).sub(0.5).sub(off));
      const on = smoothstep(float(thresh), float(1), r);
      const tw = sin(SCENE_TIME.mul(r.mul(3).add(1)).add(r.mul(40))).mul(0.25).add(0.75);
      const tint = mix(vec3(1.0, 0.86, 0.7), vec3(0.75, 0.85, 1.0), hash3(cell.add(11.1)));
      return tint.mul(on.mul(smoothstep(float(0.09), float(0.0), dist)).mul(gain).mul(tw));
    };
    // the broadcast camera barely resolves stars: only the brightest few remain
    const s = starsAt(260, 0.993 - 0.004 * starDensity, 1.6).add(starsAt(600, 0.985, 0.25));
    // milky way band (tilted great circle) with dust lanes
    const band = vec3(0.35, 0.82, 0.45).normalize();
    const bd = abs(dot(d, band));
    const mw = exp(bd.mul(bd).mul(-40));
    const dust = mx_noise_float(d.mul(9)).mul(0.5).add(0.5);
    const mwc = vec3(0.022, 0.022, 0.026).mul(mw).mul(smoothstep(float(0.25), float(0.75), dust).mul(0.8).add(0.2));
    const dense = starsAt(900, 0.86, 0.6).mul(mw);
    const aboveHorizon = smoothstep(float(-0.01), float(0.04), h);
    const sky = base.add(glow.mul(0.2)).add(town.mul(0.2)).add(s.add(mwc.mul(0.15)).add(dense.mul(0.1)).mul(aboveHorizon));
    // below the horizon: dark prairie silhouette colour (the ground plane covers most of it)
    return mix(vec3(0.004, 0.004, 0.005), sky, smoothstep(float(-0.02), float(0.0), h));
  })();
}

/** Distance haze + exponential ground fog (analytic integral along the view ray). */
export function makeFogNode(density: UFloat, groundDensity: UFloat, color: THREE.Color) {
  const H = float(2.5); // ground fog scale height (m)
  const camY = cameraPosition.y;
  const py = positionWorld.y;
  const dist = length(positionWorld.sub(cameraPosition));
  const dy = py.sub(camY);
  // ∫ ρ0·exp(-y/H) ds along the ray = ρ0·H·dist·(e^{-y0/H} − e^{-y1/H}) / dy   (limit dy→0: ρ0·dist·e^{-y/H})
  const e0 = exp(camY.max(0).div(H).negate()), e1 = exp(py.max(0).div(H).negate());
  const ground = abs(dy).greaterThan(0.05).select(H.mul(dist).mul(e0.sub(e1)).div(dy), dist.mul(e0));
  const optical = dist.mul(density).add(ground.mul(groundDensity));
  const factor = float(1).sub(exp(optical.negate()));
  return fog(vec3(color.r, color.g, color.b), clamp(factor, 0, 0.97));
}

export async function loadHdr(url: string): Promise<THREE.DataTexture | null> {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok || (head.headers.get('content-type') ?? '').includes('text/html')) return null;
    const tex = await new HDRLoader().loadAsync(url);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    return tex;
  } catch (e) {
    console.warn('[render] HDRI fehlt, nur prozeduraler Himmel:', e);
    return null;
  }
}

export { normalWorld, vec2 };
