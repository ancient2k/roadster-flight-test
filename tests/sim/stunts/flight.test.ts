// Flight phases of the stunts from airborne spawns on the full vehicle plant (modules):
// independent of the ground phases (kicker / wall traction), so they pin down the GNC itself.
import { describe, expect, it } from 'vitest';
import { kickflipLipSpawn, rampTopSpawn } from './spawns';
import { runStunt, summary, vehicleFactory, kernelFactory } from './helpers';
import { TUNING } from '../../../src/sim/stunts/tuning';

const factory = (await vehicleFactory()) ?? kernelFactory;

describe('kickflip flight phase (from the kicker lip, 18.4 m/s)', () => {
  it('360° roll, apex 7.7 m ±15 %, soft wheels-down landing, clears the car row', async () => {
    const sp = kickflipLipSpawn(18.4);
    const { result } = await runStunt('kickflip', factory, { spawn: sp.spawn, setup: sp.setup, ap: { startPhase: 'climb' }, maxS: 20 });
    const failed = result.checks.filter((c) => !c.ok && c.name !== 'launch g 3.5 ±0.7').map((c) => c.name);
    expect(failed, summary(result)).toEqual([]);
    expect(result.airUsedKg).toBeLessThan(130);
  });
});

describe('ramp_launch flight phase (fans released at the top of the overhang)', () => {
  it('half roll to wheels-down, lands on flat ground away from the wall', async () => {
    const sp = rampTopSpawn(TUNING.rampLaunch.releaseBeforeEndM, TUNING.rampLaunch.exitSpeedMs); // the real release point
    const { result, sim } = await runStunt('ramp_launch', factory, { spawn: sp.spawn, setup: sp.setup, ap: { startPhase: 'release' }, maxS: 15 });
    expect(result.success, summary(result)).toBe(true);
    expect(sim.getState().pos.z).toBeLessThan(57); // in front of the ramp origin (z = 60)
  });
});

describe('determinism', () => {
  it('same inputs -> bit-identical telemetry trace (incl. sensor noise with a fixed seed)', async () => {
    const run = async () => {
      const sp = kickflipLipSpawn(18.4);
      const { result, sim } = await runStunt('kickflip', factory, { spawn: sp.spawn, setup: sp.setup, ap: { startPhase: 'climb', noiseSeed: 99 }, maxS: 8 });
      const s = sim.getState();
      const out = [s.pos.x, s.pos.y, s.pos.z, s.quat.x, s.quat.y, s.quat.z, s.quat.w, s.tank.airMassKg, result.trace.length];
      sim.dispose();
      return out;
    };
    expect(await run()).toEqual(await run());
  });
});
