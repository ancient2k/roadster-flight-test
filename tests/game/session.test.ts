import { describe, expect, it } from 'vitest';
import { RoadsterSim } from '../../src/sim/core/roadsterSim';
import { ManualController, SimSession, rawGroups } from '../../src/game/session';
import { ManualAssist } from '../../src/sim/gnc';

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
  it('infinite air keeps the rated pressure too: the gas does not chill to a "full" tank at 2,000 psi', async () => {
    const sim = await RoadsterSim.create();
    let mc: ManualController | null = null;
    const s = new SimSession(sim, { kind: 'manual', stunt: 'ground_flip' }, (sm) => (mc = new ManualController(sm, null)));
    s.infiniteAir = true;
    mc!.axes.lift = 1; mc!.axes.boost = 1;
    let minP = Infinity;
    for (let i = 0; i < 240 * 60; i++) { s.step(); if (i > 240 * 5) minP = Math.min(minP, sim.propulsion.tank.pressure); }
    expect(sim.propulsion.tank.T).toBeGreaterThan(280);
    expect(minP).toBeGreaterThan(650e5); // 10,000 psi is 690 bar; it used to settle near 140 bar (2,050 psi)
    sim.dispose();
  });
  it('hovering in ASSIST: steering right turns the nose right with the yaw jets', async () => {
    const heading = async (steer: number) => {
      const sim = await RoadsterSim.create();
      let mc: ManualController | null = null;
      const s = new SimSession(sim, { kind: 'manual', stunt: 'ground_flip' }, (sm) => (mc = new ManualController(sm, new ManualAssist())));
      mc!.axes.lift = 1;
      for (let i = 0; i < 240 * 3; i++) s.step();            // climb to a hover
      mc!.axes.lift = 0;
      expect(sim.getState().heightAboveGroundM).toBeGreaterThan(1);
      mc!.drive = { ...mc!.drive, steer };
      let jets = 0;
      for (let i = 0; i < 240 * 2; i++) { s.step(); jets = Math.max(jets, sim.getState().nozzles[steer > 0 ? 8 : 9].thrustN); }
      const q = sim.getState().quat;
      const fx = 2 * (q.x * q.z + q.w * q.y);                // forward (body +Z) x component
      sim.dispose();
      return { fx, jets };
    };
    const r = await heading(1), l = await heading(-1), n = await heading(0);
    expect(r.jets).toBeGreaterThan(0);
    expect(l.jets).toBeGreaterThan(0);
    expect(r.fx).toBeLessThan(n.fx - 0.1);   // car right is −X: the nose swings towards −X
    expect(l.fx).toBeGreaterThan(n.fx + 0.1);
  });
  it('ASSIST switches the fans to suction while the car stands tilted on its wheels, and back off afterwards', async () => {
    const sim = await RoadsterSim.create();
    const mc = new ManualController(sim, null);
    const st = (deg: number, t: number, contact = true) => {
      const h = (deg * Math.PI) / 360;
      return { ...sim.getState(), t, groundContact: contact, quat: { x: Math.sin(h), y: 0, z: 0, w: Math.cos(h) } };
    };
    expect(mc.effectiveFan(st(5, 1))).toBe('off');
    expect(mc.effectiveFan(st(35, 2))).toBe('grip');
    expect(mc.autoFan).toBe(true);
    expect(mc.effectiveFan(st(5, 2.5))).toBe('grip');        // held a moment after the slope
    expect(mc.effectiveFan(st(5, 4))).toBe('off');
    expect(mc.effectiveFan(st(35, 5, false))).toBe('off');   // in the air: no suction
    mc.assist = 'STABILIZED';
    expect(mc.effectiveFan(st(35, 6))).toBe('off');          // only ASSIST helps
    mc.assist = 'ASSIST'; mc.fanMode = 'highspeed';
    expect(mc.effectiveFan(st(35, 7))).toBe('highspeed');    // the player's choice wins
    sim.dispose();
  });
  it('raw group mapping signs', () => {
    const c = rawGroups({ lift: 0.5, boost: 0, pitch: 0.5, roll: 0, yaw: 1 });
    expect(c.duty[4]).toBeGreaterThan(c.duty[6]); // nose up -> front lift > rear
    expect(c.duty[8]).toBe(1); expect(c.duty[9]).toBe(0);
  });
});
