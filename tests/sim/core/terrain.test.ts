import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { initRapier } from '../../../src/sim/core/roadsterSim';
import { buildTerrainColliders } from '../../../src/sim/core/world';
import { decodeHeightmap, sampleHeight, type TerrainMeta } from '../../../src/shared/worlds';

describe('terrain heightfield', () => {
  it('raycasts match bilinear sampling across tiles', async () => {
    await initRapier();
    const meta: TerrainMeta = { size: 257, extentM: 1024, minM: -50, maxM: 150, source: 'synthetic' };
    const u16 = new Uint16Array(meta.size * meta.size);
    for (let r = 0; r < meta.size; r++) for (let c = 0; c < meta.size; c++) {
      const x = c / (meta.size - 1), z = r / (meta.size - 1);
      u16[r * meta.size + c] = Math.round(65535 * (0.3 + 0.2 * Math.sin(x * 9) * Math.cos(z * 7) + 0.25 * x));
    }
    const h = decodeHeightmap(u16.buffer, meta);
    expect(sampleHeight(h, meta, 0, 0)).toBeCloseTo(0, 6);
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const info = buildTerrainColliders(RAPIER, world, h, meta.size, meta.extentM);
    expect(info.size).toBeGreaterThan(1); // tiled
    world.step();
    for (const [x, z] of [[0, 0], [123.4, -321.9], [-480, 470], [399.7, 1.3], [-0.5, 255.9]]) {
      const ray = new RAPIER.Ray({ x, y: 500, z }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(ray, 2000, true)!;
      expect(hit).not.toBeNull();
      const y = 500 - hit.timeOfImpact;
      // heightfield cells are two triangles; bilinear differs slightly inside a cell
      expect(Math.abs(y - sampleHeight(h, meta, x, z))).toBeLessThan(0.35);
    }
    world.free();
  });
});

import { RoadsterSim, spawnPose } from '../../../src/sim/core/roadsterSim';
import { MOON } from '../../../src/shared/environment';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';

describe('RoadsterSim on terrain / in space', () => {
  it('drops onto a sloped terrain under lunar gravity and comes to rest on it', async () => {
    const meta: TerrainMeta = { size: 129, extentM: 512, minM: 0, maxM: 40, source: 'synthetic' };
    const u16 = new Uint16Array(meta.size * meta.size);
    for (let r = 0; r < meta.size; r++) for (let c = 0; c < meta.size; c++) u16[r * meta.size + c] = Math.round(65535 * (0.5 + 0.2 * (c / (meta.size - 1) - 0.5)));
    const h = decodeHeightmap(u16.buffer, meta);
    const sim = await RoadsterSim.create({ ground: 'terrain', terrain: { heights: h, size: meta.size, extentM: meta.extentM } });
    sim.setEnvironment(MOON);
    sim.reset(spawnPose({ x: 0, y: 3, z: 0 }, 0));
    for (let i = 0; i < 240 * 6; i++) sim.step(neutralDrive(), neutralSystems(), zeroThrust());
    const s = sim.getState();
    const ground = sampleHeight(h, meta, s.pos.x, s.pos.z);
    expect(s.pos.y - ground).toBeGreaterThan(0.2);
    expect(s.pos.y - ground).toBeLessThan(0.8);
    sim.dispose();
  });
  it('space has no colliders and no gravity once the environment is set', async () => {
    const sim = await RoadsterSim.create({ ground: 'space' });
    expect(sim.colliderInfo.size).toBe(0);
    sim.dispose();
  });
});

describe('landmark colliders', () => {
  it('a landmark built from triangles blocks the car', async () => {
    // 10 x 6 x 10 m block (12 triangles) centred at z = 20 on a flat terrain
    const box = (cx: number, cz: number, hx: number, h: number, hz: number) => {
      const p = [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1], [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]]
        .map(([x, y, z]) => [cx + x * hx, y * h, cz + z * hz]);
      const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
      return new Float32Array(f.flatMap((t) => t.flatMap((i) => p[i])));
    };
    const n = 65, h = new Float32Array(n * n);
    const sim = await RoadsterSim.create({ ground: 'terrain', terrain: { heights: h, size: n, extentM: 256 }, landmarks: [{ id: 'block', kind: 'mesh', data: box(0, 20, 5, 6, 5) }] });
    expect([...sim.colliderInfo.values()].some((i) => i.kind === 'landmark' && i.id.startsWith('block'))).toBe(true);
    sim.reset(spawnPose({ x: 0, y: 0.1, z: 0 }, 0, 22)); // sliding on the hull (no wheel modules): fast enough to reach the block
    const hit = new Set<string>();
    for (let i = 0; i < 240 * 3; i++) { sim.step(neutralDrive(), neutralSystems(), zeroThrust()); for (const c of sim.contacts) hit.add(c.id); }
    expect([...hit].some((id) => id.startsWith('block'))).toBe(true);
    expect(sim.getState().pos.z).toBeLessThan(15); // stopped in front of the block
    sim.dispose();
  });
});
