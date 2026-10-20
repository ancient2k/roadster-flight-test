// structure of the ground-cloud volume against the stream – flat wall-jet
// splats instead of 3 m balls (the 0–60 tail was a row of hills), a tail that is low at the car and
// grows only slowly downstream, a bottom layer that runs out beyond the body (fine ground seam)
// and small divergence-free eddies (tongues instead of clumps).
import { describe, expect, it } from 'vitest';
import { CloudSim, type CloudSource } from '../../src/render/fx/volume/cloudSim';

const DT = 1 / 24;

/** Mass-weighted mean height [m] of the cells selected by `pick(k)` (k = grid row along z). */
function meanHeight(s: CloudSim, pick: (k: number) => boolean = () => true): number {
  let m = 0, my = 0;
  for (let k = 0; k < s.nz; k++) {
    if (!pick(k)) continue;
    for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) {
      const v = s.d[s.idx(i, j, k)]; m += v; my += v * (j + 0.5) * s.h;
    }
  }
  return m > 0 ? my / m : 0;
}

/** Footprint [cells] of layer j: cells with density above `thr`. */
function footprint(s: CloudSim, j: number, thr = 0.01): number {
  let n = 0;
  for (let k = 0; k < s.nz; k++) for (let i = 0; i < s.nx; i++) if (s.d[s.idx(i, j, k)] > thr) n++;
  return n;
}

/** The 0–60 wall jet as in Emitters (splats): the car launches towards +z, the jets blow back. */
function wallJet(s: CloudSim, flat: boolean): void {
  let z = -120, v = 0;
  const L = 3.0, w = 0.9;
  for (let t = 0; t < 2.0; t += DT) {
    v = Math.min(27, v + 32 * DT); z += v * DT;
    for (const f of [0.5, 1.2, 2.1, 3.2]) {
      const src: CloudSource = flat
        ? { x: 0, y: 0.4, z: z - 2.2 - L * f, r: 1.4 + f * 0.8, ry: 0.55 + f * 0.12, rate: 34 * w / f ** 0.45, vx: 0, vy: 0.02, vz: -17 / Math.sqrt(f), radial: 1.5, dt: DT }
        : { x: 0, y: 0.45, z: z - 2.2 - L * f, r: 1.2 + f * 0.6, rate: 22 * w / f ** 0.35, vx: 0, vy: 0.05, vz: -17 / Math.sqrt(f), radial: 1.5, dt: DT };
      s.addSource(src);
    }
    s.follow(0, z - 6);
    s.step(DT);
  }
}

describe('cloud volume structure', () => {
  it('a flat splat (ry < r) stays lower than a spherical one', () => {
    const run = (ry?: number) => {
      const s = new CloudSim();
      s.centreOn(0, 0, 0);
      s.addSource({ x: 0, y: 0.4, z: 0, r: 3, ry, rate: 30, vx: 0, vy: 0, vz: 0, dt: 0.2 });
      s.step(DT);
      return { top: (s.bounds!.j1 + 1) * s.h, mass: s.mass, y: meanHeight(s) };
    };
    const ball = run(), flat = run(0.7);
    expect(flat.top).toBeLessThan(ball.top);
    expect(flat.y).toBeLessThan(ball.y * 0.75);
    expect(flat.mass).toBeGreaterThan(0);
  });

  it('0–60 tail: lower and flatter than the earlier round balls, low at the car and growing downstream', () => {
    const r10b = new CloudSim(), r11a = new CloudSim();
    r10b.centreOn(0, -110, 0); r11a.centreOn(0, -110, 0);
    wallJet(r10b, false); wallJet(r11a, true);
    // (sources: 1.27 m mass-weighted height, cloud top ≥ 5 m)
    expect(meanHeight(r11a)).toBeLessThan(meanHeight(r10b) * 0.9);
    expect((r11a.bounds!.j1 + 1) * r11a.h).toBeLessThanOrEqual((r10b.bounds!.j1 + 1) * r10b.h);
    // still a long sheet
    const b = r11a.bounds!;
    expect((b.k1 - b.k0 + 1) * r11a.h).toBeGreaterThan(25);
    // wedge: the half of the tail nearest the car (high k) is lower than the far half
    const kMid = (b.k0 + b.k1) / 2;
    const near = meanHeight(r11a, (k) => k > kMid), far = meanHeight(r11a, (k) => k <= kMid);
    expect(near).toBeLessThan(far);
  });

  it('the bottom layer runs out beyond the body (thin ground seam, no hard foot)', () => {
    const run = (slump: number, spread: number) => {
      const s = new CloudSim();
      s.slump = slump; s.sheetSpread = spread;
      s.centreOn(0, 0, 0);
      for (let t = 0; t < 1.2; t += DT) {
        s.addSource({ x: 0, y: 0.5, z: 0, r: 2.8, rate: 40, vx: 0, vy: 0.9, vz: 0, radial: 14, dt: DT });
        s.step(DT);
      }
      for (let t = 0; t < 1.5; t += DT) s.step(DT);
      return { foot: footprint(s, 0), body: footprint(s, 2) };
    };
    const off = run(0, 0), on = run(2.2, 0.15);
    // the seam spreads further than without slumping …
    expect(on.foot).toBeGreaterThan(off.foot * 1.1);
    // … and the foot is wider than the body above it
    expect(on.foot).toBeGreaterThan(on.body * 1.15);
  });

  it('the small eddies are divergence free (they shear the vapour instead of clumping it)', () => {
    const s = new CloudSim();
    const a = [0, 0, 0], b = [0, 0, 0];
    const e = 0.05;
    let div = 0, mag = 0, n = 0;
    for (let x = 0; x < 9; x += 1.37) for (let y = 0.4; y < 6; y += 1.1) for (let z = 0; z < 9; z += 1.61) {
      let dsum = 0;
      for (let ax = 0; ax < 3; ax++) {
        const o = [0, 0, 0]; o[ax] = e;
        s.curlAt(x + o[0], y + o[1], z + o[2], a);
        s.curlAt(x - o[0], y - o[1], z - o[2], b);
        dsum += (a[ax] - b[ax]) / (2 * e);
        mag += Math.abs(a[ax] - b[ax]) / (2 * e);
      }
      div += Math.abs(dsum); n++;
    }
    // (exact curl of the interpolated potential: only the finite-difference error of this check)
    expect(div / n).toBeLessThan(0.03 * mag / n);
    expect(mag / n).toBeGreaterThan(0);
  });
});
