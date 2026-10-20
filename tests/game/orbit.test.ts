import { describe, expect, it } from 'vitest';
import { AU_M, ROADSTER1_STATE, elementsFromState, orbitAfterDv, sceneAxes, stackEquivalentDv } from '../../src/game/orbit';

describe('Roadster 1 orbit', () => {
  const H = ROADSTER1_STATE.horizons;
  it('elements from the Horizons state vector match the Horizons elements', () => {
    const el = elementsFromState(ROADSTER1_STATE.r, ROADSTER1_STATE.v);
    expect(el.a / H.a).toBeCloseTo(1, 6);
    expect(el.e).toBeCloseTo(H.e, 6);
    expect(el.iDeg).toBeCloseTo(H.iDeg, 4);
    expect(el.nodeDeg).toBeCloseTo(H.nodeDeg, 3);
    expect(el.argPeriDeg).toBeCloseTo(H.argPeriDeg, 3);
    expect(el.q / H.q).toBeCloseTo(1, 6);
    expect(el.Q / H.Q).toBeCloseTo(1, 6);
    expect(el.periodS / H.periodS).toBeCloseTo(1, 5);
    // published values: perihelion 0.986 AU, aphelion 1.66 AU, period ≈ 557 d (1.525 a)
    expect(el.q / AU_M).toBeCloseTo(0.986, 2);
    expect(el.Q / AU_M).toBeCloseTo(1.664, 2);
    expect(el.periodS / 86400).toBeGreaterThan(555);
    expect(el.periodS / 86400).toBeLessThan(560);
  });
  it('scene frame is orthonormal and right-handed; −X points along the flight direction', () => {
    const { X, Y, Z } = sceneAxes();
    const d = (a: typeof X, b: typeof X) => a.x * b.x + a.y * b.y + a.z * b.z;
    expect(d(X, Y)).toBeCloseTo(0, 12); expect(d(Y, Z)).toBeCloseTo(0, 12); expect(d(X, Z)).toBeCloseTo(0, 12);
    expect(d({ x: X.y * Y.z - X.z * Y.y, y: X.z * Y.x - X.x * Y.z, z: X.x * Y.y - X.y * Y.x }, Z)).toBeCloseTo(1, 12);
    const v = ROADSTER1_STATE.v, vm = Math.hypot(v.x, v.y, v.z);
    expect(-d(X, v) / vm).toBeGreaterThan(0.95);   // eccentric orbit: flight path angle ≈ 13° here
  });
  it('a prograde Δv raises the orbit by the vis-viva amount, Δv = 0 changes nothing', () => {
    const zero = orbitAfterDv({ x: 0, y: 0, z: 0 });
    expect(zero.after.a).toBe(zero.before.a);
    const r = orbitAfterDv({ x: -1, y: 0, z: 0 });   // 1 m/s, mostly prograde
    const mu = 1.32712440041279e20, a = r.before.a;
    // da = 2 a² v Δv_t / mu
    const expected = (2 * a * a * r.before.speed * r.prograde) / mu;
    expect((r.after.a - a) / expected).toBeCloseTo(1, 3);   // first order (2nd-order term ≈ 1e-4)
    expect(r.prograde).toBeGreaterThan(0.95);
    expect((r.after.a - a) / 1000).toBeGreaterThan(10_000);   // ≈ 13 000 km per m/s
    expect((r.after.periodS - r.before.periodS) / 3600).toBeGreaterThan(0.3);
    // honest scale: a few m/s change the period by hours, perihelion and aphelion by < 0.001 AU
    const big = orbitAfterDv({ x: -5, y: 0, z: 0 });
    expect(Math.abs(big.after.q - big.before.q) / AU_M).toBeLessThan(1e-3);
    expect(Math.abs(big.after.Q - big.before.Q) / AU_M).toBeLessThan(1e-3);
  });
  it('the stack (5.9 t) would get a smaller Δv from the same ram', () => {
    const s = stackEquivalentDv({ x: 1, y: 0, z: 0 }, 1950);
    expect(s.x).toBeGreaterThan(0.3); expect(s.x).toBeLessThan(0.5);   // μ ratio 1.48 × mass ratio 0.21 ≈ 0.41
  });
});
