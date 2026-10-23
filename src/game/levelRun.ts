// A drive through a track-editor level: the time trial as in the classic DOS racers (the clock starts with the first
// metre, every course piece is a section to pass in order, leaving the track costs its time as penalty, skipping
// sections costs 5 s each) and the special pieces (boost pad, air station, launch clearance with the countdown of
// the Starship launch). Pure logic: the App feeds the car state and applies the effects through callbacks.
import { buildCourse, type Course } from '../shared/course';
import { partDef, placeTransform } from '../shared/parts';
import { partTiles, type Level } from '../shared/level';

export interface RunArea { minX: number; minZ: number; tileM: number; y: number }
export interface RunCar { x: number; y: number; z: number; vx: number; vz: number; speedMs: number; grounded: boolean }
export interface RunEffects {
  /** Add speed (m/s) along the horizontal unit direction (dx, dz). */
  boost(dx: number, dz: number, dv: number): void;
  /** Refill the tank for dt seconds at the station rate. */
  refill(dt: number): void;
}
export type RunEvent =
  | { kind: 'start' } | { kind: 'section'; n: number; of: number } | { kind: 'skipped'; n: number }
  | { kind: 'offTrack' } | { kind: 'finish'; timeS: number; penaltyS: number; best: boolean }
  | { kind: 'boost' } | { kind: 'refill' } | { kind: 'launchArmed'; countdownS: number } | { kind: 'launch' };

export const SKIP_PENALTY_S = 5;
const BOOST_DV = 12, BOOST_COOLDOWN_S = 1.5;
/** Countdown of the Starship launch announced at the finish when the course has no launch clearance (s). */
export const FINISH_LAUNCH_S = 60;

export class LevelRun {
  readonly course: Course | null;
  state: 'ready' | 'running' | 'finished' = 'ready';
  /** Driving time and penalty (s). */
  t = 0; penalty = 0;
  /** Index into course.order of the last section passed. */
  progress = 0;
  missed = 0;
  /** Seconds until the Starship launch once armed; null = not armed; fired after it reached 0. */
  launchIn: number | null = null;
  launchFired = false;
  /** Game seconds since liftoff (the flight runs on it, src/shared/starshipFlight.ts metAt). */
  launchT = 0;
  private tiles: { set: Set<number>; elevated: boolean }[] = [];
  private courseTiles = new Set<number>();
  private specials: { kind: 'boost' | 'air_station' | 'launch'; tiles: Set<number>; dir: [number, number]; opt: number }[] = [];
  private boostCool = 0;
  private offNow = false;
  private leftStart = false;

  constructor(level: Level, private area: RunArea, private bestKey?: string) {
    this.src = { level, area, bestKey };
    this.course = buildCourse(level);
    const key = (i: number, j: number) => i * 4096 + j;
    if (this.course) {
      for (const k of this.course.order) {
        const p = level.parts[k];
        const set = new Set(partTiles(p).map(([i, j]) => key(i, j)));
        this.tiles.push({ set, elevated: (p.lv ?? 0) === 1 });
        set.forEach((t) => this.courseTiles.add(t));
      }
    }
    for (const p of level.parts) {
      if (p.type !== 'boost' && p.type !== 'air_station' && p.type !== 'launch') continue;
      const f = placeTransform(partDef(p.type), p.i, p.j, p.rot, 1);
      const [ax, az] = f(0.5, 0.2), [bx, bz] = f(0.5, 0.8);
      const l = Math.hypot(bx - ax, bz - az) || 1;
      this.specials.push({ kind: p.type, tiles: new Set(partTiles(p).map(([i, j]) => key(i, j))), dir: [(bx - ax) / l, (bz - az) / l], opt: p.opt ?? partDef(p.type).opt?.def ?? 60 });
    }
  }

  private readonly src: { level: Level; area: RunArea; bestKey?: string };
  /** The same level from the beginning (restart). */
  fresh(): LevelRun { return new LevelRun(this.src.level, this.src.area, this.src.bestKey); }

  /** Total time with penalties. */
  get total(): number { return this.t + this.penalty; }
  get sections(): number { return this.course ? this.course.order.length : 0; }

