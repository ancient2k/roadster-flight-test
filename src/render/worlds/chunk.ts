// Chunk geometry for one CDLOD node: (N+1)² grid sampled from the height function, a per-vertex
// "parent height" (the shape of the next coarser level) for geomorphing, and skirts against
// residual cracks. Positions are local to the chunk centre. Pure (Vitest).

export interface ChunkArrays {
  positions: Float32Array;   // xyz, local to (cx, 0, cz)
  parentY: Float32Array;     // morph target height per vertex
  normals: Float32Array;     // geometric normals (fallback; shading uses the normal texture)
  indices: Uint32Array | Uint16Array;
  minY: number;
  maxY: number;
  cx: number;
  cz: number;
}

/**
 * Parent-level height at grid vertex (i, j) given the fine heights. Fine quads use the diagonal
 * (i, j)–(i+1, j+1), so every fine triangle lies inside a coarse triangle and the odd vertices
 * interpolate linearly along coarse edges / the coarse diagonal.
 */
export function parentHeight(h: ArrayLike<number>, n1: number, i: number, j: number): number {
  const at = (a: number, b: number) => h[b * n1 + a];
  const oi = i & 1, oj = j & 1;
  if (!oi && !oj) return at(i, j);
  if (oi && !oj) return 0.5 * (at(i - 1, j) + at(i + 1, j));
  if (!oi && oj) return 0.5 * (at(i, j - 1) + at(i, j + 1));
  return 0.5 * (at(i - 1, j - 1) + at(i + 1, j + 1));
}

/** Triangle indices of an N×N grid (vertex index = j·(N+1) + i, i along +X, j along +Z), up-facing. */
export function gridIndices(N: number, skirt: boolean): Uint32Array | Uint16Array {
  const n1 = N + 1;
  const quads = N * N + (skirt ? 4 * N : 0);
  const vcount = n1 * n1 + (skirt ? 4 * n1 : 0);
  const idx = vcount > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let k = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const p00 = j * n1 + i, p10 = p00 + 1, p01 = p00 + n1, p11 = p01 + 1;
    idx[k++] = p00; idx[k++] = p01; idx[k++] = p11;
    idx[k++] = p00; idx[k++] = p11; idx[k++] = p10;
  }
  if (skirt) {
    // skirt vertices follow the grid vertices: edge e (0 = z-min, 1 = x-max, 2 = z-max, 3 = x-min), t = 0..N
    const base = n1 * n1;
    const top = (e: number, t: number) => e === 0 ? t : e === 1 ? t * n1 + N : e === 2 ? N * n1 + (N - t) : (N - t) * n1;
    for (let e = 0; e < 4; e++) for (let t = 0; t < N; t++) {
      const a = top(e, t), b = top(e, t + 1), as = base + e * n1 + t, bs = base + e * n1 + t + 1;
      // outward-facing walls (seen from outside the chunk); double-sided not needed
      idx[k++] = a; idx[k++] = b; idx[k++] = as;
      idx[k++] = b; idx[k++] = bs; idx[k++] = as;
    }
  }
  return idx;
}

/** Build the chunk arrays. heightFn is the terrain height function (world x, z). */
export function buildChunk(
  heightFn: (x: number, z: number) => number, x0: number, z0: number, size: number, N: number, skirtDepth: number,
): ChunkArrays {
  const n1 = N + 1, step = size / N, cx = x0 + size / 2, cz = z0 + size / 2;
  const nv = n1 * n1 + (skirtDepth > 0 ? 4 * n1 : 0);
  const pos = new Float32Array(nv * 3), par = new Float32Array(nv), nor = new Float32Array(nv * 3);
  const hs = new Float32Array(n1 * n1);
  let minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) {
    const y = heightFn(x0 + i * step, z0 + j * step);
    hs[j * n1 + i] = y;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) {
    const v = j * n1 + i;
    pos[v * 3] = x0 + i * step - cx; pos[v * 3 + 1] = hs[v]; pos[v * 3 + 2] = z0 + j * step - cz;
    par[v] = parentHeight(hs, n1, i, j);
    const l = hs[j * n1 + Math.max(0, i - 1)], r = hs[j * n1 + Math.min(N, i + 1)];
    const u = hs[Math.max(0, j - 1) * n1 + i], d = hs[Math.min(N, j + 1) * n1 + i];
    const dx = (r - l) / ((Math.min(N, i + 1) - Math.max(0, i - 1)) * step), dz = (d - u) / ((Math.min(N, j + 1) - Math.max(0, j - 1)) * step);
    const len = Math.hypot(dx, 1, dz);
    nor[v * 3] = -dx / len; nor[v * 3 + 1] = 1 / len; nor[v * 3 + 2] = -dz / len;
  }
  if (skirtDepth > 0) {
    const base = n1 * n1;
    const top = (e: number, t: number) => e === 0 ? t : e === 1 ? t * n1 + N : e === 2 ? N * n1 + (N - t) : (N - t) * n1;
    for (let e = 0; e < 4; e++) for (let t = 0; t < n1; t++) {
      const src = top(e, t), dst = base + e * n1 + t;
      pos[dst * 3] = pos[src * 3]; pos[dst * 3 + 1] = pos[src * 3 + 1] - skirtDepth; pos[dst * 3 + 2] = pos[src * 3 + 2];
      par[dst] = par[src] - skirtDepth;
      nor[dst * 3] = nor[src * 3]; nor[dst * 3 + 1] = nor[src * 3 + 1]; nor[dst * 3 + 2] = nor[src * 3 + 2];
    }
    minY -= skirtDepth;
  }
  return { positions: pos, parentY: par, normals: nor, indices: gridIndices(N, skirtDepth > 0), minY, maxY, cx, cz };
}

/** Height range of a square by sampling an (n+1)² lattice (used for LOD bounding boxes before geometry exists). */
export function sampleRange(heightFn: (x: number, z: number) => number, x0: number, z0: number, size: number, n = 16): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const y = heightFn(x0 + (i / n) * size, z0 + (j / n) * size);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return [lo, hi];
}
