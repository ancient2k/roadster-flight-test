// Public renderer facade. The game layer only talks to this class (see index.ts).
import * as THREE from 'three/webgpu';
import { uniform, vec4, log, min, luminance, float, uv } from 'three/tsl';
import type { TelemetryFrame, VehicleState } from '../shared/types';
import { TRACK } from '../shared/track';
import { DynamicResolution, QUALITY_PRESETS, settingsForBackend, type QualityLevel, type QualitySettings } from './quality';
import { buildTrack, type TrackWorld } from './world/track';
import { SCENE_TIME, PIXEL_ANGLE } from './world/materials';
import { FloodRig, towerLightFromEmpties, type TowerLight } from './lighting';
import { loadEnvModels, type EnvModelsHandle } from './world/envModels';
import { makePlaceholderVehicle, makeContactShadow } from './world/vehicles';
import { makeSkyNode, makeFogNode, loadHdr } from './env/sky';
import { CarRig, replaceTransmission, tuneCarMaterial, upgradePaint, type CarModelInfo } from './car/carRig';
import { nearestSite } from './cameraMath';
import { JetSystem } from './fx/jets';
import { ParticleSystem } from './fx/particles';
import { fxLight, setLedBars, FX_LIGHTS } from './fx/fxLight';
import { Emitters } from './fx/emitters';
import { CameraRig, type CameraMode } from './camera/cameraRig';
import { ReflectionProbe } from './probe';
import { BASE_EXPOSURE, NIGHT_EXPOSURE, adaptExposure, targetExposure, type ExposureParams } from './quality';
import { loadWorld, type WorldHandle } from './worlds';
import type { SiteDef } from '../shared/worlds';
import { ENVIRONMENTS } from '../shared/environment';
import { buildPost, transparentMRT, advanceGrain, type PostChain } from './post';
import { bootStep } from '../ui/bootProgress';

export type Backend = 'webgpu' | 'webgl2';
const FX_LAYER = 2;
/** Distant detail (crowd, horizon lights) skipped by the reflection probe. */
const DETAIL_LAYER = 3;

export interface RendererOptions {
  quality: QualityLevel;
  forceWebGL?: boolean;
  /** Disable dynamic resolution (benchmarks). */
  fixedResolution?: boolean;
  /** Base URL for assets (default: Vite base). */
  assetBase?: string;
  /** Debug/benchmark: switch individual effects off. */
  /** Phase-2 site (src/shared/worlds.ts). 'track' or omitted = McGregor pad; terrain/space = world. */
  site?: SiteDef;
  disable?: Partial<Record<'ao' | 'ssr' | 'traa' | 'motionBlur' | 'bloom' | 'shadows' | 'particles' | 'post' | 'probe' | 'exposure', boolean>>;
  /** Called once the site's world is loaded, before its shaders compile (e.g. start the physics build meanwhile). */
  onWorld?: (world: WorldHandle) => void;
}

export interface RenderStats {
  backend: Backend;
  quality: QualityLevel;
  fps: number;
  frameMs: number;        // wall time between frames (EMA)
  cpuMs: number;          // CPU time of update()+render() (EMA)
  gpuMs: number | null;   // GPU timestamp total (WebGPU with timestamp-query only)
  drawCalls: number;
  triangles: number;
  resolutionScale: number;
  width: number;
  height: number;
  pixelRatio: number;
  effects: string[];
  particles: number;
}

export class GameRenderer {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly backend: Backend;
  readonly rig: CameraRig;
  readonly car = new CarRig();
  readonly jets = new JetSystem();
  readonly particles: ParticleSystem;
  /** Called on camera cuts (TRAA history is reset automatically). */
  onCameraCut: (() => void) | null = null;

  private track: TrackWorld | null = null;
  private env: EnvModelsHandle | null = null;
  private world: WorldHandle | null = null;
  private site: SiteDef | null;
  private exposureParams: ExposureParams = NIGHT_EXPOSURE;
  private emitters!: Emitters;
  private post!: PostChain;
  private q!: QualitySettings;
  private level: QualityLevel;
  private dynRes!: DynamicResolution;
  private floods: FloodRig | null = null;
  private hemi!: THREE.HemisphereLight;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  simTime = 0;
  private lastFrameT = 0;
  private stats: RenderStats;
  private pendingCut = false;
  private gpuPending = false;
  private framesSinceResolve = 0;
  private fixedRes: boolean;
  private assetBase: string;
  private fogDensity = uniform(0.00006);
  private groundFog = uniform(0.0006);
  private lastState: VehicleState | null = null;
  private lastSimT: number | null = null;
  private envTex: THREE.Texture | null = null;
  private probe: ReflectionProbe | null = null;
  /** Static probe at the obstacle row (WebGPU): captured once the row is lit (kickflip site). */
  private propProbe: ReflectionProbe | null = null;
  private propProbeState: 'idle' | 'pending' | 'done' = 'idle';
  private probeFrames = 0;
  private probePos = new THREE.Vector3();
  exposure = BASE_EXPOSURE;
  private lumRT: THREE.RenderTarget | null = null;
  private lumQuad: THREE.QuadMesh | null = null;
  private lumPending = false;
  private lumFrame = 0;
  private lastRenderDt = 1 / 60;
  /** Auto exposure (eye adaptation). Set to a number to lock the exposure. */
  exposureLock: number | null = null;
  private disable: NonNullable<RendererOptions['disable']>;
  /** Diagnostics: durations (ms) of the last create()/setSite() phases. */
  timings: Record<string, number> = {};
  private baseFixedRes: boolean;
  private onWorld: RendererOptions['onWorld'];
  private baseDisable: NonNullable<RendererOptions['disable']>;
  /** Car materials' environment before the reflection probe took over (restored where the probe is off). */
  private carEnvBackup: Map<THREE.MeshStandardMaterial, [THREE.Texture | null, number]> | null = null;
  private fxMRT: ReturnType<typeof transparentMRT> | null = null;
  /** Render objects of the current world's meshes (world renderer): their vertex buffers go with the world. */
  private worldROs: WorldRenderObject[] = [];

