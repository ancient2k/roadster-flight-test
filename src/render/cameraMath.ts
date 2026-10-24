// Camera mathematics without three.js dependencies (unit-tested in tests/render).
import { TRACK, headingToForward, rampLocalToWorld, profileLength, sampleProfile } from '../shared/track';
import type { StuntId } from '../shared/types';
import { DEG, clamp, type Vec3 } from '../shared/math';

/** Critically damped spring (Game Programming Gems 4, "smooth damp"). Mutates `state`. */
export interface Spring1 { value: number; vel: number }
export function smoothDamp(s: Spring1, target: number, smoothTime: number, dt: number, maxSpeed = Infinity): number {
  const st = Math.max(1e-4, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = s.value - target;
  const maxChange = maxSpeed * st;
  change = clamp(change, -maxChange, maxChange);
  const t2 = s.value - change;
  const temp = (s.vel + omega * change) * dt;
  s.vel = (s.vel - omega * temp) * exp;
  let out = t2 + (change + temp) * exp;
  // prevent overshoot
  if ((target - s.value > 0) === (out > target)) { out = target; s.vel = (out - target) / Math.max(dt, 1e-6); }
  s.value = out;
  return out;
}

export interface Spring3 { value: Vec3; vel: Vec3 }
export const spring3 = (v: Vec3): Spring3 => ({ value: { ...v }, vel: { x: 0, y: 0, z: 0 } });
export function smoothDamp3(s: Spring3, target: Vec3, smoothTime: number, dt: number): Vec3 {
  for (const k of ['x', 'y', 'z'] as const) {
    const tmp: Spring1 = { value: s.value[k], vel: s.vel[k] };
    smoothDamp(tmp, target[k], smoothTime, dt);
    s.value[k] = tmp.value; s.vel[k] = tmp.vel;
  }
  return s.value;
}

/**
 * Keep a damped value within maxM of its target. The chase camera lags speed × smoothing time behind: at the hundreds
 * of m/s of the Sun dive that was hundreds of metres, the car shrank to a speck and the depth range fell apart.
 */
export function limitLag(s: Spring3, target: Vec3, maxM: number): Vec3 {
  const dx = s.value.x - target.x, dy = s.value.y - target.y, dz = s.value.z - target.z;
  const d = Math.hypot(dx, dy, dz);
  if (d > maxM) {
    const k = maxM / d;
    s.value.x = target.x + dx * k; s.value.y = target.y + dy * k; s.value.z = target.z + dz * k;
  }
  return s.value;
}

/** Shortest signed angle difference a-b in radians, in (-pi, pi]. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Exponential angle smoothing that respects wrap-around. */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + angleDelta(target, current) * (1 - Math.exp(-lambda * dt));
}

/**
 * Yaw (world heading, 0 = +Z, 90° = +X) the chase camera should look along.
 * Uses the velocity direction when moving forward and the body forward otherwise; returns null when
 * neither has a usable horizontal component (car pointing straight up the wall).
 */
export function chaseYaw(bodyFwd: Vec3, linVel: Vec3, minSpeed = 3): number | null {
  const hv = Math.hypot(linVel.x, linVel.z);
  const hf = Math.hypot(bodyFwd.x, bodyFwd.z);
  // reversing (the ramp hang backs down the wall at ≈ 3 m/s): stay behind the car instead of swinging
  // round to the front whenever the speed crosses minSpeed
  const reversing = hf > 0.25 && linVel.x * bodyFwd.x + linVel.z * bodyFwd.z < -0.5 * hv * hf;
  if (hv > minSpeed && !reversing) return Math.atan2(linVel.x, linVel.z);
  if (hf > 0.25) return Math.atan2(bodyFwd.x, bodyFwd.z);
  return null;
}

/** Height above ground (m) up to which the airborne chase camera drops below the car; higher it stays at that offset. */
export const CHASE_LOW_MAX_H_M = 40;
/** Longest look-ahead of the airborne chase camera (m). */
export const CHASE_MAX_LEAD_M = 12;

