import { describe, expect, it } from 'vitest';
import { ARC_END_DEG, ARC_START_DEG, ARC_SWEEP_DEG, SCALES, fillAngleRad, follow, fraction, hudScale, ringPoint } from '../../src/ui/hud/gaugeMath';
import { FT } from '../../src/shared/math';

const deg = (r: number) => (r * 180) / Math.PI;

describe('ring gauge math (fitted to stream frames)', () => {
  it('arc is symmetric about straight down with the measured 245° sweep', () => {
    expect(ARC_SWEEP_DEG).toBe(245);
    expect(ARC_START_DEG - 90).toBeCloseTo(360 + 90 - ARC_END_DEG, 9);
  });
  it('fill angle endpoints', () => {
    expect(deg(fillAngleRad(0))).toBeCloseTo(147.5, 6);
    expect(deg(fillAngleRad(1))).toBeCloseTo(392.5, 6);
    expect(deg(fillAngleRad(2))).toBeCloseTo(392.5, 6);
    expect(deg(fillAngleRad(-1))).toBeCloseTo(147.5, 6);
  });
  it('half scale points straight up', () => {
    const p = ringPoint(0.5, 100);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(-100, 6);
  });
  it('scales reproduce stream readouts within a few degrees', () => {
    // measured fill sweep (deg) in the frames, minus ~3° for the round cap
    const cases: Array<[number, typeof SCALES.gForce, number]> = [
      [0.7, SCALES.gForce, 50 - 3],
      [1.2, SCALES.gForce, 79 - 3],
      [20.8 * FT, SCALES.altitudeM, 66.5 - 3],
      [23.3 * FT, SCALES.altitudeM, 75 - 3],
      [4697, SCALES.downforceKg, 227],
      [210, SCALES.downforceKg, 14.5 - 3],
      [170, SCALES.pitchDeg, 227],
    ];
    for (const [v, s, sweep] of cases) expect(fraction(v, s) * ARC_SWEEP_DEG).toBeGreaterThan(sweep - 8);
    for (const [v, s, sweep] of cases) expect(fraction(v, s) * ARC_SWEEP_DEG).toBeLessThan(sweep + 8);
  });
  it('fraction clamps and survives NaN', () => {
    expect(fraction(-3, SCALES.gForce)).toBe(0);
    expect(fraction(99, SCALES.gForce)).toBe(1);
    expect(fraction(NaN, SCALES.gForce)).toBe(0);
  });
  it('hud scale: height-driven, width-limited on narrow screens', () => {
    expect(hudScale(1920, 1080)).toBeCloseTo(1, 6);
    expect(hudScale(3840, 2160)).toBeCloseTo(2, 6);
    expect(hudScale(1920, 1200)).toBeCloseTo(1200 / 1080, 6); // 16:10
    expect(hudScale(1280, 1024)).toBeCloseTo(1280 / 1536, 6); // 5:4 limited by width
    expect(hudScale(300, 200)).toBe(0.45);
  });
  it('follow is frame-rate independent', () => {
    let a = 0, b = 0;
    for (let i = 0; i < 60; i++) a = follow(a, 1, 1 / 60, 0.1);
    for (let i = 0; i < 240; i++) b = follow(b, 1, 1 / 240, 0.1);
    expect(a).toBeCloseTo(b, 6);
    expect(follow(NaN, 3, 0.1, 0.1)).toBe(3);
  });
});
