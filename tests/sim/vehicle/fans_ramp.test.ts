import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';
import { createRoadsterSim, vehicleModules } from '../../../src/sim/vehicle';
import { beforeAll, describe, expect, it } from 'vitest';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { ROADSTER } from '../../../src/shared/roadster';
import { G0, clamp, hudPitchDeg, qaxisAngle } from '../../../src/shared/math';
import { plenumEquilibrium, skirtRect } from '../../../src/sim/vehicle';
import { prespinFans, rampPose, resetInputs, rig, wallRamp, type Rig } from './helpers';

const F = ROADSTER.fans;
const SQ = Math.sqrt(2 / ROADSTER.aero.airDensity);
/** Total suction (N) for a uniform skirt gap h at full rpm (4 quadrant plenums). */
const suctionAtGap = (h: number) => {
  const K = F.dischargeCoeff * (F.skirtPerimeterM / 4) * h * SQ;
  return 4 * plenumEquilibrium(1, K) * (F.floorAreaM2 / 4);
};

describe('fan suction model (equilibrium)', () => {
  it('skirt rectangle reproduces floor area and perimeter', () => {
    const { w, l } = skirtRect();
    expect(w * l).toBeCloseTo(F.floorAreaM2, 6);
    expect(2 * (w + l)).toBeCloseTo(F.skirtPerimeterM, 6);
  });

  it('sealed skirts (min gap): ≈ 4,700 kg ± 10 %, power within eta * P', () => {
    const f = suctionAtGap(F.minGapM);
    const K = F.dischargeCoeff * (F.skirtPerimeterM / 4) * F.minGapM * SQ;
    const dp = plenumEquilibrium(1, K), Q = K * Math.sqrt(dp);
    console.log('sealed', { kg: f / G0, dpPa: dp, Qtotal: 4 * Q, Pshaft: 4 * dp * Q });
    expect(f / G0).toBeGreaterThan(0.9 * F.targetMaxDownforceKg);
    expect(f / G0).toBeLessThan(1.1 * F.targetMaxDownforceKg);
    expect(dp * Q).toBeLessThanOrEqual(F.powerPerFanW * F.efficiency * (1 + 1e-9));
    // fan curve consistency: dp = dp0 (1 - (Q/Qmax)^2)
    const qm = F.maxFlowM3s / F.count;
    expect(dp).toBeLessThanOrEqual(F.shutoffDeltaPPa * (1 - (Q / qm) ** 2) + 1e-6);
  });

  it('suction falls monotonically with the gap and is ≈ 0 for a 0.3 m gap (model consequence)', () => {
    let prev = Infinity;
    const pts: number[] = [];
    for (const h of [0.004, 0.006, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3]) {
      const f = suctionAtGap(h); pts.push(Math.round(f / G0));
      expect(f).toBeLessThan(prev); prev = f;
    }
    console.log('suction kg vs gap', pts);
    expect(suctionAtGap(0.3) / G0).toBeLessThan(0.01 * F.targetMaxDownforceKg);
    expect(suctionAtGap(0.02) / G0).toBeLessThan(0.5 * F.targetMaxDownforceKg);
  });

  it('power limit binds for large leaks: dp*Q never exceeds eta*P', () => {
    for (const K of [0.01, 0.1, 0.5, 1, 3]) {
      const dp = plenumEquilibrium(1, K);
      expect(dp * K * Math.sqrt(dp)).toBeLessThanOrEqual(F.powerPerFanW * F.efficiency * (1 + 1e-9));
    }
  });
});

