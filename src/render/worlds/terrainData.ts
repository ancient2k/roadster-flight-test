// Terrain data for the world renderer: loads 's site assets (two formats, see below), exposes a single
// height function over near + far tile, and generates synthetic heightmaps until real data exists.
// Pure (no three imports) so it runs under Vitest.
//
// Formats under public/assets/worlds/<siteId>/:
//  (a) contract (src/shared/worlds.ts): height.bin (Uint16 LE) + meta.json = TerrainMeta {size, extentM, minM, maxM}
//      → decodeHeightmap (centre sample = 0); landmarks.json optional.
//  (b) pipeline: meta.json with tiles.near/far {heightmap: *.png (16-bit grey), resolution, sizeM,
//      heightMinM, heightMaxM, albedo, normalMap, splat}, spawn, sun, landmarks[], rocks, detailTextures.
//      Heights are already relative to the ground at the spawn — NOT re-zeroed here, so render and
//      physics (buildTerrainColliders) see the identical array if they both use loadTerrainData().
import { decodeHeightmap, type TerrainMeta } from '../../shared/heightmap';
import type { Vec3 } from '../../shared/math';
import { decodePngGrey } from './png16';

/** Square height grid centred on (cx, cz); rows along +Z (row 0 = north = −Z), columns along +X. */
export interface HeightGrid {
  size: number;
  extentM: number;
  cx: number;
  cz: number;
  h: Float32Array;
  minM: number;
  maxM: number;
}

export interface LandmarkDef {
  file: string; x: number; y: number; z: number; headingDeg: number; scale?: number; note?: string;
  /** Physics: 'pyramid' = smooth frustum hull + drivable talus (src/shared/pyramid.ts); default exact mesh. */
  collider?: 'pyramid' | 'mesh';
  /** movable, breakable objects inside this GLB (src/shared/props.ts); their triangles leave the static collider. */
  dynamic?: import('../../shared/props').PropObjectDef[];
}

export interface WorldAssets {
  format: 'contract' | 'wsf' | 'synthetic';
  near: HeightGrid;
  far: HeightGrid | null;
  /** Near tile in the contract shape (for buildTerrainColliders: heights = near.h). */
  terrainMeta: TerrainMeta;
  albedoUrl: string | null;
  normalUrl: string | null;
  splatUrl: string | null;
  /** Detail layer names (_shared/detail/<name>_diff.jpg …). */
  detailTextures: { fine?: string; rock?: string; dark?: string };
  landmarks: LandmarkDef[];
  rocksUrl: string | null;
  sunDir: Vec3 | null;
  sunLux: number | null;
  sunColorTempK: number | null;
  spawn: { x: number; y: number; z: number; headingDeg: number } | null;
  credits: string[];
}

// ------------------------------------------------------------------ sampling

export function gridCell(g: HeightGrid): number { return g.extentM / (g.size - 1); }

