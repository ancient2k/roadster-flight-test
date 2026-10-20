import { describe, expect, it } from 'vitest';
import type { WheelState } from '../../src/shared/types';
import {
  ballisticGrain, flightTime, grainDrag, isLooseSoil, roosterVelocity, wheelDustRate, wheelSinkM,
} from '../../src/render/fxParams';
import { SEG_M, SEG_STRIDE, ScourRing, TrackRing } from '../../src/render/worlds/trackRing';
import { SURFACES, staticSinkage } from '../../src/sim/vehicle/surfaces';
import { ROADSTER } from '../../src/shared/roadster';

const wheel = (o: Partial<WheelState> = {}): WheelState => ({
  id: 'RL', contact: true, compression: 0.05, suspensionForceN: 1000, slipRatio: 0.05, slipAngleRad: 0.02,
  angularVel: 10 / 0.355, steerRad: 0, normalLoadN: 1100, contactPoint: { x: 0, y: 0, z: 0 }, surfaceNormal: { x: 0, y: 1, z: 0 }, ...o,
});
const MOON = { g: 1.62, rho: 0 }, MARS = { g: 3.721, rho: 0.02 }, EARTH = { g: 9.81, rho: 1.2 };

describe('driving dust', () => {
  it('throws no dust on rigid ground, some on loose soil', () => {
    const w = wheel();
    for (const k of ['asphalt', 'concrete', 'grass'] as const) expect(wheelDustRate(w, 2, 10, k)).toBe(0);
    expect(wheelDustRate(w, 2, 10, 'regolith')).toBeGreaterThan(50);
    expect(wheelDustRate(w, 2, 10, 'mars_soil')).toBeGreaterThan(0);
    expect(wheelDustRate(w, 2, 10, 'sand')).toBeGreaterThan(0);
    expect(wheelDustRate(w, 2, 10, null)).toBe(0);
    expect(isLooseSoil('asphalt')).toBe(false);
  });

  it('needs contact and a turning wheel; spin and side slip throw more', () => {
    expect(wheelDustRate(wheel({ contact: false }), 2, 10, 'regolith')).toBe(0);
    expect(wheelDustRate(wheel({ angularVel: 0, slipRatio: 0, slipAngleRad: 0 }), 2, 0, 'regolith')).toBe(0);
    // (4 m/s: below the rate cap)
    const roll = wheelDustRate(wheel({ angularVel: 4 / 0.355 }), 2, 4, 'regolith');
    expect(wheelDustRate(wheel({ slipRatio: 0.6, angularVel: 7 / 0.355 }), 2, 4, 'regolith')).toBeGreaterThan(roll);
    expect(wheelDustRate(wheel({ angularVel: 4 / 0.355, slipAngleRad: 0.3 }), 2, 4, 'regolith')).toBeGreaterThan(roll);
  });

  it('moon grains fly on pure parabolas: no drag, no buoyancy, gravity 1.62 m/s², life ends at the impact', () => {
    const g = ballisticGrain({ x: 3, y: 4, z: 0 }, 0, MOON);
    expect(g.drag).toBe(0);
    expect(g.buoyancy).toBeCloseTo(-1.62, 6);
    expect(g.life).toBeCloseTo(2 * 4 / 1.62, 6);
    // the particle shader integrates p = p0 + v t + ½ a t² (drag 0 → travel = t): back at y = 0 at the end of its life
    const y = 4 * g.life + 0.5 * g.buoyancy * g.life ** 2;
    expect(Math.abs(y)).toBeLessThan(1e-9);
    expect(grainDrag(MOON)).toBe(0);
  });

  it('thin Martian air hardly slows grains, Earth air does', () => {
    expect(grainDrag(MARS)).toBeGreaterThan(0);
    expect(grainDrag(MARS)).toBeLessThan(0.05);
    expect(grainDrag(EARTH)).toBeGreaterThan(grainDrag(MARS) * 20);
    // same launch: on the Moon a grain flies 2.3× as long as on Mars, 6× as long as on Earth
    expect(ballisticGrain({ x: 0, y: 3, z: 0 }, 0, MOON).life / ballisticGrain({ x: 0, y: 3, z: 0 }, 0, MARS).life).toBeCloseTo(3.721 / 1.62, 5);
    expect(flightTime(0, 0.5, 9.81)).toBeCloseTo(Math.sqrt(1 / 9.81), 6);
  });

  it('rooster-tail grains follow the tread (cycloid): up, slower than the car, backwards when the wheel spins', () => {
    for (let i = 0; i < 100; i++) {
      const r = [Math.random(), Math.random(), Math.random()] as const;
      const roll = roosterVelocity(10, 10, { x: 0, z: 1 }, ...r);
      expect(roll.y).toBeGreaterThan(0);
      expect(roll.y).toBeLessThan(10 * Math.sin(30 * Math.PI / 180) * 0.9 + 1e-9);
      expect(roll.z).toBeGreaterThanOrEqual(0);          // rolling: the tread rises from rest, never backwards
      expect(roll.z).toBeLessThan(10 * 0.2);              // and far slower than the car: the tail trails behind it
      const spin = roosterVelocity(25, 5, { x: 0, z: 1 }, ...r);
      expect(spin.z).toBeLessThan(0);                     // wheel spin: thrown backwards
    }
  });

  it('rut depth follows the R2 Bekker sinkage and is 0 on asphalt', () => {
    const w = wheel({ slipRatio: 0, angularVel: 10 / 0.355 });
    const sp = ROADSTER.wheels[2];
    const z = wheelSinkM(w, 2, 10, 'regolith');
    expect(z).toBeCloseTo(staticSinkage(1100, sp.width, sp.radius, SURFACES.regolith.soil!), 4);
    expect(z).toBeGreaterThan(0.002);
    expect(z).toBeLessThan(0.1);
    expect(wheelSinkM(w, 2, 10, 'asphalt')).toBe(0);
    // spinning wheel digs deeper (Lyasko slip sinkage)
    expect(wheelSinkM(wheel({ angularVel: 20 / 0.355 }), 2, 10, 'regolith')).toBeGreaterThan(z);
  });
});

