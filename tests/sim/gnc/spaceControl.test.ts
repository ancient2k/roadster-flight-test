// R14 manual control: RAW fires only what is pressed, STABILIZED/ASSIST bring the body rate to rest in
// zero g without a growing limit cycle, yaw in free space does not push the car along its roof.
import { describe, expect, it } from 'vitest';
import { RoadsterSim } from '../../../src/sim/core/roadsterSim';
import { ManualAssist } from '../../../src/sim/gnc';
import { EARTH, MOON, SPACE, type Environment } from '../../../src/shared/environment';
import { qaxisAngle, qrot, qrotInv, v3, type Quat } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, type AssistLevel } from '../../../src/shared/types';

const drive = neutralDrive(), sys = neutralSystems();
const zero = { lift: 0, boost: 0, pitch: 0, roll: 0, yaw: 0 };
type Axes = typeof zero;

async function spaceSim(env: Environment = SPACE, q: Quat = { x: 0, y: 0, z: 0, w: 1 }): Promise<RoadsterSim> {
  const sim = await RoadsterSim.create();
  sim.setEnvironment(env);
  sim.reset({ pos: v3(0, 500, 0), quat: q });
  return sim;
}
const bodyRate = (sim: RoadsterSim) => { const s = sim.getState(); return qrotInv(s.quat, s.angVel); };
const run = (sim: RoadsterSim, ma: ManualAssist, axes: Axes, level: AssistLevel, s: number, each?: (k: number) => void) => {
  for (let k = 0; k < Math.round(240 * s); k++) { sim.step(drive, sys, ma.update(sim, axes, level)); each?.(k); }
};
const anyOpen = (sim: RoadsterSim) => sim.propulsion.dutyActual.some((d) => d > 0);

describe('RAW: only the pressed nozzle groups', () => {
  it('no input -> no jet, in every environment, also after a tumble and after lift was released', async () => {
    for (const env of [EARTH, MOON, SPACE]) {
      const sim = await spaceSim(env, qaxisAngle(v3(1, 0.3, 0.2), 0.8));
      sim.body.setAngvel({ x: 0.8, y: -0.4, z: 1.2 }, true);
      const ma = new ManualAssist();
      run(sim, ma, { ...zero, lift: 1 }, 'RAW', 0.5);
      let maxCmd = 0, open = 0;
      // the valves need their min. on-time + closing delay to shut after the release
      run(sim, ma, zero, 'RAW', 2, (k) => {
        maxCmd = Math.max(maxCmd, ...ma.update(sim, zero, 'RAW').duty);
        if (k > 12 && anyOpen(sim)) open++;
      });
      expect(maxCmd).toBe(0);
      expect(open).toBe(0);
      sim.dispose();
    }
  });

  it('lift alone does not pitch the car over (static front/rear trim, the wet CoM is aft)', async () => {
    const sim = await spaceSim(SPACE);
    const ma = new ManualAssist();
    run(sim, ma, { ...zero, lift: 1 }, 'RAW', 1);
    const w = bodyRate(sim);
    expect(Math.abs(w.x)).toBeLessThan(0.3);   // before R14: ≈ 1.8 rad/s nose up after 1 s, then a somersault
    expect(Math.abs(w.z)).toBeLessThan(0.3);
    expect(sim.getState().linVel.y).toBeGreaterThan(15);
    sim.dispose();
  });
});