  /**
   * Per-site overrides on top of the creation options. Sun scene: the scene runs far above 60 fps and a
   * fixed resolution keeps the heat-shimmer framebuffer copy stable; the car's reflection probe hits that
   * stale copy (WebGPU "Destroyed texture"), the world environment map provides the reflections there.
   */
  private applySitePolicy(): void {
    const space = this.site?.ground === 'space';
    this.fixedRes = this.baseFixedRes || space;
    this.disable = { ...this.baseDisable, ...(space ? { probe: true } : {}) };
  }

  private constructor(renderer: THREE.WebGPURenderer, opts: RendererOptions) {
    this.renderer = renderer;
    const be = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
    this.backend = be;
    this.level = opts.quality;
    this.baseFixedRes = !!opts.fixedResolution;
    this.baseDisable = opts.disable ?? {};
    this.onWorld = opts.onWorld;
    this.site = opts.site ?? null;
    this.disable = {};
    this.fixedRes = false;
    this.applySitePolicy();
    if (this.site && this.site.ground !== 'track') this.trackWorldRenderObjects();
    this.assetBase = opts.assetBase ?? (import.meta.env?.DEV ? '/' : (import.meta.env?.BASE_URL ?? './'));
    // soft particles read a copy of the scene depth; the worlds render with a reversed 32-bit depth
    // buffer (format mismatch with the shared viewport depth texture) and need no soft edges at range
    this.particles = new ParticleSystem(20000, !(opts.site && opts.site.ground !== 'track'));
    this.rig = new CameraRig(1);
    this.rig.onCut = () => { this.pendingCut = true; };
    this.stats = {
      backend: be, quality: opts.quality, fps: 0, frameMs: 0, cpuMs: 0, gpuMs: null, drawCalls: 0, triangles: 0,
      resolutionScale: 1, width: 0, height: 0, pixelRatio: 1, effects: [], particles: 0,
    };
  }

  static async create(canvas: HTMLCanvasElement, opts: RendererOptions): Promise<GameRenderer> {
    // The G-buffer (colour, normal, material, velocity, fx coverage) needs 40 bytes/sample; the
    // WebGPU default limit is 32, Apple GPUs offer 128.
    const requiredLimits: Record<string, number> = {};
    if (!opts.forceWebGL && typeof navigator !== 'undefined' && navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        const lim = adapter?.limits.maxColorAttachmentBytesPerSample ?? 32;
        if (lim > 32) requiredLimits.maxColorAttachmentBytesPerSample = Math.min(lim, 64);
      } catch { /* keep defaults */ }
    }
    const renderer = new THREE.WebGPURenderer({
      canvas, antialias: false, forceWebGL: !!opts.forceWebGL, trackTimestamp: !opts.forceWebGL && typeof navigator !== 'undefined' && !!navigator.gpu, powerPreference: 'high-performance',
      requiredLimits,
      // worlds span 30-120 km: reversed depth avoids z-fighting (McGregor keeps the standard depth
      // that the post nodes were tuned with)
      reversedDepthBuffer: !!opts.site && opts.site.ground !== 'track' && !opts.forceWebGL,
    } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
    let tm = performance.now();
    const T: Record<string, number> = {};
    const lap = (k: string) => { const n = performance.now(); T[k] = Math.round(n - tm); tm = n; bootStep(k); };
    await renderer.init();
    lap('init');
    const gr = new GameRenderer(renderer, opts);
    gr.timings = T;
    await gr.setup();
    lap('setup');
    // render a few invisible frames in states with jets, smoke and ground blast so every
    // pipeline of the post chain and the effects is compiled before the first visible frame
    const { fakeState } = await import('./fakeState');
    // effects with half-resolution targets need a sane size (SSR blur mips fail at 1×1)
    const cw = canvas.clientWidth || 1280, ch = canvas.clientHeight || 720;
    gr.resize(Math.max(cw, 640), Math.max(ch, 360));
    for (const t of [7.2, 34.6, 3]) await gr.prewarmFrames(fakeState(t), 2);
    lap('prewarm');
    await gr.world?.ready;
    lap('bakeWait');
    gr.resetEffects();
    return gr;
  }

  private url(p: string): string { return this.assetBase.replace(/\/?$/, '/') + p; }

