import { beforeAll, describe, expect, it } from 'vitest';
import { RoadsterSim, spawnPose } from '../../../src/sim/core/roadsterSim';
import { ROADSTER } from '../../../src/shared/roadster';
import { G0 } from '../../../src/shared/math';
import { SIM_DT, neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';

let sim: RoadsterSim;
beforeAll(async () => { sim = await RoadsterSim.create(); });

const drive = neutralDrive(), systems = neutralSystems();

describe('RoadsterSim kernel', () => {
  it('free fall matches g and reports ~0 g specific force', () => {
    sim.reset(spawnPose({ x: 0, y: 50, z: 0 }, 0));
    const y0 = sim.getState().pos.y;
    const T = 1.0, n = Math.round(T / SIM_DT);
    for (let i = 0; i < n; i++) sim.step(drive, systems, zeroThrust());
    const s = sim.getState();
    expect(y0 - s.pos.y).toBeCloseTo(0.5 * G0 * T * T, 1);
    expect(sim.telemetry().gForce).toBeLessThan(0.05);
  });

  it('lift nozzles: momentum balance (∫F dt − ∫mg dt = Δ(m v)) within 1 %', () => {
    sim.reset(spawnPose({ x: 0, y: 30, z: 0 }, 0));
    const cmd = zeroThrust(); cmd.duty.set([0, 0, 0, 0, 1, 1, 1, 1, 0, 0]);
    let impulseY = 0;
    const m0 = sim.getState().massKg, v0 = sim.getState().linVel.y;
    for (let i = 0; i < 120; i++) {
      sim.step(drive, systems, cmd);
      const s = sim.getState();
      let fy = 0; for (let k = 4; k < 8; k++) fy += s.nozzles[k].thrustN * ROADSTER.nozzles[k].dir.y;
      impulseY += (fy - s.massKg * G0) * SIM_DT;
    }
    const s = sim.getState();
    // variable mass: the expelled air leaves with the vehicle velocity (thrust already accounts for exhaust momentum)
    const dp = s.massKg * s.linVel.y - m0 * v0 + (m0 - s.massKg) * (s.linVel.y + v0) / 2;
    expect(Math.abs(dp - impulseY) / Math.abs(impulseY)).toBeLessThan(0.01);
    expect(s.linVel.y).toBeGreaterThan(5); // T/W ≈ 3 -> climbing hard after 0.5 s
    // air in the tank sits behind the seats -> wet CoM is aft of the dry CoG, so equal lift on all
    // four corners pitches the nose UP (negative about +X). The allocator has to trim this.
    expect(sim.comBody.z).toBeLessThan(-0.03);
    expect(s.angVel.x).toBeLessThan(-0.1);
    expect(Math.abs(s.angVel.z)).toBeLessThan(0.02); // left/right symmetric -> no roll
  });

  it('differential lift rolls the car right-side-down as predicted by r × F', () => {
    sim.reset(spawnPose({ x: 0, y: 30, z: 0 }, 0));
    const cmd = zeroThrust(); cmd.duty.set([0, 0, 0, 0, 1, 0, 1, 0, 0, 0]); // left (FL, RL) only
    for (let i = 0; i < 48; i++) sim.step(drive, systems, cmd);
    const s = sim.getState();
    expect(s.angVel.z).toBeGreaterThan(0.5);       // positive about +Z = right side down
    expect(sim.telemetry().rollDeg).toBeGreaterThan(2);
  });

  it('YAW_L turns the nose right (negative yaw rate about +Y)', () => {
    sim.reset(spawnPose({ x: 0, y: 30, z: 0 }, 0));
    const cmd = zeroThrust(); cmd.duty[8] = 1;
    for (let i = 0; i < 48; i++) sim.step(drive, systems, cmd);
    expect(sim.getState().angVel.y).toBeLessThan(-0.05);
  });

  it('is deterministic for identical inputs', async () => {
    const run = async () => {
      const s2 = await RoadsterSim.create();
      s2.reset(spawnPose({ x: 0, y: 10, z: 0 }, 30));
      const cmd = zeroThrust();
      for (let i = 0; i < 600; i++) {
        cmd.duty.set([0.3, 0, 0.3, 0, 0.8, 0.6, 0.7, 0.9, i % 7 === 0 ? 1 : 0, 0.2]);
        s2.step(drive, systems, cmd);
      }
      const st = s2.getState();
      const out = [st.pos.x, st.pos.y, st.pos.z, st.quat.x, st.quat.y, st.quat.z, st.quat.w, st.tank.airMassKg];
      s2.dispose();
      return out;
    };
    const a = await run(), b = await run();
    expect(a).toEqual(b);
  });

  it('hitting the Semi broadside is detected as body contact', () => {
    sim.reset(spawnPose({ x: -45, y: 0.05, z: -29 }, 0, 15)); // just past the kicker lip
    const hit = new Set<string>();
    for (let i = 0; i < 240 * 2; i++) { sim.step(drive, systems, zeroThrust()); for (const c of sim.contacts) hit.add(c.id); }
    expect(hit.has('m3')).toBe(true);
    expect(sim.getState().crashed).toBe(true); // 15 m/s into a parked car
  });
});

describe('RoadsterSim options', () => {
  it('valve timing overrides reach the valve bank', async () => {
    const s = await RoadsterSim.create({ valves: { openDelayS: 0.016 } });
    expect(s.propulsion.valves.cfg.openDelayS).toBe(0.016);
    s.dispose();
  });
  it('resting chassis just above the ground is not reported as contact (speculative contacts ignored)', async () => {
    const s = await RoadsterSim.create();
    s.reset(spawnPose({ x: 0, y: 0.06, z: 0 }, 0)); // floor 0.06 + 0.10 above ground, no wheels -> falls
    let firstContactY = -1;
    for (let i = 0; i < 120; i++) {
      s.step(drive, systems, zeroThrust());
      if (s.getState().bodyContact && firstContactY < 0) firstContactY = s.getState().pos.y;
    }
    // contact only once the hull's lowest point (y = -0.35 body) is within 2 mm of the ground
    expect(firstContactY - 0.35).toBeLessThan(0.01);
    s.dispose();
  });
});
