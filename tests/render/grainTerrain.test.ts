import { describe, expect, it } from 'vitest';
import { ballisticGrain, flightTime, grainImpactTime, grainPos, terrainGrain } from '../../src/render/fxParams';

// a grain dies where its parabola meets the real terrain, not a level plane at the launch point
// (fxParams flightTime against y = launch height is wrong on slopes).
const MOON = { g: 1.62, rho: 0 }, MARS = { g: 3.721, rho: 0.02 }, EARTH = { g: 9.81, rho: 1.2 };
const slope = (k: number) => (x: number, _z: number) => -k * x;   // falls towards +x
const p0 = { x: 0, y: 0.05, z: 0 };

describe('grain impact on terrain', () => {
  it('equals the level-ground flight time on flat ground', () => {
    for (const m of [MOON, MARS, EARTH]) {
      const v = { x: 2, y: 3, z: 0.5 };
      const g = terrainGrain(v, p0, m, () => 0);
      if (m.rho === 0) expect(g.life).toBeCloseTo(flightTime(3, 0.05, m.g), 3);
      const p = grainPos(p0, g, g.life);
      expect(Math.abs(p.y)).toBeLessThan(1e-3);
    }
  });

  it('flies longer downhill and lands earlier uphill (moon, mars and earth paths)', () => {
    for (const m of [MOON, MARS, EARTH]) {
      const level = ballisticGrain({ x: 3, y: 2, z: 0 }, 0.05, m).life;
      const down = terrainGrain({ x: 3, y: 2, z: 0 }, p0, m, slope(0.3)).life;
      const up = terrainGrain({ x: 3, y: 2, z: 0 }, p0, m, slope(-0.3)).life;
      expect(down).toBeGreaterThan(level * 1.05);
      expect(up).toBeLessThan(level * 0.95);
      // the grain is on the surface at the end of its life
      for (const [k, life] of [[0.3, down], [-0.3, up]] as const) {
        const g = terrainGrain({ x: 3, y: 2, z: 0 }, p0, m, slope(k));
        const p = grainPos(p0, g, life);
        expect(Math.abs(p.y - slope(k)(p.x, p.z))).toBeLessThan(1e-3);
      }
    }
  });

  it('hits a bump on the way instead of flying through it', () => {
    // a 0.5 m high ridge 2–3 m downrange
    const ridge = (x: number) => (x > 2 && x < 3 ? 0.5 : 0);
    const g = ballisticGrain({ x: 4, y: 1, z: 0 }, 0.05, MOON);
    const t = grainImpactTime(p0, g, ridge, 3);
    expect(t).toBeLessThan(g.life);
    expect(grainPos(p0, g, t).x).toBeGreaterThan(1.9);
    expect(grainPos(p0, g, t).x).toBeLessThan(2.1);
  });

  it('a grain launched below the height field dies at once, without a height field the old rule stays', () => {
    const g = ballisticGrain({ x: -1, y: 0.1, z: 0 }, 0, MOON);
    expect(grainImpactTime({ x: 0, y: -0.1, z: 0 }, g, () => 0.2, 3)).toBeLessThan(0.3);
    expect(terrainGrain({ x: 1, y: 2, z: 0 }, p0, MOON, null).life).toBeCloseTo(flightTime(2, 0.05, 1.62), 6);
  });

  // both cases reproduced the old 40-sample / 2×-level-time search
  it('downhill on a steep slope the grain lives until it really reaches the ground', () => {
    const g = terrainGrain({ x: 3, y: 0.5, z: 0 }, { x: 0, y: 0.05, z: 0 }, MOON, (x) => -x);
    expect(g.life).toBeGreaterThan(4.2);
    expect(g.life).toBeLessThan(4.5);
    const p = grainPos({ x: 0, y: 0.05, z: 0 }, g, g.life);
    expect(Math.abs(p.y + p.x)).toBeLessThan(0.02);
  });

  it('a 5 cm wide ridge is hit, not jumped over', () => {
    const ridge = (x: number) => (x > 1.5 && x < 1.55 ? 0.5 : 0);
    const g = ballisticGrain({ x: 3, y: 1, z: 0 }, 0.05, MOON);
    const t = grainImpactTime({ x: 0, y: 0.05, z: 0 }, g, ridge, 3);
    expect(t).toBeGreaterThan(0.49);
    expect(t).toBeLessThan(0.53);
  });

  it('a near-vertical launch over a dip lands where the parabola meets the ground (no step past the apex)', () => {
    const dip = (x: number) => (x > 0.02 ? -1 : 0);
    const g = ballisticGrain({ x: 0.01, y: 2, z: 0 }, 0.05, MOON);
    const t = grainImpactTime({ x: 0, y: 0.05, z: 0 }, g, dip, 12);
    const p = grainPos({ x: 0, y: 0.05, z: 0 }, g, t);
    expect(Math.abs(p.y - dip(p.x))).toBeLessThan(0.02);
  });
});
