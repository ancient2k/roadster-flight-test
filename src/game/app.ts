// App shell: wires renderer, vehicle physics (+ core), GNC, input/HUD/menus/audio
// around the headless SimSession and the fixed-step loop.
import { GameRenderer, type WorldHandle } from '../render';
import { cameraInput } from '../render/camera/cameraRig';
import { createRoadsterSim, setDamageMode } from '@sim/vehicle';
import { steepStoneWithoutGrip } from '@sim/vehicle/fans';
import type { RoadsterSim } from '@sim/core/roadsterSim';
import { Autopilot, ManualAssist, type StuntResult } from '@sim/gnc';
import { InputManager } from '../input/InputManager';
import type { PlayerInput } from '../input/types';
import { Hud, Menu, SettingsStore } from '../ui';
import type { Settings } from '../ui/settings';
import { AudioEngine } from '../audio/AudioEngine';
import { ROADSTER } from '@shared/roadster';
import { siteFor } from '@shared/track';
import { environmentFor, site as siteDef, type SiteId } from '@shared/worlds';
import { EARTH } from '@shared/environment';
import { spawnPose } from '@sim/core/roadsterSim';
import { SunPanel } from './sunPanel';
import { OrbitPanel } from './orbitPanel';
import type { PropPose } from '@shared/props';
import { SIM_DT, type AssistLevel, type StuntId, type VehicleState } from '@shared/types';
import { v3 } from '@shared/math';
import { FixedStepLoop } from './loop';
import { t, upper } from '../i18n';
import { AERO_LABEL, ASSIST_LABEL, FAN_LABEL } from '../ui/labels';
import { cloneState, copyStateInto, interpolateState } from './interp';
import { ManualController, SimSession, type Controller, type SessionMode } from './session';
import { buildLevelScene, tileToWorld, type LevelArea, type LevelScene } from '../render/level/levelScene';
import { partDef, placeTransform } from '@shared/parts';
import type { Level } from '@shared/level';
import type { LandmarkShape } from '@sim/core/world';
import type { SiteDef } from '@shared/worlds';
import { et } from '../editor/i18n';
import { LevelRun } from './levelRun';
import { RaceHud, fmtTime } from '../editor/raceHud';
import { LaunchShow } from './launchShow';
import { gameAt } from '@shared/starshipFlight';

/** Air station refill rate (kg/s): the 250 kg tank in about 15 s. */
const AIR_STATION_KG_S = 17;

export interface AppOptions { forceWebGL?: boolean; quality?: Settings['graphics']['quality']; skipMenu?: boolean }

/** Seconds to keep the scene running after a stunt ends before the results screen opens. */
const RESULT_DELAY_S = 2.5;

/**
 * Searches outward from (x0, z0) for a spot where the ground under the car footprint is even enough
 * (rocky slopes would leave the hull resting on stones). Returns the spot and the highest ground under it.
 */
/** Pyramid courts: bounding rectangles of the talus rings + 20 m (full-resolution physics, bedrock surface). */
export function pyramidCourts(shapes: { id: string; data: Float32Array }[]): { minX: number; maxX: number; minZ: number; maxZ: number }[] {
  return shapes.filter((l) => l.id.endsWith('_talus')).map((l) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < l.data.length; i += 3) { minX = Math.min(minX, l.data[i]); maxX = Math.max(maxX, l.data[i]); minZ = Math.min(minZ, l.data[i + 2]); maxZ = Math.max(maxZ, l.data[i + 2]); }
    return { minX: minX - 20, maxX: maxX + 20, minZ: minZ - 20, maxZ: maxZ + 20 };
  });
}

/** Car position behind the start line of a level (the start piece's road runs along its own +z). */
export function levelStart(level: Level, area: LevelArea): { x: number; z: number; headingDeg: number } | null {
  const p = level.parts.find((q) => q.type === 'start');
  if (!p) return null;
  const f = placeTransform(partDef('start'), p.i, p.j, p.rot, 1);
  const [cx, cz] = f(0.5, 0.3), [fx, fz] = f(0.5, 0.7);     // 6 m before the line, heading along the road
  const [x, z] = tileToWorld(area, cx, cz);
  return { x, z, headingDeg: Math.atan2(fx - cx, fz - cz) * 180 / Math.PI };
}

