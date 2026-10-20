// McGregor test pad layout. Single source of truth for physics colliders AND render meshes.
// World: right-handed, +Y up, metres. Ground plane y = 0 (infinite for physics).
// Headings: 0° = facing +Z, 90° = facing +X (a left turn from 0°, seen from above: yaw about +Y).
import { DEG, type Vec3 } from './math';
import type { StuntId } from './types';

/** Planar profile segment in ramp-local (z forward along the approach, y up). */
export type ProfileSeg =
  | { kind: 'arc'; radius: number; fromDeg: number; toDeg: number } // tangent angle range, CCW (curving upward)
  | { kind: 'line'; length: number };

export interface CurvedRamp {
  kind: 'wallRamp' | 'kicker';
  id: string;
  origin: Vec3;           // world position of the ramp start (tangent to ground)
  headingDeg: number;     // approach direction
  width: number;
  thickness: number;      // structural thickness for collider/mesh backside
  profile: ProfileSeg[];
}

export interface BoxObstacle {
  kind: 'obstacle';
  id: string;
  model: 'semi' | 'model3' | 'modelY' | 'modelS' | 'cybertruck';
  center: Vec3;           // bottom-centre on the ground
  headingDeg: number;
  size: { x: number; y: number; z: number }; // object-local: x width, y height, z length (collider box)
}

export interface Decor {
  kind: 'lightTower' | 'stage' | 'grandstand' | 'ledStrip' | 'gate' | 'raptorStand' | 'startLine';
  id: string;
  pos: Vec3;
  headingDeg: number;
  size?: { x: number; y: number; z: number };
  length?: number;        // ledStrip / startLine
}

export interface StuntSite {
  stunt: StuntId;
  spawn: { pos: Vec3; headingDeg: number; speedMs: number };
  /** Reference values from the Tesla stream HUD for validation (docs/PHYSICS.md). */
  reference: Record<string, number>;
}

// ------------------------------------------------------------------ geometry
const WALL: CurvedRamp = {
  kind: 'wallRamp', id: 'wall', origin: { x: 60, y: 0, z: 60 }, headingDeg: 0, width: 5, thickness: 0.6,
  // Shape of the stream ramp (stream reference frames): a bend into the vertical, a tall straight
  // vertical section, then a tight curl over the top. Fitted to the two settled HUD points (the HUD altitude
  // lags while moving): pause at pitch 90° = 30.7 ft (9.36 m) → R1 = 9.8 m; hang at 170° = 69.1 ft (21.06 m)
  // → L + 0.985 R2 = 12.15 m. The stream shows a tall straight and a short curl (sheet_04: the car hangs near
  // the top end) → R2 = 8 m, L = 4.3 m; check: 119° → 17.3 m (descent reading 56.7 ft). On the R 8 curl the
  // surface rises above the skirt line behind the rear axle (≈ 0.13 m) – the fan model counts that as a fully
  // compressed, sealed skirt (fans.ts). The surface continues to 185° so the front wheels still stand on it
  // at a body pitch of 170°. Width ≈ 5 m (2.3 × the car's width in the stream).
  profile: [
    { kind: 'arc', radius: 9.8, fromDeg: 0, toDeg: 90 },
    { kind: 'line', length: 4.3 },
    { kind: 'arc', radius: 8, fromDeg: 90, toDeg: 185 },
  ],
};

const KICKER: CurvedRamp = {
  kind: 'kicker', id: 'kicker', origin: { x: -45, y: 0, z: -40 }, headingDeg: 0, width: 4.2, thickness: 0.4,
  // R 20 m to 28°: length 9.4 m, lip height 2.35 m, ~3.5-3.8 g at ~23 m/s [VIDEO 3.5 g]
  profile: [{ kind: 'arc', radius: 20, fromDeg: 0, toDeg: 28 }],
};

