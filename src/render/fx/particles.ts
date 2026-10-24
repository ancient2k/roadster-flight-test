// Stateless GPU particles: the CPU only writes spawn data into a ring buffer (instanced
// attributes, partial uploads); the vertex stage integrates motion analytically. Works on the
// WebGPU and the WebGL2 backend without compute shaders.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  uniform, instancedBufferAttribute, float, vec3, vec2, exp, max, clamp, smoothstep, mix, texture, uv, pow,
  sin, cos, select, mx_noise_vec3, rotate, positionWorld, length, cameraPosition, varying, normalize, vec4, dot,
  cameraViewMatrix, viewportDepthTexture, perspectiveDepthToViewZ, cameraNear, cameraFar, positionView,
  cameraProjectionMatrix, screenSize, acos, fract, Fn, If,
} from 'three/tsl';
import { mediumLight, cloudDepth, fxLight } from './fxLight';

// (Grain = ballistic soil grains – no swirl, no wind, no ground clamp: pure parabolas on the Moon)
// (Spray = water thrown up by the car and the jets: shaded like condensation – white, lit by the scene – and falling
// back under gravity through a negative buoyancy)
export const enum PKind { Condensation = 0, TireSmoke = 1, Dust = 2, Steam = 3, Blast = 4, Haze = 5, Grain = 6, Spray = 7 }

export interface EmitOpts {
  kind: PKind;
  pos: THREE.Vector3Like;
  vel: THREE.Vector3Like;
  life: number;
  size0: number;
  size1: number;
  drag: number;          // 1/s
  buoyancy: number;      // m/s² (upward)
  opacity: number;
  /** seconds of flight already behind the particle at this frame (sub-frame spawn: continuous streams). */
  age0?: number;
}

/** sub-grains drawn per grain sprite (a packet of soil grains that disperses with its age). */
const GRAINS_PER_PACKET = 9;