export function findFlatSpawn(heightAt: (x: number, z: number) => number, x0: number, z0: number, headingDeg: number, maxR = 120): { x: number; z: number; groundY: number; roughness: number } {
  const hd = (headingDeg * Math.PI) / 180, sn = Math.sin(hd), cs = Math.cos(hd);
  const probe = (x: number, z: number) => {
    let lo = Infinity, hi = -Infinity;
    for (const lx of [-1, 0, 1]) for (const lz of [-2.2, -1.25, 0, 1.4, 2.3]) {
      const h = heightAt(x + lx * cs + lz * sn, z - lx * sn + lz * cs);
      if (!Number.isFinite(h)) return null;
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    return { hi, rough: hi - lo };
  };
  let best = { x: x0, z: z0, groundY: 0, roughness: Infinity };
  for (let r = 0; r <= maxR; r += 3) {
    const n = r === 0 ? 1 : Math.max(8, Math.round((2 * Math.PI * r) / 3));
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n, x = x0 + r * Math.cos(a), z = z0 + r * Math.sin(a);
      const p = probe(x, z);
      if (!p) continue;
      if (p.rough < best.roughness) best = { x, z, groundY: p.hi + 0.02, roughness: p.rough };
    }
    if (best.roughness < 0.22) break; // within suspension travel + floor clearance: closest such spot wins
  }
  if (!Number.isFinite(best.roughness)) best.groundY = 0;
  return best;
}

export class App {
  renderer!: GameRenderer;
  sim!: RoadsterSim;
  session!: SimSession;
  loop!: FixedStepLoop;
  readonly settings = new SettingsStore();
  input!: InputManager;
  hud!: Hud;
  menu!: Menu;
  audio = new AudioEngine();
  manual: ManualController | null = null;
  private prev!: VehicleState;
  private cur!: VehicleState;
  private view!: VehicleState;
  private lastInput: PlayerInput | null = null;
  private resultTimer = -1;
  private resultTelemetry: ReturnType<SimSession['recorder']['telemetry']['slice']> | null = null;
  private resultShown = false;
  /** Next time (performance.now) the pyramid fan hint may show again. */
  private pyramidHintAt = 0;
  private attract = true;           // title-screen demo run in the background
  ready = false;
  frameMs = 0;
  /** Current Phase-2 site (McGregor = the Phase-1 track). */
  siteId: SiteId = 'earth_mcgregor';
  private sunPanel: SunPanel | null = null;
  /** Roadster 1's orbit after a ram (Sun scene only). */
  private orbitPanel: OrbitPanel | null = null;
  private propPoses: PropPose[] = [];
  private switching = false;
  /** Track-editor level in the current world (Boca Chica) and its static colliders. */
  private levelScene: LevelScene | null = null;
  private extraShapes: LandmarkShape[] = [];
  /** McGregor renderer (created in init) and the lazily created world renderer, each with its own canvas. */
  private trackRenderer!: GameRenderer;
  private trackCanvas!: HTMLCanvasElement;
  private worldRenderer: GameRenderer | null = null;
  private worldCanvas: HTMLCanvasElement | null = null;
  private forceWebGL = false;
  /** Timings (ms) of the last startWorld() for diagnostics. */
  lastWorldTimings: Record<string, number> = {};

  constructor(readonly root: HTMLElement, public canvas: HTMLCanvasElement) {}

  async init(opts: AppOptions = {}): Promise<void> {
    if (opts.quality) this.settings.update((d) => { d.graphics.quality = opts.quality!; }, 'graphics.quality');
    const s = this.settings.get();
    this.forceWebGL = !!opts.forceWebGL;
    this.trackCanvas = this.canvas;
    this.trackRenderer = this.renderer = await GameRenderer.create(this.canvas, { quality: s.graphics.quality, forceWebGL: opts.forceWebGL });
    await Promise.all([this.renderer.loadCar().catch(() => null), this.renderer.loadProps().catch(() => null)]);
    this.sim = await createRoadsterSim();
    this.input = new InputManager(this.root, s.controls);
    this.hud = new Hud(this.root);
    this.menu = new Menu(this.root, { settings: this.settings, input: this.input, backdrop: 'scene', worlds: true });
    this.audio.unlockOn(window);
    this.wireMenu();
    this.applySettings(s);

    this.loop = new FixedStepLoop(SIM_DT, { step: () => this.simStep(), render: (a, dt) => this.renderFrame(a, dt) });
    const resize = () => this.renderer.resize(this.canvas.clientWidth || window.innerWidth, this.canvas.clientHeight || window.innerHeight);
    window.addEventListener('resize', resize);
    resize();

    // Title screen over a live demo: the autopilot flies the kickflip with the broadcast cameras.
    this.startSession({ kind: 'auto', stunt: 'kickflip' }, true);
    if (!opts.skipMenu) this.menu.show('title');
    this.loop.start();
    this.ready = true;
  }

