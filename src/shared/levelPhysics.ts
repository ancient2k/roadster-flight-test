// The static colliders and the painted asphalt of a track-editor level in world coordinates, without the renderer
// (same placement as src/render/level/levelScene.ts): headless drives of a level (drivability tests, course driver).
import { buildPart, partDef, placeTris } from './parts';
import type { Level } from './level';
import type { LaneArea } from './lanes';

export interface LevelSolid { id: string; kind: 'mesh'; data: Float32Array; outward: true }

export function levelPhysics(level: Level, area: LaneArea): { shapes: LevelSolid[]; paved: Float32Array } {
  const shapes: LevelSolid[] = [];
  const paved: Float32Array[] = [];
  const toWorld = (t: Float32Array) => {
    for (let k = 0; k < t.length; k += 3) { t[k] += area.minX; t[k + 1] += area.y; t[k + 2] += area.minZ; }
    return t;
  };
  level.parts.forEach((p, n) => {
    const def = partDef(p.type), mesh = buildPart(p.type, p.opt);
    for (const s of mesh.solids) shapes.push({ id: `level_${n}_${p.type}`, kind: 'mesh', data: toWorld(placeTris(s.tris, def, p.i, p.j, p.rot, 0, area.tileM)), outward: true });
    for (const d of mesh.decals) if (d.mat === 'asphalt' || d.mat === 'pad') paved.push(toWorld(placeTris(d.tris, def, p.i, p.j, p.rot, 0.06, area.tileM)));
  });
  const all = new Float32Array(paved.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of paved) { all.set(a, o); o += a.length; }
  return { shapes, paved: all };
}