/** Bilinear height in the grid, clamped to its border. */
export function gridHeight(g: HeightGrid, x: number, z: number): number {
  const n = g.size, cell = gridCell(g);
  let fx = (x - g.cx + g.extentM / 2) / cell, fz = (z - g.cz + g.extentM / 2) / cell;
  fx = Math.min(n - 1, Math.max(0, fx)); fz = Math.min(n - 1, Math.max(0, fz));
  const ix = Math.min(n - 2, Math.floor(fx)), iz = Math.min(n - 2, Math.floor(fz));
  const tx = fx - ix, tz = fz - iz, h = g.h;
  const a = h[iz * n + ix], b = h[iz * n + ix + 1], c = h[(iz + 1) * n + ix], d = h[(iz + 1) * n + ix + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/** Signed distance (m) from (x, z) to the inside border of the grid square (positive inside). */
export function insideDistance(g: HeightGrid, x: number, z: number): number {
  const half = g.extentM / 2;
  return Math.min(half - Math.abs(x - g.cx), half - Math.abs(z - g.cz));
}

const smooth = (t: number) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

/**
 * Height function over near + far tile. Inside the near tile the near data wins; a blend band at its border
 * fades to the far tile (whose heights have the same datum), outside the far tile it is clamped.
 */
export class TerrainField {
  /** Half side of the whole field (m). */
  readonly halfExtent: number;
  readonly minM: number;
  readonly maxM: number;
  constructor(readonly near: HeightGrid, readonly far: HeightGrid | null, readonly blendM = 200) {
    const outer = far && far.extentM > near.extentM ? far : near;
    this.halfExtent = outer.extentM / 2;
    this.minM = Math.min(near.minM, far?.minM ?? Infinity);
    this.maxM = Math.max(near.maxM, far?.maxM ?? -Infinity);
  }

  /** Weight of the near tile at (x, z): 1 inside, 0 outside, smooth in the blend band. */
  nearWeight(x: number, z: number): number {
    if (!this.far) return 1;
    return smooth(insideDistance(this.near, x, z) / this.blendM);
  }

  height(x: number, z: number): number {
    const w = this.nearWeight(x, z);
    if (w >= 1) return gridHeight(this.near, x, z);
    const hf = gridHeight(this.far!, x, z);
    return w <= 0 ? hf : hf + (gridHeight(this.near, x, z) - hf) * w;
  }

  /** Native sample spacing at (x, z) (m) – LOD never needs to go finer. */
  spacing(x: number, z: number): number {
    return this.nearWeight(x, z) > 0 ? gridCell(this.near) : gridCell(this.far!);
  }

  /** Unit normal from central differences at spacing e (default: native spacing). */
  normal(x: number, z: number, e = this.spacing(x, z)): Vec3 {
    const dx = this.height(x + e, z) - this.height(x - e, z);
    const dz = this.height(x, z + e) - this.height(x, z - e);
    const nx = -dx, ny = 2 * e, nz = -dz;
    const l = Math.hypot(nx, ny, nz);
    return { x: nx / l, y: ny / l, z: nz / l };
  }
}

/**
 * World-space normal map of a grid (xz packed in RG as 0..255, y reconstructed), same layout as the grid.
 * Used by the fragment shader so shading does not pop with mesh LOD.
 */
export function gridNormalsRGBA8(g: HeightGrid): Uint8Array {
  const n = g.size, e = gridCell(g), h = g.h;
  const out = new Uint8Array(n * n * 4);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const l = h[r * n + Math.max(0, c - 1)], rr = h[r * n + Math.min(n - 1, c + 1)];
    const u = h[Math.max(0, r - 1) * n + c], d = h[Math.min(n - 1, r + 1) * n + c];
    const sx = (c === 0 || c === n - 1) ? 1 : 2, sz = (r === 0 || r === n - 1) ? 1 : 2;
    const nx = -(rr - l) / (sx * e), nz = -(d - u) / (sz * e);
    const len = Math.hypot(nx, 1, nz);
    const i = (r * n + c) * 4;
    out[i] = Math.round((nx / len * 0.5 + 0.5) * 255);
    out[i + 1] = Math.round((1 / len) * 255);
    out[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
    out[i + 3] = 255;
  }
  return out;
}

/** Slope (0 = flat, 1 = vertical) in [0..1] from a unit normal. */
export const slopeOf = (n: Vec3) => 1 - Math.max(0, Math.min(1, n.y));

// ------------------------------------------------------------------ synthetic heightmaps

function hash2(x: number, y: number, seed: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm2(x: number, y: number, seed: number, oct = 6, gain = 0.5): number {
  let f = 0, amp = 0.5, n = 0;
  for (let o = 0; o < oct; o++) { f += amp * (vnoise(x, y, seed + o * 13) * 2 - 1); n += amp; x *= 2.03; y *= 2.03; amp *= gain; }
  return f / n;
}

export type SynthKind = 'earth' | 'moon' | 'mars' | 'flat';

/**
 * Synthetic test terrain (rolling plain / cratered mare / Martian plain with ridges), centre at y = 0.
 * Deterministic for a seed.
 */
export function synthHeightmap(kind: SynthKind, size: number, extentM: number, seed = 1): HeightGrid {
  const h = new Float32Array(size * size);
  const cell = extentM / (size - 1);
  // crater list (moon, mars): power-law sizes
  const craters: { x: number; z: number; r: number; d: number }[] = [];
  if (kind === 'moon' || kind === 'mars') {
    const count = kind === 'moon' ? 260 : 70;
    for (let i = 0; i < count; i++) {
      const u = hash2(i, 1, seed), v = hash2(i, 2, seed), w = hash2(i, 3, seed);
      const r = 6 * Math.pow(1 - w * 0.995, -0.9) * (extentM / 4000);
      craters.push({ x: (u - 0.5) * extentM, z: (v - 0.5) * extentM, r: Math.min(r, extentM * 0.12), d: 0.18 });
    }
  }
  for (let rI = 0; rI < size; rI++) for (let c = 0; c < size; c++) {
    const x = -extentM / 2 + c * cell, z = -extentM / 2 + rI * cell;
    let y = 0;
    if (kind === 'earth') y = fbm2(x / 900, z / 900, seed, 6) * 28 + fbm2(x / 120, z / 120, seed + 5, 4) * 2.5;
    else if (kind === 'moon') y = fbm2(x / 1500, z / 1500, seed, 6) * 18 + fbm2(x / 60, z / 60, seed + 3, 4) * 0.6;
    else if (kind === 'mars') {
      const ridge = 1 - Math.abs(fbm2(x / 700, z / 700, seed + 9, 5));
      y = fbm2(x / 1200, z / 1200, seed, 6) * 35 + ridge * ridge * 22 + fbm2(x / 80, z / 80, seed + 4, 4) * 1.2;
    }
    for (const k of craters) {
      const d = Math.hypot(x - k.x, z - k.z) / k.r;
      if (d > 2.2) continue;
      // bowl + raised rim + ejecta falloff
      const bowl = d < 1 ? (d * d - 1) * k.d * k.r : 0;
      const rim = 0.06 * k.r * Math.exp(-((d - 1) * (d - 1)) / 0.04) + (d > 1 ? 0.04 * k.r * Math.pow(d, -3) : 0.04 * k.r);
      y += bowl + rim;
    }
    h[rI * size + c] = y;
  }
  const c0 = Math.floor(size / 2), y0 = h[c0 * size + c0];
  let minM = Infinity, maxM = -Infinity;
  for (let i = 0; i < h.length; i++) { h[i] -= y0; minM = Math.min(minM, h[i]); maxM = Math.max(maxM, h[i]); }
  return { size, extentM, cx: 0, cz: 0, h, minM, maxM };
}

// ------------------------------------------------------------------ loading

type Fetch = (url: string) => Promise<Response>;

async function okFetch(fetchFn: Fetch, url: string): Promise<Response | null> {
  try {
    const r = await fetchFn(url);
    // Vite dev server answers unknown paths with index.html
    if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) return null;
    return r;
  } catch { return null; }
}

function u16ToGrid(u16: Uint16Array, size: number, extentM: number, lo: number, hi: number, cx = 0, cz = 0): HeightGrid {
  const h = new Float32Array(u16.length);
  const k = (hi - lo) / 65535;
  let minM = Infinity, maxM = -Infinity;
  for (let i = 0; i < u16.length; i++) { const v = lo + u16[i] * k; h[i] = v; if (v < minM) minM = v; if (v > maxM) maxM = v; }
  return { size, extentM, cx, cz, h, minM, maxM };
}

interface WsfTile { heightmap: string; resolution: number; sizeM: number; centerX?: number; centerZ?: number; heightMinM: number; heightMaxM: number; albedo?: string; normalMap?: string; splat?: string }
interface WsfMeta {
  tiles: { near: WsfTile; far?: WsfTile };
  spawn?: { x: number; y: number; z: number; headingDeg: number };
  sun?: { direction?: number[]; illuminanceLux?: number; colorTempK?: number };
  landmarks?: LandmarkDef[];
  rocks?: { file?: string };
  detailTextures?: string[] | { fine?: string; rock?: string; dark?: string };
  sources?: { credit?: string }[];
}

async function loadPngGrid(fetchFn: Fetch, url: string, t: WsfTile): Promise<HeightGrid> {
  const r = await okFetch(fetchFn, url);
  if (!r) throw new Error(`Höhenmodell fehlt: ${url}`);
  const img = await decodePngGrey(await r.arrayBuffer());
  if (img.width !== img.height) throw new Error(`Höhenmodell nicht quadratisch: ${url}`);
  return u16ToGrid(img.data, img.width, t.sizeM, t.heightMinM, t.heightMaxM, t.centerX ?? 0, t.centerZ ?? 0);
}

/**
 * Load the terrain of a site. `dir` is the asset directory URL ending without '/'.
 * Returns null when the site has no terrain data (caller may fall back to synthHeightmap).
 */
export async function loadTerrainData(dir: string, fetchFn: Fetch = (u) => fetch(u)): Promise<WorldAssets | null> {
  const metaRes = await okFetch(fetchFn, `${dir}/meta.json`);
  if (!metaRes) return null;
  const meta = await metaRes.json() as Record<string, unknown>;
  const u = (f?: string | null) => (f ? `${dir}/${f}` : null);
  if (meta.tiles) {
    const m = meta as unknown as WsfMeta;
    if (!m.tiles.near) return null;
    const nt = m.tiles.near;
    const [near, far] = await Promise.all([
      loadPngGrid(fetchFn, `${dir}/${nt.heightmap}`, nt),
      m.tiles.far ? loadPngGrid(fetchFn, `${dir}/${m.tiles.far.heightmap}`, m.tiles.far).catch(() => null) : Promise.resolve(null),
    ]);
    const d = m.sun?.direction;
    return {
      format: 'wsf', near, far,
      terrainMeta: { size: near.size, extentM: near.extentM, minM: nt.heightMinM, maxM: nt.heightMaxM, source: 'ws-f meta.tiles.near' },
      albedoUrl: u(nt.albedo), normalUrl: u(nt.normalMap), splatUrl: u(nt.splat),
      detailTextures: Array.isArray(m.detailTextures) ? { fine: m.detailTextures[0], rock: m.detailTextures[1] } : m.detailTextures ?? {},
      landmarks: m.landmarks ?? [],
      rocksUrl: u(m.rocks?.file),
      sunDir: d && d.length === 3 ? { x: d[0], y: d[1], z: d[2] } : null,
      sunLux: m.sun?.illuminanceLux ?? null, sunColorTempK: m.sun?.colorTempK ?? null,
      spawn: m.spawn ? { x: m.spawn.x, y: m.spawn.y, z: m.spawn.z, headingDeg: m.spawn.headingDeg } : null,
      credits: (m.sources ?? []).map((s) => s.credit ?? '').filter((s, i, a) => s && a.indexOf(s) === i),
    };
  }
  const tm = meta as unknown as TerrainMeta;
  if (typeof tm.size !== 'number') return null;
  const bin = await okFetch(fetchFn, `${dir}/height.bin`);
  if (!bin) return null;
  const h = decodeHeightmap(await bin.arrayBuffer(), tm);
  let minM = Infinity, maxM = -Infinity;
  for (let i = 0; i < h.length; i++) { if (h[i] < minM) minM = h[i]; if (h[i] > maxM) maxM = h[i]; }
  const lmRes = await okFetch(fetchFn, `${dir}/landmarks.json`);
  const lm = lmRes ? await lmRes.json() as LandmarkDef[] | { landmarks: LandmarkDef[] } : [];
  const has = async (f: string) => (await okFetch(fetchFn, `${dir}/${f}`)) ? `${dir}/${f}` : null;
  return {
    format: 'contract', near: { size: tm.size, extentM: tm.extentM, cx: 0, cz: 0, h, minM, maxM }, far: null, terrainMeta: tm,
    albedoUrl: await has('albedo.jpg'), normalUrl: null, splatUrl: null, detailTextures: {},
    landmarks: Array.isArray(lm) ? lm : lm.landmarks ?? [], rocksUrl: null, sunDir: null, sunLux: null, sunColorTempK: null, spawn: null,
    credits: tm.source ? [tm.source] : [],
  };
}

/** Synthetic stand-in assets for a body (no textures, no landmarks). */
export function syntheticAssets(kind: SynthKind, seed = 1): WorldAssets {
  const near = synthHeightmap(kind, 513, 4000, seed);
  const far = synthHeightmap(kind, 257, 30000, seed + 100);
  // same datum: shift far so it matches near at the centre
  const off = gridHeight(near, 0, 0) - gridHeight(far, 0, 0);
  for (let i = 0; i < far.h.length; i++) far.h[i] += off;
  far.minM += off; far.maxM += off;
  return {
    format: 'synthetic', near, far,
    terrainMeta: { size: near.size, extentM: near.extentM, minM: near.minM, maxM: near.maxM, source: `synthetisch (${kind})` },
    albedoUrl: null, normalUrl: null, splatUrl: null, detailTextures: {}, landmarks: [], rocksUrl: null,
    sunDir: null, sunLux: null, sunColorTempK: null, spawn: null, credits: ['synthetisches Testgelände'],
  };
}