  private async setup(): Promise<void> {
    const r = this.renderer;
    let tm = performance.now();
    const lap = (k: string) => { const n = performance.now(); this.timings[k] = Math.round(n - tm); tm = n; bootStep(k); };
    r.toneMapping = THREE.AgXToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.q = this.applyDisable(settingsForBackend(this.level, this.backend));

    const scene = this.scene;
    const worldSite = this.site && this.site.ground !== 'track' ? this.site : null;
    if (worldSite) {
      await this.loadSiteWorld(worldSite);
      if (this.world) this.onWorld?.(this.world);
    } else {
      scene.backgroundNode = makeSkyNode(1);
      scene.fogNode = makeFogNode(this.fogDensity, this.groundFog, new THREE.Color(0.007, 0.008, 0.011));
      this.envTex = await loadHdr(this.url('assets/env/night_1k.hdr'));
      if (this.envTex) {
        scene.environment = this.envTex;
        scene.environmentIntensity = 0.09;
      }
      this.hemi = new THREE.HemisphereLight(0x22303f, 0x0b0907, 0.12);
      scene.add(this.hemi);
      this.track = buildTrack(this.q, this.url('assets/env/'));
      // red LED bars that tint the smoke around them (obstacle deck edges and the stunt lanes)
      const strips = TRACK.decor.filter((d) => d.kind === 'ledStrip').map((d) => ({ x: d.pos.x, z0: d.pos.z, z1: d.pos.z + (d.length ?? 10), gain: 3 }));
      const zs = TRACK.obstacles.map((o) => o.center.z), ox = TRACK.obstacles[0]?.center.x ?? 0;
      const deck = [-1, 1].map((sx) => ({ x: ox + sx * 3.75, z0: Math.min(...zs) - 3, z1: Math.max(...zs) + 3, gain: 4 }));
      setLedBars([...deck, ...strips]);
      scene.add(this.track.group);
    }
    lap('s.world');

    scene.add(this.car.root);
    this.car.root.add(this.jets.group);
    await this.car.load(this.url('assets/car/roadster.glb'));
    lap('s.car');
    // WebGL2 fallback: no dynamic probe (cube-face renders with frozen shadow maps trip sampler
    // validation there); the car uses the HDRI environment instead
    if (this.backend === 'webgpu') {
      this.probe = new ReflectionProbe(this.level === 'ultra' ? 256 : 128);
      // the car samples the probe only after its first full capture (see render()): sampling the
      // cube before it was ever rendered makes WebGPU re-create the texture under a pending PMREM
      // pass ("Destroyed texture used in a submit")
    }

    if (this.track) {
      const track = this.track;
      // environment models replace the procedural stand-ins where available
      const env = this.env = await loadEnvModels(track, this.url('assets/env-models/'), this.q);
      scene.add(env.group);
      env.setCrowdFraction(this.q.crowdCount / QUALITY_PRESETS.high.crowdCount);

      // floodlights: real spots from the lamp empties, assigned per stunt site (FloodRig)
      const towersDecor = TRACK.decor.filter((d) => d.kind === 'lightTower');
      const towerLights: TowerLight[] = towersDecor.map((_, i) => {
        const lamps = env.towerLamps?.[i];
        const f = track.floods[i];
        if (lamps && lamps.length) return { ...towerLightFromEmpties(lamps), cone: f?.cone ?? null };
        const pos = f.tower.clone();
        const dir = new THREE.Vector3(pos.x * 0.3, 0, pos.z * 0.92).sub(pos).normalize();
        return { pos, dir, halfAngleDeg: 26, cone: f?.cone ?? null };
      });
      const big = this.q.shadowMapSize;
      this.floods = new FloodRig(towerLights, track.siteLights, {
        shadows: this.q.shadows, slots: this.q.lightSlots, shadowSlots: this.q.shadowSlots, mapSizeA: big, mapSizeB: Math.max(1024, big / 2),
      });
      scene.add(this.floods.group);
    }

    this.particles.budget = this.q.particleBudget;
    scene.add(this.particles.sprite);
    this.emitters = new Emitters(this.particles, this.jets, this.env?.raptorSteam?.pos ?? this.track?.raptorSteam ?? null);
    if (this.env?.raptorSteam) this.emitters.raptorDir.copy(this.env.raptorSteam.dir);
    if (this.track && TRACK.obstacles.length) {
      const zs = TRACK.obstacles.map((o) => o.center.z), ox = TRACK.obstacles[0].center.x;
      this.emitters.hazeBox = { min: new THREE.Vector3(ox - 12, 0.8, Math.min(...zs) - 10), max: new THREE.Vector3(ox + 10, 3.0, Math.max(...zs) + 8) };
    }
    this.emitters.warmup(40, (t) => this.particles.setTime(t), 0);
    if (worldSite) this.applyWorldEnvironment(worldSite);

    this.rig.colliders = this.track && this.env ? [...this.track.cameraColliders, ...this.env.colliders] : [];
    this.rig.camera.layers.enable(FX_LAYER);
    this.rig.camera.layers.enable(DETAIL_LAYER);
    for (const o of [...(this.track?.probeExcluded ?? []), ...(this.env?.probeExcluded ?? [])]) o.traverse((c) => c.layers.set(DETAIL_LAYER));
    this.rig.attachInput(this.renderer.domElement);

    this.buildPostChain();
    this.dynRes = new DynamicResolution(this.q.resolutionSteps);
    this.applyPixelRatio();
    lap('s.rest');
    await this.warmup();
    lap('s.compile');
  }

  /** Phase-2 site: terrain/sky/sun or the Sun scene replace the McGregor pad. */
  private async loadSiteWorld(worldSite: SiteDef): Promise<void> {
    let wt = performance.now(), wk = 'w.start';
    const onProgress = (phase: string) => { const n = performance.now(); this.timings[wk] = Math.round(n - wt); wt = n; wk = 'w.' + phase; };
    this.world = await loadWorld(this.scene, this.renderer, worldSite, { quality: this.level, assetBase: this.assetBase, camera: this.rig.camera, onProgress });
    onProgress('end');
    const wh = this.world;
    this.rig.groundAt = worldSite.ground === 'space'
      ? () => -Infinity
      : (x, z) => { const h = wh.surfaceAt(x, z); return Number.isFinite(h) ? h : -Infinity; };
    this.exposureParams = this.world.exposure;
    this.exposure = this.exposureTarget = this.world.exposureFixed;
    this.rig.camera.near = 0.2;
    this.rig.camera.far = this.world.cameraFar;
    this.rig.camera.updateProjectionMatrix();
  }

