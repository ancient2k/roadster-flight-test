// shape and light of the ground-cloud volume against the stream – a long, flat 0–60 tail,
// landings wider than tall with their mass low, red LED light only shaded by the vapour between
// the bar and the cell, dark cores.
import { describe, expect, it } from 'vitest';
import { CloudSim, transm, type CloudBake, type CloudLights } from '../../src/render/fx/volume/cloudSim';

const DT = 1 / 24;
const newBake = (s: CloudSim): CloudBake => ({ data: new Uint8Array(s.n * 4), keyMax: 1, redMax: 1, keyDir: [0, 1, 0] });
const meanHeight = (s: CloudSim) => {
  let m = 0, my = 0;
  for (let k = 0; k < s.nz; k++) for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) {
    const v = s.d[s.idx(i, j, k)]; m += v; my += v * (j + 0.5) * s.h;
  }
  return my / m;
};

describe('cloud volume shape', () => {
  it('0–60 wall jet: a long, flat sheet behind the car', () => {
    const s = new CloudSim();
    s.centreOn(0, -110, 0);
    // the car launches towards +z, the main jets blow back (-z) along the pad, as in Emitters
    // (splats at 0.5/1.2/2.1/3.2 × the jet length, 17/√f m/s backwards, hardly any lift)
    let z = -120, v = 0;
    const L = 3.0, w = 0.9;
    for (let t = 0; t < 2.0; t += DT) {
      v = Math.min(27, v + 32 * DT); z += v * DT;
      for (const f of [0.5, 1.2, 2.1, 3.2]) {
        s.addSource({ x: 0, y: 0.45, z: z - 2.2 - L * f, r: 1.2 + f * 0.6, rate: 22 * w / f ** 0.35, vx: 0, vy: 0.05, vz: -17 / Math.sqrt(f), radial: 1.5, dt: DT });
      }
      s.follow(0, z - 6);
      s.step(DT);
    }
    const b = s.bounds!;
    const len = (b.k1 - b.k0 + 1) * s.h, wid = (b.i1 - b.i0 + 1) * s.h, hgt = (b.j1 + 1) * s.h;
    expect(len).toBeGreaterThan(25);
    expect(len).toBeGreaterThan(wid * 1.5);
    // stream 1267 s: the tail stays at car height (sources + tuning: 7.2 m high, mean 1.37 m)
    expect(hgt).toBeLessThan(6.4);
    expect(meanHeight(s)).toBeLessThan(1.3);
  });

  it('a landing rolls out wide and keeps its mass low', () => {
    const s = new CloudSim();
    s.centreOn(0, 0, 0);
    for (let t = 0; t < 1.5; t += DT) {
      s.addSource({ x: 0, y: 0.5, z: 0, r: 2.8, rate: 40, vx: 0, vy: 0.9, vz: 0, radial: 24, dt: DT });
      s.step(DT);
    }
    for (let t = 0; t < 1.0; t += DT) s.step(DT);
    const b = s.bounds!;
    const w = Math.min((b.i1 - b.i0 + 1) * s.h, (b.k1 - b.k0 + 1) * s.h), hgt = (b.j1 + 1) * s.h;
    expect(w).toBeGreaterThan(14);
    // (tuning: 8 m high, mean height 2.19 m)
    expect(hgt).toBeLessThan(7.2);
    expect(hgt).toBeLessThan(w * 0.5);
    expect(meanHeight(s)).toBeLessThan(1.9);
  });

  it('red LED light: vapour beyond the bar does not shade the seam facing it', () => {
    // a cloud left of a bar at x = +7 and, in a second run, an extra cloud beyond the bar (x = +13)
    const run = (beyond: boolean) => {
      const s = new CloudSim();
      s.centreOn(3, 0, 0);
      for (let t = 0; t < 1.2; t += DT) {
        s.addSource({ x: 0, y: 0.5, z: 0, r: 2.8, rate: 30, vx: 0, vy: 0.9, vz: 0, radial: 12, dt: DT });
        if (beyond) s.addSource({ x: 13, y: 0.5, z: 0, r: 2.0, rate: 30, vx: 0, vy: 0, vz: 0, dt: DT });
        s.step(DT);
      }
      const lights: CloudLights = { spots: [], sun: null, leds: [{ x: 7, z0: -20, z1: 20, gain: 4 }] };
      const out = newBake(s);
      s.bake(lights, out);
      const k = Math.round((0 - s.oz) / s.h - 0.5);
      let best = 0, bx = 0;
      for (let i = 0; i < s.nx; i++) {
        const x = s.ox + (i + 0.5) * s.h;
        if (x > 6) break;
        const d = s.d[s.idx(i, 1, k)];
        const r = (out.data[s.idx(i, 1, k) * 4 + 3] / 255) ** 2 * out.redMax;
        if (d > 0.3 && r > best) { best = r; bx = x; }
      }
      // and deep inside the cloud (x ≈ 0) the seam has faded
      const inner = (out.data[s.idx(Math.round((0 - s.ox) / s.h - 0.5), 1, k) * 4 + 3] / 255) ** 2 * out.redMax;
      return { best, bx, inner };
    };
    const a = run(false), b = run(true);
    expect(a.best).toBeGreaterThan(0);
    // took the depth from the box edge on the bar side: the cloud beyond the bar darkened the seam
    expect(b.best).toBeGreaterThan(a.best * 0.9);
    expect(a.bx).toBeGreaterThan(1.5);
    expect(a.inner).toBeLessThan(a.best * 0.5);
  });

  it('dense cores stay dark (stream contrast): low multiple-scattering floor', () => {
    // (0.14 · e^(−τ/4) – a core at τ = 4 kept 5 % of the light)
    expect(transm(4)).toBeLessThan(0.03);
    expect(transm(10)).toBeLessThan(0.03);
    expect(transm(10)).toBeGreaterThan(0);
    expect(transm(0.5)).toBeGreaterThan(0.55);
  });
});