  // ---------------------------------------------------------------- sessions
  private makeController = (sim: RoadsterSim, mode: SessionMode): Controller => {
    if (mode.kind === 'auto') return new Autopilot(sim, mode.stunt, { noiseSeed: this.settings.get().realism.sensorNoise ? (Date.now() & 0xffff) : null });
    this.manual = new ManualController(sim, new ManualAssist()); // fresh assist state per session
    this.manual.assist = this.settings.get().assistDefault;
    return this.manual;
  };

  startSession(mode: SessionMode, attract = false, assist?: AssistLevel): void {
    this.attract = attract;
    this.manual = null;
    // the demo and the auto stunts never take damage
    setDamageMode(this.sim, attract || mode.kind === 'auto' ? 'off' : this.settings.get().realism.damage);
    this.session = new SimSession(this.sim, mode, this.makeController);
    if (assist && this.manual) (this.manual as ManualController).assist = assist;
    this.session.infiniteAir = this.settings.get().realism.infiniteAir;
    this.prev = cloneState(this.sim.getState());
    this.cur = cloneState(this.sim.getState());
    this.view = cloneState(this.sim.getState());
    this.resultTimer = -1;
    this.resultShown = false;
    this.resultTelemetry = null;
    if (this.loop) { this.loop.resetAccumulator(); this.loop.timeScale = 1; }
    this.renderer.resetEffects();
    this.hud?.reset();
    this.audio.reset();
    this.renderer.setBroadcastStunt(mode.stunt ?? null);
    this.renderer.setCameraMode(mode.kind === 'auto' ? 'broadcast' : 'chase');
    if (mode.kind === 'auto') this.renderer.setBroadcastShot('auto');
  }

  startStunt(stunt: StuntId): void {
    if (this.siteId !== 'earth_mcgregor') { void this.startWorld('earth_mcgregor').then(() => this.startStunt(stunt)); return; }
    this.startSession({ kind: 'auto', stunt });
  }
  startFreePlay(stunt: StuntId = 'ground_flip', assist?: AssistLevel): void {
    if (this.siteId !== 'earth_mcgregor') { void this.startWorld('earth_mcgregor').then(() => this.startFreePlay(stunt, assist)); return; }
    this.startSession({ kind: 'manual', stunt }, false, assist);
  }

  /**
   * Switch to a Phase-2 site: renderer (terrain/sky/sun) and physics (same heights as rendered,
   * gravity/air of the body) are rebuilt; the session starts in free flight at the site's spawn.
   */
  /** Physics of a terrain or space site: heightmap, landmark colliders (+ the level's solids), movable props. */
  private async createSiteSim(site: SiteDef, w: WorldHandle | null): Promise<RoadsterSim> {
    const t = w?.terrain;
    const spc = w?.spawn ?? { x: site.spawn.pos.x, z: site.spawn.pos.z };
    // full-resolution physics around the spawn (the coarse outer ring differs by ~10 cm from the render mesh)
    // and under the pyramid talus (it must meet the exact ground, else the car trips over its lip)
    const landmarks = [...(w?.collisionShapes() ?? []), ...this.extraShapes];
    const fineAreas = pyramidCourts(landmarks);
    // movable, breakable landmarks (LM, LRV, rovers; Roadster 1 in the Sun scene)
    const props = w?.dynamicProps?.() ?? [];
    const sim = await createRoadsterSim(t
      ? { ground: 'terrain', terrain: { heights: t.heights, size: t.size, extentM: t.extentM, fineCenter: { x: spc.x, z: spc.z }, fineAreas }, landmarks, props }
      : { ground: 'space', props });
    sim.setEnvironment(environmentFor(site.id));
    return sim;
  }

  /** Back to the title menu over the McGregor demo. */
  private quitToTitle(): void {
    this.levelMode = false;
    const go = () => { this.startSession({ kind: 'auto', stunt: 'kickflip' }, true); this.menu.show('title'); };
    if (this.siteId !== 'earth_mcgregor') void this.startWorld('earth_mcgregor').then(go); else go();
  }

  // ---------------------------------------------------------------- track editor
  private editor: import('../editor/EditorScreen').EditorScreen | null = null;
  /** A level of the editor is being driven: Esc returns to the editor instead of the pause menu. */
  private levelMode = false;

  /** Opens the track editor (loaded on demand); the 3D scene pauses behind it. */
  async openEditor(): Promise<void> {
    const { EditorScreen } = await import('../editor/EditorScreen');
    this.menu.hide();
    if (!this.editor) {
      this.editor = new EditorScreen({
        testDrive: async (level) => {
          this.editor?.hide();
          this.levelMode = true;
          this.input.setContext('game');
          await this.playLevel(level);
          this.hud.flash(et('race.toEditor'), 'info', 4000);
        },
        exit: () => { this.editor?.hide(); this.input.setContext('game'); this.quitToTitle(); },
      }, this.root);
    } else this.editor.show();
    this.input.setContext('menu');
    this.loop.paused = true;
  }

