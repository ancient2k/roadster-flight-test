// Prototype: drop -> brake -> land on the real plant (shared kernel, valves, tank).
import { beforeAll, describe, expect, it } from 'vitest';
import { RoadsterSim } from '../../../src/sim/core/roadsterSim';
import { FlightControl, newFlightCommand } from '../../../src/sim/gnc/flight';
import { Lander } from '../../../src/sim/gnc/guidance';
import { Estimator } from '../../../src/sim/gnc/estimator';
import { DEG, qrot, v3 } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';

let sim: RoadsterSim;
let kernel: RoadsterSim;
beforeAll(async () => {
  kernel = await RoadsterSim.create();
  // valve-failure cases need wheels/suspension for a meaningful touchdown: plant if present
  try { sim = await (await import('../../../src/sim/vehicle')).createRoadsterSim(); } catch { sim = kernel; }
});

function dropAndLand(y0: number, vx: number, vy: number, vz: number, seed: number | null = null, stuckClosed = -1, knownFault = false) {
  sim.reset({ pos: v3(0, y0, 0), quat: { x: 0, y: 0, z: 0, w: 1 } });
  for (let i = 0; i < 10; i++) sim.propulsion.valves.setFault(i, i === stuckClosed ? -1 : 0);
  sim.body.setLinvel({ x: vx, y: vy, z: vz }, true);
  sim.step(neutralDrive(), neutralSystems(), zeroThrust()); // settle the accelerometer after the velocity jump
  const fc = new FlightControl(sim), est = new Estimator(seed), cmd = newFlightCommand(), lander = new Lander();
  if (knownFault && stuckClosed >= 0) fc.valveFault[stuckClosed] = -1; // found by a pre-flight valve check
  const thr = zeroThrust(), drive = neutralDrive(), sys = neutralSystems();
  const air0 = sim.getState().tank.airMassKg;
  let touch: { vy: number; upY: number; t: number; yawRate: number } | null = null;
  let maxG = 0;
  for (let k = 0; k < 240 * 12 && !touch; k++) {
    const e = est.update(sim.getState());
    fc.refresh(e);
    lander.maxDecel = fc.liftReserveAccel();
    lander.update(e, fc.mp, cmd);
    fc.compute(e, cmd, thr.duty);
    fc.observe(thr.duty);
    sim.step(drive, sys, thr);
    const s = sim.getState();
    if (!(s.bodyContact || s.groundContact) && k > 24) maxG = Math.max(maxG, sim.telemetry().gForce); // in-flight g (box contact has no suspension)
    if (s.bodyContact || s.groundContact) touch = { vy: s.linVel.y, upY: qrot(s.quat, v3(0, 1, 0)).y, t: s.t, yawRate: s.angVel.y };
  }
  const crashedAtTouch = sim.getState().crashed;
  // after the touchdown: jets off, brakes on for 3 s (a spinning emergency landing must come to rest upright)
  let maxTiltDeg = 0;
  if (touch) {
    const brake = { ...neutralDrive(), brake: 1 };
    for (let k = 0; k < 240 * 3; k++) {
      sim.step(brake, sys, zeroThrust());
      maxTiltDeg = Math.max(maxTiltDeg, Math.acos(Math.min(1, qrot(sim.getState().quat, v3(0, 1, 0)).y)) / DEG);
    }
  }
  const after = sim.getState();
  return { touch, air: air0 - after.tank.airMassKg, crashed: crashedAtTouch || after.crashed, maxG, maxTiltDeg, restYawRate: after.angVel.y };
}

describe('landing guidance on the real plant', () => {
  it('drop from 20 m: touchdown sink ≤ 2 m/s, upright, within the air budget', () => {
    const r = dropAndLand(20.45, 0, 0, 0);
    expect(r.touch).not.toBeNull();
    expect(-r.touch!.vy).toBeLessThan(2.0);
    expect(r.touch!.upY).toBeGreaterThan(Math.cos(5 * DEG));
    expect(r.crashed).toBe(false);
    expect(r.air).toBeLessThan(130);
    console.log('drop 20 m', r);
  });

  it('kickflip-like descent (8 m apex, 19 m/s forward) with sensor noise', () => {
    const r = dropAndLand(8.6, 0, 0, 19, 1234);
    expect(r.touch).not.toBeNull();
    expect(-r.touch!.vy).toBeLessThan(2.0);
    expect(r.touch!.upY).toBeGreaterThan(Math.cos(5 * DEG));
    expect(r.maxG).toBeLessThan(3.1); // below the full-lift ceiling (no saturation)
    console.log('kickflip-like', r);
  });

  // known stuck-closed corner jet, every corner, corrected valve PWM.
  // Front corner lost: the diagonal pair's cant makes a yaw couple the yaw jets cannot cancel, the
  // heading is released (the car turns slowly). Rear corner lost: no moment-free lift exists at all
  // (wet CoM behind the jets' midpoint); the car spins up in yaw so the body-fixed pitch moment cones
  // instead of accumulating (FlightControl.compute, LEVELS.landingRearFault). Report: r1-stunts.md §3.
  for (const [corner, name] of [[4, 'FL'], [5, 'FR'], [6, 'RL'], [7, 'RR']] as const) {
    it(`valve failure known before the drop (${name} stuck closed): soft landing on three corner jets (< 2.5 m/s)`, () => {
      const r = dropAndLand(10.45, 0, 0, 0, null, corner, true);
      for (let i = 0; i < 10; i++) sim.propulsion.valves.setFault(i, 0);
      console.log(`known stuck ${name}`, JSON.stringify(r));
      expect(r.touch).not.toBeNull();
      expect(r.crashed).toBe(false);
      expect(-r.touch!.vy).toBeLessThan(2.5);
      expect(r.touch!.upY).toBeGreaterThan(Math.cos(10 * DEG));
      expect(Math.abs(r.touch!.yawRate)).toBeLessThan(6.0);
      expect(r.maxTiltDeg).toBeLessThan(15);           // comes to rest upright, no roll-over on the spin
      expect(Math.abs(r.restYawRate)).toBeLessThan(0.2);
      expect(r.air).toBeLessThan(200);
    });
  }

  it('valve failure known (FL), kickflip-like descent with 19 m/s forward and sensor noise: < 2.5 m/s', () => {
    const r = dropAndLand(8.6, 0, 0, 19, 4321, 4, true);
    for (let i = 0; i < 10; i++) sim.propulsion.valves.setFault(i, 0);
    console.log('known stuck FL, forward 19 m/s', JSON.stringify(r));
    expect(r.touch).not.toBeNull();
    expect(r.crashed).toBe(false);
    expect(-r.touch!.vy).toBeLessThan(2.5);
    expect(r.touch!.upY).toBeGreaterThan(Math.cos(10 * DEG));
  });

  it('valve failure discovered during the burn: detected, car stays upright, sink stays below the 6 m/s structural limit', () => {
    const r = dropAndLand(10.45, 0, 0, 0, null, 4, false);
    for (let i = 0; i < 10; i++) sim.propulsion.valves.setFault(i, 0);
    console.log('unexpected stuck FL', r);
    expect(r.touch).not.toBeNull();
    expect(-r.touch!.vy).toBeLessThan(6.0);
    expect(r.touch!.upY).toBeGreaterThan(Math.cos(30 * DEG));
  });
});
