// Level format of the track editor (docs/EDITOR.md): pieces on the tile grid of a site's build area, free decoration,
// optional suggested realism settings. Pure data + validation + (de)serialisation; DOM-free (the share link's
// compression lives in src/editor/share.ts).
import { PART_TYPES, DECO_TYPES, partDef, type PartType, type DecoType } from './parts';

export const LEVEL_VERSION = 1;
/** Hard limits: keep a level small enough for a share link and cheap to build. */
export const MAX_PARTS = 1200;
export const MAX_DECO = 600;

export type Rot = 0 | 1 | 2 | 3;   // quarter turns, counter-clockwise seen from above (0 = road runs along +z)

export interface LevelPart {
  type: PartType;
  /** Tile of the footprint's lower corner (after rotation): i along +x, j along +z. */
  i: number; j: number;
  rot: Rot;
  /** Elevation level of the piece's base (0 = ground, 1 = elevated road at ELEVATED_Y). */
  lv?: 0 | 1;
  /** Piece options, e.g. countdown seconds of the launch clearance. */
  opt?: number;
}

export interface LevelDeco { type: DecoType; x: number; z: number; rotDeg: number }

export interface LevelSettings { damage?: 'off' | 'visual' | 'full'; compressor?: 'fun' | 'realistic' }

export interface Level {
  v: number;
  name: string;
  site: 'earth_bocachica';
  parts: LevelPart[];
  deco: LevelDeco[];
  settings?: LevelSettings;
  /** ISO dates, set by the editor's storage. */
  created?: string; modified?: string;
}

export interface GridSize { nx: number; nz: number }

export function emptyLevel(name: string): Level {
  return { v: LEVEL_VERSION, name, site: 'earth_bocachica', parts: [], deco: [] };
}

/** Tiles covered by a placed piece (footprint w × d along its own x/z, rotated). */
export function partTiles(p: Pick<LevelPart, 'type' | 'i' | 'j' | 'rot'>): [number, number][] {
  const d = partDef(p.type);
  const [w, h] = p.rot % 2 === 0 ? [d.w, d.d] : [d.d, d.w];
  const out: [number, number][] = [];
  for (let a = 0; a < w; a++) for (let b = 0; b < h; b++) out.push([p.i + a, p.j + b]);
  return out;
}

/** Index of the first piece covering tile (i, j) at the same level, or -1. */
export function partAt(level: Level, i: number, j: number, lv?: 0 | 1): number {
  return level.parts.findIndex((p) => (lv === undefined || (p.lv ?? 0) === lv) && partTiles(p).some(([a, b]) => a === i && b === j));
}

/** True if the piece fits the grid and does not overlap another piece on the same level (ignoring `skip`). */
export function canPlace(level: Level, grid: GridSize, p: LevelPart, skip = -1): boolean {
  const tiles = partTiles(p);
  if (tiles.some(([a, b]) => a < 0 || b < 0 || a >= grid.nx || b >= grid.nz)) return false;
  const lv = p.lv ?? 0;
  return !level.parts.some((q, k) => k !== skip && (q.lv ?? 0) === lv && partTiles(q).some(([a, b]) => tiles.some(([c, e]) => a === c && b === e)));
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export interface ValidateResult { level: Level; dropped: number }

/**
 * Accepts anything (parsed JSON from a file, a link or the browser storage) and returns a clean level: unknown
 * pieces, out-of-grid or overlapping pieces and invalid values are dropped and counted. Throws only if the input
 * is not a level at all or comes from a newer version.
 */
export function validateLevel(raw: unknown, grid: GridSize): ValidateResult {
  if (!raw || typeof raw !== 'object') throw new Error('not a level');
  const r = raw as Record<string, unknown>;
  const v = typeof r.v === 'number' ? r.v : NaN;
  if (!Number.isFinite(v)) throw new Error('not a level');
  if (v > LEVEL_VERSION) throw new Error(`level version ${v} is newer than this game (${LEVEL_VERSION})`);
  const level = emptyLevel(typeof r.name === 'string' ? r.name.slice(0, 60) : 'Track');
  if (typeof r.created === 'string') level.created = r.created.slice(0, 30);
  if (typeof r.modified === 'string') level.modified = r.modified.slice(0, 30);
  let dropped = 0;
  const parts = Array.isArray(r.parts) ? r.parts : [];
  for (const q of parts.slice(0, MAX_PARTS)) {
    const p = q as Record<string, unknown>;
    if (!PART_TYPES.includes(p.type as PartType) || !isInt(p.i, 0, 999) || !isInt(p.j, 0, 999) || !isInt(p.rot, 0, 3)) { dropped++; continue; }
    const part: LevelPart = { type: p.type as PartType, i: p.i, j: p.j, rot: p.rot as Rot };
    if (p.lv === 1) part.lv = 1;
    const def = partDef(part.type);
    if (def.opt && isNum(p.opt, def.opt.min, def.opt.max)) part.opt = p.opt;
    if (part.lv && !def.elevated) { dropped++; continue; }
    if (!canPlace(level, grid, part)) { dropped++; continue; }
    level.parts.push(part);
  }
  dropped += Math.max(0, parts.length - MAX_PARTS);
  const deco = Array.isArray(r.deco) ? r.deco : [];
  const maxX = grid.nx, maxZ = grid.nz;
  for (const q of deco.slice(0, MAX_DECO)) {
    const d = q as Record<string, unknown>;
    if (!DECO_TYPES.includes(d.type as DecoType) || !isNum(d.x, 0, maxX) || !isNum(d.z, 0, maxZ) || !isNum(d.rotDeg, -360, 360)) { dropped++; continue; }
    level.deco.push({ type: d.type as DecoType, x: d.x, z: d.z, rotDeg: d.rotDeg });
  }
  dropped += Math.max(0, deco.length - MAX_DECO);
  const s = r.settings as Record<string, unknown> | undefined;
  if (s && typeof s === 'object') {
    const settings: LevelSettings = {};
    if (s.damage === 'off' || s.damage === 'visual' || s.damage === 'full') settings.damage = s.damage;
    if (s.compressor === 'fun' || s.compressor === 'realistic') settings.compressor = s.compressor;
    if (Object.keys(settings).length) level.settings = settings;
  }
  return { level, dropped };
}

/** Compact JSON (the file format and the input of the share link). Deco positions are in tiles, 2 decimals. */
export function levelToJson(level: Level): string {
  const out: Record<string, unknown> = { v: LEVEL_VERSION, name: level.name, site: level.site };
  if (level.created) out.created = level.created;
  if (level.modified) out.modified = level.modified;
  out.parts = level.parts.map((p) => {
    const o: Record<string, unknown> = { type: p.type, i: p.i, j: p.j, rot: p.rot };
    if (p.lv) o.lv = p.lv;
    if (p.opt !== undefined) o.opt = p.opt;
    return o;
  });
  out.deco = level.deco.map((d) => ({ type: d.type, x: Math.round(d.x * 100) / 100, z: Math.round(d.z * 100) / 100, rotDeg: Math.round(d.rotDeg) }));
  if (level.settings) out.settings = level.settings;
  return JSON.stringify(out);
}