describe('fan suction in the sim', () => {
  let r: Rig;
  beforeAll(async () => { r = await rig(); });

  it('spool-up: rpm reaches 95 % after spoolTimeS; full suction on flat ground compresses the suspension', () => {
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 0, z: 0 }, 0));
    r.run(1.0);
    r.systems.fanMode = 'grip'; r.systems.fanLevel = 1;
    r.run(F.spoolTimeS);
    expect(r.sim.getState().fans.rpmNorm).toBeGreaterThan(0.94);
    r.run(2.0);
    const st = r.sim.getState();
    const sumN = st.wheels.reduce((s, w) => s + w.normalLoadN, 0);
    console.log('flat full suction', { kg: st.fans.forceN / G0, gap: st.fans.gapM, comp: st.wheels.map((w) => w.compression), powerW: st.fans.powerW });
    expect(st.fans.forceN / G0).toBeGreaterThan(0.9 * F.targetMaxDownforceKg);
    expect(st.fans.gapM).toBeCloseTo(F.minGapM, 6);
    expect(sumN).toBeCloseTo(st.massKg * G0 + st.fans.forceN, -2);  // wheels carry weight + suction
    expect(st.fans.powerW).toBeLessThanOrEqual(F.count * F.powerPerFanW);
    expect(st.bodyContact).toBe(false);
    expect(r.sim.telemetry().downforceKg).toBeCloseTo(st.fans.forceN / G0 + st.aero.downforceN / G0, 3);
  });

  it('demand control (grip, fanLevel null): idles at ≈ 250 kg standing on flat ground', () => {
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 0, z: 0 }, 0));
    r.systems.fanMode = 'grip';
    r.run(4.0);
    const kg = r.sim.getState().fans.forceN / G0;
    console.log('idle demand kg', kg);
    expect(kg).toBeGreaterThan(150); expect(kg).toBeLessThan(400);
  });

  it('fanMode off -> suction decays to ≈ 0; airborne car (no surface in range) -> ≈ 0', () => {
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 0, z: 0 }, 0));
    r.systems.fanMode = 'grip'; r.systems.fanLevel = 1; prespinFans(r);
    r.run(1.0);
    r.systems.fanMode = 'off';
    r.run(2.0);
    expect(r.sim.getState().fans.forceN / G0).toBeLessThan(0.02 * F.targetMaxDownforceKg);
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 3, z: 0 }, 0));
    r.systems.fanMode = 'grip'; r.systems.fanLevel = 1; prespinFans(r);
    r.run(0.2);
    expect(r.sim.getState().fans.forceN / G0).toBeLessThan(5);
  });

  it('unequal gaps give unequal plenum pressures (pressure moment toward the sealed side)', () => {
    resetInputs(r);
    // rolled 4° (right side down) above the ground: right skirts sealed, left skirts ≈ 9 cm open
    r.sim.reset({ pos: { x: 0, y: 0.15, z: 0 }, quat: qaxisAngle({ x: 0, y: 0, z: 1 }, 4 * Math.PI / 180) });
    r.systems.fanMode = 'grip'; r.systems.fanLevel = 1; prespinFans(r);
    r.run(0.03);
    const dp = r.vm.fans.quadDp; // 0 left-front, 1 right-front, 2 left-rear, 3 right-rear
    console.log('quad dp', Array.from(dp));
    expect(dp[1]).toBeGreaterThan(1.5 * dp[0]);
    expect(dp[3]).toBeGreaterThan(1.5 * dp[2]);
  });
});

describe('wall ramp (inverted hang, climb)', () => {
  // fresh sim per scenario (no state carried over between ramp runs)

  it('stands inverted at the top (≈170°) with fans + brake for ≥ 10 s, downforce 4,700 kg ± 10 %', async () => {
    const r = await rig();
    resetInputs(r);
    const { spawn, pitchDeg } = rampPose(wallRamp(), 170);
    r.sim.reset(spawn);
    r.systems.fanMode = 'grip'; prespinFans(r);           // automatic demand control
    r.drive.brake = 1;
    r.run(1.0);
    const p0 = { ...r.sim.getState().pos };
    const df: number[] = [];
    let minContacts = 4, maxV = 0;
    r.run(10, () => {
      const st = r.sim.getState();
      df.push(r.sim.telemetry().downforceKg);
      minContacts = Math.min(minContacts, st.wheels.filter((w) => w.contact).length);
      maxV = Math.max(maxV, st.speedMs);
    });
    const st = r.sim.getState();
    const pitch = hudPitchDeg(st.quat);
    const drift = Math.hypot(st.pos.x - p0.x, st.pos.y - p0.y, st.pos.z - p0.z);
    const dfMean = df.reduce((a, b) => a + b, 0) / df.length;
    console.log('hang', { spawnPitch: pitchDeg, pitch, altitude: st.pos.y, dfMean, drift, maxV, minContacts, loads: st.wheels.map((w) => w.normalLoadN), crashed: st.crashed });
    expect(pitchDeg).toBeGreaterThan(165);
    expect(pitch).toBeGreaterThan(165);
    expect(minContacts).toBe(4);
    expect(drift).toBeLessThan(0.05);
    expect(dfMean).toBeGreaterThan(0.9 * F.targetMaxDownforceKg); expect(dfMean).toBeLessThan(1.1 * F.targetMaxDownforceKg);
    expect(st.pos.y).toBeGreaterThan(19); // HUD ≈ 21 m (69 ft)
    expect(st.crashed).toBe(false);
    expect(st.bodyContact).toBe(false);
  });

  it('crawls up the wall at ≈ 2 m/s on fan traction from flat ground to 170° and holds 10 s', async () => {
    const r = await rig();
    resetInputs(r);
    const ramp = wallRamp();
    r.sim.reset(spawnPose({ x: ramp.origin.x, y: 0, z: ramp.origin.z - 10 }, 0));
    r.systems.fanMode = 'grip'; prespinFans(r, 0.25);
    let integ = 0, reached = -1, maxPitch = 0, df90 = 0;
    const dt = r.sim.dt;
    r.run(45, (t) => {
      const st = r.sim.getState();
      const pitch = hudPitchDeg(st.quat);
      maxPitch = Math.max(maxPitch, pitch);
      if (pitch > 88 && pitch < 92) df90 = Math.max(df90, r.sim.telemetry().downforceKg);
      if (reached < 0 && pitch >= 169.5) reached = t;
      if (reached < 0) {
        const e = 2 - st.speedMs;
        integ = clamp(integ + 0.6 * e * dt, 0, 1);
        r.drive.throttle = clamp(0.5 * e + integ, 0, 1); r.drive.brake = e < -0.5 ? 0.2 : 0;
      } else { r.drive.throttle = 0; r.drive.brake = 1; }
      return st.crashed || (reached > 0 && t > reached + 10);
    });
    const st = r.sim.getState();
    console.log('climb', { reached, maxPitch, df90, pitch: hudPitchDeg(st.quat), y: st.pos.y, crashed: st.crashed, contacts: st.wheels.map((w) => w.contact) });
    expect(reached).toBeGreaterThan(0);
    expect(hudPitchDeg(st.quat)).toBeGreaterThan(165);
    expect(st.wheels.every((w) => w.contact)).toBe(true);
    expect(st.crashed).toBe(false);
    expect(df90).toBeGreaterThan(1950);               // suction at least carries the weight at 90°
  });

  it('simple throttle controller drives up the wall past 90° (no fan level override)', async () => {
    const r = await rig();
    resetInputs(r);
    const ramp = wallRamp();
    r.sim.reset(spawnPose({ x: ramp.origin.x, y: 0, z: ramp.origin.z - 30 }, 0));
    r.systems.fanMode = 'grip'; prespinFans(r, 0.25);
    let maxPitch = 0;
    r.run(12, () => {
      const st = r.sim.getState();
      maxPitch = Math.max(maxPitch, hudPitchDeg(st.quat));
      r.drive.throttle = clamp(0.4 * (12 - st.speedMs), 0, 1);
      return st.crashed || maxPitch > 120;
    });
    console.log('drive-up maxPitch', maxPitch);
    expect(maxPitch).toBeGreaterThan(90);
    expect(r.sim.getState().crashed).toBe(false);
  });
});