// Row of vehicles parked side by side (heading 90° = length across the jump line) after the kicker lip (lip at z ≈ -30.6).
const OBSTACLES: BoxObstacle[] = [
  { kind: 'obstacle', id: 'm3', model: 'model3', center: { x: -45, y: 0, z: -24.5 }, headingDeg: 90, size: { x: 1.85, y: 1.44, z: 4.72 } },
  { kind: 'obstacle', id: 'my', model: 'modelY', center: { x: -45, y: 0, z: -21.5 }, headingDeg: 90, size: { x: 1.92, y: 1.62, z: 4.75 } },
  { kind: 'obstacle', id: 'semi', model: 'semi', center: { x: -45, y: 0, z: -17.0 }, headingDeg: 90, size: { x: 2.6, y: 4.1, z: 6.6 } },
  { kind: 'obstacle', id: 'ms', model: 'modelS', center: { x: -45, y: 0, z: -12.6 }, headingDeg: 90, size: { x: 1.99, y: 1.45, z: 5.02 } },
  { kind: 'obstacle', id: 'ct', model: 'cybertruck', center: { x: -45, y: 0, z: -9.8 }, headingDeg: 90, size: { x: 2.41, y: 1.79, z: 5.68 } },
];

const DECOR: Decor[] = [
  { kind: 'stage', id: 'stage', pos: { x: -125, y: 0, z: 10 }, headingDeg: 90, size: { x: 40, y: 1.2, z: 14 } },
  { kind: 'grandstand', id: 'gs1', pos: { x: -125, y: 0, z: 45 }, headingDeg: 90, size: { x: 50, y: 8, z: 20 } },
  { kind: 'grandstand', id: 'gs2', pos: { x: -125, y: 0, z: -30 }, headingDeg: 90, size: { x: 50, y: 8, z: 20 } },
  ...[-150, -75, 0, 75, 150].flatMap((z, i) => [
    { kind: 'lightTower' as const, id: `lt_w${i}`, pos: { x: -100, y: 0, z }, headingDeg: 90, size: { x: 3, y: 26, z: 3 } },
    { kind: 'lightTower' as const, id: `lt_e${i}`, pos: { x: 120, y: 0, z }, headingDeg: -90, size: { x: 3, y: 26, z: 3 } },
  ]),
  // The 0-60 lane in the stream (1262-1268 s) is dark and unlit up to the gate: the run strips start
  // behind the gate housing.
  { kind: 'ledStrip', id: 'led_run_w', pos: { x: -8, y: 0, z: -100 }, headingDeg: 0, length: 280 },
  { kind: 'ledStrip', id: 'led_run_e', pos: { x: 8, y: 0, z: -100 }, headingDeg: 0, length: 280 },
  { kind: 'ledStrip', id: 'led_wall_w', pos: { x: 55.5, y: 0, z: -100 }, headingDeg: 0, length: 160 },
  { kind: 'ledStrip', id: 'led_wall_e', pos: { x: 64.5, y: 0, z: -100 }, headingDeg: 0, length: 160 },
  { kind: 'ledStrip', id: 'led_kick_w', pos: { x: -48.5, y: 0, z: -120 }, headingDeg: 0, length: 70 },
  { kind: 'ledStrip', id: 'led_kick_e', pos: { x: -41.5, y: 0, z: -120 }, headingDeg: 0, length: 70 },
  // Stream 0-60 (r8_stream_z60_plume.jpg): the car launches TOWARDS a dark grey housing and drives
  // through its lit opening (~1 m short of it at 0.62 s). pos = centre of the front face, the
  // housing (size: width, height, depth) extends away from the start; it is open at both ends.
  // 16 × 4.6 × 6 m housing around a 6.4 × 3.8 m opening (stream 1267 s), before 20 × 6.8 × 6
  { kind: 'gate', id: 'gate60', pos: { x: 0, y: 0, z: -110.5 }, headingDeg: 180, size: { x: 16, y: 4.6, z: 6 } },
  { kind: 'startLine', id: 'start60', pos: { x: 0, y: 0, z: -120 }, headingDeg: 90, length: 10 },
  { kind: 'raptorStand', id: 'raptor', pos: { x: -700, y: 0, z: 1100 }, headingDeg: 200, size: { x: 30, y: 60, z: 30 } },
];

