// TSL post-processing chain: scene MRT → GTAO (½ res) → SSR (½ res, wet asphalt) → TRAA →
// motion blur → bloom → (DoF in photo mode). Tone mapping (AgX) happens in renderOutput.
import * as THREE from 'three/webgpu';
import {
  pass, mrt, output, normalView, packNormalToRGB, unpackRGBToNormal, velocity, metalness, roughness, vec2, vec4,
  uniform, float, mix, screenUV, sample, renderOutput, hash, screenCoordinate, max, luminance, clamp, int, smoothstep,
  convertToTexture, Fn, Loop, vec3,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import type { QualitySettings } from './quality';
import type { UFloat } from './tslTypes';
import { CloudVolumeNode, cloudVolumeSupported } from './fx/volume/CloudVolumeNode';
import { cloudVolume } from './fx/volume/cloudVolume';

type AnyNode = ReturnType<typeof float>;

/**
 * MRT override for transparent effect materials (particles, jets, light cones): their normal /
 * material / velocity outputs are written with alpha 0 and blended, so the opaque surface below
 * keeps its G-buffer values (otherwise SSR/GTAO/TRAA see the sprite quads as mirrors).
 */
export function transparentMRT(withMask: boolean) {
  const m = mrt({ normal: vec4(0, 0, 0, 0), metalrough: vec4(0, 0, 0, 0), velocity: vec4(0, 0, 0, 0), ...(withMask ? { fxmask: vec4(1, 1, 1, output.a) } : {}) });
  for (const k of ['normal', 'metalrough', 'velocity', ...(withMask ? ['fxmask'] : [])]) m.setBlendMode(k, new THREE.BlendMode(THREE.NormalBlending));
  return m;
}

let frameSeedRef: UFloat | null = null;
/** Advance the film-grain seed (call once per frame). */
export function advanceGrain(): void { if (frameSeedRef) frameSeedRef.value = (frameSeedRef.value + 1) % 4096; }

export interface PostChain {
  /** True when the scene pass renders into an MRT G-buffer. */
  usesMRT: boolean;
  fxMask: boolean;
  pipeline: THREE.RenderPipeline;
  scenePass: ReturnType<typeof pass>;
  setResolutionScale(s: number): void;
  setPhotoMode(on: boolean): void;
  /** Camera cut: the next frame shows the new shot without temporal history or motion blur. */
  resetHistory(): void;
  /** Call once per frame before pipeline.render(). */
  beforeRender(): void;
  focusDistance: UFloat;
  bloomStrength: UFloat;
  motionAmount: UFloat;
  dispose(): void;
  /** Human-readable list of active effects. */
  effects: string[];
}

export function buildPost(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, q: QualitySettings, postEnabled = true): PostChain {
  const be = renderer.backend as unknown as { isWebGPUBackend?: boolean; device?: GPUDevice };
  const fxMask = !be.isWebGPUBackend || (be.device?.limits.maxColorAttachmentBytesPerSample ?? 32) >= 40;
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const effects: string[] = [];
  const needsMRT = postEnabled && (q.ao || q.ssr || q.traa || q.motionBlur);
  if (needsMRT) {
    const sceneMRT = mrt({
      output,
      normal: packNormalToRGB(normalView),
      metalrough: vec2(metalness, roughness),
      velocity,
      ...(fxMask ? { fxmask: vec4(0, 0, 0, 0) } : {}),   // coverage of transparent effects, see transparentMRT
    });
    // the per-attachment blend state comes from the PASS's MRT (three reads
    // renderContext.mrt.getBlendMode(texture.name)), not from the material's override – the blend
    // modes set in transparentMRT were ignored and every particle quad overwrote the G-buffer:
    // roughness 0 in the whole sprite rectangle made SSR mirror the gate's LED jamb on the matte
    // facade (the "flat, rectangular smoke" over the 0–60 gate), zero velocity and
    // garbage normals likewise. Opaque materials write these outputs with alpha 1 (vec2/vec3 → vec4
    // pads with 1), so alpha blending leaves them unchanged; the fx outputs (alpha 0) keep the
    // surface below, the coverage mask accumulates the sprite alpha.
    for (const k of ['normal', 'metalrough', 'velocity', ...(fxMask ? ['fxmask'] : [])]) sceneMRT.setBlendMode(k, new THREE.BlendMode(THREE.NormalBlending));
    scenePass.setMRT(sceneMRT);
    // keep the MRT under 32 bytes/sample (WebGPU default limit): 8-bit normals and material params
    scenePass.getTexture('normal').type = THREE.UnsignedByteType;
    scenePass.getTexture('metalrough').type = THREE.UnsignedByteType;
    if (fxMask) scenePass.getTexture('fxmask').type = THREE.UnsignedByteType;
  }
  const color = scenePass.getTextureNode('output');
  const depth = scenePass.getTextureNode('depth');
  let composite: AnyNode = color as unknown as AnyNode;

  // (the cloud march is set up first: SSR reflects the scene WITH the cloud, see below)
  let cloudNode: CloudVolumeNode | null = null;
  let cloudC: { rgb: AnyNode; a: AnyNode } | null = null;
  let cloudT: AnyNode = float(1) as unknown as AnyNode;
  if (postEnabled && q.traa && cloudVolumeSupported(renderer)) {
    cloudNode = new CloudVolumeNode(depth, camera, q.particleBudget >= 20000 ? 80 : q.particleBudget >= 12000 ? 64 : 40);
    cloudC = cloudNode.sampleSoft(screenUV) as unknown as { rgb: AnyNode; a: AnyNode };
    cloudT = cloudC.a;
  }

  let aoNode: ReturnType<typeof ao> | null = null;
  let ssrNode: ReturnType<typeof ssr> | null = null;
  if (postEnabled && needsMRT) {
    const normalTex = scenePass.getTextureNode('normal');
    const cover = fxMask ? scenePass.getTextureNode('fxmask').sample(screenUV).r : float(0);
    const normal = sample((uvNode) => unpackRGBToNormal(normalTex.sample(uvNode as never)));
    if (q.ao) {
      aoNode = ao(depth, normal, camera);
      aoNode.resolutionScale = q.aoResolution;
      aoNode.samples.value = q.aoSamples;
      aoNode.radius.value = 0.25;
      aoNode.distanceExponent.value = 1.5;
      aoNode.scale.value = 1.0;
      const aoVal = aoNode.getTextureNode().sample(screenUV).r;
      // keep very bright pixels (LEDs, lamps) unoccluded
      const keep = clamp(luminance(color.rgb).sub(2).mul(0.5), 0, 1);
      composite = vec4(color.rgb.mul(mix(mix(float(1), aoVal, 0.35), float(1), keep.max(cover))), color.a) as unknown as AnyNode;
      effects.push('GTAO');
    }
    if (q.ssr) {
      const mr = scenePass.getTextureNode('metalrough');
      // SSR weights a hit with the "metalness" input. Feed it the specular weight we want instead:
      // metals fully, glossy dielectrics (puddles, damp lanes, lacquer) by gloss. Rough asphalt gets
      // 0 and is discarded before any ray marching (most of the frame -> most of the cost).
      const rough = mr.sample(screenUV).g;
      const gloss = float(1).sub(smoothstep(float(0.1), float(0.5), rough));
      const weight = max(mr.sample(screenUV).r, gloss.mul(0.65));
      // with the cloud volume, SSR reflects the scene with the cloud composited in – the
      // volume is not in the scene colour, so a puddle in front of a landing cloud mirrored the car
      // hidden inside it (a "ghost car" under the cloud once the sprite quads stopped overwriting
      // the G-buffer)
      // (rendered at the SSR resolution – the reflection is traced at that resolution anyway)
      let ssrColor: unknown = color;
      if (cloudC) {
        const rt = convertToTexture(vec4((color as unknown as { rgb: AnyNode }).rgb.mul(cloudC.a).add(cloudC.rgb) as never, 1) as never);
        (rt as unknown as { setResolutionScale(s: number): void }).setResolutionScale(q.ssrResolution);
        ssrColor = rt;
      }
      ssrNode = ssr(ssrColor as never, depth, normal, {
        metalnessNode: weight, roughnessNode: rough, reflectNonMetals: false, camera,
      });
      ssrNode.resolutionScale = q.ssrResolution;
      ssrNode.quality.value = q.ssrQuality;
      ssrNode.maxDistance.value = 40;
      ssrNode.thickness.value = 0.12;
      ssrNode.intensity.value = 1.0;
      const r = ssrNode as unknown as AnyNode;
      const refl = (r as unknown as { rgb: AnyNode; a: AnyNode });
      // rgb is already weighted (gloss · distance falloff · Fresnel); alpha holds the hit distance
      composite = vec4((composite as unknown as { rgb: AnyNode }).rgb.add(refl.rgb.mul(float(0.9).mul(float(1).sub(cover)))) as never, 1) as unknown as AnyNode;
      effects.push('SSR');
    }
  }

  // ground-cloud volume (ray marched at ½ res), composited before TRAA (which smooths the
  // march jitter); needs TRAA, so medium and up
  if (cloudNode && cloudC) {
    composite = vec4((composite as unknown as { rgb: AnyNode }).rgb.mul(cloudC.a).add(cloudC.rgb) as never, 1) as unknown as AnyNode;
    cloudVolume.rendering = true;
    effects.push('Wolkenvolumen');
  }

  let aa: AnyNode = composite;
  let traaNode: ReturnType<typeof traa> | null = null;
  // 1 on the first frame after a camera cut. The velocity buffer of that frame still holds the
  // motion from the previous shot's camera (three keeps the previous view matrix per camera
  // object), so TRAA reprojected the re-seeded history by a whole-screen offset (a shifted double
  // image) and motion blur smeared the cut frame along those vectors (the "streaks" on every cut of
  // the broadcast cameras). The cut frame shows the new beauty buffer as it is instead.
  const fresh = uniform(0);
  if (postEnabled && q.traa) {
    traaNode = traa(composite as never, depth, scenePass.getTextureNode('velocity'), camera);
    aa = texOf(traaNode) as unknown as AnyNode;
    effects.push('TRAA');
  }

  // subtle lateral chromatic aberration of the stream camera lens (sampled from the AA texture)
  if (postEnabled && traaNode) {
    type Tex = { sample(uvn: unknown): { r: AnyNode; g: AnyNode; b: AnyNode; a: AnyNode } };
    const tex = texOf(traaNode) as Tex;
    const beauty = (traaNode as unknown as { beautyNode: Tex }).beautyNode;
    const at = (uvn: unknown) => mix(tex.sample(uvn) as never, beauty.sample(uvn) as never, fresh) as unknown as { r: AnyNode; g: AnyNode; b: AnyNode };
    const d = screenUV.sub(0.5);
    const off = d.mul(d.length()).mul(0.0005);
    aa = vec4(at(screenUV.add(off)).r, at(screenUV).g, at(screenUV.sub(off)).b, 1) as unknown as AnyNode;
    effects.push('CA');
  }

  // exposure time as a share of the frame interval: the velocity buffer holds the NDC motion of one
  // frame, ×0.5 is its UV length. 0.25 = a 180° shutter (was 0.5 = 360°: a launching car turned
  // see-through over a quarter of its length, unlike the crisp car in the stream's 0-60 shots)
  const motionAmount = uniform(0.25);
  let mb: AnyNode = aa;
  if (postEnabled && q.motionBlur) {
    const velTex = scenePass.getTextureNode('velocity');
    const vel = velTex.sample(screenUV).xy.mul(motionAmount).mul(float(1).sub(fresh));
    type Tex = { sample(uvn: unknown): { rgb: AnyNode } };
    const src = (traaNode ? texOf(traaNode) : color) as unknown as Tex;
    // motion blur only where pixels actually move; CA is re-applied by mixing the AA result back.
    // Gather along the pixel's own motion, but only from samples that move alike: three's
    // MotionBlur averaged every tap, so the leading and trailing parts of a moving car took in the
    // static background ahead of and behind it (the car showed the gate's LED pillar through its
    // bonnet – a ghost car), and a static background next to a panned subject took in the subject.
    const n = Math.max(2, q.motionBlurSamples);
    const blurred = Fn(() => {
      const tol = vel.length().mul(0.35).add(0.0004);
      const acc = vec3(0).toVar(), wsum = float(0).toVar();
      Loop({ start: int(0), end: int(n), type: 'int', condition: '<' } as never, (({ i }: { i: AnyNode }) => {
        const uvi = screenUV.add(vel.mul(float(i).add(0.5).div(n).sub(0.5)));
        const vi = velTex.sample(uvi).xy.mul(motionAmount);
        const w = float(1).sub(vi.sub(vel).length().div(tol)).clamp(0, 1);
        acc.addAssign(src.sample(uvi).rgb.mul(w) as never);
        wsum.addAssign(w);
      }) as never);
      const c0 = src.sample(screenUV).rgb;
      return vec4(acc.add(c0.mul(0.01) as never).div(wsum.add(0.01)), 1);
    })() as unknown as AnyNode;
    // transparent effects keep the velocity of the surface behind them (alpha-0 MRT): without this
    // mask a chase camera smears the jet plumes with the background's motion into wide fans
    // (the cloud volume is not in the G-buffer either: its coverage is 1 - transmittance)
    const fxCover = max(fxMask ? scenePass.getTextureNode('fxmask').sample(screenUV).r : float(0), float(1).sub(cloudT as never));
    const speed = clamp(vel.length().mul(400), 0, 1).mul(float(1).sub(fxCover.mul(0.85)));
    mb = mix(aa, blurred, speed) as unknown as AnyNode;
    effects.push('Bewegungsunschärfe');
  }

  const bloomStrength = uniform(0.12);
  let out: AnyNode = mb;
  if (postEnabled && q.bloom) {
    const b = bloom(mb as never, 0.15, 0.2, 2.5);
    b.strength = bloomStrength as never;
    out = (mb as unknown as { add(x: unknown): AnyNode }).add(b);
    effects.push('Bloom');
  }

  const focusDistance = uniform(8);
  const grainAmount = uniform(0.006);
  const frameSeed = uniform(0);
  pipeline.renderer.info; // keep reference
  frameSeedRef = frameSeed;
  const normalOut = out;
  let photoOut: AnyNode | null = null;
  const buildPhoto = () => {
    if (photoOut) return photoOut;
    const viewZ = scenePass.getViewZNode();
    photoOut = dof(normalOut as never, viewZ, focusDistance, uniform(4.5), uniform(4.0)) as unknown as AnyNode;
    return photoOut;
  };
  const finish = (hdr: AnyNode): AnyNode => {
    // tone map (AgX) explicitly, then the display-referred camera look: vignette + film grain
    const ldr = renderOutput(hdr as never) as unknown as { rgb: AnyNode };
    if (!postEnabled) return ldr as unknown as AnyNode;
    const d = screenUV.sub(0.5).mul(vec2(1.0, 0.75));
    // ≈ 0.3 EV darkening in the corners
    const vig = float(1).sub(d.dot(d).mul(0.55)).clamp(0, 1);
    const n = hash(screenCoordinate.xy.add(frameSeed.mul(vec2(37.1, 17.3))).dot(vec2(1, 911))).sub(0.5);
    const lum = luminance(ldr.rgb);
    const grain = n.mul(grainAmount).mul(float(1.2).sub(lum));
    // gentle filmic S-curve (deeper blacks like the stream's broadcast grade)
    const c = ldr.rgb.mul(vig);
    // AgX only (no extra contrast curve)
    return vec4(c.add(grain) as never, 1) as unknown as AnyNode;
  };
  pipeline.outputColorTransform = false;
  const finalNormal = finish(normalOut);
  pipeline.outputNode = finalNormal as never;
  if (postEnabled) effects.push('AgX', 'Vignette', 'Grain');

  void max;
  let cutFrames = 0;
  return {
    usesMRT: needsMRT && postEnabled,
    fxMask,
    pipeline,
    scenePass,
    effects,
    focusDistance,
    bloomStrength,
    motionAmount,
    setResolutionScale(_s: number) {
      // Dynamic resolution is applied through the renderer pixel ratio (GameRenderer), because the
      // TRAA history/depth copies assume the scene pass matches the drawing-buffer size.
    },
    setPhotoMode(on: boolean) {
      pipeline.outputNode = (on ? finish(buildPhoto()) : finalNormal) as never;
      pipeline.needsUpdate = true;
    },
    resetHistory() { cutFrames = 2; },
    beforeRender() {
      // TRAANode has no public reset: shrinking the history target makes the next frame see a
      // size change, which re-seeds the history from the current beauty buffer (private API).
      // Twice: the history written on the cut frame is that frame's resolve, which reprojected with
      // the stale velocities; re-seeding once more lets the shot start from a clean frame.
      fresh.value = cutFrames === 2 ? 1 : 0;
      if (cutFrames > 0) {
        cutFrames--;
        const t = traaNode as unknown as { _historyRenderTarget?: THREE.RenderTarget } | null;
        t?._historyRenderTarget?.setSize(1, 1);
      }
    },
    dispose() {
      pipeline.dispose();
      aoNode?.dispose();
      (ssrNode as unknown as { dispose?: () => void })?.dispose?.();
      traaNode?.dispose();
      cloudNode?.dispose();
      if (cloudNode) cloudVolume.rendering = false;
    },
  };
}

function texOf(n: unknown): unknown {
  return (n as { getTextureNode(): unknown }).getTextureNode();
}
