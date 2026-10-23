// Scripted flight of the Starship launch at Boca Chica (docs/EDITOR.md "Starship launch"): Super Heavy + Starship lift
// off from pad A, stage over the Gulf, the booster flies back and is caught by the tower A arms at ≈ T+6:58, the ship
// reaches orbit and after one revolution comes back (time lapse) to be caught by the tower B arms. Not simulated:
// hand-made Hermite tracks (position and velocity at every key) after the public flight profiles. Pure, no three.js.
//
// Sources (times rounded): SpaceX Starship Flight 5 mission timeline and webcast telemetry, 13 Oct 2024
// (spacex.com/launches/starship-flight-5): Raptor ignition T−0:03, Max-Q T+1:02, booster MECO T+2:41, hot staging
// T+2:44, boostback burn T+2:55–3:51, booster landing burn T+6:28, catch ≈ T+7:00, ship SECO T+8:23 at ≈ 26 000 km/h,
// entry T+47:31, landing flip T+1:05:53, landing burn T+1:06:00. The ship catch after a full orbit has not flown yet:
// its return keeps the Flight 5 entry-to-landing durations, shifted by one orbit (≈ 90 min at ≈ 170 km).
//
// Frames: d = distance along the launch azimuth from the vehicle's origin (m, + = downrange over the Gulf), h = height
// above the origin (m), tilt = body axis from vertical towards +d (deg). The booster's track after staging ends at its
// catch point (tower A), the ship's return track at the tower B catch point; the ascent starts at the stack on mount A.

export interface FlightKey { t: number; h: number; d: number; vh: number; vd: number }
export type StagePhase = 'pad' | 'ascent' | 'coast' | 'boostback' | 'descent' | 'landing' | 'caught' | 'orbit' | 'entry';
export type StageId = 'booster' | 'ship';
export interface StageState {
  h: number; d: number; vh: number; vd: number;
  /** |v| (m/s). */
  speed: number;
  tilt: number;
  /** Raptors burning (booster 33/13/3, ship 6/3). */
  engines: number;
  /** Not drawn (ship in orbit, far below the horizon). */
  hidden: boolean;
  /** Held by the tower arms. */
  caught: boolean;
  phase: StagePhase;
}

/** Booster hull length; the ship sits on its hot-stage ring (m, starship_stack GLB). */
export const BOOSTER_LEN = 72;
/** Lower edge of the booster catch pins and the ship's catch hardpoints above the hull base (m). */
export const BOOSTER_PIN_Y = 63.6;
export const SHIP_PIN_Y = 33;
/** Launch azimuth (deg from north): east over the Gulf, as the Starship test flights. */
export const AZIMUTH_DEG = 97;
export const EARTH_R = 6_371_000;

export const SEP_T = 164;
export const BOOSTER_CATCH_T = 418;
export const SHIP_CATCH_T = 5925;
export const SECO_T = 503;
export const ENTRY_T = 4800;
/** Alert before each catch (s; both catches fall into a real-time segment). */
export const CATCH_ALERT_S = 30;

const K = (t: number, hKm: number, dKm: number, vh: number, vd: number): FlightKey => ({ t, h: hKm * 1000, d: dKm * 1000, vh, vd });

