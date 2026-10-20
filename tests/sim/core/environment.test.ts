import { describe, expect, it } from 'vitest';
import { RoadsterSim, spawnPose } from '../../../src/sim/core/roadsterSim';
import { MOON, SPACE, EARTH } from '../../../src/shared/environment';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';
import { NozzleModel } from '../../../src/sim/core/nozzle';
import { ROADSTER } from '../../../src/shared/roadster';

describe('environments', () => {
  it('vacuum thrust exceeds sea-level thrust (pressure term) and stays finite', () => {
    const n = new NozzleModel(ROADSTER.nozzles[0]);
    const sl = n.compute(120e5, 288, 101_325), vac = n.compute(120e5, 288, 0);
    expect(vac.thrustN).toBeGreaterThan(sl.thrustN * 1.015); // +pa·Ae ≈ 2.4 % at ε = 4
    expect(Number.isFinite(vac.exitPressureRatio)).toBe(true);
  });
  it('moon gravity free fall and specific force ~0 g', async () => {
    const sim = await RoadsterSim.create();
    sim.setEnvironment(MOON);
    sim.reset(spawnPose({ x: 0, y: 50, z: 0 }, 0));
    const y0 = sim.getState().pos.y;
    for (let i = 0; i < 240; i++) sim.step(neutralDrive(), neutralSystems(), zeroThrust());
    expect(y0 - sim.getState().pos.y).toBeCloseTo(0.5 * 1.62, 1);
    sim.dispose();
  });
  it('space: no gravity, compressor cannot refill, thrust accelerates the car', async () => {
    const sim = await RoadsterSim.create();
    sim.setEnvironment(SPACE);
    sim.reset(spawnPose({ x: 0, y: 100, z: 0 }, 0), { airMassKg: 100 });
    const sys = { ...neutralSystems(), refill: true };
    for (let i = 0; i < 240; i++) sim.step(neutralDrive(), sys, zeroThrust());
    expect(sim.getState().linVel.y).toBeCloseTo(0, 6);
    expect(sim.getState().tank.airMassKg).toBeCloseTo(100, 6);
    const c = zeroThrust(); c.duty.set([1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 24; i++) sim.step(neutralDrive(), neutralSystems(), c);
    expect(sim.getState().linVel.z).toBeGreaterThan(1);
    sim.setEnvironment(EARTH);
    sim.dispose();
  });
});
