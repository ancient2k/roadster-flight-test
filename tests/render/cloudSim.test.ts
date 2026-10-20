// CPU side of the ground-cloud volume (no GPU): injection, ground-hugging spread, roll-up,
// evaporation, grid following and the light bake.
import { describe, expect, it } from 'vitest';
import { CloudSim, DMAX, transm, type CloudBake, type CloudLights } from '../../src/render/fx/volume/cloudSim';

const DT = 1 / 30;
const lights: CloudLights = {
  spots: [{ x: 0, y: 30, z: -20, I: 2e6, dx: 0, dy: -0.83, dz: 0.55, cosOuter: Math.cos(0.6), cosInner: Math.cos(0.4) }],
  sun: null,
  leds: [{ x: 8, z0: -20, z1: 20, gain: 4 }],
};
const newBake = (s: CloudSim): CloudBake => ({ data: new Uint8Array(s.n * 4), keyMax: 1, redMax: 1, keyDir: [0, 1, 0] });

/** Landing: a steep jet hits the pad at the origin for `secs` seconds. */
function landing(s: CloudSim, secs: number, strength = 1): void {
  for (let t = 0; t < secs; t += DT) {
    s.addSource({ x: 0, y: 0.5, z: 0, r: 1.8 + strength, rate: 20 * strength, vx: 0, vy: 1.2, vz: 0, radial: 8 + 12 * strength });
    s.step(DT);
  }
}

