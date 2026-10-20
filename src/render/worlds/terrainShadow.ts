// Baked sun visibility of a static heightfield (horizon march toward the sun). Gives crater, rille and
// pyramid shadows out to the horizon, where the real-time shadow map (a few hundred metres) ends.
// Soft edge from the sun's angular radius (penumbra is physical: horizon angle vs. solar disc).
// Pure (Vitest).
import type { HeightGrid } from './terrainData';

export interface ShadowBakeOptions {
  /** Output resolution (texels per side) over the grid's extent. */
  res: number;
  /** Sun direction (unit, toward the sun). */
  sun: { x: number; y: number; z: number };
  /** Angular radius of the penumbra (rad): sun radius, widened to the texel footprint. */
  penumbra: number;
  /** Maximum march distance (m). */
  maxDist: number;
  /** Optional second height source (e.g. far tile) used beyond the grid. */
  outer?: (x: number, z: number) => number;
  /** Bake only output rows [from, to) (parallel bakes); the result then holds (to − from) × res bytes. */
  rows?: { from: number; to: number };
}

function sampler(g: HeightGrid) {
  const n = g.size, cell = g.extentM / (n - 1), x0 = g.cx - g.extentM / 2, z0 = g.cz - g.extentM / 2, h = g.h;
  return (x: number, z: number): number => {
    const fx = (x - x0) / cell, fz = (z - z0) / cell;
    if (fx < 0 || fz < 0 || fx > n - 1 || fz > n - 1) return Number.NaN;
    const ix = Math.min(n - 2, fx | 0), iz = Math.min(n - 2, fz | 0);
    const tx = fx - ix, tz = fz - iz, k = iz * n + ix;
    const a = h[k], b = h[k + 1], c = h[k + n], d = h[k + n + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
}

/** Returns res² visibility bytes (0 = shadow, 255 = lit), row 0 = north (−Z) like the grid. */
export function bakeSunVisibility(g: HeightGrid, o: ShadowBakeOptions): Uint8Array {
  const r0 = o.rows?.from ?? 0, r1 = o.rows?.to ?? o.res;
  const out = new Uint8Array((r1 - r0) * o.res);
  const s = o.sun;
  const horiz = Math.hypot(s.x, s.z);
  if (s.y <= -o.penumbra) return out;           // sun below the horizon everywhere
  if (horiz < 1e-4) { out.fill(255); return out; }
  const dx = s.x / horiz, dz = s.z / horiz;
  const sunEl = Math.atan2(s.y, horiz);
  const inner = sampler(g);
  const hAt = (x: number, z: number) => { const v = inner(x, z); return Number.isNaN(v) && o.outer ? o.outer(x, z) : v; };
  const texel = g.extentM / o.res;
  const pen = Math.max(o.penumbra, Math.atan(1 / Math.max(1, o.res)) * 0.5);
  const x0 = g.cx - g.extentM / 2, z0 = g.cz - g.extentM / 2;
  const cell = g.extentM / (g.size - 1);
  const step0 = Math.max(cell * 0.75, texel * 0.5);
  for (let r = r0; r < r1; r++) for (let c = 0; c < o.res; c++) {
    const x = x0 + (c + 0.5) * texel, z = z0 + (r + 0.5) * texel;
    const h0 = hAt(x, z) + 0.05;
    let maxTan = -Infinity, t = step0, st = step0;
    while (t < o.maxDist) {
      const h = hAt(x + dx * t, z + dz * t);
      if (Number.isNaN(h)) break;
      const tn = (h - h0) / t;
      if (tn > maxTan) maxTan = tn;
      t += st;
      st *= 1.045;
    }
    const horizon = maxTan === -Infinity ? -Math.PI / 2 : Math.atan(maxTan);
    const v = (sunEl - horizon) / (2 * pen) + 0.5;
    out[(r - r0) * o.res + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
  return out;
}

/**
 * Rasterise triangles (world space) into a copy of the grid as max-height occluders (landmarks
 * such as the pyramids then cast baked shadows too). Triangles are given as flat xyz arrays.
 */
export function stampOccluders(g: HeightGrid, tris: Float32Array): HeightGrid {
  const n = g.size, cell = g.extentM / (n - 1), x0 = g.cx - g.extentM / 2, z0 = g.cz - g.extentM / 2;
  const h = new Float32Array(g.h);
  for (let t = 0; t + 8 < tris.length; t += 9) {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2], bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5];
    const cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
    const minC = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cell)), maxC = Math.min(n - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / cell));
    const minR = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / cell)), maxR = Math.min(n - 1, Math.ceil((Math.max(az, bz, cz) - z0) / cell));
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(den) < 1e-9) continue;
    for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) {
      const px = x0 + c * cell, pz = z0 + r * cell;
      const w1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den;
      const w2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den;
      const w3 = 1 - w1 - w2;
      if (w1 < -1e-4 || w2 < -1e-4 || w3 < -1e-4) continue;
      const y = w1 * ay + w2 * by + w3 * cy;
      const k = r * n + c;
      if (y > h[k]) h[k] = y;
    }
  }
  return { ...g, h };
}

/**
 * Bake in a Web Worker when available (keeps the loading screen responsive); falls back to the main thread.
 * `outer` passes the whole field (near + far) for marching beyond the grid.
 */
export async function bakeSunVisibilityAsync(
  g: HeightGrid, o: Omit<ShadowBakeOptions, 'outer' | 'rows'>,
  outer?: { near: HeightGrid; far: HeightGrid | null; blendM: number; height: (x: number, z: number) => number } | null,
  workers = 1,
): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') return bakeSunVisibility(g, { ...o, outer: outer?.height });
  // the rows are independent – split them over several workers (identical result, ~N× faster)
  const n = Math.max(1, Math.min(workers, Math.floor(o.res / 16)));
  const bounds = Array.from({ length: n }, (_, i) => ({ from: Math.round((i * o.res) / n), to: Math.round(((i + 1) * o.res) / n) }));
  const live: Worker[] = [];
  try {
    const parts = await Promise.all(bounds.map((rows) => new Promise<Uint8Array>((resolve, reject) => {
      const w = new Worker(new URL('./shadowWorker.ts', import.meta.url), { type: 'module' });
      live.push(w);
      w.onmessage = (e: MessageEvent<Uint8Array>) => resolve(e.data);
      w.onerror = (e) => reject(e);
      w.postMessage({ grid: g, outer: outer ? { near: outer.near, far: outer.far, blendM: outer.blendM } : null, opts: { ...o, rows } });
    })));
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(o.res * o.res);
    parts.forEach((p, i) => out.set(p, bounds[i].from * o.res));
    return out;
  } catch (e) {
    console.warn('[worlds] Schatten-Worker nicht verfügbar, rechne im Hauptthread:', e);
    return bakeSunVisibility(g, { ...o, outer: outer?.height });
  } finally {
    for (const w of live) w.terminate();
  }
}