/** Stack from the mount to hot staging (positions and velocities keep the averages between keys consistent). */
export const ASCENT: FlightKey[] = [
  K(0, 0, 0, 0, 0), K(10, 0.18, 0, 38, 0), K(30, 1.6, 0.05, 105, 8), K(62, 9.5, 1.6, 380, 120), K(90, 22.5, 7.5, 560, 300),
  K(120, 40.7, 21.8, 650, 650), K(161, 68.4, 63.8, 700, 1400), K(SEP_T, 70.5, 68, 670, 1390),
];
/** Super Heavy after staging: boostback towards the coast, fall, aerobraking, landing burn (13 then 3 engines), catch. */
export const BOOSTER: FlightKey[] = [
  ASCENT[ASCENT.length - 1], K(175, 77.3, 83.2, 560, 1370), K(232, 93.3, 100.6, 0, -740), K(300, 70.6, 50.3, -666, -740),
  K(340, 36.1, 20.7, -1058, -740), K(351, 24.1, 12.6, -1120, -730), K(362, 13.5, 6.3, -800, -420), K(369, 9.5, 4.1, -320, -250),
  K(395, 1.0, 0.3, -335, -40), K(399, 0.31, 0.17, -35, -25), K(410, 0.04, 0.02, -8, -4), K(BOOSTER_CATCH_T, 0, 0, 0, 0),
];
/** Starship from hot staging to engine cut-off (≈ 28 000 km/h, orbit at ≈ 172 km); its first key is the stack's top. */
export const SHIP_ASCENT: FlightKey[] = [
  K(240, 116, 213, 600, 2400), K(360, 161, 645, 150, 4800), K(SECO_T, 171.7, 1546, 0, 7800),
];
/** Starship after one orbit: entry from the west over Mexico, belly flop, landing flip and burn, catch at tower B. */
export const SHIP_RETURN: FlightKey[] = [
  K(ENTRY_T, 120, -3050, -60, 7350), K(5000, 94, -1697, -200, 6200), K(5250, 60, -485, -160, 3500), K(5480, 33, -48, -60, 300),
  K(5605, 23, -22, -70, 133), K(5900, 0.9, -0.17, -80, 15), K(5910, 0.25, -0.055, -40, 8), K(5918, 0.05, -0.02, -10, 2),
  K(SHIP_CATCH_T, 0, 0, 0, 0),
];

type TiltKey = [t: number, deg: number];
const STACK_TILT: TiltKey[] = [[0, 0], [12, 0.5], [40, 12], [62, 25], [90, 42], [120, 55], [161, 63], [SEP_T, 63]];
// boostback: engines towards the Gulf (nose west, a little below the horizon), then engines first along the velocity
const BOOSTER_TILT: TiltKey[] = [...STACK_TILT, [170, 10], [175, -95], [231, -95], [240, -20], [252, 70], [300, 48], [340, 35], [369, 32], [395, 8], [408, 1], [BOOSTER_CATCH_T, 0]];
// entry belly first with the nose high, belly flop horizontal, the landing flip overshoots a little
const SHIP_TILT: TiltKey[] = [...STACK_TILT, [240, 72], [360, 85], [SECO_T, 90], [ENTRY_T, 70], [5480, 80], [5605, 90], [5900, 90], [5904, -12], [5909, 3], [5914, 0]];
type EngineKey = [t: number, n: number];
const BOOSTER_ENGINES: EngineKey[] = [[-3, 33], [161, 3], [SEP_T, 0], [175, 13], [231, 0], [395, 13], [399, 3], [BOOSTER_CATCH_T, 0]];
const SHIP_ENGINES: EngineKey[] = [[SEP_T, 6], [SECO_T, 0], [5901, 3], [SHIP_CATCH_T, 0]];

function hermite(keys: FlightKey[], t: number): { h: number; d: number; vh: number; vd: number } {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const a = keys[i], b = keys[i + 1];
  const dt = b.t - a.t;
  const s = Math.max(0, Math.min(1, (t - a.t) / dt));
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const g00 = (6 * s2 - 6 * s) / dt, g10 = 3 * s2 - 4 * s + 1, g01 = -g00, g11 = 3 * s2 - 2 * s;
  return {
    h: h00 * a.h + h10 * dt * a.vh + h01 * b.h + h11 * dt * b.vh, d: h00 * a.d + h10 * dt * a.vd + h01 * b.d + h11 * dt * b.vd,
    vh: g00 * a.h + g10 * a.vh + g01 * b.h + g11 * b.vh, vd: g00 * a.d + g10 * a.vd + g01 * b.d + g11 * b.vd,
  };
}
const smooth = (x: number) => x * x * (3 - 2 * x);
function tiltAt(keys: TiltKey[], t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, a] = keys[i], [t1, b] = keys[i + 1];
    if (t <= t1) return a + (b - a) * smooth((t - t0) / (t1 - t0));
  }
  return keys[keys.length - 1][1];
}
function enginesAt(keys: EngineKey[], t: number): number {
  let n = 0;
  for (const [t0, k] of keys) if (t >= t0) n = k;
  return n;
}

