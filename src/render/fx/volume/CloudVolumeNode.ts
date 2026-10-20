// Ray marcher for the ground-cloud volume. Renders at reduced resolution into its own target
// (pattern of three's GodraysNode): rgb = in-scattered radiance (scene-linear, same units as the
// effect sprites), a = transmittance. post.ts composites it as `scene · a + rgb` before TRAA, which
// also smooths the per-frame jitter of the march start.
//
// Per sample: one fetch of the baked cloud texture (density, key light reaching the cell, fill
// transmittance from above, red LED light reaching the cell – see cloudSim.bake) and two fetches
// of a tiling billow noise that erodes the thin parts into cauliflower lobes while the dense
// cores stay solid. A second pass adds a curl-noise texture whose eddies displace the envelope and advect a
// fine Worley detail that frays the rims, and a sub-cell self-shadow tap of the bake (dark cores,
// bright crowns). The march only runs inside the occupied box (empty box = early out).
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { cloudVolume } from './cloudVolume';
import { DMAX } from './cloudSim';
import { fxLight } from '../fxLight';

// (the TSL generics of @types/three are far stricter than the node graph needs)
/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;
const {
  Fn, uniform, uv, vec3, vec4, float, Loop, If, Break, texture3D, getViewPosition,
  screenCoordinate, passTexture, exp, max, min, dot, normalize, smoothstep, mix, pow, int,
} = TSL as N;

const _size = new THREE.Vector2();
const _quad = new THREE.QuadMesh(undefined as never);
let _state: N;

export class CloudVolumeNode extends THREE.TempNode {
  static get type(): string { return 'CloudVolumeNode'; }
  resolutionScale = 0.5;
  readonly steps: N;
  private depthNode: N;
  private camera: THREE.Camera;
  private target: THREE.RenderTarget;
  private material: THREE.NodeMaterial;
  private textureNode: N;
  private uCamWorld: N;
  private uProjInv: N;
  private uCamPos: N;
  private uFrame: N;

