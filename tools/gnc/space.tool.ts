// Free-space ASSIST auto-alignment: time history (lift +1 / coast / lift −1 / hands off).
import { it } from 'vitest';
import { RoadsterSim } from '../../src/sim/core/roadsterSim';
import { ManualAssist } from '../../src/sim/gnc';
import { SPACE } from '../../src/shared/environment';
import { qaxisAngle, qrot, v3 } from '../../src/shared/math';
import { neutralDrive, neutralSystems } from '../../src/shared/types';

it('space align trace', async () => {
  const sim = await RoadsterSim.create();
  sim.setEnvironment(SPACE);
  const zero = { lift: 0, boost: 0, pitch: 0, roll: 0, yaw: 0 };
  let seq: [typeof zero, number][] = [[{ ...zero, lift: 1 }, 1], [zero, 1], [{ ...zero, lift: -1 }, 1], [zero, 14]];
  if (process.env.CASE) {
    // same draws as the 8-case test in tests/sim/gnc/environment.test.ts
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let q = { x: 0, y: 0, z: 0, w: 1 }, vel = v3();
    for (let c = 0; c <= Number(process.env.CASE); c++) {
      const axis = v3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
      q = qaxisAngle(axis, rnd() * Math.PI);
      vel = v3(4 * (rnd() - 0.5), 4 * (rnd() - 0.5), 4 * (rnd() - 0.5));
    }
    sim.reset({ pos: v3(0, 500, 0), quat: q });
    sim.body.setLinvel(vel, true);
    sim.step(neutralDrive(), neutralSystems(), { duty: new Float32Array(10) });
    seq = [[zero, 2], [{ ...zero, lift: -1 }, 0.8], [zero, 25]];
  } else sim.reset({ pos: v3(0, 500, 0), quat: { x: 0, y: 0, z: 0, w: 1 } });
  const ma = new ManualAssist();
  const lines: string[] = [];
  for (const [ax, sec] of seq) for (let k = 0; k < 240 * sec; k++) {
    const out = ma.update(sim, ax, 'ASSIST');
    sim.step(neutralDrive(), neutralSystems(), out);
    const s = sim.getState();
    if (k % Number(process.env.EVERY ?? 24) === 0) {
      const vr = (ma as unknown as { vRef: { x: number; y: number; z: number } }).vRef;
      lines.push(`${s.t.toFixed(2)} v ${s.linVel.x.toFixed(2)},${s.linVel.y.toFixed(2)},${s.linVel.z.toFixed(2)} vRef ${vr.x.toFixed(2)},${vr.y.toFixed(2)},${vr.z.toFixed(2)} up ${qrot(s.quat, v3(0, 1, 0)).y.toFixed(2)} w ${Math.hypot(s.angVel.x, s.angVel.y, s.angVel.z).toFixed(2)} ${ma.status.label} unr ${ma.status.unreachableDvMs.toFixed(2)} duty ${Array.from(out.duty).map((d) => d.toFixed(1)).join(',')}`);
    }
  }
  console.log(lines.join('\n'));
});
