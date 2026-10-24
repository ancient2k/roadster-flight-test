// Builds the static Rapier world from the shared track layout (same source as the renderer).
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { TRACK, rampLocalToWorld, sampleRamp, type CurvedRamp } from '@shared/track';
import { DEG, qaxisAngle, type Vec3 } from '@shared/math';

type R = typeof RAPIER_NS;

export const GROUP_WORLD = 0x0002;
export const GROUP_CAR = 0x0001;
/** movable landmarks (src/sim/core/props.ts). Static world colliders accept them as well as the car. */
export const GROUP_PROP = 0x0004;
/** Rapier interaction groups: membership << 16 | filter. */
export const groups = (member: number, filter: number): number => ((member & 0xffff) << 16) | (filter & 0xffff);

export interface WorldColliderInfo { kind: 'ground' | 'ramp' | 'obstacle' | 'landmark' | 'prop'; id: string }

/** Collision shape of a landmark in world space: smooth convex hull (pyramids) or exact triangle mesh (stones, rovers). */
export interface LandmarkShape {
  id: string; kind: 'hull' | 'mesh'; data: Float32Array /* hull: points xyz…; mesh: triangles xyz×3… */;
  /** mesh only: closed and wound outward → one-sided with FIX_INTERNAL_EDGES (no ghost bumps at triangle edges) */
  outward?: boolean;
}

/** Closed, extruded mesh of a curved ramp: drive surface + backside offset by `thickness`. */
export function buildRampMesh(ramp: CurvedRamp, step = 0.25): { vertices: Float32Array; indices: Uint32Array } {
  const prof = sampleRamp(ramp, step);
  const hw = ramp.width / 2;
  const verts: number[] = [];
  const push = (p: Vec3) => { const w = rampLocalToWorld(ramp, p); verts.push(w.x, w.y, w.z); };
  for (const s of prof) {
    // surface normal (toward the driving side) in ramp-local y/z: rotate tangent (sinθ, cosθ) by +90°
    const ny = Math.cos(s.thetaRad), nz = -Math.sin(s.thetaRad);
    const by = s.y - ny * ramp.thickness, bz = s.z - nz * ramp.thickness;
    push({ x: hw, y: s.y, z: s.z });      // 0 surface left
    push({ x: -hw, y: s.y, z: s.z });     // 1 surface right
    push({ x: hw, y: by, z: bz });        // 2 back left
    push({ x: -hw, y: by, z: bz });       // 3 back right
  }
  const idx: number[] = [];
  const n = prof.length;
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4, b = (i + 1) * 4;
    idx.push(a, b, a + 1, a + 1, b, b + 1);               // surface
    idx.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);   // back
    idx.push(a, a + 2, b, b, a + 2, b + 2);               // left side
    idx.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);   // right side
  }
  const e = (n - 1) * 4;
  idx.push(0, 1, 2, 1, 3, 2, e, e + 2, e + 1, e + 1, e + 2, e + 3); // end caps
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
}