describe('track ring buffer', () => {
  it('fills with one segment per SEG_M of travel and stays bounded', () => {
    const r = new TrackRing(100, 4);
    let x = 0;
    for (let i = 0; i < 2000; i++) {
      x += 0.1;
      for (let w = 0; w < 4; w++) r.step(w, { x: x, y: 0, z: w * 1.7 }, true, 0.3, 0.01);
    }
    expect(r.total).toBeGreaterThan(4 * (200 / SEG_M) * 0.7);
    expect(r.count).toBe(100);
    expect(r.data.length).toBe(100 * SEG_STRIDE);
    // the oldest are faded, the newest not
    expect(r.fadeOf(r.total - 1)).toBe(1);
    expect(r.fadeOf(r.total - 100)).toBeLessThan(0.1);
  });

  it('writes nothing without contact or on a jump, and the jet erases tracks', () => {
    const r = new TrackRing(50, 1);
    expect(r.step(0, { x: 0, y: 0, z: 0 }, false, 0.3, 0.01)).toBe(-1);
    r.step(0, { x: 0, y: 0, z: 0 }, true, 0.3, 0.01);
    expect(r.step(0, { x: 10, y: 0, z: 0 }, true, 0.3, 0.01)).toBe(-1);   // teleport
    for (let i = 1; i <= 10; i++) r.step(0, { x: 10 + i * 0.4, y: 0, z: 0 }, true, 0.3, 0.01);
    expect(r.count).toBe(10);
    expect(r.takeDirty()).toEqual([0, 9]);
    expect(r.takeDirty()).toBeNull();
    expect(r.erase(12, 0, 1, 1)).toBeGreaterThan(0);
    const strengths = Array.from({ length: 10 }, (_, i) => r.data[i * SEG_STRIDE + 9]);
    expect(Math.min(...strengths)).toBeLessThan(0.5);
    expect(Math.max(...strengths)).toBe(1);
  });

  it('merges repeated jet hits into one scour spot', () => {
    const s = new ScourRing(8);
    for (let i = 0; i < 200; i++) s.add(0.1 * Math.sin(i), 0, 0.1 * Math.cos(i), 2, 0.01);
    expect(s.count).toBe(1);
    expect(s.data[4]).toBe(1);
    s.add(30, 0, 0, 2, 0.1);
    expect(s.count).toBe(2);
    for (let i = 0; i < 20; i++) s.add(100 + i * 10, 0, 0, 1, 0.1);
    expect(s.count).toBe(8);
  });
});