  private levelRun: LevelRun | null = null;
  private raceHud: RaceHud | null = null;
  /** Starship launch of the level (from the moment it is armed). */
  private launch: LaunchShow | null = null;

  /** Time trial and special pieces of the driven level (src/game/levelRun.ts). */
  private updateLevelRun(dt: number): void {
    const run = this.levelRun!;
    const s = this.sim.getState();
    const evs = run.update(dt, {
      x: s.pos.x, y: s.pos.y, z: s.pos.z, vx: s.linVel.x, vz: s.linVel.z, speedMs: s.speedMs, grounded: s.groundContact,
    }, {
      boost: (dx, dz, dv) => this.sim.body.applyImpulse({ x: dx * dv * s.massKg, y: 0, z: dz * dv * s.massKg }, true),
      refill: (d) => { const tk = this.sim.propulsion.tank; tk.fill(Math.min(ROADSTER.tank.fullMassKg, tk.m + AIR_STATION_KG_S * d)); },
    });
    for (const e of evs) {
      if (e.kind === 'boost') this.hud.flash(upper(et('special.boost')), 'info', 1200);
      else if (e.kind === 'offTrack') this.hud.flash(upper(et('race.offTrack')), 'warn', 1500);
      else if (e.kind === 'skipped') this.hud.flash(et('race.missed', { n: e.n }), 'warn', 2500);
      else if (e.kind === 'finish') this.hud.flash(et('race.finish', { time: fmtTime(e.timeS + e.penaltyS) }) + (e.best ? ' ★' : ''), 'info', 6000);
      else if (e.kind === 'launchArmed') this.hud.flash(upper(et('special.launch', { s: e.countdownS })), 'warn', 4000);
    }
    if (evs.some((e) => e.kind === 'refill')) this.hud.flash(et('special.refill'), 'info', 600);
    this.raceHud?.update(run);
    if (run.launchIn !== null) {
      this.launch ??= new LaunchShow(this.renderer, this.root, this.audio);
      this.launch.update(run, dt, s.pos, this.settings.get().units, {
        push: (x, y, z) => this.sim.body.applyImpulse({ x: x * s.massKg, y: y * s.massKg, z: z * s.massKg }, true),
        flash: (text, kind, ms) => this.hud.flash(text, kind, ms),
        stackSolid: (on) => this.setStackSolid(on),
      });
    }
  }

  /** The box collider of the Starbase stack on mount A (off while the stack is in the air). */
  private setStackSolid(on: boolean): void {
    for (const [h, info] of this.sim.colliderInfo) if (info.id.startsWith('starship_stack')) this.sim.world.getCollider(h)?.setEnabled(on);
  }

  private endLaunch(): void {
    if (!this.launch) return;
    this.launch.dispose();
    this.launch = null;
    this.setStackSolid(true);
  }

  /** Test hook: move the launch clock on by `seconds` of game time (the countdown stops a frame before zero), or set
   *  it to mission time `met` (negative = countdown). Returns the mission time. */
  launchWarp(seconds: number, met?: number): number | null {
    const r = this.levelRun;
    if (!r || r.launchIn === null) return null;
    if (met !== undefined) {
      if (met < 0) { r.launchIn = -met; r.launchFired = false; r.launchT = 0; } else { r.launchIn = 0; r.launchFired = true; r.launchT = gameAt(met); }
    } else if (!r.launchFired) r.launchIn = Math.max(0.001, r.launchIn - seconds);
    else r.launchT += seconds;
    return LaunchShow.met(r);
  }

  private backToEditor(): void {
    this.loop.paused = true;
    this.input.setContext('menu');
    this.editor?.show();
  }

  /** Removes the track-editor level from the world (next physics build without its colliders). */
  private clearLevel(): void {
    this.endLaunch();
    this.levelRun = null;
    this.raceHud?.dispose();
    this.raceHud = null;
    this.levelScene?.group.removeFromParent();
    this.levelScene?.dispose();
    this.levelScene = null;
    this.extraShapes = [];
  }

