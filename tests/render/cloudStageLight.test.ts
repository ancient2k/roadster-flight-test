// red stage floods in the cloud bake (finale: light "too grey instead of spatially
// separated white/red"). A red flood from one side must colour that half of the cloud and leave the
// other half to the white key; without red floods the bake is unchanged (LED bars only).
import { describe, expect, it } from 'vitest';
import { CloudSim, DMAX, runStep, type CloudBake, type CloudLights, type CloudSource } from '../../src/render/fx/volume/cloudSim';

const DT = 1 / 24;

/** A landing-like cloud at the origin (radial outflow, ~1 s of emission). */
function cloud(): CloudSim {
  const s = new CloudSim();
  s.centreOn(0, 0, 0);
  for (let t = 0; t < 1.0; t += DT) {
    const src: CloudSource = { x: 0, y: 0.8, z: 0, r: 2.6, rate: 30, vx: 0, vy: 0.3, vz: 0, radial: 2.5, dt: DT };
    s.addSource(src);
    s.step(DT);
  }
  return s;
}

/** A spot at `p` aimed at the cloud centre (1.5 m up). */
function spotAt(x: number, y: number, z: number, I: number): CloudLights['spots'][number] {
  const dx = -x, dy = 1.5 - y, dz = -z, l = Math.hypot(dx, dy, dz);
  return { x, y, z, I, dx: dx / l, dy: dy / l, dz: dz / l, cosOuter: Math.cos(0.7), cosInner: Math.cos(0.38) };
}

function bake(s: CloudSim, L: CloudLights): CloudBake {
  const out: CloudBake = { data: new Uint8Array(s.n * 4), keyMax: 1, redMax: 1, keyDir: [0, 1, 0] };
  s.bake(L, out);
  return out;
}

/** Mean of channel `c` (0..255) over the dense cells with x on one side of the centre. */
function sideMean(s: CloudSim, b: CloudBake, c: number, side: 1 | -1): number {
  let sum = 0, n = 0;
  for (let k = 0; k < s.nz; k++) for (let j = 0; j < s.ny; j++) for (let i = 0; i < s.nx; i++) {
    const id = s.idx(i, j, k);
    if (s.d[id] < 0.2 * DMAX / 3) continue;
    const x = s.ox + (i + 0.5) * s.h;
    if (Math.sign(x) !== side || Math.abs(x) < 1) continue;
    sum += b.data[id * 4 + c]; n++;
  }
  return n ? sum / n : 0;
}

describe('red stage floods in the cloud bake', () => {
  it('a red flood from +x reddens the +x half far more than the −x half', () => {
    const s = cloud();
    const white = spotAt(-14, 2.5, 6, 25_000);
    const L: CloudLights = { spots: [white], sun: null, leds: [], reds: [spotAt(14, 1.5, 6, 25_000)] };
    const b = bake(s, L);
    const redPlus = sideMean(s, b, 3, 1), redMinus = sideMean(s, b, 3, -1);
    const keyPlus = sideMean(s, b, 1, 1), keyMinus = sideMean(s, b, 1, -1);
    expect(redPlus).toBeGreaterThan(1.8 * redMinus);
    // and the white key does the opposite: spatially separated white / red
    expect(keyMinus).toBeGreaterThan(1.8 * keyPlus);
    // the red direction points towards the red flood, and the floods carry the red channel
    expect(b.redDir![0]).toBeGreaterThan(0.6);
    expect(b.redSpot!).toBeGreaterThan(0.9);
  });

  it('without red floods the bake is the LED-bar bake (redSpot 0, identical data)', () => {
    const s = cloud();
    const base: CloudLights = { spots: [spotAt(-14, 2.5, 6, 25_000)], sun: null, leds: [{ x: 6, z0: -20, z1: 20, gain: 1 }] };
    const a = bake(s, base);
    const b = bake(s, { ...base, reds: [] });
    expect(b.redSpot).toBe(0);
    expect(Buffer.from(b.data).equals(Buffer.from(a.data))).toBe(true);
    expect(b.redMax).toBe(a.redMax);
  });

  it('runStep passes the red direction and share through to the main thread', () => {
    const s = new CloudSim();
    const r = runStep(s, {
      sources: [{ x: 0, y: 0.8, z: 0, r: 2.6, rate: 30, vx: 0, vy: 0.3, vz: 0, radial: 2.5 }],
      steps: 6, dt: DT, focus: { x: 0, z: 0 }, car: { x: 0, z: 0 },
      lights: { spots: [], sun: null, leds: [], reds: [spotAt(10, 1.5, 0, 25_000)] },
      buf: new ArrayBuffer(s.n * 4),
    });
    expect(r.redDir[0]).toBeGreaterThan(0.6);
    expect(r.redSpot).toBeGreaterThan(0.9);
  });
});
