import { describe, expect, it } from 'vitest';
import { AU, GM_SUN, R_SUN, STAGES, SunDive } from '../../src/game/sun';

describe('SunDive', () => {
  it('free-fall time from 1 AU matches the analytic radial infall (~64.6 days)', () => {
    const d = new SunDive(1.0);
    d.warp = 1e6;
    let guard = 0;
    while (d.state.r > R_SUN * 1.01 && guard++ < 100000) d.update(1);
    const analytic = (Math.PI / 2) * Math.sqrt((AU ** 3) / (2 * GM_SUN)); // t_ff = π/2 · sqrt(r0³ / 2GM)
    expect(d.state.t / 86400).toBeGreaterThan(60);
    expect(Math.abs(d.state.t - analytic) / analytic).toBeLessThan(0.02);
  });
  it('speed follows energy conservation', () => {
    const d = new SunDive(1.0); d.warp = 2e5;
    for (let i = 0; i < 200; i++) d.update(1);
    expect(Math.abs(d.state.v - d.speedAt(d.state.r)) / d.speedAt(d.state.r)).toBeLessThan(0.02);
  });
  it('equilibrium temperature scales with r^-1/2 and is plausible at 1 AU', () => {
    const d = new SunDive();
    const t1 = d.equilibriumTemp(AU), t025 = d.equilibriumTemp(0.25 * AU);
    expect(t1).toBeGreaterThan(150); expect(t1).toBeLessThan(260);
    expect(t025 / t1).toBeCloseTo(2, 3);
  });
  it('passes the stages in order and finally vaporises', () => {
    const d = new SunDive(1.0); d.warp = 5e5;
    let guard = 0;
    while (!d.state.done && guard++ < 200000) d.update(1 / 60);
    expect(d.state.done).toBe(true);
    const ids = d.events.map((e) => e.id);
    expect(ids[0]).toBe('venus');
    expect(ids).toContain('aluminium');
    expect(ids.at(-1)).toBe('vapor');
    expect(new Set(ids).size).toBe(STAGES.length);
    expect(d.state.tempK).toBeGreaterThanOrEqual(3000);
  });
  it('distance milestones fire at their distance even while the car is still cool', () => {
    const d = new SunDive(1.0); d.warp = 1e5;
    let rAtMercury = 0;
    for (let i = 0; i < 400000 && !rAtMercury; i++) { for (const e of d.update(1 / 60)) if (e.id === 'mercury') rAtMercury = d.rAU; }
    expect(rAtMercury).toBeGreaterThan(0.36); expect(rAtMercury).toBeLessThan(0.39);
  });
});
