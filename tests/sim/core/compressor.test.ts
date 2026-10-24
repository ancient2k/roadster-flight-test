import { describe, expect, it } from 'vitest';
import { RoadsterSim, spawnPose } from '../../../src/sim/core/roadsterSim';
import { compressorConfig, type CompressorMode } from '../../../src/sim/core/propulsion';
import { ENVIRONMENTS, EARTH, type BodyId } from '../../../src/shared/environment';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';
import { ROADSTER } from '../../../src/shared/roadster';
import { defaultSettings } from '../../../src/ui/settings';

const BODIES = Object.keys(ENVIRONMENTS) as BodyId[];
const GAME = ROADSTER.tank.refillKgPerSGame, REAL = ROADSTER.tank.refillKgPerSRealistic;

/** Expected refill rate (kg/s) per world and compressor setting. */
const expected = (body: BodyId, mode: CompressorMode) => mode === 'game' ? GAME : ENVIRONMENTS[body].canRefill ? REAL : 0;

describe('compressor setting', () => {
  it('defaults to Fun; full-tank times: 20 s everywhere (Fun), 6–7 h on Earth only (Realistic)', () => {
    expect(defaultSettings().refillRate).toBe('game');
    expect(ROADSTER.tank.fullMassKg / GAME).toBeCloseTo(20, 6);
    expect(ROADSTER.tank.fullMassKg / REAL / 3600).toBeCloseTo(6.5, 6);
    expect(compressorConfig('game')).toEqual({ rateKgS: GAME, onboard: true });
    expect(compressorConfig('realistic')).toEqual({ rateKgS: REAL, onboard: false });
    // only Earth has an atmosphere the compressor can draw in
    expect(BODIES.filter((b) => ENVIRONMENTS[b].canRefill)).toEqual(['earth']);
  });

  it('refill rate per world and mode (1 s with the compressor on, standing on the ground)', async () => {
    const sim = await RoadsterSim.create();
    const sys = { ...neutralSystems(), refill: true };
    for (const mode of ['game', 'realistic'] as CompressorMode[]) {
      sim.propulsion.setCompressor(mode);
      for (const body of BODIES) {
        sim.setEnvironment(ENVIRONMENTS[body]);
        sim.reset(spawnPose({ x: 0, y: 0.5, z: 0 }, 0), { airMassKg: 100 });
        expect(sim.compressorAvailable, `${body}/${mode}`).toBe(expected(body, mode) > 0);
        const m0 = sim.getState().tank.airMassKg;
        for (let i = 0; i < 240; i++) sim.step(neutralDrive(), sys, zeroThrust());
        const rate = sim.getState().tank.airMassKg - m0; // kg over 1 s
        if (expected(body, mode) === 0) expect(rate, `${body}/${mode}`).toBe(0);
        else expect(rate / expected(body, mode), `${body}/${mode}`).toBeCloseTo(1, 3);
      }
    }
    sim.setEnvironment(EARTH);
    sim.dispose();
  });

  it('Fun refills the Moon tank from 0 to full in about 20 s', async () => {
    const sim = await RoadsterSim.create();
    sim.propulsion.setCompressor('game');
    sim.setEnvironment(ENVIRONMENTS.moon);
    sim.reset(spawnPose({ x: 0, y: 0.5, z: 0 }, 0), { airMassKg: 0 });
    const sys = { ...neutralSystems(), refill: true };
    let t = 0;
    while (sim.getState().tank.airMassKg < ROADSTER.tank.fullMassKg && t < 30) { sim.step(neutralDrive(), sys, zeroThrust()); t += sim.dt; }
    expect(t).toBeGreaterThan(19.5);
    expect(t).toBeLessThan(20.5);
    sim.setEnvironment(EARTH);
    sim.dispose();
  });

  it('Fun stops at the rated tank: about 10,000 psi when full, no compression heating (was 16,800 psi)', async () => {
    const sim = await RoadsterSim.create();
    sim.propulsion.setCompressor('game');
    sim.reset(spawnPose({ x: 0, y: 0.5, z: 0 }, 0), { airMassKg: 20 });
    const sys = { ...neutralSystems(), refill: true };
    for (let i = 0; i < 240 * 25; i++) sim.step(neutralDrive(), sys, zeroThrust());
    const tk = sim.getState().tank;
    expect(tk.airMassKg).toBeCloseTo(ROADSTER.tank.fullMassKg, 3);
    expect(tk.pressurePa / ROADSTER.tank.fullPressurePa).toBeGreaterThan(0.97);
    expect(tk.pressurePa / ROADSTER.tank.fullPressurePa).toBeLessThan(1.03);
    sim.dispose();
  });

  it('Fun brings a full but chilled tank back to its rated pressure on the ground (it stayed in the red)', async () => {
    const sim = await RoadsterSim.create();
    sim.propulsion.setCompressor('game');
    sim.reset(spawnPose({ x: 0, y: 0.5, z: 0 }, 0));
    sim.propulsion.tank.fill(ROADSTER.tank.fullMassKg, 60); // after a long hover with infinite air: 250 kg at 60 K
    const sys = { ...neutralSystems(), refill: true };
    for (let i = 0; i < 240 * 60; i++) sim.step(neutralDrive(), sys, zeroThrust());
    expect(sim.propulsion.tank.pressure).toBeGreaterThan(650e5);
    sim.dispose();
  });
});
