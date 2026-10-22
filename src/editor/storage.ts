// Levels in the browser (localStorage): a list of { id, name, modified, json }. Every access may throw (private
// mode, blocked storage): the editor keeps working with the level in memory then.
import { levelToJson, validateLevel, type GridSize, type Level } from '../shared/level';

const KEY = 'rft.levels.v1';
const LAST = 'rft.levels.last';

export interface StoredLevel { id: string; name: string; modified: string; json: string }

function readAll(): StoredLevel[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string' && typeof e.json === 'string') : [];
  } catch { return []; }
}

function writeAll(list: StoredLevel[]): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}

export function listLevels(): StoredLevel[] {
  return readAll().sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Saves (or updates) a level; returns its id, or null if the browser refused. */
export function saveLevel(level: Level, id?: string): string | null {
  const list = readAll();
  const now = new Date().toISOString();
  level.modified = now;
  level.created ??= now;
  const nid = id ?? `L${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const entry: StoredLevel = { id: nid, name: level.name, modified: now, json: levelToJson(level) };
  const k = list.findIndex((e) => e.id === nid);
  if (k >= 0) list[k] = entry; else list.push(entry);
  if (!writeAll(list)) return null;
  try { localStorage.setItem(LAST, nid); } catch { /* blocked */ }
  return nid;
}

export function loadLevel(id: string, grid: GridSize): Level | null {
  const e = readAll().find((x) => x.id === id);
  if (!e) return null;
  try { return validateLevel(JSON.parse(e.json), grid).level; } catch { return null; }
}

export function deleteLevel(id: string): void {
  writeAll(readAll().filter((e) => e.id !== id));
}

export function lastLevelId(): string | null {
  try { return localStorage.getItem(LAST); } catch { return null; }
}
