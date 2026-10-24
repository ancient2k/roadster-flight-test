// Driving lines of the track pieces (the middle of the lane, in the piece frame of src/shared/parts.ts) and the line
// of a whole course in world coordinates. Used by the course driver (src/sim/gnc/courseDriver.ts): drivability tests
// of the editor pieces and tracks, and the trailer's test drive.
import { BANK_DEG, ELEVATED_Y, TILE_M, bankEase, loopLine, partDef, placeTransform, type PartType } from './parts';
import { buildCourse } from './course';
import type { Level, LevelPart } from './level';

export interface LanePoint {
  x: number; y: number; z: number;
  /** Highest sensible speed here (m/s): curve radius, landing. */
  vMax: number;
  /** Speed needed here (m/s): loop, jump. */
  vMin: number;
  /** Index of the part in level.parts. */
  part: number;
  /** Airborne stretch (jump gap): no steering corrections. */
  air?: boolean;
  /** Jump ramp before a gap: full power up to vMax (the take-off speed decides where the car lands). */
  takeoff?: boolean;
}

type V = [number, number, number];
const T = TILE_M, H = T / 2;
const sstep = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const sample = (n: number, f: (s: number) => V): V[] => Array.from({ length: n + 1 }, (_, k) => f(k / n));
const arc = (r: number, y = 0) => (s: number): V => { const a = s * Math.PI / 2; return [H + r - r * Math.cos(a), y, r * Math.sin(a)]; };
/** Grip-limited cornering speed on radius r (m/s), with a margin. */
const vCurve = (r: number) => Math.sqrt(0.75 * 9.81 * r);
const V_ROAD = 45;

/** The driving line of a piece in its own frame, from its first road end (conn[0]) to its other end (or its far edge). */
export function partLane(type: PartType): { pts: V[]; vMax: number; vMin: number } | null {
  switch (type) {
    case 'road': case 'start': case 'boost': case 'air_station': case 'launch':
      return { pts: sample(4, (s) => [H, 0, T * s]), vMax: V_ROAD, vMin: 0 };
    case 'halfpipe':
      return { pts: sample(8, (s) => [H, 0, 2 * T * s]), vMax: V_ROAD, vMin: 0 };
    case 'curve': return { pts: sample(16, arc(H)), vMax: vCurve(H), vMin: 0 };
    case 'curve_wide': return { pts: sample(24, arc(T + H)), vMax: vCurve(T + H), vMin: 0 };
    case 'elevated_curve': return { pts: sample(16, arc(H, ELEVATED_Y)), vMax: vCurve(H), vMin: 0 };
    case 'banked': {
      const R = T + H, bank = BANK_DEG * Math.PI / 180, w = 10;
      return { pts: sample(24, (s) => { const a = s * Math.PI / 2, b = bank * bankEase(s); return [H + R - R * Math.cos(a), Math.sin(b) * w / 2, R * Math.sin(a)]; }), vMax: vCurve(R) * 1.25, vMin: 0 };
    }
    case 'ramp_up': return { pts: sample(16, (s) => [H, ELEVATED_Y * sstep(s), 2 * T * s]), vMax: 22, vMin: 0 };
    case 'elevated': return { pts: sample(4, (s) => [H, ELEVATED_Y, T * s]), vMax: V_ROAD, vMin: 0 };
    case 'kicker': return { pts: sample(8, (s) => [H, 3 * s * s, T * s]), vMax: 30, vMin: 22 };
    // single road end on N: driven from its high end (−z, coming over the gap) down to N
    case 'landing': return { pts: sample(16, (s) => [H, 4 * (1 - sstep(s)), 2 * T * s]), vMax: V_ROAD, vMin: 0 };
    case 'loop': {
      const L = loopLine(), x0 = L.pts[0][0], x1 = L.pts[L.pts.length - 1][0];
      // entry and exit lanes lie off the road's middle (the loop's lanes pass each other): straight on them
      const entry = sample(4, (s) => [x0, 0, L.zIn * s]);
      const loop = L.pts.filter((_, i) => i % 6 === 0 || i === L.pts.length - 1);
      const exit = sample(4, (s) => [x1, 0, L.zOut + (2 * T - L.zOut) * s]);
      return { pts: [...entry, ...loop.slice(1), ...exit.slice(1)], vMax: 30, vMin: 23 };
    }
    // dead-end stunt pieces (wall ramp: the stream's stunt; the ring is flown through): the line runs along the
    // ground beside them so that a lap can go on
    case 'wallramp': return { pts: sample(8, (s) => [H, 0, 2 * T * s]), vMax: 0, vMin: 0 };
    case 'ring': return null;
  }
}

