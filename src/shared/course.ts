// The course of a level: the pieces in driving order from the start/finish piece, following the road ends
// (src/shared/parts.ts connectors) and over jump gaps. Used by the time trial (sections to pass, off-track test)
// and by the editor (closed-course hint, placing a piece so that it continues the road).
import { DIRS, partDef, placedConnectors, type PartType } from './parts';
import { partTiles, type Level, type LevelPart, type Rot } from './level';

export interface Course {
  /** Part indices in driving order, starting with the start piece. */
  order: number[];
  /** True if the road leads back into the start piece. */
  closed: boolean;
}

type Exit = { ti: number; tj: number; dir: number; lv: 0 | 1 };

const conns = (p: LevelPart): Exit[] => placedConnectors(partDef(p.type), p.i, p.j, p.rot, p.lv ?? 0);

/** Piece index covering tile (i, j) with a road end on that tile facing `dir` at level lv. */
function entryAt(level: Level, i: number, j: number, dir: number, lv: 0 | 1, skip: Set<number>): { k: number; at: Exit } | null {
  for (let k = 0; k < level.parts.length; k++) {
    if (skip.has(k)) continue;
    for (const c of conns(level.parts[k])) if (c.ti === i && c.tj === j && c.dir === dir && c.lv === lv) return { k, at: c };
  }
  return null;
}

export function buildCourse(level: Level): Course | null {
  const s = level.parts.findIndex((p) => p.type === 'start');
  if (s < 0) return null;
  const start = level.parts[s];
  // the start piece's road runs along its own +z: its 'N' end is the exit
  const startConns = conns(start);
  let exit = startConns[1];
  const order = [s];
  const used = new Set([s]);
  for (let guard = 0; guard < level.parts.length + 2; guard++) {
    const [dx, dz] = DIRS[exit.dir];
    const back = (exit.dir + 2) % 4;
    // the next piece's road end on the neighbouring tile, facing back
    let hit = entryAt(level, exit.ti + dx, exit.tj + dz, back, exit.lv, new Set<number>());
    if (hit && hit.k === s) return { order, closed: true };
    hit = hit && used.has(hit.k) ? null : hit;
    let next: number | null = hit?.k ?? null;
    let entry: Exit | null = hit?.at ?? null;
    if (next === null) {
      // a jump: look up to 4 tiles ahead (any level) for the piece the car lands on
      for (let a = 1; a <= 4 && next === null; a++) {
        const ti = exit.ti + dx * (a + 1), tj = exit.tj + dz * (a + 1);
        for (let k = 0; k < level.parts.length; k++) {
          if (used.has(k) && k !== s) continue;
          if (!partTiles(level.parts[k]).some(([i, j]) => i === ti && j === tj)) continue;
          if (k === s) return { order, closed: true };
          next = k;
          entry = conns(level.parts[k]).find((c) => c.dir === back) ?? null;
          break;
        }
      }
    }
    if (next === null) return { order, closed: false };
    order.push(next);
    used.add(next);
    const cs = conns(level.parts[next]);
    // leave through the other road end (single-ended pieces: landing ramps leave through their only end,
    // jump ramps and wall ramps end the road -> keep the direction and jump)
    const other = cs.find((c) => !entry || c.ti !== entry.ti || c.tj !== entry.tj || c.dir !== entry.dir);
    if (other) exit = other;
    else {
      // dead-end stunt piece: continue from its far edge in the travel direction
      const tiles = partTiles(level.parts[next]);
      const far = tiles.reduce((b, t) => (t[0] * dx + t[1] * dz > b[0] * dx + b[1] * dz ? t : b), tiles[0]);
      exit = { ti: far[0], tj: far[1], dir: exit.dir, lv: exit.lv };
    }
  }
  return { order, closed: false };
}

/**
 * Rotation to draw a piece with so its arrows point the way the course runs through it. Only for pieces whose road
 * works both ways and whose markings are directional (the boost pad: chevrons along its own +z, the pad pushes in
 * either direction); every other piece, and a boost pad off the course, keeps its own rotation.
 */
export function drawRot(level: Level, k: number, course: Course | null = buildCourse(level)): Rot {
  const p = level.parts[k];
  if (p.type !== 'boost' || !course) return p.rot;
  const n = course.order.indexOf(k);
  if (n < 0) return p.rot;
  // the neighbour the car comes from (or, for the first piece, the one it goes to) and the end nearer to it
  const other = level.parts[course.order[n > 0 ? n - 1 : n + 1] ?? k];
  if (other === p) return p.rot;
  const tiles = partTiles(other);
  const dist = (c: Exit) => Math.min(...tiles.map(([i, j]) => Math.hypot(i - (c.ti + DIRS[c.dir][0]), j - (c.tj + DIRS[c.dir][1]))));
  const [south, north] = conns(p);   // the pad's connectors: S (back) then N (+z, where the chevrons point)
  const fromNorth = dist(north) < dist(south);
  return ((n > 0) === fromNorth ? (p.rot + 2) % 4 : p.rot) as Rot;
}

/**
 * Places a piece so that one of its road ends sits on tile (ti, tj) facing `dir` (the direction back towards the
 * road it continues). `variant` picks among the fitting rotations/ends (e.g. a curve turning left or right).
 */
export function fitPiece(type: PartType, ti: number, tj: number, dir: number, lv: 0 | 1 = 0, variant = 0): LevelPart | null {
  const def = partDef(type);
  const fits: LevelPart[] = [];
  for (const rot of [0, 1, 2, 3] as Rot[]) {
    const base = placedConnectors(def, 0, 0, rot, 0);
    for (const c of base) {
      if (c.dir !== dir) continue;
      const pieceLv = (lv - (c.lv - 0)) as 0 | 1;           // the end's level relative to the piece
      if (pieceLv < 0 || pieceLv > 1 || (pieceLv === 1 && !def.elevated)) continue;
      const p: LevelPart = { type, i: ti - c.ti, j: tj - c.tj, rot };
      if (pieceLv) p.lv = 1;
      fits.push(p);
    }
  }
  return fits.length ? fits[variant % fits.length] : null;
}

/** The exit of a just-placed piece: its road end that is not the one at (ti, tj, entryDir). */
export function exitOf(p: LevelPart, ti: number, tj: number, entryDir: number): Exit | null {
  return conns(p).find((c) => !(c.ti === ti && c.tj === tj && c.dir === entryDir)) ?? null;
}
