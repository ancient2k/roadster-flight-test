// Flicker/ghosting metrics of tests/render/flickerGhost.mjs on synthetic sequences.
import { describe, expect, it } from 'vitest';
import { cutResidual, dropout, meanAbsDiff, popFrames, pumping, reversalEnergy, reversalHeat, type LumaFrame } from './frameMetrics';

const W = 32, H = 18;
const frame = (fn: (x: number, y: number) => number): LumaFrame => {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = Math.max(0, Math.min(255, Math.round(fn(x, y))));
  return { w: W, h: H, data };
};
/** A bright bar moving one pixel per frame over a gradient. */
const moving = (t: number) => frame((x) => 40 + x * 2 + (Math.abs(x - 4 - t) < 3 ? 120 : 0));

describe('flicker metrics', () => {
  it('reversal energy ignores smooth motion and catches a blinking light', () => {
    const smooth = reversalEnergy(moving(0), moving(1), moving(2));
    // a 4×4 lamp that is on in the middle frame only
    const lamp = (on: boolean) => frame((x, y) => 50 + (on && x >= 20 && x < 24 && y >= 6 && y < 10 ? 80 : 0));
    const blink = reversalEnergy(lamp(false), lamp(true), lamp(false));
    expect(blink).toBeCloseTo((16 * 80) / (W * H), 5);
    // the moving bar's leading and trailing edges change monotonically except where the bar spans
    // one pixel's in/out within two frames (none for a 5-px bar at 1 px/frame)
    expect(smooth).toBeLessThan(blink * 0.05);
  });

  it('heat map locates the flickering block', () => {
    const frames = Array.from({ length: 12 }, (_, t) => frame((x, y) => 60 + (x < 4 && y < 4 && t % 2 ? 50 : 0)));
    const heat = reversalHeat(frames);
    expect(heat[0]).toBeGreaterThan(40);
    expect(heat[W * H - 1]).toBe(0);
  });

  it('pop detector finds a one-frame light switch but not steady motion', () => {
    const frames = Array.from({ length: 40 }, (_, t) => {
      const f = moving(t % 20);
      if (t >= 25) for (let i = 0; i < f.data.length; i++) f.data[i] = Math.min(255, f.data[i] + 30); // light on
      return f;
    });
    const pops = popFrames(frames, new Set([20])); // t=20: the bar wraps (a "cut")
    expect(pops.map((p) => p.t)).toEqual([25]);
  });

  it('pumping is zero for a monotonic fade and the amplitude for an oscillation', () => {
    expect(pumping([10, 11, 12, 13, 14])).toBe(0);
    expect(pumping([10, 12, 10, 12, 10, 12])).toBeCloseTo(2, 6);
  });

  it('cut residual ≈ 1 for a clean cut, large for a cut frame that still shows the old shot', () => {
    const a = (t: number) => moving(t), b = (t: number) => frame((x, y) => 200 - x * 3 - y + t);
    const clean = [a(0), a(1), b(2), b(3), b(4), b(5)];
    const ghost = [a(0), a(1), frame((x, y) => (a(1).data[y * W + x] + b(2).data[y * W + x]) / 2), b(3), b(4), b(5)];
    expect(cutResidual(clean, 2)).toBeLessThan(2.5);
    expect(cutResidual(ghost, 2)).toBeGreaterThan(cutResidual(clean, 2) * 4);
    expect(meanAbsDiff(a(0), a(0))).toBe(0);
  });

  it('dropout counts a light that keeps falling back to black, not a steady shimmer', () => {
    const lamp = (v: number) => frame((x, y) => (x >= 10 && x < 12 && y >= 4 && y < 14 ? v : 3));
    const saw = Array.from({ length: 60 }, (_, t) => lamp([60, 90, 120, 140, 10][t % 5]));
    const shimmer = Array.from({ length: 60 }, (_, t) => lamp(t % 2 ? 100 : 86));
    expect(dropout(saw)).toBeGreaterThan(0.15);
    expect(dropout(shimmer)).toBe(0);
  });
});
