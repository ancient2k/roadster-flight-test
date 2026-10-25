// Drivable pyramids: from the sand over the talus into the 51.84° face (fan suction seals on the stone), up to
// the summit platform; negative control without fans. Synthetic Khufu-like frustum (100 m base, 12 m summit
// platform as Khufu's today, 55.9 m high).
import { describe, expect, it } from 'vitest';
import { createRoadsterSim, vehicleModules } from '../../../src/sim/vehicle';
import { spawnPose, type RoadsterSim } from '../../../src/sim/core/roadsterSim';
import { fitPyramid, pyramidHeightAt, pyramidHullMesh, pyramidHullPoints, pyramidTalus, triangleHeightField, type PyramidFit } from '../../../src/shared/pyramid';
import { hudPitchDeg } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';

const SLOPE = 51.84 * Math.PI / 180;
const A = 50, B = 6, Y0 = -2, H = (A - B) * Math.tan(SLOPE);

function synthetic(): PyramidFit {
  const pts: number[] = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push(sx * A, Y0, sz * A, sx * B, Y0 + H, sz * B);
  return fitPyramid(new Float32Array(pts), 0, 0, Math.PI); // heading 180° as at Giza
}

async function world(): Promise<{ sim: RoadsterSim; fit: PyramidFit }> {
  const fit = synthetic();
  const n = 129, heights = new Float32Array(n * n); // flat sand at y = 0, 512 m
  const sim = await createRoadsterSim({
    ground: 'terrain', terrain: { heights, size: n, extentM: 512 },
    landmarks: [
      { id: 'pyr', kind: 'mesh', data: pyramidHullMesh(fit), outward: true }, // as in the game
      { id: 'pyr_talus', kind: 'mesh', data: pyramidTalus(fit, () => 0) },
    ],
  });
  sim.surface = 'sand'; // the stone (kind 'landmark' → concrete) must be what seals the skirt, not the site
  return { sim, fit };
}

/** Drive straight at the -z face from the sand (heading 0 = +z); cruise-control to vSet, fans in grip at fanLevel. */
function climb(sim: RoadsterSim, seconds: number, fans: boolean, vSet = 7, stopAtZ = Infinity) {
  const drive = neutralDrive(), sys = neutralSystems(), thr = zeroThrust();
  if (fans) { sys.fanMode = 'grip'; sys.fanLevel = 1; vehicleModules(sim).fans.rpm = 1; }
  sim.reset(spawnPose({ x: 0, y: 0.6, z: -A - 25 }, 0));
  let maxY = -Infinity, crashed = false, minPitch = 0;
  const log: string[] = [];
  for (let i = 0; i < Math.round(seconds / sim.dt); i++) {
    const s = sim.getState();
    const err = (s.pos.z > stopAtZ ? 0 : vSet) - s.speedMs;
    drive.throttle = Math.max(0, Math.min(1, 0.35 + err * 0.4));
    drive.brake = s.pos.z > stopAtZ ? 1 : err < -1.5 ? Math.min(1, -err * 0.3) : 0;
    if (s.pos.z > stopAtZ) drive.throttle = 0;
    if (fans) sys.fanLevel = 1;
    sim.step(drive, sys, thr);
    maxY = Math.max(maxY, s.pos.y);
    minPitch = Math.min(minPitch, -hudPitchDeg(s.quat));
    crashed ||= s.crashed;
    if (i % 240 === 0) log.push(`t=${s.t.toFixed(0)} z=${s.pos.z.toFixed(1)} y=${s.pos.y.toFixed(1)} v=${s.speedMs.toFixed(1)} pitch=${hudPitchDeg(s.quat).toFixed(0)} wheels=${s.wheels.filter((w) => w.contact).length} fan=${(s.fans.forceN / 9.81).toFixed(0)}kg body=${s.bodyContact}`);
  }
  return { maxY, crashed, log, state: sim.getState() };
}

