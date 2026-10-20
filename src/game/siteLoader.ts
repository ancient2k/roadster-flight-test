// Loads the physics-side data of a site (terrain heightmap + environment) and builds a RoadsterSim for it.
// Rendering of the site is done by src/render/worlds. DOM-free apart from the injected fetch.
import { createRoadsterSim } from '@sim/vehicle';
import type { RoadsterSim } from '@sim/core/roadsterSim';
import { spawnPose } from '@sim/core/roadsterSim';
import { decodeHeightmap, environmentFor, sampleHeight, site as siteDef, type SiteDef, type SiteId, type TerrainMeta } from '@shared/worlds';
import type { Environment } from '@shared/environment';
import type { SpawnPose } from '@shared/types';

export type FetchLike = (url: string) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface LoadedSite {
  site: SiteDef;
  env: Environment;
  terrain?: { heights: Float32Array; meta: TerrainMeta };
  spawn: SpawnPose;
}

export async function loadSiteData(id: SiteId, fetchFn: FetchLike = (u) => fetch(u), base = ''): Promise<LoadedSite> {
  const site = siteDef(id);
  const env = environmentFor(id);
  let terrain: LoadedSite['terrain'];
  let groundY = 0;
  if (site.ground === 'terrain') {
    const dir = `${base}${site.assetDir}`;
    const [mr, hr] = await Promise.all([fetchFn(`${dir}/meta.json`), fetchFn(`${dir}/height.bin`)]);
    if (!mr.ok || !hr.ok) throw new Error(`Gelände für ${site.name} fehlt (${dir})`);
    const meta = (await mr.json()) as TerrainMeta;
    const heights = decodeHeightmap(await hr.arrayBuffer(), meta);
    terrain = { heights, meta };
    // Highest ground under the car footprint (heading-aligned), so no part of the hull starts inside a slope.
    const hd = (site.spawn.headingDeg * Math.PI) / 180, sn = Math.sin(hd), cs = Math.cos(hd);
    groundY = -Infinity;
    for (const lx of [-1.0, 0, 1.0]) for (const lz of [-2.2, -1.25, 0, 1.4, 2.3]) {
      const x = site.spawn.pos.x + lx * cs + lz * sn, z = site.spawn.pos.z - lx * sn + lz * cs;
      const h = sampleHeight(heights, meta, x, z);
      if (Number.isFinite(h)) groundY = Math.max(groundY, h);
    }
    if (!Number.isFinite(groundY)) groundY = 0;
    groundY += 0.02;
  }
  const pose = spawnPose({ x: site.spawn.pos.x, y: site.spawn.pos.y + groundY, z: site.spawn.pos.z }, site.spawn.headingDeg, site.spawn.speedMs);
  return { site, env, terrain, spawn: pose };
}

export async function createSiteSim(l: LoadedSite): Promise<RoadsterSim> {
  const sim = await createRoadsterSim(
    l.site.ground === 'terrain' && l.terrain
      ? { ground: 'terrain', terrain: { heights: l.terrain.heights, size: l.terrain.meta.size, extentM: l.terrain.meta.extentM } }
      : { ground: l.site.ground === 'space' ? 'space' : 'track' },
  );
  sim.setEnvironment(l.env);
  sim.reset(l.spawn);
  return sim;
}