/** Desired chase-camera position for a given yaw. Distance grows with speed. */
export function chaseOffset(target: Vec3, yaw: number, speedMs: number, out: Vec3 = { x: 0, y: 0, z: 0 }, air = 0, heightM = Math.max(0, target.y)): Vec3 {
  // ground: close behind and above. Airborne (air → 1): pull back, drop towards a broadcast-like
  // low camera and slide to the side so the trajectory reads (stream shot t_963).
  const groundDist = 7.2 + clamp(speedMs * 0.06, 0, 4.5);
  const dist = groundDist + (19 - groundDist) * air;
  const side = 11 * air;
  const groundH = target.y + 2.1 + clamp(speedMs * 0.012, 0, 1.0);
  // airborne: low, at 45 % of the height above the ground (broadcast look) – relative to the car, and only up to
  // CHASE_LOW_MAX_H_M of height: the absolute "0.45 × y" put the camera hundreds of metres off a car high above the
  // origin (space, high terrain) or below the terrain
  const airH = target.y + 2.2 - 0.55 * clamp(heightM, 0, CHASE_LOW_MAX_H_M);
  out.x = target.x - Math.sin(yaw) * dist - Math.cos(yaw) * side;
  out.z = target.z - Math.cos(yaw) * dist + Math.sin(yaw) * side;
  out.y = groundH + (airH - groundH) * air;
  return out;
}

/** Look-at point: in flight slightly ahead of the car so it sits in the trailing third of the frame. */
export function chaseLook(target: Vec3, vel: Vec3, air: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  // (lead capped at CHASE_MAX_LEAD_M: at the speeds of a long flight in space the look point ran far ahead of the car)
  const sp = Math.hypot(vel.x, vel.y, vel.z);
  const lead = 0.25 * air * Math.min(1, CHASE_MAX_LEAD_M / Math.max(1e-6, 0.25 * sp));
  out.x = target.x + vel.x * lead;
  out.y = target.y + vel.y * lead * 0.3;
  out.z = target.z + vel.z * lead;
  return out;
}

/** Keep a camera above the ground plane. */
/** Keeps p at least `minY` above the ground (`ground` = terrain height at p; McGregor pad = 0). */
export function clampAboveGround(p: Vec3, minY = 0.45, ground = 0): Vec3 {
  if (p.y < ground + minY) p.y = ground + minY;
  return p;
}

// ------------------------------------------------------------------------ broadcast direction

export interface BroadcastShot {
  id: string;
  site: StuntId | 'overview';
  label: string;            // German label for the UI
  pos: Vec3;
  /** Fixed look-at point, or null to track the car. */
  lookAt: Vec3 | null;
  fovDeg: number;
  /** Track the car with this much lag (0 = locked off). */
  trackCar: boolean;
  /** Optional rail: the camera slides with the car along this axis (dolly), clamped. */
  dolly?: { axis: Vec3; min: number; max: number };
  /** Exposure offset of this broadcast camera in EV (each stream camera has its own iris). */
  ev?: number;
  /** The shot only works while the car is below this height (e.g. low ramp cams lose a high flight). */
  maxCarY?: number;
  /**
   * Phase camera of the stream: preferred while the car is within `r` metres (horizontal) of
   * `c` – and, with `dir`, only while it moves along `dir` (e.g. dropping off the wall ramp) –
   * and avoided elsewhere. The director only sees the car's position and velocity, so the stream's
   * per-phase cameras (approach, roll, landing) are bound to where those phases happen. Once on air, the shot
   * keeps the car within `rKeep` whatever its direction (the ramp landing camera follows the car driving off).
   */
  zone?: { c: Vec3; r: number; dir?: Vec3; rKeep?: number };
}

const wall = TRACK.ramps.find((r) => r.kind === 'wallRamp')!;
const kicker = TRACK.ramps.find((r) => r.kind === 'kicker')!;
const kickerLip = rampLocalToWorld(kicker, (() => { const s = sampleProfile(kicker.profile, profileLength(kicker.profile)); return { x: 0, y: s.y, z: s.z }; })());
const site = (id: StuntId) => TRACK.sites.find((s) => s.stunt === id)!.spawn.pos;
const semi = TRACK.obstacles.find((o) => o.model === 'semi')!;