function makePuffAtlas(): THREE.DataTexture {
  // 2x2 atlas of 128px soft fbm puffs (R = density). Generated once on the CPU.
  const S = 128, N = 2, W = S * N;
  const data = new Uint8Array(W * W * 4);
  const rnd = (x: number, y: number, s: number) => {
    const h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const vnoise = (x: number, y: number, s: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = rnd(xi, yi, s), b = rnd(xi + 1, yi, s), c = rnd(xi, yi + 1, s), d = rnd(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  for (let t = 0; t < N * N; t++) {
    const ox = (t % N) * S, oy = Math.floor(t / N) * S;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const px = (x + 0.5) / S * 2 - 1, py = (y + 0.5) / S * 2 - 1;
      let f = 0, amp = 0.5, fr = 3;
      for (let o = 0; o < 5; o++) { f += amp * vnoise(px * fr + 10, py * fr + 10, t * 17 + o); amp *= 0.5; fr *= 2.1; }
      // gaussian core with a noisy rim: overlapping puffs blend into one plume (no "dots")
      const r = Math.hypot(px, py) + (f - 0.5) * 0.35;
      let d = Math.exp(-r * r * 4.5) * (0.6 + 0.8 * f);
      d *= Math.max(0, 1 - Math.hypot(px, py) * 1.02) ** 0.5;
      const v = Math.max(0, Math.min(255, Math.round(d * 255)));
      const i = ((oy + y) * W + ox + x) * 4;
      data[i] = v; data[i + 1] = Math.round(f * 255); data[i + 2] = 0; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, W, W);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export class ParticleSystem {
  readonly sprite: THREE.Sprite;
  readonly uTime = uniform(0);
  /** base colour of soil dust and grains (grey regolith, ochre Mars, tan sand), set per world. */
  readonly dustTint = uniform(new THREE.Vector3(0.62, 0.52, 0.4));
  /** 1 = flat pad at y = 0 (McGregor: sprites are kept above it); 0 = terrain worlds (no clamp to y = 0). */
  readonly flatGround = uniform(1);
  /** sky fill on soil grains as a fraction of the sun (none on the Moon, the dusty Martian sky, Earth's blue sky). */
  readonly grainSky = uniform(0.02);
  /** smallest / largest grain diameter (m) of the size distribution. */
  readonly grainD = uniform(new THREE.Vector2(0.004, 0.03));
  /** extra diffuse daylight (sun + sky, multiple scattering) on puffs; 0 = only the modelled lights (launch cloud: > 0). */
  readonly fill = uniform(new THREE.Vector3(0, 0, 0));
  private A: THREE.InstancedBufferAttribute; // pos.xyz, t0
  private B: THREE.InstancedBufferAttribute; // vel.xyz, life
  private C: THREE.InstancedBufferAttribute; // size0, size1, drag, buoyancy
  private D: THREE.InstancedBufferAttribute; // seed, kind, opacity, -
  private head = 0;
  private dirtyFrom = -1;
  private dirtyTo = -1;
  private wrapped = false;
  private time = 0;
  readonly capacity: number;
  budget: number;

  constructor(capacity: number, softParticles = true) {
    this.capacity = capacity;
    this.budget = capacity;
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.A = mk(); this.B = mk(); this.C = mk(); this.D = mk();
    // start all particles dead
    for (let i = 0; i < capacity; i++) { this.A.array[i * 4 + 3] = -1e6; this.B.array[i * 4 + 3] = 0.001; }

    const a = instancedBufferAttribute<'vec4'>(this.A, 'vec4'), b = instancedBufferAttribute<'vec4'>(this.B, 'vec4');
    const c = instancedBufferAttribute<'vec4'>(this.C, 'vec4'), d = instancedBufferAttribute<'vec4'>(this.D, 'vec4');
    const age = this.uTime.sub(a.w);
    const life = b.w;
    const f = clamp(age.div(life), 0, 1);
    const alive = age.greaterThanEqual(0).and(age.lessThan(life));
    const drag = max(c.z, float(0.001));
    // (drag 0 = vacuum, e.g. lunar grains: plain ballistic travel; the closed form is used only where there is drag)
    const travel = select(c.z.lessThan(0.001), age, float(1).sub(exp(drag.mul(age).negate())).div(drag));
    const seed = d.x;
    const kind = d.y;
    // (the blast cloud is cold, dense vapour: it swirls sideways but must not wander metres upwards –
    // 4-5 s old puffs otherwise floated 5-7 m above the 0-60 gate)
    const swirl = mx_noise_vec3(vec3(seed.mul(13.1), age.mul(0.35), seed)).mul(age.mul(0.6).min(2.5))
      .mul(vec3(1, select(kind.equal(4), float(0.25), float(1)), 1));
    // (ballistic grains follow the parabola only – no turbulence, no wind, no ground clamp: their
    // life ends at the impact, see fxParams.ballisticGrain)
    const grain = kind.equal(6);
    const drift = select(grain, float(0), float(1));
    const p = a.xyz.add(b.xyz.mul(travel)).add(vec3(0, c.w.mul(age).mul(age).mul(0.5), 0)).add(swirl.mul(drift)).add(vec3(0.6, 0, 0.25).mul(age.mul(0.4)).mul(drift));
    // (a grain sprite is a packet of grains whose spread grows linearly with its age – the velocity
    // dispersion of the grains thrown together; puffs keep their fast early growth)
    // (grain/puff differences are blended with a 0/1 mask, not select(): TSL emits a node shared by
    // both select() branches only inside the branch that builds it first, the other one then reads it
    // uninitialised – the puffs vanished in the terrain worlds)
    const grainF = select(grain, float(1), float(0));
    const size = mix(mix(c.x, c.y, pow(f, float(0.55))), mix(c.x, c.y, f), grainF);
    const keepY = max(grainF, float(1).sub(this.flatGround));
    const pos = vec3(p.x, mix(max(p.y, size.mul(0.28)), p.y, keepY), p.z);
    // world size of one pixel at the particle (sub-grains are kept ≥ ~1.2 px wide, their opacity scaled
    // down by the area they were enlarged by – else TRAA and the resolve eat them)
    const camDist = length(pos.sub(cameraPosition));
    const pxWorld = camDist.mul(2).div(cameraProjectionMatrix.mul(vec4(0, 1, 0, 0)).y.mul(screenSize.y));
    const dMax = this.grainD.y;
    const rcMax = max(dMax.mul(0.5), pxWorld.mul(0.6));
    const grainScale = size.add(rcMax.add(pxWorld).mul(2));
    const scale = mix(size, grainScale, grainF);

    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    mat.positionNode = pos;
    mat.scaleNode = vec2(select(alive, scale, float(0)), select(alive, scale, float(0)));
    mat.rotationNode = seed.mul(6.283).add(age.mul(sin(seed.mul(91.7)).mul(0.35)));

    const atlas = makePuffAtlas();
    const tile = vec2(seed.mul(7.31).fract().greaterThan(0.5).select(float(0.5), float(0)), seed.mul(3.17).fract().greaterThan(0.5).select(float(0.5), float(0)));
    const tex = texture(atlas, uv().mul(0.5).add(tile));
    const dens = tex.r;
    const isSteam = kind.equal(3);
    const isDust = kind.equal(2);
    const base = select(isDust.or(grain), this.dustTint, select(kind.equal(1), vec3(0.82, 0.82, 0.84), vec3(0.93, 0.95, 1.0)));
    // --- lighting (per vertex; the sprite is small against the light falloff)
    // floods (with forward scattering), ambient and the red LED bars nearby
    const ml = mediumLight(pos as unknown as Node<'vec3'>, 0.6);
    // cloud-scale self-shadowing: optical depth through the blast-cloud density field towards the
    // key light (Beer-Lambert with a soft multiple-scattering lobe) and sideways towards the LED
    // bars on the ground. Puffs deep inside / on the far side of a billow go dark, the rims facing
    // the flood stay bright and the low outer rims pick up the red bars (stream t_964.5, 729.5).
    const pv = pos as unknown as Node<'vec3'>;
    const tauKey = cloudDepth(pv, ml.keyDir);
    const tauUp = cloudDepth(pv, vec3(0, 1, 0) as unknown as Node<'vec3'>);
    const tauSide = cloudDepth(pv, vec3(1, 0, 0) as unknown as Node<'vec3'>).min(cloudDepth(pv, vec3(-1, 0, 0) as unknown as Node<'vec3'>));
    const trans = (tau: Node<'float'>) => max(exp(tau.negate()), exp(tau.mul(-0.25)).mul(0.12));
    // (spray is not part of the blast cloud: its shadow made the droplets over the sea dark grey blots)
    const shadowed = kind.equal(3).not().and(kind.equal(7).not());
    const tKey = select(shadowed, trans(tauKey), float(1));
    const tAmb = select(shadowed, trans(tauUp.mul(0.6)), float(1));
    const tRed = select(shadowed, trans(tauSide.mul(0.8)), float(1));
    const amb = fxLight.ambient as unknown as Node<'vec3'>;
    const lightV = varying(ml.radiance.sub(amb).mul(tKey).add(amb.mul(tAmb)));
    const redV = varying(ml.red.mul(tRed));
    // (blast cloud only: tyre smoke is not fed into the cloud field, so it would get the full fill
    // even far from any flood)
    const fillV = varying((fxLight.cloudFill as unknown as Node<'vec3'>).mul(trans(tauUp)).mul(select(kind.equal(4), float(1), float(0))));
    const keyView = varying(normalize(cameraViewMatrix.mul(vec4(ml.keyDir, 0)).xyz));
    // pseudo normal of a puff (sphere-ish, bumped by the atlas noise) -> lit side towards the
    // dominant flood, self-shadowed far side; thick cores darker than the wispy rim
    const q = uv().sub(0.5).mul(2);
    const nrm = normalize(vec3(q.x.add(tex.g.sub(0.5).mul(0.6)), q.y.add(tex.g.sub(0.5).mul(0.6)), float(0.75)));
    const ndl = dot(nrm, keyView);
    // (kept gentle: a strong per-sprite gradient turns overlapping puffs into a pile of balls)
    // (the cloud field above carries the large-scale shadow; this only models the single puff)
    const selfShadow = mix(float(0.6), float(1.1), smoothstep(float(-0.7), float(0.9), ndl));
    const thick = mix(float(1.0), float(0.7), smoothstep(float(0.4), float(1.0), dens));
    const shade = selfShadow.mul(thick);
    const steamLight = vec3(1.0, 0.8, 0.6).mul(mix(float(0.9), float(0.12), uv().y)).add(vec3(0.05, 0.055, 0.07));
    // (per-sprite values the fragment stage needs, as one varying. Computed there from the shared
    // nodes, TSL emitted them inside the first select() branch that used them – the grain branch – and the
    // puff branch read them uninitialised: nearFade = 0, the blast cloud, Mars veil and Giza sand cloud
    // vanished while the grains still drew)
    const gV = varying(vec4(pxWorld, size, grainScale, camDist));
    const sizeF = gV.y, camDistF = gV.w;
    // soil grains are opaque bodies, not a scattering medium – a Lambert sphere lit by the sun with
    // the phase angle α between the sun and the camera seen from the grain: Φ(α) = (sin α + (π − α) cos α)/π,
    // disc-averaged radiance (2/3)·A·E/π·Φ (geometric albedo of a Lambert sphere). Bright with the sun
    // behind the camera, dark against the light – the forward-scattering phase of smoke made the lunar
    // rooster tail glow white in back light. A small opposition surge on top (regolith, Hapke).
    const sunV = fxLight.sunDir as unknown as Node<'vec4'>;
    const toCam = normalize(cameraPosition.sub(pos));
    // (fxLight.sunDir.xyz is the light's travel direction, away from the sun)
    const alpha = acos(clamp(dot(sunV.xyz.negate(), toCam), -1, 1));
    const phi = sin(alpha).add(float(Math.PI).sub(alpha).mul(cos(alpha))).div(Math.PI).max(0);
    const surge = float(1).add(exp(alpha.div(-0.08)).mul(0.35));
    // the fine fraction diffracts a little light forward: a faint rim glow when looking into the sun
    const diffr = exp(float(Math.PI).sub(alpha).div(-0.35)).mul(0.08);
    const grainLit = varying((fxLight.colour as unknown as Node<'vec3'>).mul(sunV.w.mul(phi.mul(surge).mul(2 / (3 * Math.PI)).add(diffr).add(this.grainSky)))
      .add(fxLight.ambient as unknown as Node<'vec3'>));
    const lit = mix(select(isSteam, steamLight, lightV.add(fillV).add(this.fill).mul(shade).add(redV.mul(mix(float(0.6), float(1.0), thick)).mul(select(kind.equal(4), float(2.4), float(1))))), grainLit, grainF);
    // the jet blast cloud is dense, freshly condensed vapour: it scatters noticeably more than the
    // thin stage haze or tyre smoke (stream: brilliant white billows next to dark asphalt)
    // (water spray: bright droplets in the sun, like the blast's fresh vapour)
    mat.colorNode = base.mul(lit).mul(select(kind.equal(4), float(2.6), select(kind.equal(7), float(2.0), float(1))));
    // (the life fraction goes to the fragment stage as an explicit varying – recomputed there from
    // the instanced attributes it came out ≈ 0 in the terrain worlds, so fadeIn hid every sprite: no
    // dust, veil or condensation was visible on the Moon/Mars/Giza)
    const fF = varying(f);
    const fadeIn = smoothstep(float(0), float(0.08), fF);
    // (a grain is there until it hits the ground – its life ends at the impact, no fading parabola)
    const fadeOut = mix(pow(float(1).sub(fF), float(1.3)), float(1), grainF);
    // fade sprites that come close to the camera (otherwise a chase camera inside a cloud sees a
    // full-screen grey wall)
    // (grains passing the chase camera would blow up into metre-wide blobs: fade them over 2–5 m;
    // real-size grains stay small, only the closest metre fades)
    const nearFade = mix(smoothstep(sizeF.mul(0.4), sizeF.mul(1.6).add(1.5), camDistF), smoothstep(float(0.3), float(1.0), camDistF), grainF);
    // soft particles: fade where the sprite plane cuts into the ground, the car or the obstacles;
    // the steam far away does not need it
    // (band ≈ ¼ of the puff size, 0.3–1.5 m – the old 0.15–0.4 m left a straight cut where a
    // 3–6 m blast puff of the 0–60 hold stood in the vertical gate facade: the grey rectangle over
    // the opening in an earlier review; it also softens the ground seam of the big puffs)
    let soft: Node<'float'> = float(1) as unknown as Node<'float'>;
    if (softParticles) {
      const sceneZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar);
      // (grains of a few cm need a band of their own size, else they vanish near the ground)
      soft = smoothstep(float(0), mix(sizeF.mul(0.25).clamp(0.3, 1.5), float(0.02), grainF), positionView.z.sub(sceneZ)) as unknown as Node<'float'>;
    }
    // feather the sprite rim so overlapping puffs merge into one body instead of reading as discs
    const rim = smoothstep(float(1.0), float(0.35), length(q));
    // billowing smoke (blast cloud, tyre smoke): the atlas noise erodes the puff into cauliflower
    // lobes with defined edges instead of a soft ball; the erosion eases off as the puff ages
    const billow = kind.equal(4).or(kind.equal(1));
    const erode = smoothstep(float(0.32), float(0.62), tex.g.mul(0.75).add(dens.mul(0.6)).sub(fF.mul(0.12)));
    // a grain sprite draws GRAINS_PER_PACKET hard discs (no puff texture: the fbm puff made "dots")
    // – positions spread over the packet, diameters from a power law (many fine, few coarse clods),
    // each at least ~1.2 px wide with its opacity scaled by the true/drawn area
    const pxV = gV.x, sizeV = gV.y, scaleV = gV.z;
    // (evaluated for grain sprites only – If inside a Fn; all inputs are fresh nodes or varying reads so
    // nothing shared gets emitted inside the branch, see grainF above)
    const gA = Fn(() => {
      const acc = float(0).toVar();
      If(grain, () => {
        const wq = uv().sub(0.5).mul(2).mul(scaleV.mul(0.5));
        let cov0: Node<'float'> = float(0) as unknown as Node<'float'>;
        for (let i = 0; i < GRAINS_PER_PACKET; i++) {
          const h1 = fract(sin(seed.mul(12.9898 + i * 7.13).add(i * 3.7)).mul(43758.5453));
          const h2 = fract(sin(seed.mul(78.233 + i * 5.31).add(i * 1.9)).mul(24634.6345));
          const h3 = fract(sin(seed.mul(39.425 + i * 2.77).add(i * 4.3)).mul(31415.9265));
          // disc sample inside the packet; the first grain sits at the centre (it carries the trajectory)
          const rr = i === 0 ? float(0) : h1.sqrt().mul(sizeV.mul(0.5));
          const ang = h2.mul(6.2832);
          const ctr = vec2(cos(ang), sin(ang)).mul(rr);
          // N(>d) ∝ d^-2: d = dMin / sqrt(1 − u), capped at dMax (a disc below a pixel stands for the few
          // unresolved grains around it: its area-scaled opacity counts two of them)
          const dI = this.grainD.x.div(float(1).sub(h3.mul(0.97)).sqrt()).min(dMax);
          const rI = dI.mul(0.5);
          const rC = max(rI, pxV.mul(0.6));
          const cov = smoothstep(rC.add(pxV.mul(0.5)), rC.sub(pxV.mul(0.5)), length(wq.sub(ctr))).mul(rI.div(rC).pow(2).mul(2).min(1));
          cov0 = cov0.max(cov) as unknown as Node<'float'>;
        }
        acc.assign(cov0);
      });
      return acc;
    })();
    const shaped = select(billow, dens.mul(erode.mul(1.5)).min(1), mix(dens, gA, grainF));
    mat.opacityNode = clamp(shaped.mul(mix(rim, float(1), grainF)).mul(d.z).mul(fadeIn).mul(fadeOut).mul(nearFade).mul(soft), 0, 1);
    void cos; void rotate; void positionWorld; void exp;

    this.sprite = new THREE.Sprite(mat);
    this.sprite.count = capacity;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 20;
    this.sprite.name = 'Particles';
  }

  setTime(t: number): void { this.time = t; this.uTime.value = t; }

  /** Kill every particle (e.g. after warm-up frames) and re-upload the whole buffer. */
  clear(): void {
    const A = this.A.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) A[i * 4 + 3] = -1e6;
    for (const attr of [this.A, this.B, this.C, this.D]) { attr.clearUpdateRanges(); attr.needsUpdate = true; }
    this.head = 0;
    this.dirtyFrom = this.dirtyTo = -1;
    this.wrapped = false;
    this.emittedWindow.length = 0;
    this.emitted = 0;
  }

  emit(o: EmitOpts): void {
    if (this.liveEstimate() >= this.budget) return;
    const i = this.head;
    const A = this.A.array as Float32Array, B = this.B.array as Float32Array, C = this.C.array as Float32Array, D = this.D.array as Float32Array;
    const k = i * 4;
    A[k] = o.pos.x; A[k + 1] = o.pos.y; A[k + 2] = o.pos.z; A[k + 3] = this.time - (o.age0 ?? 0);
    B[k] = o.vel.x; B[k + 1] = o.vel.y; B[k + 2] = o.vel.z; B[k + 3] = o.life;
    C[k] = o.size0; C[k + 1] = o.size1; C[k + 2] = o.drag; C[k + 3] = o.buoyancy;
    D[k] = Math.random(); D[k + 1] = o.kind; D[k + 2] = o.opacity; D[k + 3] = 0;
    if (this.dirtyFrom < 0) { this.dirtyFrom = i; this.dirtyTo = i; }
    else if (i < this.dirtyFrom) this.wrapped = true;
    this.dirtyTo = i;
    this.head = (this.head + 1) % this.capacity;
    this.emitted++;
  }

  private emitted = 0;
  private emittedWindow: number[] = [];

  private liveEstimate(): number { return this.emittedWindow.reduce((s, x) => s + x, 0) + this.emitted; }

  /** Upload the written range(s). Call once per frame after all emits. */
  flush(): void {
    // rolling estimate of particles alive (≈ emitted in the last ~4 s at 60 fps)
    this.emittedWindow.push(this.emitted);
    if (this.emittedWindow.length > 240) this.emittedWindow.shift();
    this.emitted = 0;
    if (this.dirtyFrom < 0) return;
    for (const attr of [this.A, this.B, this.C, this.D]) {
      attr.clearUpdateRanges();
      if (this.wrapped || this.dirtyTo < this.dirtyFrom) {
        attr.addUpdateRange(this.dirtyFrom * 4, (this.capacity - this.dirtyFrom) * 4);
        attr.addUpdateRange(0, (this.dirtyTo + 1) * 4);
      } else {
        attr.addUpdateRange(this.dirtyFrom * 4, (this.dirtyTo - this.dirtyFrom + 1) * 4);
      }
      attr.needsUpdate = true;
    }
    this.dirtyFrom = this.dirtyTo = -1;
    this.wrapped = false;
  }
}
