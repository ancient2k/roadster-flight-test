// Heightmap contract of the Phase 2 terrains (decoder and sampler). Kept free of UI/i18n imports so the
// terrain workers can use it without bundling the locale tables; re-exported by ./worlds.
export interface TerrainMeta {
  /** Samples per side (square). */
  size: number;
  /** World extent of the heightmap (metres per side), centred on the site origin. */
  extentM: number;
  /** Height = minM + (u16 / 65535) * (maxM - minM). */
  minM: number;
  maxM: number;
  /** Height at the site origin is shifted to y = 0 by the loader. */
  source: string;
}

/** Decode a Uint16 heightmap into metres (Float32Array, size*size), shifted so the centre sample is y = 0. */
export function decodeHeightmap(buf: ArrayBuffer, meta: TerrainMeta): Float32Array {
  const u16 = new Uint16Array(buf);
  if (u16.length !== meta.size * meta.size) throw new Error(`heightmap size mismatch: ${u16.length} vs ${meta.size}²`);
  const out = new Float32Array(u16.length);
  const k = (meta.maxM - meta.minM) / 65535;
  for (let i = 0; i < u16.length; i++) out[i] = meta.minM + u16[i] * k;
  const c = Math.floor(meta.size / 2);
  const y0 = out[c * meta.size + c];
  for (let i = 0; i < out.length; i++) out[i] -= y0;
  return out;
}

/** Bilinear height at world (x, z) in metres; NaN outside the map. */
export function sampleHeight(h: Float32Array, meta: TerrainMeta, x: number, z: number): number {
  const n = meta.size, cell = meta.extentM / (n - 1);
  const fx = (x + meta.extentM / 2) / cell, fz = (z + meta.extentM / 2) / cell;
  if (fx < 0 || fz < 0 || fx > n - 1 || fz > n - 1) return Number.NaN;
  const ix = Math.min(n - 2, Math.floor(fx)), iz = Math.min(n - 2, Math.floor(fz));
  const tx = fx - ix, tz = fz - iz;
  const a = h[iz * n + ix], b = h[iz * n + ix + 1], c = h[(iz + 1) * n + ix], d = h[(iz + 1) * n + ix + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}