/** Fixed cameras modelled on the Tesla stream (stream reference frames, semi_jump, finale). */
export const BROADCAST_SHOTS: BroadcastShot[] = [
  // Wall ramp: the stream's locked-off wide shot of the whole wall (674–710 s), a low rear shot at the
  // ramp foot, and a high wide angle. wall_side is the stream camera calibrated in R15 (tools/ramp/): on
  // the ground 45 m in front of the ramp foot and 14 m to the side (≈ 18° off the run-up axis), tilted
  // 12° up, 54° vertical field of view; the car at the foot is seen from behind at ≈ 17°.
  { id: 'wall_side', site: 'ramp_hang', label: 'Rampe seitlich', pos: { x: wall.origin.x - 14, y: 1.7, z: wall.origin.z - 44.9 }, lookAt: { x: wall.origin.x + 1.4, y: 12.3, z: wall.origin.z + 1.5 }, fovDeg: 54, trackCar: false },
  // Stream rear view (stream reference frames): long lens low behind the car, the ramp
  // framed by the red drapes; behind the spawn so the car never passes the camera. 5.5° so the
  // car fills ≈ 40 % of the frame width at the ramp foot as at 668 s (10° gave ≈ 22 %), and 2 m high
  // so the roof and rear window show as in the stream (was 1.4 m). The eye adaptation would lift the
  // washed concrete to ≈ 150/255; the stream camera holds it at ≈ 90–115 (iris −1 EV).
  // The stream uses it only while the car is at the foot of the ramp (668–672 s waiting, 712–717 s back
  // down): up the wall the long lens would show nothing but the underside filling the frame (hang, drop).
  { id: 'wall_rear', site: 'ramp_hang', label: 'Rampe von hinten', pos: { x: wall.origin.x - 1.0, y: 2.0, z: wall.origin.z - 32 }, lookAt: null, fovDeg: 5.5, trackCar: true, ev: -1.0,
    maxCarY: 2.5, zone: { c: { x: wall.origin.x, y: 0, z: wall.origin.z - 6 }, r: 9 } },
  // High wide angle, only while the car is low: from 24 m up it looks onto the top of the overhang, the car hanging
  // underneath it is hidden (the stream holds the locked-off wide shot for the whole hang).
  { id: 'wall_wide', site: 'ramp_hang', label: 'Rampe total', pos: { x: wall.origin.x - 38, y: 24, z: wall.origin.z - 40 }, lookAt: null, fovDeg: 42, trackCar: true, maxCarY: 8 },
  // Kickflip over the semi: broadside from the far side like t_963, plus a low tracking shot.
  // Low and oblique like t_963: from the kicker side of the pad the camera looks along the row at
  // ~45°, so Model 3 and Model Y overlap the Semi in depth, the car crosses left to right above the
  // row and the lit wall ramp closes the background (instead of a face-on line-up).
  { id: 'kick_broadside', site: 'kickflip', label: 'Kickflip seitlich', pos: { x: kicker.origin.x - 40, y: 1.4, z: semi.center.z - 45 }, lookAt: { x: semi.center.x + 6, y: 6, z: semi.center.z + 6 }, fovDeg: 30, trackCar: true },
  { id: 'kick_low', site: 'kickflip', label: 'Kicker flach', pos: { x: kickerLip.x + 9, y: 0.5, z: kickerLip.z - 2 }, lookAt: null, fovDeg: 52, trackCar: true, maxCarY: 3.5, ev: 0.2 },
  { id: 'kick_drone', site: 'kickflip', label: 'Drohne', pos: { x: kicker.origin.x - 14, y: 26, z: semi.center.z - 22 }, lookAt: null, fovDeg: 55, trackCar: true },
  // Stream approach (958-961 s): long lens from far behind the car, straight down the LED-lined lane
  // at the row and the light tower; for the run-up and the kicker, until the car is high enough for
  // the broadside camera.
  { id: 'kick_rear', site: 'kickflip', label: 'Anlauf Tele', pos: { x: kicker.origin.x, y: 1.6, z: -196 }, lookAt: { x: kicker.origin.x, y: 2.2, z: semi.center.z }, fovDeg: 12, trackCar: true,
    zone: { c: { x: kicker.origin.x, y: 0, z: -95 }, r: 65 } },
  // Stream landing (964.5 s): a low camera close to the landing zone. The stream crosses the line
  // here: the car runs right to left and its cloud trails to the right, so the camera stands on the
  // far (+x) side of the lane, looking diagonally back across it (instead of the broadside camera
  // ~70 m away).
  { id: 'kick_land', site: 'kickflip', label: 'Landung', pos: { x: kicker.origin.x + 21, y: 1.1, z: -6 }, lookAt: { x: kicker.origin.x - 0.5, y: 3.5, z: 5 }, fovDeg: 30, trackCar: true,
    zone: { c: { x: kicker.origin.x, y: 0, z: 16 }, r: 17 } },
  // 0-60: head-on from ahead (the car comes out of the gate housing), then a side dolly.
  { id: 'z60_front', site: 'zero60', label: '0–60 frontal', pos: { x: 0.0, y: 1.0, z: -60 }, lookAt: null, fovDeg: 22, trackCar: true },
  { id: 'z60_side', site: 'zero60', label: '0–60 seitlich', pos: { x: -14, y: 1.6, z: -116 }, lookAt: null, fovDeg: 45, trackCar: true, dolly: { axis: { x: 0, y: 0, z: 1 }, min: -120, max: 60 } },
  // Stream 0-60 (1262-1268 s, r8_stream_z60_plume.jpg): raised three-quarter camera behind the start
  // on the +x side, looking diagonally down the measuring lane at the lit gate opening (screen left);
  // the car drives away from the camera into the gate, its jet plume trailing to screen right.
  // 6.5° further right so the gate sits at the left edge and the car at 0.62 s left of centre
  // as in the 1267 s still (before: lookAt (-1, 1.6, -115))
  { id: 'z60_gate', site: 'zero60', label: '0–60 Tor', pos: { x: 12.5, y: 3.2, z: -131 }, lookAt: { x: -2.7, y: 1.6, z: -116.6 }, fovDeg: 30, trackCar: false,
    zone: { c: { x: 0, y: 0, z: -115 }, r: 16 } },
  // Finale (flat-ground flip).
  { id: 'fin_low', site: 'ground_flip', label: 'Finale flach', pos: { x: site('ground_flip').x - 18, y: 0.8, z: site('ground_flip').z + 14 }, lookAt: null, fovDeg: 42, trackCar: true },
  { id: 'fin_drone', site: 'ground_flip', label: 'Finale Drohne', pos: { x: site('ground_flip').x + 6, y: 30, z: site('ground_flip').z - 12 }, lookAt: null, fovDeg: 50, trackCar: true },
  // Stream finale (1600-1612 s): locked-off long lens 65 m ahead of the car, at the nose; the roll
  // turns in the image plane and the cloud spreads over the lower third.
  { id: 'fin_front', site: 'ground_flip', label: 'Finale Tele', pos: { x: site('ground_flip').x, y: 1.6, z: site('ground_flip').z + 65 }, lookAt: { x: site('ground_flip').x - 0.5, y: 3.6, z: site('ground_flip').z }, fovDeg: 15, trackCar: false,
    zone: { c: site('ground_flip'), r: 10 } },
  // Title / menu: low wide view across the lit obstacle row towards the stage and the wall ramp.
  { id: 'title', site: 'overview', label: 'Titelbild', pos: { x: semi.center.x + 30, y: 1.6, z: semi.center.z - 34 }, lookAt: { x: semi.center.x - 6, y: 5.5, z: semi.center.z + 6 }, fovDeg: 38, trackCar: false },
  // Overview from the grandstands.
  { id: 'overview', site: 'overview', label: 'Tribüne', pos: { x: -112, y: 14, z: 45 }, lookAt: null, fovDeg: 40, trackCar: true },
];
// ramp_launch shares the wall cameras.
for (const s of BROADCAST_SHOTS.filter((x) => x.site === 'ramp_hang')) {
  BROADCAST_SHOTS.push({ ...s, id: s.id.replace('wall', 'wlaunch'), site: 'ramp_launch' });
}
// The launch car drives off the end of the overhang (z −8) and lands ≈ 17 m in front of the ramp foot.
// The stream follows the drop with a panning camera on the ground ≈ 54 m in front of the ramp foot and
// 16 m to the side (calibrated on the ramp silhouette at 720 s and 727–728 s, R15): the landing camera
// stands there and aims at the touchdown. It takes the car from the drop off the overhang end (≈ 22 m up,
// stream 726 s) down to the rollout. The hang has no landing: the stream stays on the wide shot while the
// car reverses down and cuts to the rear view at the foot (712 s). After the touchdown the car drives off out of
// its cloud (stream 729.7–733 s): the camera keeps it (rKeep) until the results.
BROADCAST_SHOTS.push({ id: 'wlaunch_land', site: 'ramp_launch', label: 'Rampe Landung', pos: { x: wall.origin.x - 16, y: 1.8, z: wall.origin.z - 54 },
  lookAt: { x: wall.origin.x, y: 3, z: wall.origin.z - 17 }, fovDeg: 40, trackCar: true, maxCarY: 25,
  zone: { c: { x: wall.origin.x, y: 0, z: wall.origin.z - 15 }, r: 10, dir: { x: 0, y: 0, z: -1 }, rKeep: 22 } });