/** Ship just after hot staging: the top of the stack, then its own track. */
const SHIP_UP: FlightKey[] = (() => {
  const b = ASCENT[ASCENT.length - 1], tl = STACK_TILT[STACK_TILT.length - 1][1] * Math.PI / 180;
  return [{ t: SEP_T, h: b.h + BOOSTER_LEN * Math.cos(tl), d: b.d + BOOSTER_LEN * Math.sin(tl), vh: b.vh + 20, vd: b.vd + 30 }, ...SHIP_ASCENT];
})();

export function boosterState(met: number): StageState {
  if (met < 0) return { h: 0, d: 0, vh: 0, vd: 0, speed: 0, tilt: 0, engines: enginesAt(BOOSTER_ENGINES, met), hidden: false, caught: false, phase: 'pad' };
  const caught = met >= BOOSTER_CATCH_T;
  const p = caught ? { h: 0, d: 0, vh: 0, vd: 0 } : met <= SEP_T ? hermite(ASCENT, met) : hermite(BOOSTER, met);
  const phase: StagePhase = caught ? 'caught' : met < 161 ? 'ascent' : met < 175 ? 'coast' : met < 231 ? 'boostback' : met < 395 ? 'descent' : 'landing';
  return { ...p, speed: Math.hypot(p.vh, p.vd), tilt: tiltAt(BOOSTER_TILT, met), engines: enginesAt(BOOSTER_ENGINES, met), hidden: false, caught, phase };
}

/** Ship base relative to its origin: pad A until the orbit, the tower B catch point from the entry on (`fromB`). */
export function shipState(met: number): StageState & { fromB: boolean } {
  if (met < SEP_T) {
    const b = boosterState(met), tl = b.tilt * Math.PI / 180;
    return { ...b, h: b.h + BOOSTER_LEN * Math.cos(tl), d: b.d + BOOSTER_LEN * Math.sin(tl), engines: 0, fromB: false };
  }
  const engines = enginesAt(SHIP_ENGINES, met), tilt = tiltAt(SHIP_TILT, met);
  if (met <= SECO_T) {
    const p = hermite(SHIP_UP, met);
    return { ...p, speed: Math.hypot(p.vh, p.vd), tilt, engines, hidden: met > 420, caught: false, phase: 'ascent', fromB: false };
  }
  if (met < ENTRY_T) {
    const last = SHIP_ASCENT[SHIP_ASCENT.length - 1];
    return { h: last.h, d: last.d + last.vd * (met - SECO_T), vh: 0, vd: last.vd, speed: last.vd, tilt, engines, hidden: true, caught: false, phase: 'orbit', fromB: false };
  }
  const caught = met >= SHIP_CATCH_T;
  const p = caught ? { h: 0, d: 0, vh: 0, vd: 0 } : hermite(SHIP_RETURN, met);
  const phase: StagePhase = caught ? 'caught' : met < 5605 ? 'entry' : met < 5901 ? 'descent' : 'landing';
  return { ...p, speed: Math.hypot(p.vh, p.vd), tilt, engines, hidden: p.d < -400_000, caught, phase, fromB: true };
}

// ------------------------------------------------------------------ time lapse
/** [MET from which the rate applies, MET seconds per game second]: real time until the booster is caught and the ship
 *  in orbit, then the orbit, the entry and the belly flop in time lapse, the last 85 s before the ship catch in real time. */
export const WARP: [met: number, rate: number][] = [[0, 1], [540, 80], [ENTRY_T, 10], [5605, 4], [5840, 1]];

/** MET (s) after `g` game seconds since liftoff. */
export function metAt(g: number): number {
  if (g <= 0) return g;
  let left = g;
  for (let i = 0; i < WARP.length; i++) {
    const [m0, r] = WARP[i], m1 = WARP[i + 1]?.[0] ?? Infinity;
    const span = (m1 - m0) / r;
    if (left <= span) return m0 + left * r;
    left -= span;
  }
  return Infinity;
}
/** Game seconds since liftoff at MET `met` (inverse of metAt). */
export function gameAt(met: number): number {
  if (met <= 0) return met;
  let g = 0;
  for (let i = 0; i < WARP.length; i++) {
    const [m0, r] = WARP[i], m1 = WARP[i + 1]?.[0] ?? Infinity;
    if (met <= m1) return g + (met - m0) / r;
    g += (m1 - m0) / r;
  }
  return g;
}
export const warpAt = (met: number): number => { let r = 1; for (const [m, k] of WARP) if (met >= m) r = k; return r; };

