// Heat effects for the player's Roadster in the Sun scene, driven by the game logic through heat01 or
// surfaceTempK: black-body glow overlay on every mesh (front facing the sun heats first), heat shimmer
// (screen-space refraction billboard), molten sparks streaming off the hot side, a plasma envelope at
// extreme heat and a coloured point light. Works as an overlay – the car materials stay untouched.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  vec2, vec3, vec4, float, uniform, texture, positionLocal, normalLocal, normalWorld, positionWorld, cameraPosition,
  mx_noise_float, time, clamp, smoothstep, dot, normalize, max, pow, abs, mix, instanceIndex, hash, fract, uv,
  viewportSharedTexture, screenUV, length, sin, cos,
} from 'three/tsl';
import { blackbodyRGB } from './colorScience';
import { glowRadiance, heatToTempK, tempToHeat } from './sunLayout';
import type { UFloat, UVec3 } from './types';

type N3 = Node<'vec3'>;

const LUT_T0 = 500, LUT_T1 = 6500, LUT_N = 256;

/** Black-body glow LUT (RGB × display radiance), half float, T from 500 to 6500 K along u. */
export function blackbodyLut(): THREE.DataTexture {
  const d = new Uint16Array(LUT_N * 4);
  for (let i = 0; i < LUT_N; i++) {
    const T = LUT_T0 + (i / (LUT_N - 1)) * (LUT_T1 - LUT_T0);
    const c = blackbodyRGB(T), L = glowRadiance(T);
    d[i * 4] = THREE.DataUtils.toHalfFloat(Math.min(60000, c[0] * L));
    d[i * 4 + 1] = THREE.DataUtils.toHalfFloat(Math.min(60000, c[1] * L));
    d[i * 4 + 2] = THREE.DataUtils.toHalfFloat(Math.min(60000, c[2] * L));
    d[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const t = new THREE.DataTexture(d, LUT_N, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

export class HeatEffects {
  readonly group = new THREE.Group();
  readonly heat: UFloat = uniform(0);
  readonly tempK: UFloat = uniform(300);
  /** Direction from the car TO the sun (world). */
  readonly toSun: UVec3 = uniform(new THREE.Vector3(0, 0, 1));
  readonly carPos: UVec3 = uniform(new THREE.Vector3());
  readonly carVel: UVec3 = uniform(new THREE.Vector3());
  private lut = blackbodyLut();
  private glowMat: THREE.MeshBasicNodeMaterial;
  private plasmaMat: THREE.MeshBasicNodeMaterial;
  private overlays: THREE.Mesh[] = [];
  /** Attached car (null = none). */
  target: THREE.Object3D | null = null;
  private shimmer: THREE.Mesh;
  private sparks: THREE.Sprite;
  private light = new THREE.PointLight(0xff6020, 0, 30, 2);
  private lastPos = new THREE.Vector3();
  private radius = 2.5;
  /** Shimmer needs the framebuffer copy (viewportSharedTexture); off on the WebGL2 fallback if it fails. */
  shimmerEnabled = true;

  constructor(sparkCount = 1800) {
    this.group.name = 'HeatEffects';
    const lutAt = (T: Node<'float'>) => texture(this.lut, vec2(clamp(T.sub(LUT_T0).div(LUT_T1 - LUT_T0), 0, 1), 0.5)).rgb;

    // --- glow overlay: additive black-body emission on the body surface
    const g = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide });
    g.name = 'HeatGlow';
    g.polygonOffset = true; g.polygonOffsetFactor = -2; g.polygonOffsetUnits = -2;
    g.positionNode = positionLocal.add(normalLocal.mul(0.002));
    const facing = dot(normalize(normalWorld), this.toSun).mul(0.5).add(0.5);
    const n1 = mx_noise_float(positionWorld.mul(3.1).add(vec3(0, time.mul(0.35), 0))).mul(0.5).add(0.5);
    const n2 = mx_noise_float(positionWorld.mul(11).sub(vec3(time.mul(0.8), 0, 0))).mul(0.5).add(0.5);
    // the sun-facing side runs up to 25 % hotter, edges/thin parts (noise) flicker
    const Tloc = this.tempK.mul(facing.mul(0.35).add(0.75)).mul(n1.mul(0.12).add(n2.mul(0.06)).add(0.91));
    g.colorNode = lutAt(Tloc);
    g.opacityNode = float(1);
    this.glowMat = g;

    // --- plasma envelope (heat > 0.6): fresnel shell, flickering, white-violet
    const p = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide });
    p.name = 'HeatPlasma';
    p.positionNode = positionLocal.add(normalLocal.mul(0.06).mul(mx_noise_float(positionLocal.mul(4).add(time.mul(2))).mul(0.5).add(1)));
    const V = normalize(cameraPosition.sub(positionWorld));
    const fres = pow(float(1).sub(abs(dot(normalize(normalWorld), V))), float(2.5));
    const env = smoothstep(float(0.6), float(1.0), this.heat);
    const flick = mx_noise_float(positionWorld.mul(2.3).add(vec3(time.mul(3), time.mul(1.7), 0))).mul(0.5).add(0.5);
    p.colorNode = mix(vec3(1.0, 0.75, 0.45), vec3(0.75, 0.7, 1.0), flick).mul(fres.mul(flick.add(0.3))).mul(env).mul(lutAt(this.tempK).mul(0.25).add(2));
    this.plasmaMat = p;

    // --- heat shimmer: camera-facing quad refracting the framebuffer
    const sm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    sm.name = 'HeatShimmer';
    const q = uv().sub(0.5).mul(2);
    const r = length(q);
    const mask = smoothstep(float(1), float(0.35), r).mul(smoothstep(float(0.15), float(0.6), this.heat));
    const wob = vec2(
      mx_noise_float(vec3(q.mul(5), time.mul(2.2))),
      mx_noise_float(vec3(q.mul(5).add(7.3), time.mul(2.6))),
    ).mul(0.006).mul(mask);
    sm.colorNode = viewportSharedTexture(screenUV.add(wob)).rgb;
    sm.opacityNode = mask.min(1);
    this.shimmer = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sm);
    this.shimmer.name = 'HeatShimmer';
    this.shimmer.renderOrder = 10;
    this.shimmer.frustumCulled = false;

    // --- sparks: stateless GPU particles (age from time + per-instance seed)
    const spm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    spm.name = 'HeatSparks';
    const id = instanceIndex.toFloat();
    const seed = hash(id);
    const life = seed.mul(0.9).add(0.5);
    const age = fract(time.div(life).add(hash(id.add(17.1)))).mul(life);
    const k = age.div(life);
    const active = smoothstep(seed.mul(0.6).add(0.3), seed.mul(0.6).add(0.4), this.heat);
    // emission point on an ellipsoid around the car, biased to the sun-facing side
    const a = hash(id.add(3.3)).mul(6.2832), b = hash(id.add(5.7)).mul(2).sub(1);
    const sph = vec3(cos(a).mul(b.mul(b).oneMinus().sqrt()), b, sin(a).mul(b.mul(b).oneMinus().sqrt()));
    const toward = normalize(sph.add(this.toSun.mul(1.2)));
    const local = toward.mul(vec3(1.0, 0.55, 2.3));
    const velDir = normalize(this.toSun.negate().mul(1.5).add(sph.mul(0.8)));
    const speed = hash(id.add(9.1)).mul(4).add(1.5).mul(this.heat.add(0.4));
    const pos = this.carPos.add(local).sub(this.carVel.mul(age)).add(velDir.mul(speed).mul(age));
    spm.positionNode = pos;
    const T = this.tempK.mul(float(1).sub(k.mul(0.45))).mul(seed.mul(0.2).add(0.9));
    spm.colorNode = lutAt(T).mul(1.5);
    spm.opacityNode = active.mul(float(1).sub(k)).mul(smoothstep(float(0.0), float(0.04), age));
    spm.scaleNode = hash(id.add(1.7)).mul(0.035).add(0.012).mul(float(1).sub(k.mul(0.6)));
    this.sparks = new THREE.Sprite(spm);
    (this.sparks as unknown as { count: number }).count = sparkCount;
    this.sparks.frustumCulled = false;
    this.sparks.name = 'HeatSparks';

    this.light.name = 'HeatGlowLight';
    this.group.add(this.shimmer, this.sparks, this.light);
    void vec4; void max; void sin;
  }

  /** Attach to the car object (overlay meshes follow its hierarchy). */
  attach(obj: THREE.Object3D): void {
    if (this.target === obj) return;
    this.detach();
    this.target = obj;
    const box = new THREE.Box3().setFromObject(obj);
    this.radius = Math.max(1.5, box.getSize(new THREE.Vector3()).length() * 0.5);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh || m.name.startsWith('Heat')) return;
      const glow = new THREE.Mesh(m.geometry, this.glowMat);
      glow.name = 'HeatGlowOverlay';
      glow.renderOrder = 5;
      const plasma = new THREE.Mesh(m.geometry, this.plasmaMat);
      plasma.name = 'HeatPlasmaOverlay';
      plasma.renderOrder = 6;
      m.add(glow, plasma);
      this.overlays.push(glow, plasma);
    });
    this.lastPos.setFromMatrixPosition(obj.matrixWorld);
  }

  detach(): void {
    for (const o of this.overlays) o.removeFromParent();
    this.overlays = [];
    this.target = null;
  }

  /** Set the heat state: heat01 (0..1) or surfaceTempK. */
  set(p: { heat01?: number; surfaceTempK?: number }): void {
    const T = p.surfaceTempK ?? heatToTempK(p.heat01 ?? 0);
    this.tempK.value = T;
    this.heat.value = p.surfaceTempK !== undefined ? tempToHeat(T) : Math.min(1, Math.max(0, p.heat01 ?? 0));
  }

  /** Per frame: car position/velocity, sun direction, shimmer billboard, glow light. */
  update(dt: number, camera: THREE.Camera, sunCenter: THREE.Vector3): void {
    const h = this.heat.value;
    const on = h > 0.01 && !!this.target;
    for (const o of this.overlays) o.visible = on && (o.name === 'HeatGlowOverlay' ? this.tempK.value > 650 : h > 0.6);
    this.sparks.visible = on && h > 0.3;
    this.shimmer.visible = on && h > 0.15 && this.shimmerEnabled;
    if (!this.target) { this.light.intensity = 0; return; }
    const pos = new THREE.Vector3().setFromMatrixPosition(this.target.matrixWorld);
    if (dt > 0) this.carVel.value.copy(pos).sub(this.lastPos).divideScalar(dt);
    this.lastPos.copy(pos);
    this.carPos.value.copy(pos);
    this.toSun.value.copy(sunCenter).sub(pos).normalize();
    // shimmer quad: in front of the car toward the camera, sized to cover it
    const toCam = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).sub(pos);
    const dist = toCam.length();
    this.shimmer.position.copy(pos).addScaledVector(toCam.normalize(), Math.min(this.radius * 1.2, dist * 0.5));
    this.shimmer.quaternion.copy(camera.quaternion);
    this.shimmer.scale.setScalar(this.radius * 3.2);
    // glow light
    const c = blackbodyRGB(this.tempK.value);
    this.light.color.setRGB(c[0], c[1], c[2]);
    this.light.intensity = this.tempK.value > 650 ? glowRadiance(this.tempK.value) * 12 : 0;
    this.light.position.copy(pos);
  }

  dispose(): void {
    this.detach();
    this.group.removeFromParent();
    this.glowMat.dispose(); this.plasmaMat.dispose();
    (this.shimmer.material as THREE.Material).dispose(); this.shimmer.geometry.dispose();
    (this.sparks.material as THREE.Material).dispose();
    this.lut.dispose();
    this.light.dispose();
  }
}

export type { N3 };