/** Region of the pad that belongs to each stunt site (used to pick the shot set). */
export function nearestSite(p: Vec3): StuntId | 'overview' {
  const regions: { id: StuntId; c: Vec3; r: number; rz?: number }[] = [
    // centred on where each stunt actually runs (approach + action), so neighbouring lanes do not
    // steal each other's cameras (the 0-60 start at z≈-118 is 45 m from the kicker lane)
    { id: 'ramp_hang', c: { x: wall.origin.x, y: 0, z: wall.origin.z - 40 }, r: 80 },
    // the whole lane (ellipse, 30 m across, 105 m along): run-up from the spawn at z -150, flight
    // over the row and the rollout to z ≈ +48 stay on the site (a circle let the 0-60 region take
    // the first 40 m of the run-up)
    { id: 'kickflip', c: { x: kicker.origin.x, y: 0, z: -50 }, r: 30, rz: 105 },
    { id: 'zero60', c: { x: 0, y: 0, z: -90 }, r: 60 },
    { id: 'ground_flip', c: site('ground_flip'), r: 40 },
  ];
  let best: StuntId | 'overview' = 'overview', bestD = Infinity;
  for (const r of regions) {
    const d = Math.hypot((p.x - r.c.x) / r.r, (p.z - r.c.z) / (r.rz ?? r.r));
    if (d < 1 && d < bestD) { bestD = d; best = r.id; }
  }
  return best;
}

