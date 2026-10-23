// The Starship launch of a track-editor level (docs/EDITOR.md): runs on the launch clock of the LevelRun (countdown,
// then game seconds since liftoff → mission time with the time lapse of src/shared/starshipFlight.ts) and drives the
// 3D side (src/render/level/starshipLaunch.ts), the on-screen side (src/editor/launchHud.ts), the pressure wave on
// the car and the rumble. Created when a launch is armed, disposed on restart or when the level goes.
import * as THREE from 'three/webgpu';
import type { GameRenderer } from '../render';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Units } from '../ui/units';
import type { LevelRun } from './levelRun';
import { StarshipLaunchVisuals } from '../render/level/starshipLaunch';
import { LaunchHud, type LaunchHudFrame } from '../editor/launchHud';
import { et } from '../editor/i18n';
import {
  BLAST_RADIUS_M, BOOSTER_CATCH_T, ENTRY_T, SHIP_CATCH_T, SOUND_MS, blastDv, boosterState, eventsBetween, metAt, returnsIn,
  shipState, warpAt, type LaunchEvent, type V3,
} from '../shared/starshipFlight';

/** Viewpoint shown to the player: Highway 4 south of the launch site, ≈ 540 m from mount A, both towers in view (world m). */
export const LAUNCH_VIEWPOINT = { x: 650, z: 880 };
/** Jet blast right at the mount during the first seconds (radius m, extra acceleration m/s² at the mount). */
const JET_BLAST_M = 150, JET_BLAST_A = 28;

export interface LaunchCar { x: number; y: number; z: number }
export interface LaunchEffects {
  /** Add a velocity change (m/s) to the car. */
  push(dvx: number, dvy: number, dvz: number): void;
  flash(text: string, kind: 'info' | 'success' | 'warn', ms: number): void;
  /** Stack collider on mount A on/off (it stands only while the stack or the caught booster is there). */
  stackSolid(on: boolean): void;
}

const _v = new THREE.Vector3(), _c = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3();

export class LaunchShow {
  readonly hud: LaunchHud;
  visuals: StarshipLaunchVisuals | null = null;
  private lastMet = -Infinity;
  private solid = true;
  private hitByWave = false;

  constructor(private renderer: GameRenderer, root: HTMLElement, private audio: AudioEngine) {
    this.hud = new LaunchHud(root);
    const w = renderer.worldHandle;
    if (w) {
      const vy = w.heightAt(LAUNCH_VIEWPOINT.x, LAUNCH_VIEWPOINT.z);
      const st = renderer.getStats();
      this.visuals = StarshipLaunchVisuals.create(w.group, (x, z) => w.heightAt(x, z), st.quality, st.backend === 'webgl2',
        { x: LAUNCH_VIEWPOINT.x, y: Number.isFinite(vy) ? vy : 0, z: LAUNCH_VIEWPOINT.z }, w.sunLight.intensity);
      if (this.visuals) renderer.tagEffects();
      else console.warn('[launch] Starbase stack or towers missing: launch without 3D');
    }
  }

  /** Mission time of the run's launch clock (negative = countdown); null when no launch is armed. */
  static met(run: LevelRun): number | null {
    if (run.launchFired) return metAt(run.launchT);
    return run.launchIn === null ? null : -run.launchIn;
  }