describe('skirt gap sampling (tight concave curl vs. overhanging edge)', () => {
  it('on the R 8 curl of the wall (≈ 140°) every skirt sample is sealed (surface above the skirt line = compressed)', async () => {
    const r = await rig();
    resetInputs(r);
    const { spawn } = rampPose(wallRamp(), 140);
    r.sim.reset(spawn);
    r.systems.fanMode = 'grip'; r.systems.fanLevel = 1; prespinFans(r);
    r.drive.brake = 1;
    r.run(1.5);
    const gaps = r.vm.fans.samples.map((x) => x.gap);
    console.log('curl gaps (mm)', gaps.map((g) => Math.round(g * 1000)));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(F.minGapM + 1e-6);
    expect(r.sim.getState().fans.forceN / G0).toBeGreaterThan(0.9 * F.targetMaxDownforceKg);
  });

  it('over a 1 m deep trench across the car: the skirt above it is open, the suction collapses (no false seal from the higher ray start)', async () => {
    // terrain: flat pad with a 1.2 m wide, 1 m deep trench across the car's middle (|z| < 0.6); the wheels
    // (z = +1.40 / -1.25) stand on the pad, the side skirt samples in the middle span the trench
    const n = 513, ext = 256, heights = new Float32Array(n * n), cell = ext / (n - 1);
    for (let rr = 0; rr < n; rr++) for (let c = 0; c < n; c++) heights[rr * n + c] = Math.abs(-ext / 2 + rr * cell) < 0.6 ? -1 : 0;
    const sim = await createRoadsterSim({ ground: 'terrain', terrain: { heights, size: n, extentM: ext } });
    const fans = vehicleModules(sim).fans;
    const drive = neutralDrive(), sys = neutralSystems(), thr = zeroThrust();
    sys.fanMode = 'grip'; sys.fanLevel = 1; fans.rpm = 1; drive.brake = 1;
    sim.reset(spawnPose({ x: 0, y: 0.6, z: 0 }, 0));
    for (let i = 0; i < 240 * 1.5; i++) sim.step(drive, sys, thr);
    const mid = fans.samples.filter((x) => Math.abs(x.pos.z) < 0.3).map((x) => x.gap);
    const ends = fans.samples.filter((x) => Math.abs(x.pos.z) > 1.0).map((x) => x.gap);
    const kg = sim.getState().fans.forceN / G0;
    console.log('trench', { mid: mid.map((g) => Math.round(g * 1000)), ends: ends.map((g) => Math.round(g * 1000)), kg: Math.round(kg) });
    expect(mid.length).toBeGreaterThan(0);
    expect(Math.min(...mid)).toBeGreaterThan(0.1);            // open over the trench
    expect(Math.max(...ends)).toBeLessThanOrEqual(0.01);      // sealed on the pad
    expect(kg).toBeLessThan(0.5 * F.targetMaxDownforceKg);    // the leak kills most of the suction
    sim.dispose();
  });
});
