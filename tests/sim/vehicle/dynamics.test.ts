import { beforeAll, describe, expect, it } from 'vitest';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { ROADSTER } from '../../../src/shared/roadster';
import { G0, MPH, clamp } from '../../../src/shared/math';
import { siteFor } from '../../../src/shared/track';
import { steerLimitRad } from '../../../src/sim/vehicle';
import { GEOM } from '../../../src/sim/vehicle/params';
import { mean, prespinFans, resetInputs, rig, type Rig } from './helpers';

/** min over wheels of omega*r/v while braking above 3 m/s (ABS check) of the last brakeTest. */
export let lastMinRoll = 0;

/** Straight-line braking from v0 to standstill; returns distance (m) and time (s). */
export function brakeTest(r: Rig, v0: number): { dist: number; time: number; meanG: number } {
  resetInputs(r);
  r.sim.reset(spawnPose({ x: 0, y: 0, z: -1000 }, 0, v0));
  r.run(0.3, () => { r.drive.throttle = 0; });       // let the spawn transient settle while coasting
  const s0 = { ...r.sim.getState().pos }, v1 = r.sim.getState().speedMs, t0 = r.sim.getState().t;
  r.drive.brake = 1;
  let minRoll = Infinity;
  r.run(10, () => {
    const st = r.sim.getState();
    if (st.speedMs > 3) for (const w of r.vm.chassis.wheels) minRoll = Math.min(minRoll, (w.omega * w.r) / st.speedMs);
    return st.speedMs < 0.02;
  });
  lastMinRoll = minRoll;
  const st = r.sim.getState();
  const dist = Math.hypot(st.pos.x - s0.x, st.pos.z - s0.z), time = st.t - t0;
  // normalise to exactly v0 (coasting lost a little speed): d ∝ v²
  const k = (v0 / v1) ** 2;
  return { dist: dist * k, time, meanG: (v1 * v1) / (2 * dist) / G0 };
}

/** Steady cornering with a fixed steer input at a held speed; returns lateral g (body left). */
export function steadyCorner(r: Rig, v: number, steer: number, fan: number | null): { latG: number; radius: number } {
  resetInputs(r);
  r.sim.reset(spawnPose({ x: 0, y: 0, z: 0 }, 0, v));
  r.systems.fanMode = fan === null ? 'off' : 'grip'; r.systems.fanLevel = fan;
  if (fan !== null) prespinFans(r, fan);
  r.drive.steer = steer;
  const a: number[] = [], rad: number[] = [];
  r.run(6, (t) => {
    const st = r.sim.getState();
    r.drive.throttle = clamp(0.5 * (v - st.speedMs), 0, 1);
    if (t > 4) { a.push(-st.specificForce.x * Math.sign(steer)); rad.push(st.speedMs / Math.abs(st.angVel.y)); }
  });
  return { latG: mean(a) / G0, radius: mean(rad) };
}

/** Closed-loop skidpad (left turn) with a slowly increasing speed; returns the max sustained lateral g. */
export function skidpad(r: Rig, R: number, fans: boolean): { maxLatG: number; atSpeed: number } {
  resetInputs(r);
  const c = { x: -300, z: 300 };
  const v0 = 12;
  r.sim.reset(spawnPose({ x: c.x + R, y: 0, z: c.z }, 180, v0));
  if (fans) { r.systems.fanMode = 'grip'; r.systems.fanLevel = null; prespinFans(r, 0.5); }
  r.systems.aeroMode = 'highDownforce';
  let vt = v0, best = 0, bestV = 0;
  const win: number[] = [];
  let lost = 0;
  r.run(110, () => {
    const st = r.sim.getState(), p = st.pos, v = st.linVel;
    const rx = p.x - c.x, rz = p.z - c.z, d = Math.hypot(rx, rz);
    const tx = rz / d, tz = -rx / d;                    // CCW tangent (left turn)
    const sp = Math.hypot(v.x, v.z);
    const psiErr = Math.asin(clamp((v.z * tx - v.x * tz) / Math.max(sp, 0.1), -1, 1));
    const yawRef = sp / R;
    let delta = Math.atan(GEOM.wheelbase / R) + 0.04 * (d - R) + 0.8 * psiErr + 0.15 * (yawRef - st.angVel.y);
    r.drive.steer = clamp(-delta / steerLimitRad(sp), -1, 1);
    r.drive.throttle = clamp(0.6 * (vt - sp), 0, 1);
    vt += 0.3 * r.sim.dt;
    const aLat = -st.specificForce.x * -1; // left turn: centripetal = body +X
    win.push(st.specificForce.x);
    if (win.length > 240) win.shift();
    if (Math.abs(d - R) < 1.5 && win.length === 240) {
      const g = mean(win) / G0;
      if (g > best) { best = g; bestV = sp; }
    }
    void aLat; void delta;
    if (Math.abs(d - R) > 6) lost++;
    return lost > 240;
  });
  return { maxLatG: best, atSpeed: bestV };
}