  constructor(depthNode: N, camera: THREE.Camera, steps = 48) {
    super('vec4');
    this.depthNode = depthNode;
    this.camera = camera;
    this.steps = uniform(int(steps));
    this.updateBeforeType = THREE.NodeUpdateType.FRAME;
    this.uCamWorld = uniform(camera.matrixWorld);
    this.uProjInv = uniform(camera.projectionMatrixInverse);
    this.uCamPos = uniform(new THREE.Vector3());
    this.uFrame = uniform(0);
    this.target = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType });
    this.target.texture.name = 'CloudVolume';
    this.material = new THREE.NodeMaterial();
    this.material.name = 'CloudVolume';
    this.textureNode = passTexture(this as never, this.target.texture);
  }

  getTextureNode(): N { return this.textureNode; }

  /**
   * The march result for the full-resolution composite: centre + four diagonal bilinear taps one
   * screen pixel away (≈ a 3×3 tent over the half-resolution texels) – removes the residual jitter
   * dither that TRAA's variance clipping keeps.
   */
  sampleSoft(uvNode: N): N {
    const tex = this.textureNode;
    const px = vec3(TSL.screenSize as N, 0).xy.reciprocal().mul(1.5);   // (1 → 1.5 px)
    const o1 = px, o2 = px.mul(vec3(1, -1, 0).xy);
    return tex.sample(uvNode).mul(0.4)
      .add(tex.sample(uvNode.add(o1)).mul(0.15)).add(tex.sample(uvNode.sub(o1)).mul(0.15))
      .add(tex.sample(uvNode.add(o2)).mul(0.15)).add(tex.sample(uvNode.sub(o2)).mul(0.15));
  }

  setSize(w: number, h: number): void {
    this.target.setSize(Math.max(1, Math.round(w * this.resolutionScale)), Math.max(1, Math.round(h * this.resolutionScale)));
  }

  override updateBefore(frame: N): boolean | undefined {
    const renderer = frame.renderer as THREE.WebGPURenderer;
    _state = THREE.RendererUtils.resetRendererState(renderer, _state);
    const size = renderer.getDrawingBufferSize(_size);
    this.setSize(size.width, size.height);
    this.uCamPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    this.uFrame.value = (this.uFrame.value + 1) % 64;
    _quad.material = this.material;
    _quad.name = 'CloudVolume';
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(this.target);
    _quad.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, _state);
    return undefined;
  }

  override setup(builder: N): N {
    const cv = cloudVolume;
    const L = fxLight as N;
    const march = Fn(() => {
      const out = vec4(0, 0, 0, 1).toVar();
      const uvN = uv();
      const depth = this.depthNode.sample(uvN).r;
      const viewPos = getViewPosition(uvN, depth, this.uProjInv);
      const worldPos = this.uCamWorld.mul(vec4(viewPos, 1)).xyz;
      const ro = this.uCamPos;
      const toP = worldPos.sub(ro);
      const tScene = depth.greaterThanEqual(0.99999).select(float(1e4), toP.length());
      const rd = normalize(toP);
      // ray vs occupied box (slab test)
      const inv = vec3(1).div(rd.add(vec3(1e-6)));
      const ta = (cv.uBoxMin as N).sub(ro).mul(inv), tb = (cv.uBoxMax as N).sub(ro).mul(inv);
      const tmin = min(ta, tb), tmax = max(ta, tb);
      const tN = max(max(tmin.x, tmin.y), max(tmin.z, float(0)));
      const tF = min(min(tmax.x, tmax.y), min(tmax.z, tScene));
      If(tF.greaterThan(tN), () => {
        const steps = this.steps;
        const len = tF.sub(tN);
        // adaptive steps: coarse through empty space, fine inside the cloud (coarse jittered steps
        // through a dense billow show up as a honeycomb that TRAA cannot fully hide)
        const coarse = max(len.div(float(steps)), float(0.5));
        const fine = float(0.16);   // (0.22 → 0.16, the frayed rims are sharper)
        const stepLen = coarse.toVar();
        // (structureless per-pixel hash, new every frame – the IGN start jitter left a diagonal
        // hatch on the sharper rims: after the soft composite tap its residual is a regular pattern
        // that sits inside TRAA's variance clip box)
        const jitter = TSL.hash(screenCoordinate.x.add(screenCoordinate.y.mul(4096)).add(this.uFrame.mul(7919))) as N;
        const t = tN.add(coarse.mul(jitter)).toVar();
        // fine steps left after entering the cloud (0 = coarse stepping)
        const fineLeft = float(0).toVar();
        const nFine = coarse.div(fine).ceil().add(1);
        const T = float(1).toVar();
        const Ls = vec3(0).toVar();
        // per-pixel lighting constants
        const cosT = dot(cv.uKeyDir as N, rd);
        const g = 0.6, g2 = g * g;
        const hg = float(1 - g2).div(pow(max(float(1 + g2).sub(cosT.mul(2 * g)), float(1e-3)), float(1.5)));
        const phase = hg.mul(0.6).add(0.4);
        const keyCol = L.colour.mul(L.scatter).mul(phase).mul((cv.uScale as N).x);
        const ambient = L.ambient;
        // the uniform flood fill is scaled per site (finale: lit from the sides, not greyed)
        const fill = L.cloudFill.mul(cv.uFill as N);
        const redCol = L.ledColour.mul((cv.uScale as N).y).mul(1.1);
        // red stage floods light the body like the key (own direction and phase); uRed.w = their
        // share of the red channel (0 on sites with LED bars only: unchanged rim seams)
        const uRed = cv.uRed as N;
        const cosR = dot(uRed.xyz, rd);
        const hgR = float(1 - g2).div(pow(max(float(1 + g2).sub(cosR.mul(2 * g)), float(1e-3)), float(1.5)));
        const redSpotCol = L.ledColour.mul(L.scatter).mul(hgR.mul(0.6).add(0.4)).mul((cv.uScale as N).y);
        const redW = uRed.w;
        const time = cv.uTime as N;
        Loop({ start: int(0), end: steps, type: 'int', condition: '<' }, () => {
          If(t.greaterThanEqual(tF).or(T.lessThan(0.015)), () => { Break(); });
          const p = ro.add(rd.mul(t));
          // low-frequency noise: rgb warps the coarse grid into lumpy billows (2–4 m), a erodes
          const nw = texture3D(cv.noise, p.mul(0.07).add(vec3(time.mul(-0.01), time.mul(-0.03), 0))).level(0);
          // + curl-noise eddies (≈ 4 m, divergence free, drifting) displace the envelope itself:
          // a turbulent silhouette with tongues and bays instead of a smooth hull
          const cw = texture3D(cv.fine, p.mul(0.06).add(vec3(time.mul(0.05), time.mul(-0.09), time.mul(0.03)))).level(0).rgb.sub(0.5);
          // height above the pad (the grid floor is the ground)
          const y = p.y.sub((cv.uOrigin as N).y);
          // anisotropic warp – the vertical displacement (±1.6 m isotropic) turned a
          // 1.5 m ground sheet into a row of hills and round domes: ~15 % at the pad, ~50 % above 3 m
          const vWarp = mix(float(0.15), float(0.5), smoothstep(float(0.3), float(3.0), y));
          const warp = nw.rgb.sub(0.5).mul(3.2).add(cw.mul(1.8)).mul(vec3(1, vWarp, 1));
          const uvw = p.add(warp).sub(cv.uOrigin as N).div(cv.uSize as N);
          const s = texture3D(cv.texture, uvw).level(0);
          const d0 = s.r.mul(s.r).mul(DMAX);
          const dense = d0.greaterThan(0.004);
          // entered the cloud on a coarse step: go back and approach the surface in fine steps
          // (otherwise the surface is quantised to the coarse step: stripes)
          // (the fine step grows in thin material – translucent rims no longer stop the ray
          // early, so the step budget has to reach through them)
          const fineHere = mix(float(0.34), fine, smoothstep(float(0.12), float(0.6), s.r));
          const refine = dense.and(fineLeft.lessThan(0.5));
          If(refine, () => { t.subAssign(coarse); fineLeft.assign(nFine); stepLen.assign(fineHere); });
          If(refine.not(), () => {
            fineLeft.assign(dense.select(max(fineLeft, float(2)), fineLeft.sub(1)));
            stepLen.assign(fineLeft.greaterThan(0.5).select(fineHere, coarse));
          });
          If(dense.and(refine.not()), () => {
            // erode the edges instead of inflating the volume.
            const hHi = smoothstep(float(1.6), float(4.2), y);     // upper part: wispy, frayed
            const hLow = float(1).sub(smoothstep(float(0.2), float(1.0), y));   // ground layer: haze
            const core0 = smoothstep(float(0.05), float(1.6), d0);
            // fine detail first: rgb = small curl eddies (≈ 1.5 m) that swirl the billow lookups
            // below – sheared tongues and curls instead of round Worley cupolas; a = Worley crumbs.
            // The large curl eddies advect the lookup (more at the rims). (A vertical stretch of the
            // lookups read as a fur of upright fibres along the crowns – isotropic.)
            const pf = p.add(cw.mul(float(1).sub(core0).mul(2.0).add(0.6)));
            const fd = texture3D(cv.fine, pf.mul(0.17).add(vec3(0, time.mul(-0.16), time.mul(0.05)))).level(0);
            const swirl = fd.rgb.sub(0.5).mul(mix(float(0.9), float(1.3), hHi));
            // billow erosion: big lobes + finer ones, drifting slowly upwards / downwind
            const n2 = texture3D(cv.noise, p.add(swirl.mul(0.6)).mul(0.2).add(vec3(0, time.mul(-0.07), time.mul(0.02)))).level(0).a;
            // (the finest billow octave is swirled most: sheared tongues at the rims)
            const n3 = texture3D(cv.noise, p.add(swirl).mul(0.53).add(vec3(time.mul(0.03), time.mul(-0.12), 0))).level(0).a;
            const n = nw.a.mul(0.42).add(n2.mul(0.33)).add(n3.mul(0.25));
            // stage 1 – break-up: the two big billow octaves (cells ≈ 3.6 / 1.25 m) cut irregular gaps
            // and bays into the thin and mid-density parts and split the body into separate puffs;
            // the dense cores keep most of their density, the ground layer stays a continuous haze
            const nBig = nw.a.mul(0.6).add(n2.mul(0.4));
            const gap = smoothstep(float(0.3), float(0.64), nBig.add(core0.mul(0.12)).add(hLow.mul(0.22)));
            const dB = d0.mul(gap);
            const core = smoothstep(float(0.05), float(1.6), dB);
            const rim = float(1).sub(core);
            // stage 2 – lobes: soft shape threshold – wide at the thin rims (edges fade out), tight in the
            // cores (crisp cauliflower lobes); wider and higher in the upper part (wisps, not cupolas)
            const th = mix(float(0.62), float(0.2), core).add(hHi.mul(0.08));
            const shape = smoothstep(th.sub(0.04), th.add(mix(float(0.3), float(0.08), core)).add(hHi.mul(0.12)), n);
            // stage 3 – fine turbulent fraying. The curl eddies also advect the detail lookup (more at the
            // rims), two Worley octaves (≈ 0.75 m / 0.37 m) eat the rims away into wisps and crumbs
            // (Nubis-style remap); billowy crumbs low down, partly inverted (threads) high up
            const df = fd.a;
            const dW = mix(df, float(1).sub(df), hHi.mul(0.7));
            const ero = rim.mul(0.66).add(0.14).add(hHi.mul(0.12)).mul(float(1).sub(hLow.mul(0.4)));
            const fray = shape.sub(float(1).sub(dW).mul(ero)).div(float(1).sub(ero.mul(0.85))).clamp(0, 1);
            // thin translucent wisps in the outer envelope – where the eroded body has gone, the
            // thin vapour around it is kept as threads (inverted, curl-advected Worley, stretched
            // upwards high up) instead of being cut away: Fetzen and fine seams, τ ≲ 0.4 /m
            const env = smoothstep(float(0.004), float(0.2), d0).mul(float(1).sub(smoothstep(float(0.5), float(1.6), d0)));
            // (patchy: only where the big billow noise is high – Fetzen, not a fur along the whole crown)
            const threads = smoothstep(float(0.55), float(0.85), float(1).sub(df).mul(0.6).add(n3.mul(0.4)))
              .mul(smoothstep(float(0.42), float(0.62), nBig));
            // + torn rags in the outermost thin vapour only (d0 ≲ 0.3 /m, outside the body;
            // review 11: "too few fine transparent wisps"): fibrous, translucent tails that run
            // out of every silhouette instead of ending at the last lobe. Inside the body (gaps between
            // lobes) nothing is added – a haze there turned the lobes into fog.
            // (the thin vapour around a cloud spans a large volume – e.g. the whole 0–60 trail – so the
            // rags stay sparse and faint and keep above ~1.5 m: the 0–60 trail stays dense and sharply bounded;
            // patchy with the big billow noise: a uniform layer read as a second "cotton cap")
            const outer = smoothstep(float(0.02), float(0.06), d0).mul(float(1).sub(smoothstep(float(0.15), float(0.35), d0)))
              .mul(smoothstep(float(1.2), float(2.4), y));
            const rags = smoothstep(float(0.5), float(0.85), float(1).sub(df).mul(0.5).add(n3.mul(0.5)));
            const wisp = env.mul(threads).mul(mix(float(0.2), float(0.38), hLow).mul(float(1).sub(hHi.mul(0.6))))
              .add(outer.mul(rags).mul(smoothstep(float(0.5), float(0.7), nBig)).mul(0.09)).mul(float(1).sub(fray));
            // density: thin material stays translucent, only the cores are opaque (0.9 + 1.6·core)
            const dens = dB.mul(fray).mul(core.mul(1.5).add(0.7)).add(wisp)
              // soft foot – density fades in the lowest ~0.3 m (no hard line on the pad)
              .mul(smoothstep(float(-0.05), float(0.35), y).mul(0.7).add(0.3))
              // fade towards the camera: a chase camera inside the cloud must not see a grey wall
              .mul(smoothstep(float(1.0), float(7.0), t));
            // local crease shadow: the eroded density 0.7 m towards the key light (sub-cell billows
            // shade each other – bright lobe tops, dark gaps; the coarse bake cannot resolve that)
            // (towards key + zenith – on the pad most of the light is the flood fill from above,
            // so the shading direction leans upwards: bright crowns, dark undersides)
            const keyDir = normalize((cv.uKeyDir as N).add(vec3(0, 1.2, 0)));
            const q = p.add(keyDir.mul(0.7));
            const m2 = texture3D(cv.noise, q.add(swirl.mul(0.6)).mul(0.2).add(vec3(0, time.mul(-0.07), time.mul(0.02)))).level(0).a;
            // (the finest octave is reused from the sample itself – one fetch less per sample)
            const nq = nw.a.mul(0.42).add(m2.mul(0.33)).add(n3.mul(0.25));
            const crease = exp(dB.mul(smoothstep(th, th.add(0.09), nq)).mul(-2.2)).mul(0.72).add(0.28);
            // sub-cell self shadow – the baked density 1.8 m towards the key light (the bake's
            // key channel is per cell and cannot see the dense core just above a sample)
            const sh = texture3D(cv.texture, q.add(keyDir.mul(1.1)).add(warp).sub(cv.uOrigin as N).div(cv.uSize as N)).level(0).r;
            const selfSh = exp(sh.mul(sh).mul(DMAX).mul(-1.2)).mul(0.75).add(0.25);
            const tau = dens.mul(stepLen);
            const a = float(1).sub(exp(tau.negate()));
            const key = s.g.mul(s.g);
            // (concentrated on the cells near the bars: the red sat as a
            // matte tint inside the cloud instead of as strong local accents on the flanks)
            const red = s.a.mul(s.a).mul(smoothstep(float(0.3), float(0.8), s.a)).mul(1.7);
            const fillT = s.b;
            // dense interior gathers less of the diffuse fill than the thin rims (bright edges, dark cores)
            const occ = exp(d0.mul(-1.1)).mul(0.75).add(0.25);
            const occK = exp(d0.mul(-0.6)).mul(0.5).add(0.5);
            // red LED light sits on the frayed rims near the bars (it hardly reaches into the core)
            // (and low down – the bars lie on the pad; in the stream the red seam hugs the foot
            // of the cloud and its thin wisps, the crowns stay white)
            const redRim = rim.mul(1.6).add(0.1).mul(float(1.6).sub(fray.mul(0.6))).mul(3.5)
              .mul(mix(float(1.15), float(0.35), smoothstep(float(0.8), float(3.5), y)));
            const sKey = keyCol.mul(key).mul(occK).mul(crease).mul(selfSh).mul(0.65);
            const sAmb = ambient.mul(fillT.mul(0.88).add(0.12)).mul(occ)
              .add(fill.mul(fillT).mul(occ).mul(crease).mul(selfSh).mul(8.0));
            const sRedLed = redCol.mul(red).mul(redRim);
            const sRedSpot = redSpotCol.mul(s.a.mul(s.a)).mul(occK).mul(crease).mul(selfSh).mul(0.8);
            const sRed = mix(sRedLed, sRedSpot, redW);
            const S = sKey.add(sAmb).add(sRed).mul(3.2);
            Ls.addAssign(S.mul(a).mul(T));
            T.mulAssign(float(1).sub(a));
          });
          t.addAssign(stepLen);
        });
        out.assign(vec4(Ls, T));
      });
      return out;
    });
    this.material.fragmentNode = march().context(builder.getSharedContext());
    this.material.needsUpdate = true;
    return this.textureNode;
  }

  override dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}

/** Whether this renderer draws the volume (track only: the worlds use reversed depth and no ground cloud). */
export function cloudVolumeSupported(renderer: THREE.WebGPURenderer): boolean {
  return !(renderer as unknown as { reversedDepthBuffer?: boolean }).reversedDepthBuffer;
}
