import { describe, expect, it } from 'vitest';
import { createSiteSim, loadSiteData, type FetchLike } from '../../src/game/siteLoader';
import { neutralDrive, neutralSystems, zeroThrust } from '../../src/shared/types';
import { sampleHeight, type TerrainMeta } from '../../src/shared/worlds';

const fakeFetch = (meta: TerrainMeta, u16: Uint16Array): FetchLike => async (url) => ({
  ok: true,
  json: async () => meta,
  arrayBuffer: async () => (url.endsWith('height.bin') ? u16.buffer : new ArrayBuffer(0)) as ArrayBuffer,
});

describe('site loader', () => {
  it('builds a lunar site on a hilly synthetic terrain and the car settles on it at 1/6 g', async () => {
    const meta: TerrainMeta = { size: 129, extentM: 600, minM: -20, maxM: 60, source: 'synthetic' };
    const u16 = new Uint16Array(meta.size * meta.size);
    for (let r = 0; r < meta.size; r++) for (let c = 0; c < meta.size; c++) {
      const x = c / (meta.size - 1), z = r / (meta.size - 1);
      u16[r * meta.size + c] = Math.round(65535 * (0.4 + 0.08 * Math.sin(x * 12) + 0.05 * Math.cos(z * 9)));
    }
    const l = await loadSiteData('moon_tranquility', fakeFetch(meta, u16));
    expect(l.env.gravity.y).toBeCloseTo(-1.62, 2);
    const sim = await createSiteSim(l);
    for (let i = 0; i < 240 * 8; i++) sim.step(neutralDrive(), neutralSystems(), zeroThrust());
    const s = sim.getState();
    const g = sampleHeight(l.terrain!.heights, meta, s.pos.x, s.pos.z);
    expect(s.pos.y - g).toBeGreaterThan(0.25);
    expect(s.pos.y - g).toBeLessThan(0.75);
    expect(s.crashed).toBe(false);
    expect(s.fans.forceN).toBe(0); // no air on the Moon
    sim.dispose();
  });
  it('space site: no ground, no gravity', async () => {
    const l = await loadSiteData('space_sun', async () => { throw new Error('no fetch expected'); });
    const sim = await createSiteSim(l);
    const y0 = sim.getState().pos.y;
    for (let i = 0; i < 240; i++) sim.step(neutralDrive(), neutralSystems(), zeroThrust());
    expect(sim.getState().pos.y).toBeCloseTo(y0, 6);
    sim.dispose();
  });
});
