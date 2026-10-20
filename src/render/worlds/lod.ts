// CDLOD quadtree (Strugar 2010) over a square terrain field: distance-based node selection with
// per-level ranges that double, and the morph window each selected node uses for geomorphing.
// Pure logic (Vitest).
//
// Crack-freedom: a node of level L sits next to a coarser node (L+1) only where that neighbour was not
// subdivided, i.e. its bounding box lies outside the sphere range[L]; the shared edge therefore is at
// distance ≥ range[L] = morphEnd(L), where the fine node has fully morphed to the coarse shape. Skirts
// cover remaining float error.

export interface Vec3Like { x: number; y: number; z: number }

export interface LodNode {
  /** 0 = leaf level (finest), increasing toward the root. */
  level: number;
  /** Depth from the root (root = 0). */
  depth: number;
  x0: number;
  z0: number;
  size: number;
  /** Morph window (world distance from the camera). */
  morphStart: number;
  morphEnd: number;
}

export interface LodConfig {
  /** Root square: min corner and side. */
  x0: number;
  z0: number;
  size: number;
  /** Quads per node side (grid resolution of every chunk). */
  gridN: number;
  /** Deepest allowed depth (leaf). */
  maxDepth: number;
  /** Range of the leaf level (m); level L uses leafRange·2^L. */
  leafRange: number;
  /** Morph starts at this fraction of the range. */
  morphStartRatio: number;
  /** Optional per-node depth cap (e.g. far tile has coarser data): return the max depth for that square. */
  depthCap?: (x0: number, z0: number, size: number) => number;
  /** Height range of a node square (for the 3D bounding box). */
  heightRange: (x0: number, z0: number, size: number) => [number, number];
}

/** Ranges per level (index = level, 0 = leaf). */
export function lodRanges(leafRange: number, levels: number): number[] {
  const r: number[] = [];
  for (let i = 0; i < levels; i++) r.push(leafRange * 2 ** i);
  return r;
}

/** Depth at which the chunk grid spacing first reaches `spacing` or finer. */
export function depthForSpacing(rootSize: number, gridN: number, spacing: number): number {
  return Math.max(0, Math.ceil(Math.log2(rootSize / (gridN * spacing)) - 1e-9));
}

/** Squared distance from p to an axis-aligned box. */
export function boxDistSq(p: Vec3Like, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const dx = Math.max(x0 - p.x, 0, p.x - x1);
  const dy = Math.max(y0 - p.y, 0, p.y - y1);
  const dz = Math.max(z0 - p.z, 0, p.z - z1);
  return dx * dx + dy * dy + dz * dz;
}

/** Morph factor for a vertex at distance d (0 = own detail, 1 = parent shape). */
export function morphFactor(d: number, start: number, end: number): number {
  return Math.min(1, Math.max(0, (d - start) / Math.max(1e-6, end - start)));
}

/** Select the nodes to draw for a camera position. */
export function selectLod(cfg: LodConfig, cam: Vec3Like, out: LodNode[] = []): LodNode[] {
  out.length = 0;
  const ranges = lodRanges(cfg.leafRange, cfg.maxDepth + 1);
  const visit = (depth: number, x0: number, z0: number, size: number) => {
    const level = cfg.maxDepth - depth;
    const cap = cfg.depthCap ? Math.min(cfg.maxDepth, cfg.depthCap(x0, z0, size)) : cfg.maxDepth;
    const [y0, y1] = cfg.heightRange(x0, z0, size);
    const finer = level > 0 ? ranges[level - 1] : 0;
    const subdivide = depth < cap && boxDistSq(cam, x0, y0, z0, x0 + size, y1, z0 + size) < finer * finer;
    if (subdivide) {
      const h = size / 2;
      visit(depth + 1, x0, z0, h); visit(depth + 1, x0 + h, z0, h);
      visit(depth + 1, x0, z0 + h, h); visit(depth + 1, x0 + h, z0 + h, h);
      return;
    }
    // Depth-capped nodes never morph (no finer level beside them except where the cap changes).
    const end = ranges[level];
    out.push({ level, depth, x0, z0, size, morphStart: end * cfg.morphStartRatio, morphEnd: end });
  };
  visit(0, cfg.x0, cfg.z0, cfg.size);
  return out;
}

/** Stable key for caching a node's geometry. */
export const nodeKey = (n: { depth: number; x0: number; z0: number }) => `${n.depth}:${Math.round(n.x0 * 16)}:${Math.round(n.z0 * 16)}`;