/**
 * Shot set for the car at p during `stunt`. Both wall-ramp stunts run on the same ramp, so the position
 * alone cannot tell them apart: the launch gets its own set (landing camera at the touchdown).
 */
export function shotSite(p: Vec3, stunt: StuntId | null = null): StuntId | 'overview' {
  const site = nearestSite(p);
  return site === 'ramp_hang' && stunt === 'ramp_launch' ? 'ramp_launch' : site;
}

/** Score of a shot for the car at p: prefers cameras at a pleasant distance with line of sight. */
export function shotScore(shot: BroadcastShot, p: Vec3, vel?: Vec3, onAir = false): number {
  const d = Math.hypot(p.x - shot.pos.x, p.y - shot.pos.y, p.z - shot.pos.z);
  const ideal = 25 * Math.tan(30 * DEG) / Math.tan((shot.fovDeg / 2) * DEG); // longer lens, further away
  let s = 1 - Math.abs(d - ideal) / (ideal * 1.5);
  if (d < 3) s -= 2;
  if (shot.maxCarY !== undefined && p.y > shot.maxCarY) s -= 2.5;
  if (shot.lookAt) {
    // fixed framing: car must be within the view cone
    const fx = shot.lookAt.x - shot.pos.x, fy = shot.lookAt.y - shot.pos.y, fz = shot.lookAt.z - shot.pos.z;
    const fl = Math.hypot(fx, fy, fz);
    const cos = (fx * (p.x - shot.pos.x) + fy * (p.y - shot.pos.y) + fz * (p.z - shot.pos.z)) / (fl * Math.max(d, 1e-3));
    if (cos < Math.cos(shot.fovDeg * 0.45 * DEG)) s -= 3;
    else s += 0.4;
  }
  if (shot.zone) s += inZone(shot.zone, p, vel, onAir) ? 1.2 : -1.5;
  return s;
}