  /** Smoke/jets of a world: ambient pressure, gravity and ground of the body. */
  private applyWorldEnvironment(worldSite: SiteDef): void {
    const env = ENVIRONMENTS[worldSite.body];
    const w = this.world;
    this.emitters.setEnvironment(env.ambientPressurePa, Math.abs(env.gravity.y) || 0, w && w.terrain ? (x, z) => w.surfaceAt(x, z) : null);
    // loose soil under wheels and jets (bare terrain only: not on landmarks, pyramids or props)
    this.emitters.setSoil(w && w.terrain ? worldSite.surface : null,
      w && w.terrain ? (x, y, z) => { const h = w.heightAt(x, z); return Number.isFinite(h) && y - h < 0.15 && w.surfaceAt(x, z) - h < 0.05; } : null,
      env.airDensity);
    this.emitters.onScour = w?.marks ? (x, z, r, dose) => w.marks!.scour(x, z, r, dose) : null;
    this.jets.air = this.emitters.air;
  }

  /**
   * switch a world renderer to another Phase-2 site in place. The renderer, car, effects and post
   * chain stay; only the world is rebuilt, so three.js re-uses every cached pipeline that does not
   * depend on the new world (the old path re-created the WebGPU device and compiled everything again).
   * Only between worlds: McGregor keeps its own renderer (standard depth buffer, see create()).
   */
  async setSite(site: SiteDef, onWorld?: (world: WorldHandle) => void): Promise<void> {
    if (!this.world || site.ground === 'track') throw new Error('setSite: nur zwischen Welten (McGregor hat einen eigenen Renderer)');
    this.timings = {};
    let tm = performance.now();
    const lap = (k: string) => { const n = performance.now(); this.timings[k] = Math.round(n - tm); tm = n; };
    // material.dispose() keeps its maps: free the GLB textures of the world too (landmarks, rock set, grass,
    // Roadster 1) – with a renderer that lives on they would pile up (~290 MB per tour of all sites)
    const maps = new Set<THREE.Texture>();
    this.world.group.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
        for (const v of Object.values(m)) if ((v as THREE.Texture | null)?.isTexture) maps.add(v as THREE.Texture);
      }
    });
    const release = this.releaseWorldBuffers();
    this.world.dispose();
    for (const t of maps) t.dispose();
    release(); // after world.dispose(): the world's own meshes are out of the scene then
    this.world = null;
    this.site = site;
    const probeWas = !this.disable.probe;
    this.applySitePolicy();
    // Probe on in both worlds: it stays bound – the prewarm frames below re-capture the cube in the new world
    // before anything is visible (re-binding would recompile every car material twice). Sun scene: the world
    // environment lights the car; back from there the car samples the probe again after its first full capture.
    if (this.disable.probe) this.restoreCarEnv();
    else if (!probeWas) this.probeFrames = 0;
    this.lastFrameT = 0;
    this.dynRes.reset(this.q.resolutionSteps);
    this.applyPixelRatio();
    lap('dispose');
    await this.loadSiteWorld(site);
    lap('s.world');
    if (this.world) onWorld?.(this.world);
    this.applyWorldEnvironment(site);
    this.tagTransparent();
    await this.warmup();
    lap('s.compile');
    const { fakeState } = await import('./fakeState');
    // two frames per effect state as in create(): with one, shadow/probe pipelines of the new world's
    // materials are left for the first visible frames (measured: 130–400 ms hitches)
    for (const t of [7.2, 34.6, 3]) await this.prewarmFrames(fakeState(t), 2);
    lap('prewarm');
    await (this.world as WorldHandle | null)?.ready;
    lap('bakeWait');
    this.resetEffects();
  }

  /**
   * three.js frees the vertex buffers three.js itself creates for a mesh (InstancedMesh instance matrices) only
   * through the first render object of its geometry, and buffers of geometries the world does not dispose not at
   * all – harmless when the whole renderer went, ~6–21 MB per visit with a world renderer that lives on. So the
   * render objects of world meshes are noted when three.js creates them (once per object and pass)…
   */
  private trackWorldRenderObjects(): void {
    const objs = (this.renderer as unknown as { _objects: { createRenderObject: (...a: unknown[]) => WorldRenderObject } })._objects;
    if (!objs?.createRenderObject) return;
    const create = objs.createRenderObject.bind(objs);
    objs.createRenderObject = (...a: unknown[]) => {
      const ro = create(...a);
      const g = this.world?.group;
      let p = a[3] as THREE.Object3D | null;
      while (p && p !== g) p = p.parent;
      if (g && p) this.worldROs.push(ro);
      return ro;
    };
  }

  /**
   * …and their buffers deleted with the world (except those of geometries outside it: car, effects). Collect
   * before world.dispose() (disposing an object clears its render objects), call the result after it.
   */
  private releaseWorldBuffers(): () => void {
    const drop = new Set<unknown>();
    for (const ro of this.worldROs) {
      for (const at of ro.attributes ?? []) drop.add(at);
      if (ro.geometry?.index) drop.add(ro.geometry.index);
    }
    this.worldROs = [];
    return () => this.deleteBuffers(drop);
  }

  private deleteBuffers(drop: Set<unknown>): void {
    const keep = new Set<unknown>();
    this.scene.traverse((o) => {
      const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (!geo) return;
      if (geo.index) keep.add(geo.index);
      for (const at of Object.values(geo.attributes)) keep.add(at);
    });
    const attrs = (this.renderer as unknown as { _attributes?: { delete(a: unknown): unknown } })._attributes;
    if (!attrs) return;
    for (const at of drop) if (!keep.has(at)) attrs.delete(at); // a buffer still in use is re-created on its next draw
  }

  /** Undo the probe environment on the car (Sun scene: the world environment map lights it). */
  private restoreCarEnv(): void {
    if (!this.carEnvBackup) return;
    for (const [m, [tex, k]] of this.carEnvBackup) { m.envMap = tex; m.envMapIntensity = k; m.needsUpdate = true; }
    this.carEnvBackup = null;
  }

  /** Car environment = the reflection probe; remembers the previous maps for restoreCarEnv(). */
  private bindProbeToCar(): void {
    if (!this.probe) return;
    if (!this.carEnvBackup) {
      const b = new Map<THREE.MeshStandardMaterial, [THREE.Texture | null, number]>();
      this.car.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const sm = m as THREE.MeshStandardMaterial;
          if ('envMap' in sm && !(m as THREE.MeshBasicMaterial).isMeshBasicMaterial && !b.has(sm)) b.set(sm, [sm.envMap, sm.envMapIntensity]);
        }
      });
      this.carEnvBackup = b;
    }
    this.car.setEnvMap(this.probe.texture, 0.8);
  }

  /**
   * Compile every pipeline up front (scene materials incl. effects, reflection probe, post chain)
   * so the first seconds and the first camera cuts do not stutter.
   */
  private async warmup(): Promise<void> {
    const cam = this.rig.camera;
    // make every effect visible once so its pipeline gets compiled
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    try {
      await this.renderer.compileAsync(this.scene, cam);
      if (this.probe) {
        const cubeCam = this.probe.cubeCamera.children[0] as THREE.Camera;
        await this.renderer.compileAsync(this.scene, cubeCam, this.scene);
      }
    } catch (e) {
      console.warn('[render] Vorkompilieren fehlgeschlagen:', e);
    }
    hidden.forEach((o) => { o.visible = false; });
  }

  /** Drop all transient effects (particles, jet state, exposure) – used after the warm-up. */
  resetEffects(): void {
    this.simTime = 0;
    this.lastSimT = null;
    this.exposure = BASE_EXPOSURE;
    this.particles.clear();
    this.particles.setTime(0);
    this.emitters.warmup(40, (t) => this.particles.setTime(t), 0);
    for (const p of this.jets.params) { p.intensity = 0; p.length = 0; p.diamondStrength = 0; }
    this.rig.resetSmoothing();
    this.pendingCut = true;
  }

  /** Render a few frames invisibly (post chain, probe, TRAA history) – call after resize. */
  async prewarmFrames(state: VehicleState, frames = 3): Promise<void> {
    // draw every object once through the G-buffer path (no frustum culling), otherwise objects
    // first seen after a camera cut compile their MRT pipeline on that frame
    const culled: THREE.Object3D[] = [];
    this.scene.traverse((o) => { if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; } });
    for (let i = 0; i < frames; i++) {
      this.update(state, null, 1 / 60);
      this.render();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    culled.forEach((o) => { o.frustumCulled = true; });
  }

  private applyDisable(q: QualitySettings): QualitySettings {
    const d = this.disable;
    if (d.ao) q.ao = false;
    if (d.ssr) q.ssr = false;
    if (d.traa) q.traa = false;
    if (d.motionBlur) q.motionBlur = false;
    if (d.bloom) q.bloom = false;
    if (d.shadows) q.shadows = false;
    if (d.particles) q.particleBudget = 0;
    return q;
  }

  private buildPostChain(): void {
    this.post?.dispose();
    this.post = buildPost(this.renderer, this.scene, this.rig.camera, this.q, !this.disable.post);
    this.fxMRT = this.post.usesMRT ? transparentMRT(this.post.fxMask) : null;
    this.tagTransparent(true);
    this.stats.effects = this.post.effects;
  }

  /** Transparent node materials write the fx coverage MRT and live on the FX layer (new world materials too). */
  private tagTransparent(force = false): void {
    const fx = this.fxMRT;
    this.scene.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
        if (m.transparent && (m as THREE.NodeMaterial).isNodeMaterial) {
          if (!force && (m as THREE.NodeMaterial).mrtNode === fx) { o.layers.set(FX_LAYER); continue; }
          (m as THREE.NodeMaterial).mrtNode = fx;
          m.needsUpdate = true;
          // effects live on layer 2: seen by the main camera, skipped by the reflection probe
          // (whose render target has no G-buffer for the MRT override)
          o.layers.set(FX_LAYER);
        }
      }
    });
  }

  private applyPixelRatio(): void {
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.q.maxPixelRatio) * (this.dynRes ? this.dynRes.scale : 1);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
  }

  // ------------------------------------------------------------------ public API

  async loadCar(url = 'assets/car/roadster.glb'): Promise<CarModelInfo> {
    const info = await this.car.load(/^(https?:)?\//.test(url) || url.startsWith('./') ? url : this.url(url));
    if (this.probe && this.probeFrames > 3 && !this.disable.probe) { this.carEnvBackup = null; this.bindProbeToCar(); }
    return info;
  }

  /** Loads obstacle props (public/assets/props/<model>.glb); missing files keep the placeholders. */
  async loadProps(): Promise<Record<string, 'glb' | 'placeholder'>> {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const result: Record<string, 'glb' | 'placeholder'> = {};
    const track = this.track;
    if (!track) return result; // worlds have no obstacle row
    const cache = new Map<string, THREE.Object3D | null>();
    for (const o of TRACK.obstacles) {
      if (!cache.has(o.model)) {
        const url = this.url(`assets/props/${o.model}.glb`);
        let obj: THREE.Object3D | null = null;
        try {
          const head = await fetch(url, { method: 'HEAD' });
          if (head.ok && !(head.headers.get('content-type') ?? '').includes('text/html')) obj = (await loader.loadAsync(url)).scene;
        } catch { obj = null; }
        cache.set(o.model, obj);
      }
      const src = cache.get(o.model);
      const holder = track.obstacles.get(o.id);
      if (!holder) continue;
      if (src) {
        holder.clear();
        const inst = src.clone(true);
        inst.traverse((x) => {
          const mesh = x as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true; mesh.receiveShadow = true;
          // clones share materials with the cache source: upgrade/tune each material once
          const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
            let u = (m.userData.r3Upgraded as THREE.Material | undefined) ?? null;
            if (!u) { u = upgradePaint(m); replaceTransmission(u); tuneCarMaterial(u); m.userData.r3Upgraded = u; u.userData.r3Upgraded = u; }
            return u;
          });
          mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
        });
        holder.add(inst, makeContactShadow(o.size));
        result[o.id] = 'glb';
        if (this.propProbeState === 'done') this.propProbeState = 'idle'; // new props: capture again
      } else {
        if (!holder.children.length) holder.add(makePlaceholderVehicle(o.model, o.size));
        result[o.id] = 'placeholder';
      }
    }
    return result;
  }

  update(state: VehicleState, telemetry: TelemetryFrame | null, dtRender: number): void {
    const t0 = performance.now();
    const dt = Math.min(Math.max(dtRender, 0), 0.1);
    // Effects follow simulation time: a paused or slowed simulation freezes / slows jets, smoke and
    // wheels, while the camera keeps using wall-clock time (orbiting in pause, photo mode).
    // (the integration mutates one view object in place, so keep the time as a number)
    const prevT = this.lastSimT;
    const fxDt = prevT === null ? dt : Math.min(Math.max(state.t - prevT, 0), 0.1);
    this.lastSimT = state.t;
    this.lastRenderDt = fxDt;
    this.lastState = state;
    this.simTime += fxDt;
    this.particles.setTime(this.simTime);
    SCENE_TIME.value = this.simTime;
    this.env?.update(this.simTime);
    this.car.update(state, fxDt);
    // light level near the car: brighter on the pad, darker high up / far away
    const light = 0.55 + 0.45 * Math.exp(-Math.max(0, state.pos.y - 3) / 25);
    if (fxDt > 0 || prevT === null) this.jets.update(state.nozzles, fxDt, light, telemetry?.thrusterDuty ?? null);
    this.emitters.update(state, fxDt, Math.min(1, this.q.particleBudget / 12000) + 0.25);
    this.particles.flush();
    this.updateLights(state);
    this.rig.update(state, dt);
    this.world?.update(this.rig.camera.position, fxDt);
    if (fxDt > 0) this.world?.marks?.update(state);
    this.post.focusDistance.value = this.rig.focusDistance;
    void telemetry;
    this.stats.cpuMs = ema(this.stats.cpuMs, performance.now() - t0, 0.1);
  }

  private updateLights(s: VehicleState): void {
    const pos = fxLight.pos.array as THREE.Vector4[], dir = fxLight.dir.array as THREE.Vector4[], inner = fxLight.inner.array as THREE.Vector4[];
    if (this.world) {
      // worlds: smoke is lit by the sun (directional, no cone)
      const d = this.world.sunDirection;
      fxLight.sunDir.value.set(-d.x, -d.y, -d.z, this.world.sunLight.intensity);
      for (const p of pos) p.w = 0;
      return;
    }
    fxLight.sunDir.value.w = 0;
    if (!this.floods) return;
    const car = _carPos.set(s.pos.x, s.pos.y, s.pos.z);
    this.floods.update(car);
    // the media around the car are lit by the floods that light the car best (keys, batteries)
    const ranked = this.floods.slots.filter((l) => l.intensity > 0).map((l) => {
      const d = _tmpV.copy(car).sub(l.position);
      const dist2 = Math.max(1, d.lengthSq());
      const ax = _tmpV2.copy(l.target.position).sub(l.position).normalize();
      const cos = d.normalize().dot(ax);
      const cone = THREE.MathUtils.smoothstep(cos, Math.cos(l.angle * 1.6), Math.cos(l.angle * 0.5));
      return { l, e: (l.intensity * (cone + 0.05)) / dist2 };
    }).sort((a, b) => b.e - a.e);
    for (let i = 0; i < FX_LIGHTS; i++) {
      const l = ranked[i]?.l;
      if (!l) { pos[i].w = 0; continue; }
      const ax = _tmpV2.copy(l.target.position).sub(l.position).normalize();
      pos[i].set(l.position.x, l.position.y, l.position.z, l.intensity);
      dir[i].set(ax.x, ax.y, ax.z, Math.cos(l.angle));
      inner[i].x = Math.cos(l.angle * (1 - l.penumbra));
    }
  }

  render(): void {
    const t0 = performance.now();
    if (this.lastFrameT > 0) {
      const frame = t0 - this.lastFrameT;
      this.stats.frameMs = ema(this.stats.frameMs, frame, 0.08);
      this.stats.fps = 1000 / Math.max(this.stats.frameMs, 0.001);
      if (!this.fixedRes) {
        const budgetMs = this.stats.gpuMs ?? frame;
        if (this.dynRes.update(budgetMs)) this.applyPixelRatio();
      }
    }
    this.lastFrameT = t0;
    if (this.pendingCut) {
      this.pendingCut = false;
      this.post.resetHistory();
      this.onCameraCut?.();
    }
    advanceGrain();
    // each broadcast camera has its own iris (BroadcastShot.ev) on top of the eye adaptation
    const ev = this.rig.mode === 'broadcast' && !this.world ? (this.rig.currentShot?.ev ?? 0) : 0;
    this.renderer.toneMappingExposure = this.exposureLock ?? this.exposure * 2 ** ev;
    this.post.beforeRender();
    PIXEL_ANGLE.value = 2 / (this.rig.camera.projectionMatrix.elements[5] * Math.max(1, this.height * this.pixelRatio));
    this.post.pipeline.render();
    // probe after the main pass: shadow maps are then up to date (and sized) for this frame
    if (this.probe && this.lastState && !this.disable.probe) {
      const p = this.lastState.pos;
      const n = this.probeFrames++;
      // two faces per frame from one capture position: the cube is complete after three frames
      // (seams cannot wander far) and no frame pays for all six faces (p95/p99 spikes)
      const k = n % 6;
      if (k < 3) {
        if (k === 0) this.probePos.set(p.x, p.y + 0.2, p.z);
        this.probe.update(this.renderer, this.scene, this.probePos, [this.car.root, this.particles.sprite], [k * 2, k * 2 + 1]);
      }
      if (n === 3 && !this.carEnvBackup) this.bindProbeToCar();
    }
    this.updatePropProbe();
    this.measureLuminance();
    const info = this.renderer.info.render as unknown as { drawCalls?: number; calls?: number; triangles: number };
    this.stats.drawCalls = info.drawCalls ?? info.calls ?? 0;
    this.stats.triangles = info.triangles;
    this.stats.resolutionScale = this.dynRes.scale;
    this.stats.width = this.width; this.stats.height = this.height; this.stats.pixelRatio = this.pixelRatio;
    this.stats.particles = this.particles.budget;
    this.framesSinceResolve++;
    if (this.backend === 'webgpu' && !this.gpuPending) {
      this.gpuPending = true;
      const frames = this.framesSinceResolve;
      this.framesSinceResolve = 0;
      // resolves to the summed pass durations of the last complete frame
      this.renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then((total) => {
        const ms = typeof total === 'number' ? total : 0;
        void frames;
        // Chrome on Apple/Metal reports quantised, implausible values: only accept numbers that
        // fit into the measured frame interval.
        if (ms > 0 && ms < this.stats.frameMs * 1.25) this.stats.gpuMs = ema(this.stats.gpuMs ?? ms, ms, 0.1);
        else if (ms > this.stats.frameMs * 1.25) this.stats.gpuMs = null;
        this.gpuPending = false;
      }).catch(() => { this.gpuPending = false; });
    }
    this.stats.cpuMs = ema(this.stats.cpuMs, performance.now() - t0, 0.02);
  }

  /**
   * The parked vehicles reflect their surroundings through one static cube capture next to the row,
   * taken once the stunt lights of the kickflip site are on (FloodRig slots) – their lacquer then
   * shows the light walls, the LED bars and the dark sky instead of a uniform HDRI.
   */
  private updatePropProbe(): void {
    if (this.backend !== 'webgpu' || !this.track || this.disable.probe || this.propProbeState === 'done') return;
    if (!this.lastState || nearestSite(this.lastState.pos) !== 'kickflip') return;
    // wait a few frames on the site (shadow maps and slots settled)
    if (this.propProbeState === 'idle') { this.propProbeState = 'pending'; this.propProbeWait = 8; return; }
    if (--this.propProbeWait > 0) return;
    const zs = TRACK.obstacles.map((o) => o.center.z), ox = TRACK.obstacles[0]?.center.x ?? 0;
    this.propProbe ??= new ReflectionProbe(this.level === 'ultra' ? 256 : 128);
    const at = new THREE.Vector3(ox + 4, 2.4, (Math.min(...zs) + Math.max(...zs)) / 2);
    this.propProbe.update(this.renderer, this.scene, at, [this.car.root, this.particles.sprite], true);
    const tex = this.propProbe.texture;
    for (const holder of this.track.obstacles.values()) holder.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const sm = m as THREE.MeshStandardMaterial;
        if (!('envMap' in sm) || (m as THREE.MeshBasicMaterial).isMeshBasicMaterial || sm.envMap === tex) continue;
        sm.envMap = tex;
        sm.envMapIntensity = 0.9;
        sm.needsUpdate = true;
      }
    });
    this.propProbeState = 'done';
  }
  private propProbeWait = 0;

  /** Log-average luminance of the HDR scene pass, read back asynchronously every few frames. */
  private measureLuminance(): void {
    if (this.exposureLock !== null || this.disable.exposure) return;
    const dt = this.lastRenderDt;
    if (this.lumPending || (this.lumFrame++ % 4) !== 0) { this.exposure = adaptExposure(this.exposure, this.exposureTarget, dt, this.exposureParams); return; }
    if (!this.lumRT) {
      this.lumRT = new THREE.RenderTarget(48, 27, { type: THREE.HalfFloatType, depthBuffer: false });
      const mat = new THREE.NodeMaterial();
      this.lumQuad = new THREE.QuadMesh(mat);
    }
    const tex = this.post.scenePass.getTextureNode('output');
    const mat = this.lumQuad!.material as THREE.NodeMaterial;
    if ((mat as unknown as { _src?: unknown })._src !== tex) {
      // centre-weighted log luminance, bright light sources clamped so a lamp does not darken the frame
      mat.fragmentNode = vec4(log(min(luminance(tex.sample(uv()).rgb), float(4)).add(1e-4)), 0, 0, 1);
      (mat as unknown as { _src?: unknown })._src = tex;
      mat.needsUpdate = true;
    }
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.lumRT);
    this.lumQuad!.render(this.renderer);
    this.renderer.setRenderTarget(prev);
    this.lumPending = true;
    this.renderer.readRenderTargetPixelsAsync(this.lumRT!, 0, 0, 48, 27).then((buf) => {
      const a = buf as unknown as ArrayLike<number> & { BYTES_PER_ELEMENT: number };
      let sum = 0, wsum = 0;
      for (let y = 0; y < 27; y++) for (let x = 0; x < 48; x++) {
        const raw = a[(y * 48 + x) * 4];
        const v = a.BYTES_PER_ELEMENT === 2 ? THREE.DataUtils.fromHalfFloat(raw) : raw;
        const dx = (x - 23.5) / 24, dy = (y - 13) / 13.5;
        const w = Math.exp(-(dx * dx + dy * dy) * 1.5);
        sum += v * w; wsum += w;
      }
      this.exposureTarget = this.world?.autoExposure ? this.world.autoExposure(this.rig.camera) : targetExposure(Math.exp(sum / wsum), this.exposureParams); // scene-referred (pre-exposure)
      this.lumPending = false;
    }).catch(() => { this.lumPending = false; });
    this.exposure = adaptExposure(this.exposure, this.exposureTarget, dt, this.exposureParams);
  }
  private exposureTarget = BASE_EXPOSURE;

  resize(w: number, h: number): void {
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));
    this.rig.camera.aspect = this.width / this.height;
    this.rig.camera.updateProjectionMatrix();
    this.applyPixelRatio();
  }

  setQuality(level: QualityLevel): void {
    if (level === this.level) return;
    this.level = level;
    this.stats.quality = level;
    this.q = this.applyDisable(settingsForBackend(level, this.backend));
    // The shadow-map size is fixed at creation: resizing it at runtime destroys the depth texture
    // while the reflection probe's frozen-shadow pass still references it.
    this.particles.budget = this.q.particleBudget;
    this.track?.setCrowdCount(this.q.crowdCount);
    this.env?.setCrowdFraction(this.q.crowdCount / QUALITY_PRESETS.high.crowdCount);
    this.world?.setQuality(level);
    this.dynRes.reset(this.q.resolutionSteps);
    this.buildPostChain();
    this.applyPixelRatio();
  }

  setCameraMode(mode: CameraMode): void {
    this.rig.setMode(mode);
    this.post.setPhotoMode(mode === 'photo');
  }

  cycleCamera(): CameraMode {
    const m = this.rig.cycle();
    this.post.setPhotoMode(m === 'photo');
    return m;
  }

  setBroadcastShot(id: string | 'auto'): void { this.rig.setBroadcastShot(id); }

  get cameraMode(): CameraMode { return this.rig.mode; }
  get camera(): THREE.PerspectiveCamera { return this.rig.camera; }
  get carInfo(): CarModelInfo { return this.car.info; }
  /** Heat glow of the car paint (Sun scene / re-entry). */
  setCarHeatGlow(color: THREE.ColorRepresentation, intensity: number): void { this.car.setHeatGlow(color, intensity); }
  /** Site this renderer shows (null = McGregor pad). */
  get currentSite(): SiteDef | null { return this.site; }
  /** Loaded world (null on the McGregor pad). */
  get worldHandle(): WorldHandle | null { return this.world; }
  /** soil effects for tests/HUD – dust particles emitted and the tyre-track/scour buffers. */
  groundFx(): { dust: Emitters['soilStats']; marks: { segments: number; total: number; scours: number } | null } {
    return { dust: { ...this.emitters.soilStats }, marks: this.world?.marks?.stats() ?? null };
  }

  getStats(): RenderStats { return { ...this.stats, effects: [...this.stats.effects] }; }

  dispose(): void {
    this.world?.dispose(); // removes its own group; before the generic traverse below
    this.world = null;
    this.rig.dispose();
    this.post.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) mat.dispose();
    });
    this.envTex?.dispose();
    this.probe?.dispose();
    this.propProbe?.dispose();
    this.lumRT?.dispose();
    this.renderer.dispose();
    void this.lastState;
  }
}

/** The parts of a three.js RenderObject read by releaseWorldBuffers() (internal API, three 0.186). */
interface WorldRenderObject { attributes: unknown[] | null; geometry?: THREE.BufferGeometry }

const _carPos = new THREE.Vector3(), _tmpV = new THREE.Vector3(), _tmpV2 = new THREE.Vector3();

function ema(prev: number, x: number, a: number): number {
  return prev === 0 ? x : prev + (x - prev) * a;
}
