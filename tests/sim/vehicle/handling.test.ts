// Driving physics setting (src/shared/handling.ts): 'fun' guides a car that glances off a wall along it and lines
// it up with the wall; 'realistic' (the default of RoadsterSim, and always for the auto stunts) is the plain model.
import { describe, expect, it } from 'vitest';
import { createRoadsterSim } from '../../../src/sim/vehicle';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { v3 } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';
import { sweep, type Frame } from '../../../src/shared/parts';
import type { HandlingMode } from '../../../src/shared/handling';

/** A wall along z at x = 0 as the track pieces build theirs (swept in 2 m frames). */
function wall(h: number, w: number): Float32Array {
  const fr: Frame[] = [];
  for (let i = 0; i <= 100; i++) fr.push({ p: [0, 0, -100 + 2 * i], t: [0, 0, 1], n: [0, 1, 0] });
  const t: number[] = [];
  sweep(t, fr, [[0, -1], [w, -1], [w, h], [0, h]]);
  return new Float32Array(t);
}

/** Coast into the wall at v (m/s) and angle (deg); speed and heading (deg, 0 = along the wall) after 2 s. */
async function glance(mode: HandlingMode, h: number, v: number, angDeg: number) {
  const n = 65, heights = new Float32Array(n * n);
  const sim = await createRoadsterSim({ ground: 'terrain', terrain: { heights, size: n, extentM: 640 }, landmarks: [{ id: 'w', kind: 'mesh', data: wall(h, h > 1 ? 1 : 0.4), outward: true }] });
  sim.handling = mode;
  const a = angDeg * Math.PI / 180;
  sim.reset(spawnPose(v3(-14 * Math.sin(a), 0, -14 * Math.cos(a)), angDeg, v));
  for (let k = 0; k < 240 * 2; k++) sim.step(neutralDrive(), neutralSystems(), zeroThrust());
  const vel = sim.body.linvel(), q = sim.body.rotation();
  const heading = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)) * 180 / Math.PI;
  const r = { speed: Math.hypot(vel.x, vel.z), heading, guides: sim.funWallGuides };
  sim.dispose();
  return r;
}

describe('driving physics: fun vs realistic', () => {
  it('a new sim runs the plain model', async () => {
    const sim = await createRoadsterSim();
    expect(sim.handling).toBe('realistic');
    sim.dispose();
  });
  it.each([[2, 20, 30], [0.45, 20, 30], [2, 30, 20]] as [number, number, number][])('wall %d m at %d m/s, %d°: fun keeps more speed and runs on along the wall', async (h, v, ang) => {
    const real = await glance('realistic', h, v, ang), fun = await glance('fun', h, v, ang);
    expect(real.guides).toBe(0);
    expect(fun.guides).toBeGreaterThan(0);
    expect(fun.speed).toBeGreaterThan(real.speed + 2);
    expect(Math.abs(fun.heading)).toBeLessThan(10);
  });
  it('a steep hit at 60° does not spin the car round in fun', async () => {
    const fun = await glance('fun', 2, 20, 60);
    expect(Math.abs(fun.heading)).toBeLessThan(60);
  });
});