function inZone(z: NonNullable<BroadcastShot['zone']>, p: Vec3, vel?: Vec3, onAir = false): boolean {
  const d = Math.hypot(p.x - z.c.x, p.z - z.c.z);
  if (onAir && z.rKeep !== undefined && d <= z.rKeep) return true;
  if (d > z.r) return false;
  if (!z.dir) return true;
  return vel !== undefined && vel.x * z.dir.x + vel.y * z.dir.y + vel.z * z.dir.z > 0.5;
}

/**
 * Automatic director. Holds each shot at least `minHold` seconds, cuts when the car leaves the
 * site, when a clearly better shot exists, or after `maxHold`.
 */
export class BroadcastDirector {
  current: BroadcastShot | null = null;
  heldS = 0;
  forced: string | null = null;
  /** Stunt being flown (picks the shot set where two stunts share a site), or null. */
  stunt: StuntId | null = null;
  constructor(public shots: BroadcastShot[] = BROADCAST_SHOTS, public minHold = 2.4, public maxHold = 7) {}

  /** Returns the shot to use this frame and whether a cut happened (`vel`: car velocity, m/s). */
  update(p: Vec3, dt: number, vel?: Vec3): { shot: BroadcastShot; cut: boolean } {
    this.heldS += dt;
    if (this.forced) {
      const f = this.shots.find((s) => s.id === this.forced);
      if (f) {
        const cut = this.current !== f;
        if (cut) { this.current = f; this.heldS = 0; }
        return { shot: f, cut };
      }
    }
    const siteId = shotSite(p, this.stunt);
    const candidates = this.shots.filter((s) => s.site === siteId);
    const pool = candidates.length ? candidates : this.shots.filter((s) => s.site === 'overview');
    let best = pool[0], bestScore = -Infinity;
    for (const s of pool) {
      let sc = shotScore(s, p, vel, s === this.current);
      if (s === this.current) sc += 0.35; // inertia
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
    const cur = this.current;
    let cut = false;
    if (!cur) cut = true;
    else if (cur !== best) {
      const curScore = shotScore(cur, p, vel, true);
      const leftSite = cur.site !== siteId && !(cur.site === 'overview' && pool[0].site === 'overview');
      if (leftSite) cut = true;                      // new stunt site (e.g. stunt start): cut at once
      else if (curScore < -1) cut = true;            // lost the car
      else if (this.heldS > this.minHold && bestScore > curScore + 0.5) cut = true;
      // the stream cuts to its phase cameras on cue (e.g. the landing camera while the car is still
      // ~3 m up), so a phase camera whose zone the car enters needs only half the hold time
      else if (best.zone && this.heldS > this.minHold * 0.5 && bestScore > curScore + 0.5) cut = true;
      else if (this.heldS > this.maxHold) cut = true;
    } else if (this.heldS > this.maxHold * 1.6 && pool.length > 1) {
      // rotate to the second best for variety
      const alt = pool.filter((s) => s !== cur).sort((a, b) => shotScore(b, p, vel) - shotScore(a, p, vel))[0];
      if (alt && shotScore(alt, p, vel) > -0.5 && !(cur.zone?.rKeep !== undefined && shotScore(cur, p, vel, true) > 0)) { best = alt; cut = true; }
    }
    if (cut) { this.current = best; this.heldS = 0; }
    return { shot: this.current!, cut };
  }
}

/** Forward direction of a heading (re-export for convenience). */
export { headingToForward };