export function buildTrackColliders(RAPIER: R, world: RAPIER_NS.World): Map<number, WorldColliderInfo> {
  const info = new Map<number, WorldColliderInfo>();
  const g = groups(GROUP_WORLD, GROUP_CAR | GROUP_PROP);
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  // Ground as a grid of 400 m tiles: single huge cuboids/trimeshes make Rapier's f32 GJK shape casts
  // miss ~50 % of the time (measurement: half-extent 3000 m -> 1048/2000 misses, <= 300 m -> 0).
  const TILE = 400, N = 15, half = (N * TILE) / 2;   // ±3000 m
  for (let ix = 0; ix < N; ix++) {
    for (let iz = 0; iz < N; iz++) {
      const cx = -half + TILE / 2 + ix * TILE, cz = -half + TILE / 2 + iz * TILE;
      const tile = world.createCollider(
        RAPIER.ColliderDesc.cuboid(TILE / 2, 1, TILE / 2).setTranslation(cx, -1, cz)
          .setFriction(1.0).setCollisionGroups(g).setSolverGroups(g),
        fixed,
      );
      info.set(tile.handle, { kind: 'ground', id: `ground_${ix}_${iz}` });
    }
  }

  for (const ramp of TRACK.ramps) {
    const { vertices, indices } = buildRampMesh(ramp);
    const c = world.createCollider(
      RAPIER.ColliderDesc.trimesh(vertices, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(1.0).setCollisionGroups(g).setSolverGroups(g),
      fixed,
    );
    info.set(c.handle, { kind: 'ramp', id: ramp.id });
  }

  for (const o of TRACK.obstacles) {
    const q = qaxisAngle({ x: 0, y: 1, z: 0 }, o.headingDeg * DEG);
    const c = world.createCollider(
      RAPIER.ColliderDesc.cuboid(o.size.x / 2, o.size.y / 2, o.size.z / 2)
        .setTranslation(o.center.x, o.center.y + o.size.y / 2, o.center.z)
        .setRotation(q).setFriction(0.8).setCollisionGroups(g).setSolverGroups(g),
      fixed,
    );
    info.set(c.handle, { kind: 'obstacle', id: o.id });
  }
  return info;
}

/** Adds trimesh tiles for the sample window [r0, r1] x [c0, c1] (inclusive, original indices) at `stride`. */
function addTerrainWindow(
  RAPIER: R, world: RAPIER_NS.World, fixed: RAPIER_NS.RigidBody, info: Map<number, WorldColliderInfo>,
  heights: Float32Array, size: number, extentM: number, stride: number,
  r0: number, r1: number, c0: number, c1: number, tag: string,
): RAPIER_NS.Collider | null {
  const g = groups(GROUP_WORLD, GROUP_CAR | GROUP_PROP);
  const baseCell = extentM / (size - 1);
  const nr = Math.floor((r1 - r0) / stride), nc = Math.floor((c1 - c0) / stride);
  if (nr < 1 || nc < 1) return null;
  const verts = new Float32Array((nr + 1) * (nc + 1) * 3);
  for (let r = 0; r <= nr; r++) for (let c = 0; c <= nc; c++) {
    const rr = r0 + r * stride, cc = c0 + c * stride, k = (r * (nc + 1) + c) * 3;
    verts[k] = -extentM / 2 + cc * baseCell;
    verts[k + 1] = heights[rr * size + cc];
    verts[k + 2] = -extentM / 2 + rr * baseCell;
  }
  const idx = new Uint32Array(nr * nc * 6);
  let i = 0;
  for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
    const a = r * (nc + 1) + c, b = a + 1, d = a + (nc + 1), e = d + 1;
    idx[i++] = a; idx[i++] = d; idx[i++] = b;   // CCW seen from +Y
    idx[i++] = b; idx[i++] = d; idx[i++] = e;
  }
  const col = world.createCollider(
    RAPIER.ColliderDesc.trimesh(verts, idx, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
      .setFriction(0.5).setCollisionGroups(g).setSolverGroups(g),
    fixed,
  );
  info.set(col.handle, { kind: 'ground', id: `terrain_${tag}_${r0}_${c0}` });
  return col;
}

/**
 * Terrain from a decoded heightmap (row-major, rows along +Z, columns along +X, centred on the origin) as
 * triangle-mesh tiles. Trimeshes instead of Rapier heightfields: exactly vertical rays miss Rapier's HeightField
 * along cell lines (measured), which breaks wheel casts. Tiles (≤ ~500 m) keep Rapier's f32 GJK precise.
 *
 * Two levels to keep the build time low (2049² samples would be 8 M triangles): the central `fineHalfM` square
 * at full resolution, the rest at `coarseStride`. Coarse tiles that cover the fine square are skipped, so the
 * levels do not overlap (small T-junction steps at the border are acceptable for physics).
 */
export function buildTerrainColliders(
  RAPIER: R, world: RAPIER_NS.World, heights: Float32Array, size: number, extentM: number,
  opts: {
    fineHalfM?: number; coarseStride?: number; tileCells?: number; fineCenter?: { x: number; z: number };
    /** Extra world rectangles that need the full resolution (pyramid talus must meet the exact ground). */
    fineAreas?: { minX: number; maxX: number; minZ: number; maxZ: number }[];
  } = {},
): TerrainColliders {
  const info = new Map<number, WorldColliderInfo>();
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const tiles: TerrainTile[] = [];
  const cell = extentM / (size - 1);
  const stride = Math.max(1, opts.coarseStride ?? (size > 1100 ? 4 : 1));
  const fineHalfM = opts.fineHalfM ?? 500;
  // coarse tile in original sample units (multiple of the stride)
  // (with a coarse level: ≈ 125 m tiles, so that rebuilding one at full resolution while driving costs a few ms, not
  // the ≈ 70 ms of a 500 m tile – TerrainColliders.update)
  const tileCells = opts.tileCells ?? Math.max(stride * 2, Math.round((stride > 1 ? 125 : 500) / cell / stride) * stride);
  const n = size - 1;
  // centre of the full-resolution square in sample units (default: map centre; worlds pass the spawn)
  const fc = opts.fineCenter;
  const centreC = fc ? Math.round((fc.x + extentM / 2) / cell / tileCells) * tileCells : n / 2;
  const centreR = fc ? Math.round((fc.z + extentM / 2) / cell / tileCells) * tileCells : n / 2;
  const fineCells = stride > 1 ? Math.round(fineHalfM / cell / tileCells) * tileCells : 0; // half-width in cells
  for (let r0 = 0; r0 < n; r0 += tileCells) {
    for (let c0 = 0; c0 < n; c0 += tileCells) {
      const r1 = Math.min(n, r0 + tileCells), c1 = Math.min(n, c0 + tileCells);
      const x0 = c0 * cell - extentM / 2, x1 = c1 * cell - extentM / 2, z0 = r0 * cell - extentM / 2, z1 = r1 * cell - extentM / 2;
      const inArea = (opts.fineAreas ?? []).some((a) => a.maxX > x0 && a.minX < x1 && a.maxZ > z0 && a.minZ < z1);
      const inFine = stride > 1 && (inArea || (fineCells > 0 && r0 >= centreR - fineCells && r1 <= centreR + fineCells && c0 >= centreC - fineCells && c1 <= centreC + fineCells));
      const col = addTerrainWindow(RAPIER, world, fixed, info, heights, size, extentM, inFine ? 1 : stride, r0, r1, c0, c1, inFine ? 'fine' : 'coarse');
      tiles.push({ r0, r1, c0, c1, x0, x1, z0, z1, fine: inFine || stride === 1, pinned: inFine || stride === 1, col });
    }
  }
  return new TerrainColliders(RAPIER, world, fixed, info, heights, size, extentM, stride, tiles);
}

interface TerrainTile {
  r0: number; r1: number; c0: number; c1: number;
  x0: number; x1: number; z0: number; z1: number;
  /** full resolution now; pinned = built fine at the start (spawn square, fine areas), never coarsened again */
  fine: boolean; pinned: boolean;
  col: RAPIER_NS.Collider | null;
}

/** Distance (m) from the car within which coarse tiles are rebuilt at full resolution, and beyond which they go back. */
export const TERRAIN_FINE_NEAR_M = 300, TERRAIN_FINE_FAR_M = 900;

/**
 * Terrain tiles with a full-resolution window that follows the car. Beyond the spawn square the tiles used to stay
 * coarse (every 4th sample, ≈ 16 m on the large worlds): on rugged ground the physics surface lay metres below the
 * rendered one and the car sank out of sight ("slid under the surface at the edge of the world"). Coarse tiles near
 * the car are now rebuilt fine, at most one per call, and far ones go back to coarse (memory).
 */
export class TerrainColliders {
  constructor(
    private RAPIER: R, private world: RAPIER_NS.World, private fixed: RAPIER_NS.RigidBody,
    readonly info: Map<number, WorldColliderInfo>, private heights: Float32Array, private size: number,
    private extentM: number, private stride: number, readonly tiles: TerrainTile[],
  ) {}

  /** Swap at most one tile towards the wanted resolution around (x, z); returns true if one was rebuilt. */
  update(x: number, z: number): boolean {
    if (this.stride === 1) return false;
    let best: TerrainTile | null = null, bestD = Infinity, wantFine = false;
    for (const t of this.tiles) {
      if (t.pinned) continue;
      const dx = Math.max(t.x0 - x, 0, x - t.x1), dz = Math.max(t.z0 - z, 0, z - t.z1), d = Math.hypot(dx, dz);
      if (!t.fine && d < TERRAIN_FINE_NEAR_M && d < bestD) { best = t; bestD = d; wantFine = true; }
      else if (t.fine && d > TERRAIN_FINE_FAR_M && !wantFine && !best) { best = t; wantFine = false; }
    }
    if (!best) return false;
    if (best.col) { this.info.delete(best.col.handle); this.world.removeCollider(best.col, false); }
    best.col = addTerrainWindow(this.RAPIER, this.world, this.fixed, this.info, this.heights, this.size, this.extentM,
      wantFine ? 1 : this.stride, best.r0, best.r1, best.c0, best.c1, wantFine ? 'fine' : 'coarse');
    best.fine = wantFine;
    return true;
  }
}

/**
 * Static landmark colliders. Pyramids: smooth rounded frustum (src/shared/pyramid.ts, outward triangle mesh) the car can climb with the fan
 * suction sealing on it (the stepped core masonry of the render mesh would catch the wheels on 0.75 m steps) plus
 * the talus mesh at the foot. Sphinx, stones, rovers and landers: exact two-sided triangle mesh (no
 * FIX_INTERNAL_EDGES: GLB winding varies). Friction 0.35: carbon/steel underbody sliding on stone (tires use
 * their own model).
 */
export function buildLandmarkColliders(RAPIER: R, world: RAPIER_NS.World, shapes: LandmarkShape[], maxTrisPerCollider = 60_000): Map<number, WorldColliderInfo> {
  const info = new Map<number, WorldColliderInfo>();
  if (!shapes.length) return info;
  const g = groups(GROUP_WORLD, GROUP_CAR | GROUP_PROP);
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (const sh of shapes) {
    if (sh.kind === 'hull') {
      const desc = RAPIER.ColliderDesc.convexHull(sh.data);
      if (!desc) continue;
      const c = world.createCollider(desc.setFriction(0.35).setCollisionGroups(g).setSolverGroups(g), fixed);
      info.set(c.handle, { kind: 'landmark', id: sh.id });
      continue;
    }
    const nTri = Math.floor(sh.data.length / 9);
    for (let t0 = 0, k = 0; t0 < nTri; t0 += maxTrisPerCollider, k++) {
      const n = Math.min(maxTrisPerCollider, nTri - t0);
      const verts = sh.data.slice(t0 * 9, (t0 + n) * 9);
      const idx = new Uint32Array(n * 3);
      for (let i = 0; i < idx.length; i++) idx[i] = i;
      const desc = sh.outward ? RAPIER.ColliderDesc.trimesh(verts, idx, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES) : RAPIER.ColliderDesc.trimesh(verts, idx);
      const c = world.createCollider(desc.setFriction(0.35).setCollisionGroups(g).setSolverGroups(g), fixed);
      info.set(c.handle, { kind: 'landmark', id: `${sh.id}_${k}` });
    }
  }
  return info;
}
