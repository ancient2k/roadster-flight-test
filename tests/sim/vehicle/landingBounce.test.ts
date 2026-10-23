// Hard landings must not throw the car back into the air (R17 user finding: "when you hit the ground you are bounced
// up like a rubber ball and flung into the air without control"). Drops from 2–20 m, flat and tilted, on Earth.
import { describe, expect, it } from 'vitest';
import { createRoadsterSim } from '../../../src/sim/vehicle';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { v3 } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';
import { ManualAssist } from '../../../src/sim/gnc';
import { qaxisAngle } from '../../../src/shared/math';

interface Drop { h: number; rollDeg: number; pitchDeg: number; vx: number }
/** Drop the car and report the impact speed, the highest rebound speed and height of the CoG after the first impact. */
async function drop(d: Drop) {
  const n = 65, heights = new Float32Array(n * n);
  const sim = await createRoadsterSim({ ground: 'terrain', terrain: { heights, size: n, extentM: 640 } });
  sim.reset(spawnPose(v3(0, d.h, 0), 0, 0));
  const r = d.rollDeg * Math.PI / 180 / 2, p = d.pitchDeg * Math.PI / 180 / 2;
  // q = q_pitch(x) * q_roll(z)
  sim.body.setRotation({ x: Math.sin(p) * Math.cos(r), y: -Math.sin(p) * Math.sin(r), z: Math.cos(p) * Math.sin(r), w: Math.cos(p) * Math.cos(r) }, true);
  sim.body.setLinvel({ x: d.vx, y: 0, z: 0 }, true);
  let vImpact = 0, hit = false, vUp = 0, yMax = -Infinity, yRest = 0;
  for (let k = 0; k < 240 * 4; k++) {
    const vy = sim.body.linvel().y, y = sim.body.translation().y;
    sim.step(neutralDrive(), neutralSystems(), zeroThrust());
    const vy2 = sim.body.linvel().y;
    if (!hit && vy2 - vy > 0.5) { hit = true; vImpact = -vy; }
    if (hit) { vUp = Math.max(vUp, vy2); yMax = Math.max(yMax, sim.body.translation().y); }
    yRest = y;
  }
  sim.dispose();
  return { vImpact, vUp, rebound: yMax - yRest, yRest };
}

describe('hard landings', () => {
  const cases: Drop[] = [
    { h: 2, rollDeg: 0, pitchDeg: 0, vx: 0 }, { h: 5, rollDeg: 0, pitchDeg: 0, vx: 0 },
    { h: 10, rollDeg: 0, pitchDeg: 0, vx: 0 }, { h: 20, rollDeg: 0, pitchDeg: 0, vx: 0 },
    { h: 10, rollDeg: 30, pitchDeg: 0, vx: 0 }, { h: 10, rollDeg: 60, pitchDeg: 0, vx: 0 },
    { h: 10, rollDeg: 0, pitchDeg: 25, vx: 15 }, { h: 20, rollDeg: 45, pitchDeg: -20, vx: 20 },
  ];
  // before the fix: 10 m flat −13.5 → +11.2 m/s and 5.2 m back up; 10 m at 60° roll +43.9 m/s
  it.each(cases)('drop from $h m, roll $rollDeg°, pitch $pitchDeg°, $vx m/s: no rubber-ball rebound', async (d) => {
    const r = await drop(d);
    expect(r.vImpact).toBeGreaterThan(5);
    // flat: a real rebound coefficient; tilted: the car rolls or pitches over on impact, which lifts the CoG a little
    const flat = d.rollDeg === 0 && d.pitchDeg === 0;
    expect(r.vUp).toBeLessThan((flat ? 0.4 : 0.5) * r.vImpact);
    expect(r.rebound).toBeLessThan(flat ? 1 : 2);                 // CoG rise after the impact (m)
  });

  // off a ramp: 10 m down at 20 m/s. The rear hits first, the nose slams down and the second double stop threw
  // the car 3.7 m up for 1.8 s; STABILIZED then fired the jets against the tumble (the R17 finding exactly).
  it.each(['ASSIST', 'STABILIZED'] as const)('jump landing at 20 m/s in %s: stays down, no jets after touchdown', async (mode) => {
    const car = await createRoadsterSim();
    const m = new ManualAssist(), d = neutralDrive(), s = neutralSystems(), zero = { lift: 0, boost: 0, pitch: 0, roll: 0, yaw: 0 };
    car.reset({ pos: v3(0, 0.6, 0), quat: qaxisAngle(v3(0, 1, 0), 0) });
    for (let k = 0; k < 240; k++) car.step(d, s, zeroThrust());
    for (let k = 0; k < 24; k++) car.step(d, s, m.update(car, zero, mode));      // the assist saw the ground
    car.reset({ pos: v3(0, 10, 0), quat: qaxisAngle(v3(0, 1, 0), 0) });
    car.body.setLinvel({ x: 0, y: 0, z: 20 }, true);
    let yTouch = NaN, rise = 0, air = 0, duty = 0;
    for (let k = 0; k < 240 * 5; k++) {
      const c = m.update(car, zero, mode);
      car.step(d, s, c);
      const st = car.getState();
      if (Number.isNaN(yTouch)) { if (st.groundContact || st.bodyContact) yTouch = st.pos.y; continue; }
      rise = Math.max(rise, st.pos.y - yTouch);
      if (!st.groundContact && !st.bodyContact) air += 1 / 240;
      duty += c.duty.reduce((a, b) => a + b, 0) / 240;
    }
    car.dispose();
    expect(rise).toBeLessThan(1);
    expect(air).toBeLessThan(0.5);
    expect(duty).toBe(0);
  });
});