describe('longitudinal and lateral performance', () => {
  let r: Rig;
  beforeAll(async () => { r = await rig(); });

  it('full throttle from standstill (no fans, no jets): traction-limited RWD launch', () => {
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0));
    r.run(0.5);
    r.drive.throttle = 1;
    let t60 = -1; const t0 = r.sim.getState().t;
    r.run(6, (t) => { if (t60 < 0 && r.sim.getState().speedMs >= 60 * MPH) t60 = t - t0; });
    console.log('0-60 no fans/jets', t60);
    expect(t60).toBeGreaterThan(2.0);   // ≈ 0.9 g on the rear axle only (no suction)
    expect(t60).toBeLessThan(4.0);
    expect(r.sim.getState().crashed).toBe(false);
  });

  it('brakes 100–0 km/h: ≈ 1.3 g, 28–34 m, ABS keeps the wheels rolling', () => {
    const b = brakeTest(r, 100 / 3.6);
    console.log('100-0', b, 'min omega*r/v while braking', lastMinRoll);
    expect(lastMinRoll).toBeGreaterThan(0.5);   // ABS: wheels keep rolling (slip ≈ peak slip)
    expect(b.dist).toBeGreaterThan(26); expect(b.dist).toBeLessThan(35);
    expect(b.meanG).toBeGreaterThan(1.1);
  });

  it('top speed ≈ 103 m/s (230 mph) in low-drag mode', () => {
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -1350 }, 0, 20));
    r.systems.aeroMode = 'lowDrag';
    r.drive.throttle = 1;
    let vmax = 0, pmax = 0;
    r.run(45, () => { const st = r.sim.getState(); vmax = Math.max(vmax, st.speedMs); pmax = Math.max(pmax, st.motorPowerW); return st.pos.z > 1300; });
    console.log('top speed', vmax, 'peak power', pmax, 'z', r.sim.getState().pos.z);
    expect(vmax).toBeGreaterThan(100); expect(vmax).toBeLessThan(105);
    expect(pmax).toBeLessThanOrEqual(ROADSTER.powertrain.batteryPowerW * 1.001);
    expect(r.sim.getState().crashed).toBe(false);
  });

  it('skidpad R = 40 m: tires only ≈ 1.2–1.4 g, with fan suction 3.4–4.3 g (stream claim: > 2 g)', () => {
    const noFan = skidpad(r, 40, false);
    const fan = skidpad(r, 40, true);
    console.log('skidpad', { noFan, fan });
    expect(noFan.maxLatG).toBeGreaterThan(1.2); expect(noFan.maxLatG).toBeLessThan(1.4);
    // tyre-limited: lat g ≈ μ(N)·(m g + F_fan)/(m g); 4,700 kg suction on ≈ 1.9 t with the load-sensitive μ
    // (μ drops with load) gives ≈ 3.5–4 g – well above the stream's "> 2 g", far below the 1 + 2.5 = 3.5×μ0 naive
    expect(fan.maxLatG).toBeGreaterThan(3.4); expect(fan.maxLatG).toBeLessThan(4.3);
  });

  it('0–60 mph in 0.81 s ± 0.1 s: launch mode + fans (grip) + accelLimitG 3.4 + 4 main jets', () => {
    resetInputs(r);
    const site = siteFor('zero60');
    r.sim.reset(spawnPose(site.spawn.pos, site.spawn.headingDeg));
    r.systems.fanMode = 'grip';
    r.drive.brake = 1; r.drive.launchMode = true; r.drive.accelLimitG = ROADSTER.powertrain.retinaLimitG;
    r.run(3.0);                                             // fans spool + settle under suction
    const st0 = r.sim.getState();
    expect(st0.fans.forceN / G0).toBeGreaterThan(4000);
    const t0 = st0.t, z0 = st0.pos.z;
    r.drive.brake = 0; r.drive.throttle = 1;
    for (let i = 0; i < 4; i++) r.thr.duty[i] = 1;
    let t60 = -1, peakG = 0;
    r.run(2, (t) => {
      const st = r.sim.getState();
      peakG = Math.max(peakG, st.specificForce.z / G0);
      if (st.speedMs >= 60 * MPH) { t60 = t - t0; return true; }
    });
    const st = r.sim.getState();
    console.log('0-60', { t60, peakG, dist: st.pos.z - z0, air: st.tank.airMassKg, power: st.motorPowerW });
    expect(t60).toBeGreaterThan(0.71); expect(t60).toBeLessThan(0.91);
    expect(peakG).toBeLessThan(3.4 * 1.08);
    expect(st.crashed).toBe(false);
  });
});

describe('step-size convergence (120 / 240 / 480 Hz)', () => {
  it('braking distance and steady cornering differ < 2 %', async () => {
    const res: Record<number, { brake: number; lat: number; latFan: number; latSat: number }> = {};
    for (const hz of [120, 240, 480]) {
      const r = await rig({ dt: 1 / hz });
      const b = brakeTest(r, 100 / 3.6);
      const c = steadyCorner(r, 20, -0.12, null);
      const cf = steadyCorner(r, 25, -0.16, 1);
      const cs = steadyCorner(r, 22, -0.6, null);    // saturated: front axle at the friction limit
      res[hz] = { brake: b.dist, lat: c.latG, latFan: cf.latG, latSat: cs.latG };
      r.sim.dispose();
    }
    console.log('convergence', res);
    for (const k of ['brake', 'lat', 'latFan', 'latSat'] as const) {
      const ref = res[480][k];
      expect(Math.abs(res[120][k] - ref) / ref).toBeLessThan(0.02);
      expect(Math.abs(res[240][k] - ref) / ref).toBeLessThan(0.02);
    }
  });
});
