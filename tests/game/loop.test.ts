import { describe, expect, it } from 'vitest';
import { FixedStepLoop } from '../../src/game/loop';
import { Recorder } from '../../src/game/recorder';
import { interpolateState } from '../../src/game/interp';
import { RoadsterSim, spawnPose } from '../../src/sim/core/roadsterSim';
import { SIM_DT, neutralDrive, neutralSystems, zeroThrust } from '../../src/shared/types';

describe('FixedStepLoop', () => {
  it('takes the right number of steps and carries the remainder', () => {
    let steps = 0; const alphas: number[] = [];
    const loop = new FixedStepLoop(SIM_DT, { step: () => steps++, render: (a) => alphas.push(a) });
    for (let i = 0; i < 60; i++) loop.advance(1 / 60);
    expect(steps).toBeGreaterThanOrEqual(239); expect(steps).toBeLessThanOrEqual(240);
    for (const a of alphas) { expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThan(1); }
  });
  it('time scale and pause', () => {
    let steps = 0;
    const loop = new FixedStepLoop(SIM_DT, { step: () => steps++, render: () => {} });
    loop.timeScale = 0.25;
    for (let i = 0; i < 60; i++) loop.advance(1 / 60);
    expect(steps).toBeGreaterThanOrEqual(59); expect(steps).toBeLessThanOrEqual(60);
    loop.paused = true; const before = steps;
    for (let i = 0; i < 60; i++) loop.advance(1 / 60);
    expect(steps).toBe(before);
  });
  it('drops backlog after a long stall instead of spiralling', () => {
    let steps = 0;
    const loop = new FixedStepLoop(SIM_DT, { step: () => steps++, render: () => {} });
    loop.advance(5);
    expect(steps).toBeLessThanOrEqual(loop.maxStepsPerFrame);
  });
});

describe('recorder + interpolation', () => {
  it('records at 60 Hz and interpolates poses between steps', async () => {
    const sim = await RoadsterSim.create();
    sim.reset(spawnPose({ x: 0, y: 20, z: 0 }, 0));
    const rec = new Recorder(60);
    for (let i = 0; i < 240; i++) { sim.step(neutralDrive(), neutralSystems(), zeroThrust()); rec.push(sim.getState(), sim.telemetry()); }
    expect(rec.frames.length).toBeGreaterThanOrEqual(59); expect(rec.frames.length).toBeLessThanOrEqual(61);
    const s = rec.sample(0.5)!;
    const out = structuredClone(s.a.state);
    interpolateState(out, s.a.state, s.b.state, 0.5);
    expect(out.pos.y).toBeLessThanOrEqual(s.a.state.pos.y);
    expect(out.pos.y).toBeGreaterThanOrEqual(s.b.state.pos.y);
    sim.dispose();
  });
});
