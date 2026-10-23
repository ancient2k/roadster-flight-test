import { describe, expect, it } from 'vitest';
import { RoadsterSim } from '../../src/sim/core/roadsterSim';
import { ManualController, SimSession, rawGroups } from '../../src/game/session';

describe('SimSession', () => {
  it('runs a manual session headless and records telemetry', async () => {
    const sim = await RoadsterSim.create();
    let mc: ManualController | null = null;
    const s = new SimSession(sim, { kind: 'manual', stunt: 'ground_flip' }, (sm) => (mc = new ManualController(sm, null)));
    mc!.axes.lift = 1;
    for (let i = 0; i < 240 * 2.5; i++) s.step(); // 1.5 s settling after the spawn, then lift
    expect(s.telemetry().altitudeM).toBeGreaterThan(1);
    expect(s.recorder.frames.length).toBeGreaterThan(50);
    s.restart();
    expect(s.state().t).toBe(0);
    sim.dispose();
  });
  it('infinite air keeps the tank full under continuous lift', async () => {
    const run = async (inf: boolean) => {
      const sim = await RoadsterSim.create();
      let mc: ManualController | null = null;
      const s = new SimSession(sim, { kind: 'manual', stunt: 'ground_flip' }, (sm) => (mc = new ManualController(sm, null)));
      s.infiniteAir = inf;
      const m0 = sim.propulsion.tank.m;
      mc!.axes.lift = 1;
      for (let i = 0; i < 240 * 8; i++) s.step();
      const used = m0 - sim.propulsion.tank.m;
      sim.dispose();
      return used / m0;
    };
    expect(await run(false)).toBeGreaterThan(0.2);
    expect(await run(true)).toBeLessThan(0.03);
  });
  it('raw group mapping signs', () => {
    const c = rawGroups({ lift: 0.5, boost: 0, pitch: 0.5, roll: 0, yaw: 1 });
    expect(c.duty[4]).toBeGreaterThan(c.duty[6]); // nose up -> front lift > rear
    expect(c.duty[8]).toBe(1); expect(c.duty[9]).toBe(0);
  });
});