/** Piece frame → world (x, z) for a placed part: build-area origin (minX, minZ) and tile size. */
export interface LaneArea { minX: number; minZ: number; tileM: number; y: number }

/** Speed limits per piece type replacing the built-in ones (tests: how fast a piece can or must be taken). */
export type LaneSpeeds = Partial<Record<PartType, { vMin?: number; vMax?: number }>>;

function placedLane(p: LevelPart, k: number, area: LaneArea, speeds: LaneSpeeds = {}): LanePoint[] | null {
  const base = partLane(p.type);
  const lane = base && { ...base, ...speeds[p.type] };
  if (!lane) return null;
  const def = partDef(p.type);
  const f = placeTransform(def, p.i, p.j, p.rot, area.tileM);
  const sc = area.tileM / TILE_M;
  return lane.pts.map(([x, y, z]) => {
    const [wx, wz] = f(x * sc, z * sc);
    return { x: area.minX + wx, y: area.y + y, z: area.minZ + wz, vMax: lane.vMax, vMin: lane.vMin, part: k };
  });
}

const d2 = (a: { x: number; z: number }, b: { x: number; z: number }) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

/**
 * The driving line of a level's course (start piece first, in driving order; each piece's lane turned to continue
 * from the previous one; jump gaps bridged by an airborne straight). null without a start piece.
 */
export function courseLine(level: Level, area: LaneArea, speeds?: LaneSpeeds): { pts: LanePoint[]; closed: boolean } | null {
  const course = buildCourse(level);
  if (!course) return null;
  const pts: LanePoint[] = [];
  for (const k of course.order) {
    let lane = placedLane(level.parts[k], k, area, speeds);
    if (!lane) continue;
    if (pts.length) {
      const last = pts[pts.length - 1];
      if (d2(lane[lane.length - 1], last) < d2(lane[0], last)) lane = lane.reverse();
      const gap = Math.sqrt(d2(lane[0], last));
      if (gap > 2 && level.parts[last.part]?.type === 'kicker') {
        // a jump: an airborne straight across the gap, and the take-off speed that lands the car in the middle of
        // the landing ramp (lip at 17°, distance from the lip to the middle of the next piece's lane)
        const n = Math.ceil(gap / 2);
        for (let m = 1; m < n; m++) {
          const u = m / n;
          pts.push({ x: last.x + (lane[0].x - last.x) * u, y: last.y + (lane[0].y - last.y) * u, z: last.z + (lane[0].z - last.z) * u, vMax: 0, vMin: 0, part: last.part, air: true });
        }
        last.air = true;
        const mid = lane[Math.floor(lane.length / 2)], D = Math.sqrt(d2(mid, last));
        const v = Math.sqrt((9.81 * D) / Math.sin(2 * 17 * Math.PI / 180));
        for (const p of pts) if (p.part === last.part && !p.air) { p.vMin = v; p.vMax = v + 6; p.takeoff = true; }
      }
      else if (gap > 2) {
        // ground (or a drop off the end of an elevated road) between two pieces: straight on
        const n = Math.ceil(gap / 4);
        for (let m = 1; m < n; m++) {
          const u = m / n;
          pts.push({ x: last.x + (lane[0].x - last.x) * u, y: Math.min(last.y, lane[0].y), z: last.z + (lane[0].z - last.z) * u, vMax: 24, vMin: 0, part: last.part });
        }
      }
      if (d2(lane[0], pts[pts.length - 1]) < 0.01) lane = lane.slice(1);
    }
    pts.push(...lane);
  }
  return { pts, closed: course.closed };
}

/** Where a level's car starts: 6 m before the start line, heading along the start piece's road (as App.playLevel). */
export function courseStart(level: Level, area: LaneArea): { x: number; z: number; headingDeg: number } | null {
  const p = level.parts.find((q) => q.type === 'start');
  if (!p) return null;
  const f = placeTransform(partDef('start'), p.i, p.j, p.rot, 1);
  const [cx, cz] = f(0.5, 0.3), [fx, fz] = f(0.5, 0.7);
  return { x: area.minX + cx * area.tileM, z: area.minZ + cz * area.tileM, headingDeg: Math.atan2(fx - cx, fz - cz) * 180 / Math.PI };
}