  best(): number | null {
    if (!this.bestKey) return null;
    try { const v = Number(localStorage.getItem(this.bestKey)); return v > 0 ? v : null; } catch { return null; }
  }

  update(dt: number, car: RunCar, fx: RunEffects): RunEvent[] {
    const ev: RunEvent[] = [];
    const a = this.area;
    const i = Math.floor((car.x - a.minX) / a.tileM), j = Math.floor((car.z - a.minZ) / a.tileM);
    const tile = i * 4096 + j;
    const high = car.y > a.y + 3.5;              // on (or over) the elevated network
    // ---- special pieces (also in free driving)
    this.boostCool = Math.max(0, this.boostCool - dt);
    for (const s of this.specials) {
      if (!s.tiles.has(tile) || high) continue;
      const along = car.vx * s.dir[0] + car.vz * s.dir[1];   // the pad works in both directions of its road
      if (s.kind === 'boost' && car.grounded && this.boostCool === 0 && Math.abs(along) > 2) {
        const sg = Math.sign(along);
        fx.boost(s.dir[0] * sg, s.dir[1] * sg, BOOST_DV); this.boostCool = BOOST_COOLDOWN_S; ev.push({ kind: 'boost' });
      } else if (s.kind === 'air_station' && car.grounded && car.speedMs < 1.5) {
        fx.refill(dt); ev.push({ kind: 'refill' });
      } else if (s.kind === 'launch' && this.launchIn === null && !this.launchFired) {
        this.launchIn = s.opt; ev.push({ kind: 'launchArmed', countdownS: s.opt });
      }
    }
    if (this.launchFired) this.launchT += dt;
    else if (this.launchIn !== null) {
      this.launchIn = Math.max(0, this.launchIn - dt);
      if (this.launchIn === 0) { this.launchFired = true; ev.push({ kind: 'launch' }); }
    }
    // ---- time trial
    if (!this.course || this.state === 'finished') return ev;
    if (this.state === 'ready') {
      if (car.speedMs > 0.5) { this.state = 'running'; ev.push({ kind: 'start' }); } else return ev;
    }
    this.t += dt;
    const onTile = (k: number) => this.tiles[k].set.has(tile) && (this.tiles[k].elevated ? high : !high || !car.grounded);
    // next sections (up to three ahead: skipping costs a penalty)
    const n = this.tiles.length;
    for (let ahead = 1; ahead <= 3; ahead++) {
      const k = this.progress + ahead;
      if (k >= n) break;
      if (onTile(k)) {
        if (ahead > 1) { this.missed += ahead - 1; this.penalty += (ahead - 1) * SKIP_PENALTY_S; ev.push({ kind: 'skipped', n: ahead - 1 }); }
        this.progress = k;
        ev.push({ kind: 'section', n: k, of: n });
        break;
      }
    }
    if (!this.tiles[0].set.has(tile)) this.leftStart = true;
    // finish: back on the start piece after the last section (closed course) or on the last piece (open course)
    const done = this.course.closed ? this.leftStart && this.progress >= n - 1 && onTile(0) : this.progress === n - 1;
    if (done) {
      this.state = 'finished';
      const total = this.total;
      const prev = this.best();
      const best = prev === null || total < prev;
      if (best && this.bestKey) try { localStorage.setItem(this.bestKey, total.toFixed(3)); } catch { /* blocked */ }
      ev.push({ kind: 'finish', timeS: this.t, penaltyS: this.penalty, best });
      // no launch clearance passed: the Starship launch is announced at the finish (time to drive to a viewpoint)
      if (this.launchIn === null && !this.launchFired) { this.launchIn = FINISH_LAUNCH_S; ev.push({ kind: 'launchArmed', countdownS: FINISH_LAUNCH_S }); }
      return ev;
    }
    // off the track: on the ground, not on a course tile -> its time is penalty (1 s per s, as in the original)
    const off = car.grounded && !this.courseTiles.has(tile);
    if (off) { this.penalty += dt; if (!this.offNow) ev.push({ kind: 'offTrack' }); }
    this.offNow = off;
    return ev;
  }
}

