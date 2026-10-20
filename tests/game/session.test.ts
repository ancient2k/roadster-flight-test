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
  it('raw group mapping signs', () => {
    const c = rawGroups({ lift: 0.5, boost: 0, pitch: 0.5, roll: 0, yaw: 1 });
    expect(c.duty[4]).toBeGreaterThan(c.duty[6]); // nose up -> front lift > rear
    expect(c.duty[8]).toBe(1); expect(c.duty[9]).toBe(0);
  });
});