  /**
   * Drives a track-editor level: loads Boca Chica if needed, puts the pieces into the world and the physics and
   * the car behind the start line (or at the west end of the build field without a start piece).
   */
  async playLevel(level: Level): Promise<void> {
    const id: SiteId = 'earth_bocachica';
    if (this.siteId !== id || !this.renderer.worldHandle?.buildArea) await this.startWorld(id);
    const w = this.renderer.worldHandle;
    const area = w?.buildArea as LevelArea | null | undefined;
    if (!w || !area) throw new Error('the site has no build area');
    this.clearLevel();
    this.levelScene = buildLevelScene(level, area);
    w.group.add(this.levelScene.group);
    this.extraShapes = this.levelScene.shapes;
    this.loop.paused = true;
    try {
      this.sim.dispose();
      this.sim = await this.createSiteSim(siteDef(id), w);
      this.sim.surface = siteDef(id).surface;
      this.sim.hardGround = [];
      this.applySettings(this.settings.get());
      const s = levelStart(level, area) ?? { x: w.spawn.x, z: w.spawn.z, headingDeg: w.spawn.headingDeg };
      const spawn = spawnPose({ x: s.x, y: area.y, z: s.z }, s.headingDeg, 0);
      this.startSession({ kind: 'manual', spawn, siteId: id }, false);
      // best time per track layout (the parts, not the name)
      let hash = 0;
      for (const ch of JSON.stringify(level.parts)) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
      this.levelRun = new LevelRun(level, area, `rft.best.${(hash >>> 0).toString(36)}`);
      this.raceHud ??= new RaceHud(this.root);
    } finally {
      this.loop.paused = false;
    }
  }