describe('cloud volume simulation', () => {
  it('starts empty and stays empty without sources', () => {
    const s = new CloudSim();
    s.centreOn(0, 0, 0);
    for (let i = 0; i < 10; i++) s.step(DT);
    expect(s.bounds).toBeNull();
    expect(s.mass).toBe(0);
  });

  it('a landing spreads into a wide, ground-hugging cloud (much wider than tall)', () => {
    const s = new CloudSim();
    s.centreOn(0, 0, 0);
    landing(s, 1.5);
    for (let t = 0; t < 1.0; t += DT) s.step(DT);
    const b = s.bounds!;
    expect(b).not.toBeNull();
    const w = (b.i1 - b.i0 + 1) * s.h, d = (b.k1 - b.k0 + 1) * s.h, hgt = (b.j1 + 1) * s.h;
    // 2–3× the R8 billow (σ 5.8 m): well over 15 m across, a few metres high
    expect(Math.min(w, d)).toBeGreaterThan(15);
    expect(hgt).toBeGreaterThan(2.5);
    expect(hgt).toBeLessThan(Math.min(w, d) * 0.6);
    // mass sits low: the bottom third of the cloud holds most of it
    let low = 0, all = 0;
    for (let k = 0; k < s.nz; k++) for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) {
      const v = s.d[s.idx(i, j, k)]; all += v; if (j * s.h < 3) low += v;
    }
    expect(low / all).toBeGreaterThan(0.6);
  });

  it('the front rolls up: some vapour rises above the source height', () => {
    const s = new CloudSim();
    s.centreOn(0, 0, 0);
    landing(s, 1.2);
    const b = s.bounds!;
    expect((b.j1 + 1) * s.h).toBeGreaterThan(2);
  });

  it('evaporates after the jets stop', () => {
    const s = new CloudSim();
    s.centreOn(0, 0, 0);
    landing(s, 1);
    const m0 = s.mass;
    for (let t = 0; t < 6; t += DT) s.step(DT);
    expect(s.mass).toBeLessThan(m0 * 0.6);
    for (let t = 0; t < 40; t += DT) s.step(DT);
    expect(s.bounds).toBeNull();
  });

  it('a wall jet behind a moving car leaves a long trail', () => {
    const s = new CloudSim();
    s.centreOn(0, 0, 0);
    let z = -10, v = 0;
    for (let t = 0; t < 2.5; t += DT) {
      v = Math.min(27, v + 12 * DT); z += v * DT;
      for (const f of [0.5, 1.2, 2.0]) s.addSource({ x: 0, y: 0.6, z: z - 2 - 3 * f, r: 1.4 + f * 0.9, rate: 9 / f, vx: 0, vy: 0.3, vz: -13 / f, radial: 2.5 });
      s.follow(0, z - 4);
      s.step(DT);
    }
    const b = s.bounds!;
    const len = (b.k1 - b.k0 + 1) * s.h, wid = (b.i1 - b.i0 + 1) * s.h, hgt = (b.j1 + 1) * s.h;
    expect(len).toBeGreaterThan(20);
    expect(len).toBeGreaterThan(wid * 1.3);
    expect(hgt).toBeLessThan(8);
  });

  it('following shifts the grid in whole cells and keeps the content in place', () => {
    const s = new CloudSim();
    s.centreOn(0, 0, 0);
    s.addSource({ x: 2, y: 1, z: 3, r: 1.5, rate: 30, vx: 0, vy: 0, vz: 0 });
    s.step(DT);
    const peak = () => { let m = 0, at = [0, 0, 0]; for (let k = 0; k < s.nz; k++) for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) { const v = s.d[s.idx(i, j, k)]; if (v > m) { m = v; at = [s.ox + (i + 0.5) * s.h, (j + 0.5) * s.h, s.oz + (k + 0.5) * s.h]; } } return at; };
    const p0 = peak();
    expect(s.follow(30, 0)).toBe(true);
    const p1 = peak();
    expect(p1[0]).toBeCloseTo(p0[0], 5);
    expect(p1[2]).toBeCloseTo(p0[2], 5);
    expect(Math.round(s.ox / s.h) * s.h).toBeCloseTo(s.ox, 6);
  });

  it('bake: dense core darker towards the key light than the lit crown, red only near the bars', () => {
    const s = new CloudSim();
    s.centreOn(0, 0, 0);
    landing(s, 1.5);
    const out = newBake(s);
    s.bake(lights, out);
    expect(out.keyMax).toBeGreaterThan(0);
    // key light points up/back towards the spot
    expect(out.keyDir[1]).toBeGreaterThan(0.5);
    const b = s.bounds!;
    const ci = Math.round((b.i0 + b.i1) / 2), ck = Math.round((b.k0 + b.k1) / 2);
    const at = (i: number, j: number, k: number, c: number) => out.data[s.idx(i, j, k) * 4 + c];
    // bottom centre (deep in the cloud) vs the top of the same column
    expect(at(ci, 0, ck, 1)).toBeLessThan(at(ci, b.j1, ck, 1));
    // fill transmittance from above decreases downwards
    expect(at(ci, 0, ck, 2)).toBeLessThan(at(ci, b.j1, ck, 2));
    // red: the side next to the bar (x = +8) beats the far side
    const jr = 0;
    let near = 0, far = 0;
    for (let i = b.i0; i <= b.i1; i++) {
      const x = s.ox + (i + 0.5) * s.h;
      if (x > 4) near = Math.max(near, at(i, jr, ck, 3)); else if (x < -4) far = Math.max(far, at(i, jr, ck, 3));
    }
    expect(near).toBeGreaterThan(far);
    // density encoding round-trips within 8 bits
    const id = s.idx(ci, 0, ck);
    const dec = (at(ci, 0, ck, 0) / 255) ** 2 * DMAX;
    expect(Math.abs(dec - Math.min(DMAX, s.d[id]))).toBeLessThan(0.08 * DMAX);
  });

  it('transmittance keeps a multiple-scattering floor (grey cores, not black)', () => {
    expect(transm(0)).toBe(1);
    expect(transm(20)).toBeGreaterThan(0);
    expect(transm(2)).toBeLessThan(transm(1));
  });

  it('a step over a full landing cloud stays within a few milliseconds', () => {
    const s = new CloudSim();
    s.centreOn(0, 0, 0);
    landing(s, 1.5);
    const out = newBake(s);
    // (a few untimed steps first – the worker runs warm; cold, the JIT of the eddy and seam code
    // landed in the timed loop)
    for (let i = 0; i < 4; i++) { s.step(DT); s.bake(lights, out); }
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) { s.step(DT); s.bake(lights, out); }
    const ms = (performance.now() - t0) / 10;
    // generous bound (CI machines are loaded); the real cost is reported in docs/RENDERING.md
    expect(ms).toBeLessThan(40);
  });
});