  update(run: LevelRun, dt: number, car: LaunchCar, units: Units, fx: LaunchEffects): void {
    const met = LaunchShow.met(run);
    if (met === null) return;
    const b = boosterState(met), s = shipState(met);
    const cam = this.renderer.camera;
    this.visuals?.update({ met, booster: b, ship: s }, cam, dt);
    const pad: V3 = this.visuals?.padA ?? { x: 656, y: 20.5, z: 344.5 };
    const dist = Math.hypot(car.x - pad.x, car.z - pad.z);
    // ---- ticker (a jump of the test hook passes many events at once: the last four)
    if (met > this.lastMet) {
      const evs: LaunchEvent[] = eventsBetween(this.lastMet, met).slice(-4);
      for (const e of evs) {
        this.hud.event(e);
        if (e.msg === 'caught') fx.flash(et('launch.ev.caught', { stage: e.stage === 'booster' ? 'SUPER HEAVY' : 'STARSHIP' }).toUpperCase(), 'success', 5000);
      }
    }
    // ---- pressure wave: the front leaves the mount at liftoff with the speed of sound, pushes cars inside the ring
    if (!this.hitByWave && dist < BLAST_RADIUS_M) {
      const tFront = dist / SOUND_MS;
      if (this.lastMet < tFront && met >= tFront) {
        this.hitByWave = true;
        const dv = blastDv(dist), ux = (car.x - pad.x) / (dist || 1), uz = (car.z - pad.z) / (dist || 1);
        fx.push(ux * dv, dv * 0.35, uz * dv);
        fx.flash(et('launch.blast').toUpperCase(), 'warn', 2500);
      }
    }
    if (met > 0 && met < 8 && dist < JET_BLAST_M && dt > 0) {
      const a = JET_BLAST_A * (1 - dist / JET_BLAST_M) ** 2 * (1 - met / 8) * dt, ux = (car.x - pad.x) / (dist || 1), uz = (car.z - pad.z) / (dist || 1);
      fx.push(ux * a, a * 0.2, uz * a);
    }
    // ---- stack collider: gone with the liftoff, back with the caught booster
    const solid = this.visuals?.stackSolid ?? true;
    if (solid !== this.solid) { this.solid = solid; fx.stackSolid(solid); }
    // ---- rumble, delayed by the sound travel time from the burning stage
    const vis = this.visuals;
    let level = 0, crackle = 0;
    if (vis) {
      for (const [st, p, n] of [[b, vis.boosterPos, 33], [s, vis.shipPos, 6]] as const) {
        const d = Math.hypot(p.x - car.x, p.y - car.y, p.z - car.z);
        if (d > 60_000) continue;
        const late = met - d / SOUND_MS;
        const eng = (st === b ? boosterState(late) : shipState(late)).engines;
        if (!eng) continue;
        const l = Math.sqrt(eng / n) * Math.min(1, 900 / (d + 250));
        level = Math.max(level, l); crackle = Math.max(crackle, Math.min(1, 3000 / (d + 500)));
      }
    }
    this.audio.rocketSound(level, crackle);
    // ---- HUD
    _v.set(pad.x - cam.position.x, 0, pad.z - cam.position.z);
    cam.getWorldDirection(_f); _f.y = 0; _f.normalize();
    _r.set(-_f.z, 0, _f.x);
    const vp = vis?.viewpoint ?? { ...LAUNCH_VIEWPOINT, y: 0 };
    this.hud.update({
      met, warp: warpAt(met), units, padDist: dist, padBearing: Math.atan2(_v.dot(_r), _v.dot(_f)), viewDist: Math.hypot(car.x - vp.x, car.z - vp.z),
      inZone: dist < BLAST_RADIUS_M, booster: b, ship: s, boosterIn: returnsIn('booster', met), shipIn: met >= ENTRY_T ? returnsIn('ship', met) : null,
      mark: vis ? this.marker(met, vis, car) : null,
    });
    this.lastMet = met;
  }

  /** Screen marker of the returning stage: on it when visible, else an arrow at the screen edge towards it. */
  private marker(met: number, vis: StarshipLaunchVisuals, car: LaunchCar): LaunchHudFrame['mark'] {
    const stage = met >= 175 && met < BOOSTER_CATCH_T ? 'booster' : met >= ENTRY_T + 400 && met < SHIP_CATCH_T ? 'ship' : null;
    if (!stage) return null;
    const p = stage === 'booster' ? vis.boosterPos : vis.shipPos;
    const cam = this.renderer.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const camSpace = _c.copy(p).applyMatrix4(cam.matrixWorldInverse);
    const ndc = _v.copy(p).project(cam);
    const behind = camSpace.z > 0;
    const onScreen = !behind && Math.abs(ndc.x) < 0.92 && Math.abs(ndc.y) < 0.85;
    const dist = Math.hypot(p.x - car.x, p.y - car.y, p.z - car.z);
    if (onScreen) return { stage, x: (ndc.x + 1) / 2 * W, y: (1 - ndc.y) / 2 * H, onScreen, angle: 0, dist };
    let dx = behind ? -ndc.x : ndc.x, dy = behind ? -ndc.y : ndc.y;
    if (behind && Math.hypot(dx, dy) < 1e-3) dy = -1;
    const k = 1 / Math.max(Math.abs(dx) / 0.86, Math.abs(dy) / 0.72, 1e-6);
    dx *= k; dy *= k;
    return { stage, x: (dx + 1) / 2 * W, y: (1 - dy) / 2 * H, onScreen: false, angle: Math.atan2(dx, dy), dist };
  }

  dispose(): void {
    this.visuals?.dispose();
    this.visuals = null;
    this.hud.dispose();
    this.audio.rocketSound(0, 0);
  }
}
