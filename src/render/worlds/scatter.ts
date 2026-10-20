// Deterministic boulder placement over the near tile (pure, Vitest): power-law size distribution
// (N(>D) ∝ D^-2.5, like lunar/Martian boulder counts), rejection by slope and an optional extra weight.
import type { TerrainField } from './terrainData';

export interface RockInstance { x: number; y: number; z: number; size: number; yaw: number; tilt: number; flat: number; variant: number }

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** Size from a cumulative power law between dMin and dMax (diameter, m). */
export function powerLawSize(u: number, dMin: number, dMax: number, alpha = 2.5): number {
  const a = dMin ** -alpha, b = dMax ** -alpha;
  return (a - u * (a - b)) ** (-1 / alpha);
}

export function scatterRocks(field: TerrainField, o: { count: number; seed: number; dMin?: number; dMax?: number; extraWeight?: (x: number, z: number) => number }): RockInstance[] {
  const r = rng(o.seed + 17);
  const out: RockInstance[] = [];
  const g = field.near, half = g.extentM / 2 - 20;
  const dMin = o.dMin ?? 0.25, dMax = o.dMax ?? 3.2;
  let tries = 0;
  while (out.length < o.count && tries < o.count * 12) {
    tries++;
    const x = g.cx + (r() * 2 - 1) * half, z = g.cz + (r() * 2 - 1) * half;
    const n = field.normal(x, z);
    const slope = 1 - n.y;
    // more boulders on moderate slopes/rims, none on cliffs; flat ground keeps a base rate
    let w = 0.25 + Math.min(1, slope * 6) * 0.75;
    if (slope > 0.5) w *= 0.2;
    if (o.extraWeight) w = Math.max(w, o.extraWeight(x, z));
    if (r() > w) continue;
    const size = powerLawSize(r(), dMin, dMax) * 0.5;
    out.push({ x, y: field.height(x, z), z, size, yaw: r() * Math.PI * 2, tilt: (r() - 0.5) * 0.5, flat: 0.55 + r() * 0.4, variant: Math.floor(r() * 64) });
  }
  return out;
}
