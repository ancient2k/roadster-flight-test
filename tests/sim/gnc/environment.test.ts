// GNC independent of gravity and atmosphere (Phase 2 worlds) + ASSIST air reserve / auto-landing.
import { describe, expect, it } from 'vitest';
import { RoadsterSim } from '../../../src/sim/core/roadsterSim';
import { ManualAssist } from '../../../src/sim/gnc';
import { EARTH, MARS, MOON, SPACE, type Environment } from '../../../src/shared/environment';
import { qaxisAngle, qrot, qrotInv, v3 } from '../../../src/shared/math';
import { neutralDrive, neutralSystems } from '../../../src/shared/types';

const drive = neutralDrive(), sys = neutralSystems();
const zero = { lift: 0, boost: 0, pitch: 0, roll: 0, yaw: 0 };

async function vehicleSim(env: Environment): Promise<RoadsterSim> {
  let sim: RoadsterSim;
  try { sim = await (await import('../../../src/sim/vehicle')).createRoadsterSim(); } catch { sim = await RoadsterSim.create(); }
  sim.setEnvironment(env);
  return sim;
}

describe('ASSIST air reserve (Earth): holding the lift button never ends in a crash', () => {
  it('climb is limited, LOW_AIR warns, AUTOLAND lands softly with air left', async () => {
    const sim = await vehicleSim(EARTH);
    sim.reset({ pos: v3(0, 0, 0), quat: { x: 0, y: 0, z: 0, w: 1 } });
    const ma = new ManualAssist();
    const labels = new Set<string>();
    let maxH = 0, touchSink = NaN, airborne = false, landedT = NaN;
    for (let k = 0; k < 240 * 40 && Number.isNaN(landedT); k++) {
      const s0 = sim.getState();
      sim.step(drive, sys, ma.update(sim, { ...zero, lift: 1 }, 'ASSIST'));
      const s = sim.getState();
      labels.add(ma.status.label);
      maxH = Math.max(maxH, sim.telemetry().altitudeM);
      if (!s.groundContact && s.pos.y > 1) airborne = true;
      if (airborne && s.groundContact) { touchSink = -s0.linVel.y; landedT = s.t; }
    }
    const s = sim.getState();
    console.log({ maxH, touchSink, landedT, air: s.tank.airMassKg, labels: [...labels] });
    expect(labels.has('LOW_AIR')).toBe(true);
    expect(labels.has('AUTOLAND')).toBe(true);
    expect(touchSink).toBeLessThan(2.0);
    expect(s.crashed).toBe(false);
    expect(s.tank.airMassKg).toBeGreaterThan(10);
    sim.dispose();
  });

  it('STABILIZED only warns (no override)', async () => {
    const sim = await vehicleSim(EARTH);
    sim.reset({ pos: v3(0, 30, 0), quat: { x: 0, y: 0, z: 0, w: 1 } }, { airMassKg: 60 });
    const ma = new ManualAssist();
    sim.step(drive, sys, ma.update(sim, { ...zero, lift: 0.4 }, 'STABILIZED'));
    expect(ma.status.lowAir).toBe(true);
    expect(ma.status.autoLand).toBe(false);
    expect(ma.status.label).toBe('LOW_AIR');
    sim.dispose();
  });
});

describe('ASSIST on the Moon and on Mars (gravity + ambient pressure from the environment)', () => {
  for (const env of [MOON, MARS]) {
    it(`${env.body}: hovers on the lift stick, holds height when centred, lands softly`, async () => {
      const sim = await vehicleSim(env);
      sim.reset({ pos: v3(0, 0, 0), quat: { x: 0, y: 0, z: 0, w: 1 } });
      const ma = new ManualAssist();
      const run = (axes: typeof zero, s: number) => { for (let k = 0; k < 240 * s; k++) sim.step(drive, sys, ma.update(sim, axes, 'ASSIST')); };
      run({ ...zero, lift: 0.5 }, 2.5);
      const h0 = sim.getState().pos.y;
      expect(h0).toBeGreaterThan(3);
      run(zero, 4);
      // no downward jets: only gravity stops the climb (climb rate is limited to stop within ≈ 3 m)
      expect(Math.abs(sim.getState().pos.y - h0)).toBeLessThan(4.5);
      expect(Math.abs(sim.getState().linVel.y)).toBeLessThan(0.5);
      let sink = NaN;
      for (let k = 0; k < 240 * 30 && Number.isNaN(sink); k++) {
        const v = sim.getState().linVel.y;
        sim.step(drive, sys, ma.update(sim, { ...zero, lift: -1 }, 'ASSIST'));
        if (sim.getState().groundContact) sink = -v;
      }
      expect(sink).toBeLessThan(1.5);
      expect(sim.getState().crashed).toBe(false);
      sim.dispose();
    });
  }
});