describe('drivable pyramids', () => {
  it('fit ignores a thin survey mast on the summit platform (Khufu)', () => {
    const pts: number[] = [];
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push(sx * A, Y0, sz * A, sx * B, Y0 + H, sz * B);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push(sx * 0.15, Y0 + H, sz * 0.15, sx * 0.1, Y0 + H + 9, sz * 0.1);
    const f = fitPyramid(new Float32Array(pts), 0, 0, Math.PI);
    expect(f.yTop).toBeCloseTo(Y0 + H, 3);
    expect(f.bx).toBeCloseTo(B, 3);
    expect(f.slope * 180 / Math.PI).toBeCloseTo(51.84, 1);
  });

  it('fit and hull: frustum recovered, crest rounded, analytic height matches', () => {
    const f = synthetic();
    expect(f.slope * 180 / Math.PI).toBeCloseTo(51.84, 1);
    expect(f.yTop).toBeCloseTo(Y0 + H, 3);
    expect(pyramidHeightAt(f, 0, -A + 10)).toBeCloseTo(Y0 + 10 * Math.tan(SLOPE), 1);
    expect(pyramidHeightAt(f, 0, -A - 1)).toBe(-Infinity);
    const hp = pyramidHullPoints(f);
    let top = -Infinity; for (let i = 1; i < hp.length; i += 3) top = Math.max(top, hp[i]);
    expect(top).toBeCloseTo(f.yTop, 3);
  });

  it('ground height includes the talus: no step from the sand over the fillet onto the face (car sits on it)', () => {
    const f = synthetic();
    const talus = triangleHeightField(pyramidTalus(f, () => 0));
    const ground = (x: number, z: number) => Math.max(0, talus(x, z), pyramidHeightAt(f, x, z));
    expect(talus(A + 40, 0)).toBe(-Infinity);
    // walking in from the sand towards the face: rising, without a step anywhere, and above the bare ground on the fillet
    let prev = ground(A + 25, 3), maxStep = 0, onFillet = 0;
    for (let x = A + 25; x >= A - 15; x -= 0.25) {
      const h = ground(x, 3);
      expect(h).toBeGreaterThanOrEqual(prev - 1e-6);
      maxStep = Math.max(maxStep, h - prev);
      if (talus(x, 3) > 0.5) onFillet++;
      prev = h;
    }
    expect(maxStep).toBeLessThan(0.25 * Math.tan(SLOPE) + 0.05);
    expect(onFillet).toBeGreaterThan(4);
  });

  it('collision mesh: closed and wound outward (positive volume ≈ frustum volume)', () => {
    const f = synthetic();
    const t = pyramidHullMesh(f);
    let vol = 0;
    for (let i = 0; i < t.length; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.subarray(i, i + 9);
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    const a2 = (2 * A) ** 2, b2 = (2 * B) ** 2;
    const frustum = H / 3 * (a2 + b2 + Math.sqrt(a2 * b2));
    expect(vol).toBeGreaterThan(0.97 * frustum);   // the rounded crest removes a little
    expect(vol).toBeLessThan(frustum * 1.0001);
  });

  it('with fans in grip: drives from the sand over the talus up the 52° face and parks on the summit platform', async () => {
    const { sim, fit } = await world();
    const r = climb(sim, 30, true, 7, -1.5);
    console.log(r.log.join('\n'));
    const s = r.state;
    expect(r.crashed).toBe(false);
    expect(Math.abs(s.pos.z)).toBeLessThan(fit.bz);      // on the platform, not over the far edge
    expect(s.pos.y).toBeGreaterThan(fit.yTop);            // CoG above the summit
    expect(s.speedMs).toBeLessThan(0.3);
    expect(s.wheels.filter((w) => w.contact).length).toBe(4);
    expect(Math.abs(hudPitchDeg(s.quat))).toBeLessThan(8);   // level on the platform, not hanging on the crest
    sim.dispose();
  }, 60_000);

  it('and over the top: down the far face under suction, back onto the sand', async () => {
    const { sim } = await world();
    const r = climb(sim, 40, true, 7);
    console.log(r.log.join('\n'));
    expect(r.crashed).toBe(false);
    expect(r.state.pos.z).toBeGreaterThan(A + 10);
    expect(r.state.pos.y).toBeLessThan(1);
    sim.dispose();
  }, 60_000);

  it('holds on the face with the brakes while the fans seal', async () => {
    const { sim } = await world();
    const drive = neutralDrive(), sys = neutralSystems(), thr = zeroThrust();
    sys.fanMode = 'grip'; sys.fanLevel = 1; vehicleModules(sim).fans.rpm = 1;
    sim.reset(spawnPose({ x: 0, y: 0.6, z: -A - 25 }, 0));
    let onFace = false;
    for (let i = 0; i < 240 * 40 && !onFace; i++) {
      const s = sim.getState();
      drive.throttle = Math.max(0, Math.min(1, 0.35 + (7 - s.speedMs) * 0.4));
      sim.step(drive, sys, thr);
      onFace = s.pos.y > 20;
    }
    expect(onFace).toBe(true);
    drive.throttle = 0; drive.brake = 1;
    for (let i = 0; i < 240 * 4; i++) sim.step(drive, sys, thr);
    const s = sim.getState();
    console.log('hold', { y: s.pos.y, v: s.speedMs, wheels: s.wheels.filter((w) => w.contact).length, fanKg: s.fans.forceN / 9.81 });
    expect(s.speedMs).toBeLessThan(0.3);
    expect(s.wheels.filter((w) => w.contact).length).toBeGreaterThanOrEqual(3);
    expect(s.crashed).toBe(false);
    sim.dispose();
  }, 60_000);

  it('demand control (manual fan "grip"): easing off the throttle on the face keeps full suction', async () => {
    const { sim } = await world();
    const drive = neutralDrive(), sys = neutralSystems(), thr = zeroThrust();
    sys.fanMode = 'grip'; sys.fanLevel = null; // automatic demand, as in the manual mode
    sim.reset(spawnPose({ x: 0, y: 0.6, z: -A - 25 }, 0));
    let onFace = false;
    for (let i = 0; i < 240 * 40 && !onFace; i++) {
      const s = sim.getState();
      drive.throttle = s.speedMs < 7 ? 1 : 0;
      sim.step(drive, sys, thr);
      onFace = s.pos.y > 25;
    }
    expect(onFace).toBe(true);
    drive.throttle = 0;
    let minFan = Infinity, crashed = false;
    for (let i = 0; i < 240 * 3; i++) { sim.step(drive, sys, thr); const s = sim.getState(); minFan = Math.min(minFan, s.fans.forceN / 9.81); crashed ||= s.crashed; }
    const s = sim.getState();
    expect(crashed).toBe(false);
    expect(s.wheels.filter((w) => w.contact).length).toBe(4);
    expect(minFan).toBeGreaterThan(3000);
    sim.dispose();
  }, 60_000);

  it('negative control: without the fans the car cannot climb the 52° face', async () => {
    const { sim, fit } = await world();
    const r = climb(sim, 25, false);
    console.log(r.log.join('\n'));
    expect(r.maxY).toBeLessThan(fit.y0 + 0.5 * (fit.yTop - fit.y0));
    sim.dispose();
  }, 60_000);
});