export const TRACK = {
  pad: { min: { x: -150, z: -200 }, max: { x: 150, z: 200 } },   // asphalt pad; prairie beyond (render only)
  ramps: [WALL, KICKER] as CurvedRamp[],
  obstacles: OBSTACLES,
  decor: DECOR,
  sites: [
    {
      // 30 m run-up: enough for ~8 m/s entry and the ~3 s fan spool-up before the ramp as in the video
      stunt: 'ramp_hang', spawn: { pos: { x: 60, y: 0, z: 30 }, headingDeg: 0, speedMs: 0 },
      reference: { maxPitchDeg: 170, holdAltitudeM: 21.0, maxDownforceKg: 4700, holdSeconds: 10 },
    },
    {
      stunt: 'ramp_launch', spawn: { pos: { x: 60, y: 0, z: 30 }, headingDeg: 0, speedMs: 0 },
      reference: { leaveAltitudeM: 19.5, touchdownG: 1.4, climbG: 1.4 },
    },
    {
      stunt: 'kickflip', spawn: { pos: { x: -45, y: 0, z: -150 }, headingDeg: 0, speedMs: 0 },
      reference: { launchG: 3.5, apexAltitudeM: 7.7, touchdownG: 2.0, rollDeg: 360, airtimeS: 3.5 },
    },
    {
      stunt: 'zero60', spawn: { pos: { x: 0, y: 0, z: -120 }, headingDeg: 0, speedMs: 0 },
      reference: { zeroToSixtyS: 0.81 },
    },
    {
      stunt: 'ground_flip', spawn: { pos: { x: 20, y: 0, z: 40 }, headingDeg: 0, speedMs: 0 },
      reference: { rollDeg: 360, apexAltitudeM: 8.0 },
    },
  ] as StuntSite[],
} as const;

// ------------------------------------------------------------------ profile sampling (shared by physics + render)
export interface ProfileSample { s: number; y: number; z: number; thetaRad: number }

export function profileLength(profile: readonly ProfileSeg[]): number {
  let L = 0;
  for (const seg of profile) L += seg.kind === 'line' ? seg.length : seg.radius * Math.abs(seg.toDeg - seg.fromDeg) * DEG;
  return L;
}

/** Point on the ramp surface centreline at arc length s (ramp-local: z along approach, y up). */
export function sampleProfile(profile: readonly ProfileSeg[], s: number): ProfileSample {
  let y = 0, z = 0, theta = profile.length && profile[0].kind === 'arc' ? profile[0].fromDeg * DEG : 0, acc = 0;
  for (const seg of profile) {
    const segLen = seg.kind === 'line' ? seg.length : seg.radius * Math.abs(seg.toDeg - seg.fromDeg) * DEG;
    const d = Math.min(Math.max(s - acc, 0), segLen);
    if (seg.kind === 'line') {
      y += Math.sin(theta) * d; z += Math.cos(theta) * d;
    } else {
      const t0 = seg.fromDeg * DEG, t1 = t0 + d / seg.radius;
      // dz/ds = cos θ, dy/ds = sin θ, dθ/ds = 1/R
      z += seg.radius * (Math.sin(t1) - Math.sin(t0));
      y += seg.radius * (Math.cos(t0) - Math.cos(t1));
      theta = t1;
    }
    acc += segLen;
    if (s <= acc) break;
  }
  return { s: Math.min(s, acc), y, z, thetaRad: theta };
}

/** Uniformly sampled centreline (step in metres). */
export function sampleRamp(ramp: CurvedRamp, step = 0.25): ProfileSample[] {
  const L = profileLength(ramp.profile);
  const n = Math.max(2, Math.ceil(L / step) + 1);
  const out: ProfileSample[] = [];
  for (let i = 0; i < n; i++) out.push(sampleProfile(ramp.profile, (L * i) / (n - 1)));
  return out;
}

/** Ramp-local (x = left across, y up, z along the approach) -> world. Right-handed. */
export function rampLocalToWorld(ramp: CurvedRamp, p: Vec3): Vec3 {
  const h = ramp.headingDeg * DEG, c = Math.cos(h), s = Math.sin(h);
  return { x: ramp.origin.x + p.x * c + p.z * s, y: ramp.origin.y + p.y, z: ramp.origin.z - p.x * s + p.z * c };
}

export function headingToForward(headingDeg: number): Vec3 {
  return { x: Math.sin(headingDeg * DEG), y: 0, z: Math.cos(headingDeg * DEG) };
}

export function siteFor(stunt: StuntId): StuntSite {
  const s = TRACK.sites.find((x) => x.stunt === stunt);
  if (!s) throw new Error(`no site for ${stunt}`);
  return s;
}