describe('zero g: a disturbance is damped to rest, then the jets go quiet (no limit-cycle growth)', () => {
  // random tumbles (seeded), hands-off
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const cases = Array.from({ length: 4 }, (_, c) => {
    const axis = v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5), ang = rnd() * 3;
    const w = v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5), n = Math.hypot(w.x, w.y, w.z), W = c < 2 ? 0.6 : 1.5;
    return { q: qaxisAngle(axis, ang), w: v3(w.x / n * W, w.y / n * W, w.z / n * W) };
  });

  it('STABILIZED: rate into the band within 2 s, afterwards no firing for ≥ 5 s', async () => {
    for (const c of cases) {
      const sim = await spaceSim(SPACE, c.q);
      sim.body.setAngvel(c.w, true);
      sim.step(drive, sys, { duty: new Float32Array(10) });
      const ma = new ManualAssist();
      run(sim, ma, zero, 'STABILIZED', 2);
      const w = bodyRate(sim);
      expect(Math.abs(w.x)).toBeLessThan(0.2);
      expect(Math.abs(w.y)).toBeLessThan(0.1);
      expect(Math.abs(w.z)).toBeLessThan(0.25);
      let opens = 0, maxW = 0;
      run(sim, ma, zero, 'STABILIZED', 6, (k) => {
        if (k > 240 && anyOpen(sim)) opens++;   // the last pulse may still be closing during the 1st second
        const b = bodyRate(sim); maxW = Math.max(maxW, Math.hypot(b.x, b.y, b.z));
      });
      expect(opens).toBe(0);
      expect(maxW).toBeLessThan(0.3);
      sim.dispose();
    }
  });

  it('ASSIST: tumble killed, attitude held; the min-impulse limit cycle stays small and does not grow', async () => {
    for (const c of cases) {
      const sim = await spaceSim(SPACE, c.q);
      sim.body.setAngvel(c.w, true);
      sim.step(drive, sys, { duty: new Float32Array(10) });
      const ma = new ManualAssist();
      run(sim, ma, zero, 'ASSIST', 5);
      // the held attitude (the one the tumble came to rest in)
      const q0 = (ma as unknown as { heldQ: Quat | null }).heldQ!;
      expect(q0).toBeTruthy();
      const v0 = { ...sim.getState().linVel }, air0 = sim.propulsion.tank.m;
      let maxAtt = 0, maxWa = 0, maxWb = 0;
      run(sim, ma, zero, 'ASSIST', 15, (k) => {
        const s = sim.getState();
        const d = Math.abs(q0.x * s.quat.x + q0.y * s.quat.y + q0.z * s.quat.z + q0.w * s.quat.w);
        maxAtt = Math.max(maxAtt, 2 * Math.acos(Math.min(1, d)));
        const b = bodyRate(sim), wn = Math.hypot(b.x, b.y, b.z);
        if (k < 240 * 10) maxWa = Math.max(maxWa, wn); else maxWb = Math.max(maxWb, wn);
      });
      const s = sim.getState();
      const dv = Math.hypot(s.linVel.x - v0.x, s.linVel.y - v0.y, s.linVel.z - v0.z);
      // before R14 (5° / 0.15 rad/s deadband, X velocity chased): 11–24 m/s and 40–96 kg per 15 s
      expect(dv).toBeLessThan(3);
      expect(air0 - sim.propulsion.tank.m).toBeLessThan(10);
      expect(maxAtt).toBeLessThan(12 * Math.PI / 180);
      expect(maxWb).toBeLessThan(0.45);
      expect(maxWb).toBeLessThanOrEqual(1.3 * maxWa + 0.05);   // no growth (amplitude set by the pulse size)
      sim.dispose();
    }
  });

  it('ASSIST and STABILIZED: a yaw input uses the yaw jets, not the corner cant (no push along the roof)', async () => {
    for (const level of ['ASSIST', 'STABILIZED'] as const) {
      const sim = await spaceSim(SPACE);
      const ma = new ManualAssist();
      run(sim, ma, zero, level, 0.5);
      run(sim, ma, { ...zero, yaw: -1 }, level, 0.5);
      run(sim, ma, zero, level, 3);
      const s = sim.getState();
      const up = qrot(s.quat, v3(0, 1, 0));
      const vUp = s.linVel.x * up.x + s.linVel.y * up.y + s.linVel.z * up.z;
      expect(Math.abs(vUp)).toBeLessThan(0.6);   // before R14: ≈ 4.6 m/s from a 0.5 s yaw tap (ASSIST)
      expect(Math.abs(bodyRate(sim).y)).toBeLessThan(0.1);
      sim.dispose();
    }
  });
});

describe('STABILIZED with gravity: centred sticks hold rate 0 in the air', () => {
  it('a pitch rate left over from the last input is damped instead of flipping the car', async () => {
    const sim = await spaceSim(EARTH);
    sim.body.setAngvel({ x: -0.9, y: 0, z: 0 }, true);
    sim.step(drive, sys, { duty: new Float32Array(10) });
    const ma = new ManualAssist();
    run(sim, ma, zero, 'STABILIZED', 1.5);
    const w = bodyRate(sim);
    expect(Math.abs(w.x)).toBeLessThan(0.2);   // before R14: −0.9 rad/s kept until the next key press
    expect(qrot(sim.getState().quat, v3(0, 1, 0)).y).toBeGreaterThan(0.7);
    sim.dispose();
  });
});