// Free space with these jets is limited by the minimum valve impulse (15 ms of 15 kN): every
// attitude correction is a +Y body push of ≈ 0.13 m/s. The tests check what ASSIST can honestly do.
describe('ASSIST in free space: attitude hold + velocity hold over the jets', () => {
  it('kills a tumble and then holds the attitude it came to rest in', async () => {
    const sim = await RoadsterSim.create();
    sim.setEnvironment(SPACE);
    sim.reset({ pos: v3(0, 500, 0), quat: qaxisAngle(v3(1, 2, 0.5), 0.7) });
    sim.body.setLinvel({ x: 1.5, y: -2, z: 0.8 }, true);
    sim.body.setAngvel({ x: 0.3, y: 0.2, z: -0.4 }, true);
    sim.step(drive, sys, { duty: new Float32Array(10) });   // refresh the state after the velocity jump
    const ma = new ManualAssist();
    for (let k = 0; k < 240 * 3; k++) sim.step(drive, sys, ma.update(sim, zero, 'ASSIST'));
    const q1 = { ...sim.getState().quat };
    let maxRate = 0;
    for (let k = 0; k < 240 * 4; k++) {
      sim.step(drive, sys, ma.update(sim, zero, 'ASSIST'));
      const w = sim.getState().angVel;
      maxRate = Math.max(maxRate, Math.hypot(w.x, w.y, w.z));
    }
    const s = sim.getState();
    expect(ma.status.zeroG).toBe(true);
    expect(maxRate).toBeLessThan(0.45);                          // deadband limit cycle (≈ 2 min. impulses)
    const up = qrotInv(q1, qrot(s.quat, v3(0, 1, 0)));
    const fwd = qrotInv(q1, qrot(s.quat, v3(0, 0, 1)));
    expect(up.y).toBeGreaterThan(Math.cos(10 * Math.PI / 180)); // attitude held within the deadband
    expect(fwd.z).toBeGreaterThan(Math.cos(10 * Math.PI / 180));
    expect(Number.isFinite(s.linVel.x + s.linVel.y + s.linVel.z)).toBe(true);
    sim.dispose();
  });

  it('translates on the lift stick, flags an unreachable request, brakes after the pilot rolls 180°', async () => {
    const sim = await RoadsterSim.create();
    sim.setEnvironment(SPACE);
    sim.reset({ pos: v3(0, 500, 0), quat: { x: 0, y: 0, z: 0, w: 1 } });
    const ma = new ManualAssist();
    const run = (axes: typeof zero, s: number, each?: () => void) => { for (let k = 0; k < 240 * s; k++) { sim.step(drive, sys, ma.update(sim, axes, 'ASSIST')); each?.(); } };
    run({ ...zero, lift: 1 }, 1);
    run(zero, 1);
    expect(sim.getState().linVel.y).toBeGreaterThan(1.5);       // ≈ 2 m/s up
    run({ ...zero, lift: -1 }, 1);                               // back to 0 would need −Y thrust
    expect(ma.status.unreachableDvMs).toBeGreaterThan(1.5);
    expect(ma.status.label).toBe('ROTATE');
    run({ ...zero, roll: 1 }, Math.PI / 3.0);                    // pilot rolls the roof down (3 rad/s)
    let minSpeed = Infinity;
    run(zero, 3, () => { const v = sim.getState().linVel; minSpeed = Math.min(minSpeed, Math.hypot(v.y, v.z)); });
    expect(minSpeed).toBeLessThan(0.3);                          // the up-velocity was braked
    sim.dispose();
  });

  it('an unreachable stick request does not pump the car the wrong way (attitude limit cycle coasts)', async () => {
    const sim = await RoadsterSim.create();
    sim.setEnvironment(SPACE);
    sim.reset({ pos: v3(0, 500, 0), quat: { x: 0, y: 0, z: 0, w: 1 } });
    const ma = new ManualAssist();
    const run = (axes: typeof zero, s: number) => { for (let k = 0; k < 240 * s; k++) sim.step(drive, sys, ma.update(sim, axes, 'ASSIST')); };
    run({ ...zero, lift: 1 }, 1);
    run(zero, 1);
    const vy0 = sim.getState().linVel.y;
    run({ ...zero, lift: -1 }, 3);          // the pilot holds a request the jets cannot fulfil
    const dvy = sim.getState().linVel.y - vy0;
    console.log('unreachable lift −1 for 3 s: Δvy', dvy.toFixed(2), 'm/s (before the fix: +2.50 m/s)');
    expect(ma.status.label).toBe('ROTATE');
    expect(dvy).toBeLessThan(1.8);            // 1.36 m/s (limit cycle remains: hardware resolution)
    sim.dispose();
  });
});