// ------------------------------------------------------------------ ticker
export type LaunchMsg =
  | 'deluge' | 'ignition' | 'liftoff' | 'maxq' | 'meco' | 'sep' | 'boostback' | 'landingBurn' | 'catchAttempt' | 'caught'
  | 'seco' | 'timelapse' | 'reentry' | 'flip' | 'alert';
export interface LaunchEvent { met: number; msg: LaunchMsg; stage?: StageId }
export const EVENTS: LaunchEvent[] = [
  { met: -10, msg: 'deluge' }, { met: -3, msg: 'ignition' }, { met: 0, msg: 'liftoff' }, { met: 62, msg: 'maxq' },
  { met: 161, msg: 'meco', stage: 'booster' }, { met: SEP_T, msg: 'sep' }, { met: 175, msg: 'boostback', stage: 'booster' },
  { met: BOOSTER_CATCH_T - CATCH_ALERT_S, msg: 'alert', stage: 'booster' }, { met: 395, msg: 'landingBurn', stage: 'booster' },
  { met: 405, msg: 'catchAttempt', stage: 'booster' }, { met: BOOSTER_CATCH_T, msg: 'caught', stage: 'booster' },
  { met: SECO_T, msg: 'seco', stage: 'ship' }, { met: WARP[1][0], msg: 'timelapse' }, { met: ENTRY_T, msg: 'reentry', stage: 'ship' },
  { met: SHIP_CATCH_T - CATCH_ALERT_S, msg: 'alert', stage: 'ship' }, { met: 5901, msg: 'flip', stage: 'ship' },
  { met: 5912, msg: 'catchAttempt', stage: 'ship' }, { met: SHIP_CATCH_T, msg: 'caught', stage: 'ship' },
];
/** Events with MET in (from, to]. */
export const eventsBetween = (from: number, to: number): LaunchEvent[] => EVENTS.filter((e) => e.met > from && e.met <= to);

/** Game seconds until a stage is caught: null before it heads back (booster: staging, ship: entry) and once it is caught. */
export function returnsIn(stage: StageId, met: number): number | null {
  const c = stage === 'booster' ? BOOSTER_CATCH_T : SHIP_CATCH_T;
  if (met >= c || met < (stage === 'booster' ? SEP_T : SECO_T)) return null;
  return gameAt(c) - gameAt(met);
}

// ------------------------------------------------------------------ tower arms
/** Arms 1 = open, 0 = closed on the pins; carriage offset (m) from its shock absorbers after the catch. */
export function armsAt(met: number, catchMet: number): { open: number; dy: number } {
  const close0 = catchMet - 2.5;
  const open = met < close0 ? 1 : met >= catchMet ? 0 : 1 - smooth((met - close0) / 2.5);
  // the carriage gives ≈ 1.2 m under the impact and settles in a damped bounce
  const s = met - catchMet;
  const dy = s <= 0 ? 0 : -1.2 * (1 - Math.exp(-s * 1.6) * Math.cos(s * 3.2));
  return { open, dy };
}

// ------------------------------------------------------------------ world placement
export interface V3 { x: number; y: number; z: number }
/** World position of (d, h) along the azimuth from `origin`, the Earth curving away (+X east, −Z north). */
export function toWorld(origin: V3, d: number, h: number, azDeg = AZIMUTH_DEG): V3 {
  const a = azDeg * Math.PI / 180;
  return { x: origin.x + Math.sin(a) * d, y: origin.y + h - (d * d) / (2 * EARTH_R), z: origin.z - Math.cos(a) * d };
}

/** Exclusion zone around mount A: the pressure wave of the liftoff pushes cars inside it (m). */
export const BLAST_RADIUS_M = 400;
export const SOUND_MS = 343;
/** Speed (m/s) the passing pressure front adds to a car `dist` m from the mount. */
export function blastDv(dist: number): number {
  return dist >= BLAST_RADIUS_M ? 0 : 22 * (1 - dist / BLAST_RADIUS_M) ** 1.6;
}
