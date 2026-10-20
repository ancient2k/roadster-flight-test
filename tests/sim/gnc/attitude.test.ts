import { beforeAll, describe, expect, it } from 'vitest';
import { RoadsterSim } from '../../../src/sim/core/roadsterSim';
import { AttitudeController, newAttitudeRef, quatFromUpForward } from '../../../src/sim/gnc/attitude';
import { AngleProfile, RotationTrajectory, relativeAxisAngle } from '../../../src/sim/gnc/trajectory';
import { FlightControl, newFlightCommand } from '../../../src/sim/gnc/flight';
import { Estimator } from '../../../src/sim/gnc/estimator';
import { LEVELS } from '../../../src/sim/gnc/allocator';
import { DEG, qaxisAngle, qmul, qrot, v3, type Quat } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';

let sim: RoadsterSim;
beforeAll(async () => { sim = await RoadsterSim.create(); });

const angleBetween = (a: Quat, b: Quat) => relativeAxisAngle(a, b).angle;

describe('angle profile / continuous winding', () => {
  it('360° profile ends at exactly 2π with rate and accel limits respected', () => {
    const p = new AngleProfile(2 * Math.PI, 6, 12);
    let prev = 0;
    for (let t = 0; t <= p.duration + 0.1; t += 0.001) {
      const s = p.sample(t);
      expect(s.theta).toBeGreaterThanOrEqual(prev - 1e-12); prev = s.theta;
      expect(Math.abs(s.rate)).toBeLessThanOrEqual(6 + 1e-9);
      expect(Math.abs(s.acc)).toBeLessThanOrEqual(12 + 1e-9);
    }
    expect(p.sample(p.duration + 1).theta).toBeCloseTo(2 * Math.PI, 12);
  });

  it('trajectory passes through the inverted attitude although start == end', () => {
    const q0 = qaxisAngle(v3(0, 1, 0), 0.3);
    const tr = new RotationTrajectory(q0, v3(0, 0, 1), new AngleProfile(2 * Math.PI, 6, 12), 0);
    const ref = newAttitudeRef();
    tr.sample(tr.profile.duration / 2, ref);
    expect(qrot(ref.q, v3(0, 1, 0)).y).toBeLessThan(-0.99); // upside down mid-roll
    tr.sample(tr.endTime + 0.01, ref);
    expect(angleBetween(ref.q, q0)).toBeLessThan(1e-9);
    expect(tr.theta(tr.endTime)).toBeCloseTo(2 * Math.PI, 12);
  });
});

/** Ideal rigid body (Euler equations, RK-free small step) to unit-test the control law alone. */
function rigidBodyConverges(q0: Quat): number {
  const J = v3(2700, 3000, 760);
  const c = new AttitudeController();
  const ref = newAttitudeRef();
  let q = { ...q0 }; const w = v3(); // world rate
  const M = v3(); const dt = 1 / 480;
  for (let k = 0; k < 480 * 6; k++) {
    c.compute(q, w, ref, J, M);
    // body rate
    const qi = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    const wb = qrot(qi, w);
    const Jw = v3(J.x * wb.x, J.y * wb.y, J.z * wb.z);
    const gyro = v3(wb.y * Jw.z - wb.z * Jw.y, wb.z * Jw.x - wb.x * Jw.z, wb.x * Jw.y - wb.y * Jw.x);
    wb.x += ((M.x - gyro.x) / J.x) * dt; wb.y += ((M.y - gyro.y) / J.y) * dt; wb.z += ((M.z - gyro.z) / J.z) * dt;
    const ww = qrot(q, wb); w.x = ww.x; w.y = ww.y; w.z = ww.z;
    const ang = Math.hypot(w.x, w.y, w.z) * dt;
    if (ang > 0) q = qmul(qaxisAngle(v3(w.x, w.y, w.z), ang), q);
  }
  return angleBetween(q, ref.q);
}

describe('SO(3) attitude controller', () => {
  it('converges from 180° about every body axis (ideal rigid body)', () => {
    for (const ax of [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1), v3(1, 1, 1)]) {
      expect(rigidBodyConverges(qaxisAngle(ax, Math.PI))).toBeLessThan(0.5 * DEG);
      expect(rigidBodyConverges(qaxisAngle(ax, 179.9 * DEG))).toBeLessThan(0.5 * DEG);
    }
  });

  it('rights the real plant (RoadsterSim + allocator + valves) from inverted in < 2.5 s', () => {
    sim.reset({ pos: v3(0, 180, 0), quat: qaxisAngle(v3(0, 0, 1), Math.PI) });
    const fc = new FlightControl(sim), est = new Estimator(null), cmd = newFlightCommand();
    cmd.levels = LEVELS.rotate;
    quatFromUpForward(v3(0, 1, 0), v3(0, 0, 1), cmd.att.q);
    const thr = zeroThrust(), drive = neutralDrive(), sys = neutralSystems();
    let tUp = -1;
    for (let k = 0; k < 240 * 4; k++) {
      const e = est.update(sim.getState());
      fc.compute(e, cmd, thr.duty);
      sim.step(drive, sys, thr);
      const err = angleBetween(sim.getState().quat, cmd.att.q);
      if (tUp < 0 && err < 3 * DEG) tUp = sim.getState().t;
    }
    expect(tUp).toBeGreaterThan(0); expect(tUp).toBeLessThan(2.5);
    expect(angleBetween(sim.getState().quat, cmd.att.q)).toBeLessThan(2 * DEG);
  });
});