  async startWorld(id: SiteId, assist?: AssistLevel): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    this.clearLevel();
    this.loop.paused = true;
    const overlay = this.showLoading(siteDef(id));
    const T: Record<string, number> = {}; let tm = performance.now();
    const lap = (k: string) => { const n = performance.now(); T[k] = Math.round(n - tm); tm = n; };
    try {
      const site = siteDef(id);
      const track = site.ground === 'track';
      // the old sim goes once the new one is being built (the loop is paused while switching)
      let simP: Promise<RoadsterSim> | null = null;
      let oldSimGone = false;
      const buildSim = async (w: WorldHandle | null): Promise<RoadsterSim> => {
        if (!oldSimGone) { oldSimGone = true; this.sim.dispose(); }
        let sim: RoadsterSim;
        if (track) {
          sim = await createRoadsterSim();
          sim.setEnvironment(EARTH);
        } else {
          sim = await this.createSiteSim(site, w);
        }
        sim.surface = site.surface;
        // the pyramid courts are levelled bedrock, not the site's sand
        sim.hardGround = track ? [] : pyramidCourts(w?.collisionShapes() ?? []);
        return sim;
      };
      const onWorld = (w: WorldHandle) => {
        const stale = simP; // a failed setSite already built one: drop it
        simP = buildSim(w);
        void stale?.then((sm) => sm.dispose()).catch(() => {});
      };
      if (id !== this.siteId) {
        // two persistent renderers, each on its own canvas – McGregor (standard depth buffer, the post
        // nodes were tuned with it) and the worlds (reversed depth for 30–120 km). Nothing is disposed:
        // returning to McGregor is instant, and between worlds only the world is rebuilt (setSite),
        // so the renderer keeps its device and its cached pipelines (car, effects, post chain).
        const next = track ? this.trackRenderer : this.worldRenderer;
        const nextCanvas = track ? this.trackCanvas : (this.worldCanvas ??= this.makeCanvas());
        // (no wait for the old renderer: it is only hidden – renderFrame() stops drawing while switching)
        this.showCanvas(nextCanvas);
        lap('dispose');
        if (track) {
          this.renderer = this.trackRenderer;
        } else {
          let r = next;
          if (r && r.currentSite?.id !== id) {
            // a failed rebuild leaves no usable world in it: start over with a fresh world renderer
            try { await r.setSite(site, onWorld); } catch (e) { console.warn('[app] site switch in the world renderer failed, rebuilding:', e); r.dispose(); r = this.worldRenderer = null; }
          } else if (r) r.timings = {}; // same world as last time: keep it as it is
          r ??= this.worldRenderer = await GameRenderer.create(this.worldCanvas = this.replaceCanvas(nextCanvas), {
            quality: this.settings.get().graphics.quality, forceWebGL: this.forceWebGL, site, onWorld,
          });
          this.renderer = r;
        }
        lap(track ? 'renderer' : next ? 'setSite' : 'rendererCreate');
        if (!track) for (const [k, v] of Object.entries(this.renderer.timings)) T['r.' + k] = v;
        const cw = this.canvas.clientWidth || window.innerWidth, ch = this.canvas.clientHeight || window.innerHeight;
        const st = this.renderer.getStats();
        if (Math.floor(cw) !== st.width || Math.floor(ch) !== st.height) this.renderer.resize(cw, ch); // avoid needless RT re-allocation
      }
      // physics: started as soon as the world's heights/landmarks exist (overlaps the shader compilation)
      simP ??= buildSim(this.renderer.worldHandle);
      this.sim = await simP;
      const w = this.renderer.worldHandle;
      lap('physics');
      this.applySettings(this.settings.get());
      this.siteId = id;
      this.sunPanel?.dispose();
      this.orbitPanel?.dispose();
      this.orbitPanel = id === 'space_sun' && this.sim.props ? new OrbitPanel(this.root) : null;
      this.sunPanel = id === 'space_sun' ? new SunPanel(this.root, (label, final) => this.hud.flash(upper(label), final ? 'warn' : 'info', final ? 6000 : 2600)) : null;
      if (track) {
        this.startSession({ kind: 'manual', stunt: 'ground_flip' }, false, assist);
      } else {
        const sp0 = w?.spawn ?? { x: site.spawn.pos.x, y: 0, z: site.spawn.pos.z, headingDeg: site.spawn.headingDeg };
        const sp = { ...sp0 };
        let gy = site.ground === 'space' ? sp.y : 0;
        if (site.ground !== 'space' && w) {
          const fp = findFlatSpawn((x, z) => w.heightAt(x, z), sp.x, sp.z, sp.headingDeg);
          sp.x = fp.x; sp.z = fp.z; gy = fp.groundY;
        }
        const spawn = spawnPose({ x: sp.x, y: gy, z: sp.z }, sp.headingDeg, 0);
        this.startSession({ kind: 'manual', spawn, siteId: id }, false, assist);
      }
      lap('session');
    } finally {
      this.lastWorldTimings = T;
      overlay.remove();
      this.loop.paused = false;
      this.switching = false;
    }
  }
  private makeCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.style.cssText = this.trackCanvas.style.cssText;
    c.style.display = 'none';
    this.trackCanvas.after(c);
    return c;
  }

  /** After a dispose a WebGL2 canvas has lost its context: a new renderer needs a fresh canvas. */
  private replaceCanvas(c: HTMLCanvasElement): HTMLCanvasElement {
    if (!c.dataset.used) { c.dataset.used = '1'; return c; }
    const fresh = document.createElement('canvas');
    fresh.style.cssText = c.style.cssText;
    fresh.dataset.used = '1';
    c.replaceWith(fresh);
    if (this.canvas === c) this.canvas = fresh;
    return fresh;
  }

  /** Show one renderer's canvas; the other one stays alive but hidden (and is not rendered). */
  private showCanvas(c: HTMLCanvasElement): void {
    for (const k of [this.trackCanvas, this.worldCanvas]) if (k) k.style.display = k === c ? 'block' : 'none';
    this.canvas = c;
  }
  restart(): void {
    this.startSession(this.session.mode, this.attract, this.manual?.assist);
    this.endLaunch();                                   // one launch per run: a restart puts the stack back
    this.levelRun = this.levelRun?.fresh() ?? null;     // a restart of a level starts a new lap
  }

  // ---------------------------------------------------------------- menu / settings
  private wireMenu(): void {
    const m = this.menu;
    m.on('startStunt', (id) => { m.hide(); this.startStunt(id); });
    m.on('startFree', ({ assist, site }) => { m.hide(); this.startFreePlay(site, assist); });
    m.on('resume', () => { m.hide(); });
    m.on('restart', () => { m.hide(); this.restart(); });
    m.on('quitToTitle', () => this.quitToTitle());
    m.on('openEditor', () => void this.openEditor());
    m.on('startWorld', ({ site }) => { m.hide(); void this.startWorld(site as SiteId); });
    m.on('settingsChanged', (s) => this.applySettings(s));
    m.on('uiSound', (k) => this.audio.playUi(k));
    m.on('screenChange', (screen) => {
      const open = screen !== 'none';
      this.input.setContext(open ? 'menu' : 'game');
      this.audio.duck(open ? 0.8 : 0);
      // Pause the simulation in pause/settings/help during a run; keep the attract demo and results running.
      this.loop.paused = open && !this.attract && screen !== 'results';
    });
  }

  private applySettings(s: Readonly<Settings>): void {
    this.input.setOptions(s.controls);
    cameraInput.rightButton = !s.controls.mouseAttitude; // the right button turns the chase camera unless it steers
    this.audio.setVolume(s.audio);
    this.hud.setVisible(s.hud.visible);
    if (this.renderer.getStats().quality !== s.graphics.quality) this.renderer.setQuality(s.graphics.quality);
    this.sim?.propulsion.setCompressor(s.refillRate); // 'game' = Fun: 20 s on every world, 'realistic': 6–7 h, Earth only
    if (this.session) this.session.infiniteAir = s.realism.infiniteAir;
  }

  // ---------------------------------------------------------------- loop
  private simStep(): void {
    if (this.switching) return;
    copyStateInto(this.prev, this.cur);
    this.session.step();
    copyStateInto(this.cur, this.sim.getState());
    if (this.session.outcome.status !== 'running' && this.resultTimer < 0) {
      this.resultTimer = RESULT_DELAY_S;
      this.resultTelemetry = this.session.recorder.telemetry.slice();
      if (!this.attract) {
        if (this.session.outcome.status === 'success') { this.audio.cheer(1); this.hud.flash(t('flash.success'), 'success'); }
        else this.hud.flash(t('flash.failed'), 'warn');
      }
    }
  }

  private renderFrame(alpha: number, dt: number): void {
    if (this.switching) return; // renderer/sim are being rebuilt
    const t0 = performance.now();
    const input = this.input.poll(dt);
    this.lastInput = input;
    if (this.editor?.visible) {
      // the track editor covers the screen and takes the keyboard itself
    } else if (this.menu.isOpen()) {
      this.menu.nav(input.menuNav);
    } else {
      if (this.levelMode && input.pressed.menu) this.backToEditor();
      else if (input.pressed.menu || input.pressed.pause) this.menu.show('pause');
      if (input.pressed.help) this.menu.show('help');
      if (this.manual) {
        this.manual.drive = input.drive;
        Object.assign(this.manual.axes, input.thrust);
        if (input.pressed.fanModeCycle) this.hud.flash(t('flash.fan', { mode: upper(FAN_LABEL[this.manual.cycleFan()]) }));
        if (input.pressed.aeroModeCycle) this.hud.flash(t('flash.aero', { mode: upper(AERO_LABEL[this.manual.cycleAero()]) }));
        if (input.pressed.assistCycle) this.hud.flash(t('flash.assist', { mode: upper(ASSIST_LABEL[this.manual.cycleAssist()]) }));
        if (input.pressed.refillToggle) {
          this.manual.refill = !this.manual.refill;
          // "Compressor: Realistic" on the Moon, Mars or in space: say why the tank does not fill
          if (this.manual.refill && !this.sim.compressorAvailable) this.hud.flash(t('flash.compressorNoAir'), 'warn', 5000);
          else this.hud.flash(t(this.manual.refill ? 'flash.compressorOn' : 'flash.compressorOff'));
        }
        // pyramid faces need the fan suction: hint (at most every 20 s) while on steep stone without GRIP
        if (steepStoneWithoutGrip(this.sim, this.manual.fanMode) && performance.now() > this.pyramidHintAt) { this.pyramidHintAt = performance.now() + 20_000; this.hud.flash(t('pyramid.needFans', { mode: upper(FAN_LABEL.grip) }), 'warn', 4500); }
      }
      if (input.pressed.cameraCycle) this.renderer.cycleCamera();
      if (input.pressed.reset) this.restart();
      if (input.pressed.slowMo) this.loop.timeScale = this.loop.timeScale < 1 ? 1 : 0.25;
      if (input.pressed.photoMode) this.renderer.setCameraMode(this.renderer.cameraMode === 'photo' ? 'chase' : 'photo');
    }

    // results / attract loop
    if (this.resultTimer >= 0 && !this.resultShown && !this.menu.isOpen() && !this.loop.paused) {
      this.resultTimer -= dt;
      if (this.resultTimer <= 0) {
        this.resultShown = true;
        if (this.attract) { this.startSession(this.session.mode, true); }
        else if (this.session.mode.kind === 'auto') this.showResults();
      }
    }

    interpolateState(this.view, this.prev, this.cur, alpha);
    const tel = this.session.telemetry();
    const simDt = this.loop.paused ? 0 : dt * this.loop.timeScale;
    this.renderer.update(this.view, tel, simDt);
    if (this.levelRun && simDt > 0) this.updateLevelRun(simDt);
    const s = this.settings.get();
    const mode = this.session.mode;
    this.hud.setVisible(s.hud.visible && !this.menu.isOpen());
    // launch start on the telemetry clock (the stunt clock runs a step or two apart from tel.t)
    const stuntCtl = (this.session.controller as { stunt?: { phaseTime: number } } | undefined)?.stunt;
    this.hud.update(tel, this.view, {
      mode: mode.kind, stunt: mode.stunt, assist: this.manual?.assist, units: s.units,
      scale: s.hud.scale, extras: s.hud.showExtras, timerT0: stuntCtl ? tel.t - stuntCtl.phaseTime : undefined,
      compressor: !this.manual?.refill ? undefined
        : !this.sim.compressorAvailable ? 'noAir'
        : tel.airMassKg >= ROADSTER.tank.fullMassKg * 0.999 ? 'full' : 'filling',
      resetHint: this.view.damage?.totalLoss ? this.resetHint() : undefined,
    });
    const cam = this.renderer.camera;
    const fwd = v3(), up = v3();
    const e = cam.matrixWorld.elements;
    fwd.x = -e[8]; fwd.y = -e[9]; fwd.z = -e[10];
    up.x = e[4]; up.y = e[5]; up.z = e[6];
    this.audio.update(this.view, tel, { pos: { x: cam.position.x, y: cam.position.y, z: cam.position.z }, forward: fwd, up });
    const props = this.sim.props;
    if (props) {
      this.renderer.worldHandle?.setPropPoses?.(props.poses(this.propPoses));
      if (this.orbitPanel) {
        const v = props.velocity(0), v0 = props.objects[0].placement.linVel ?? { x: 0, y: 0, z: 0 };
        this.orbitPanel.update({ x: v.x - v0.x, y: v.y - v0.y, z: v.z - v0.z }, this.sim.getState().massKg);
      }
    }
    if (this.sunPanel) {
      const T = this.sunPanel.update(this.loop.paused ? 0 : dt);
      this.renderer.worldHandle?.heat?.set({ surfaceTempK: T });
    }
    this.renderer.render();
    this.frameMs = performance.now() - t0;
  }

  /** Full-screen loading card while a site is built (the render loop is suspended meanwhile). */
  private showLoading(site: { name: string; subtitle: string; coords: string; body: string }): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'rft-loading';
    el.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;'
      + 'background:radial-gradient(ellipse at center,#141414 0%,#000 70%);color:#fff;z-index:50;'
      + 'font:600 14px/1.6 "RFT Display",system-ui,"Noto Sans",sans-serif;letter-spacing:.12em;text-transform:uppercase';
    const esc = (v: string) => v.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    el.innerHTML = `<div style="opacity:.6;font-size:12px">${esc(t('loading.site'))}</div>`
      + `<div style="font-size:34px;letter-spacing:.08em;margin:6px 0 2px">${esc(site.name)}</div>`
      + `<div style="opacity:.75">${esc(site.subtitle)}</div>`
      + `<div style="opacity:.45;font-size:12px;margin-top:4px">${esc(site.coords)}</div>`
      + `<div style="margin-top:26px;width:220px;height:2px;background:rgba(255,255,255,.15);overflow:hidden">`
      + `<div style="width:40%;height:100%;background:#e8212b;animation:rftload 1.1s ease-in-out infinite"></div></div>`
      + `<style>@keyframes rftload{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}</style>`;
    this.root.appendChild(el);
    return el;
  }

  private showResults(): void {
    const r = this.session.outcome.result as (StuntResult & { startT?: number }) | undefined;
    const mode = this.session.mode;
    const stunt = mode.stunt; // undefined: free run ended by a total loss (no stunt reference)
    // Only show figures that have a video reference, plus air used and duration.
    const keys = new Set([...(stunt ? Object.keys(siteFor(stunt).reference) : []), 'airUsedKg', 'durationS']);
    const metrics: Record<string, number> = {};
    for (const [k, v] of Object.entries(r?.metrics ?? {})) if (keys.has(k) && Number.isFinite(v)) metrics[k] = v;
    if (r) { metrics.airUsedKg ??= r.airUsedKg; metrics.durationS ??= r.durationS; }
    const tel = this.resultTelemetry ?? this.session.recorder.telemetry.slice();
    let startT = r?.startT;
    if (startT === undefined && stunt === 'zero60') startT = tel.find((f) => f.speedMs > 0.3)?.t;
    this.menu.showResults({
      mode: mode.kind, stunt, success: this.session.outcome.status === 'success',
      reason: r?.reason ?? this.session.outcome.reason, metrics, telemetry: tel, startT,
      damage: this.sim.getState().damage ? structuredClone(this.sim.getState().damage) : undefined,
    });
  }

  /** Reset control for on-screen hints: key · gamepad button · touch button (↺). */
  private resetHint(): string {
    const keys = this.input.hint('reset'), pad = this.input.hint('reset', 'gamepad');
    return [keys, pad !== keys ? pad : '', '↺'].filter(Boolean).join(' · ');
  }

  get playerInput(): PlayerInput | null { return this.lastInput; }
}
