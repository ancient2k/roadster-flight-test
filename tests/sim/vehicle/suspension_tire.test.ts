import { beforeAll, describe, expect, it } from 'vitest';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { ROADSTER } from '../../../src/shared/roadster';
import { DEG, G0, hudPitchDeg, qaxisAngle, qrot } from '../../../src/shared/math';
import {
  C_LAT, C_LONG, LAT, LONG, SX_PEAK, SY_PEAK, combinedForce, mf, muLoad, peakForce, relax,
} from '../../../src/sim/vehicle/tire';
import { bumpStopForce, damperForce, steerLimitRad } from '../../../src/sim/vehicle';
import { rig, resetInputs, type Rig } from './helpers';

const S = ROADSTER.suspension, T = ROADSTER.tire;

describe('tire model (pure)', () => {
  it('Magic Formula peaks at D for C > 1 and the peak slips are plausible', () => {
    expect(mf(SX_PEAK, LONG)).toBeCloseTo(1, 6);
    expect(mf(SY_PEAK, LAT)).toBeCloseTo(1, 6);
    expect(SX_PEAK).toBeGreaterThan(0.06); expect(SX_PEAK).toBeLessThan(0.16);
    expect(SY_PEAK / DEG).toBeGreaterThan(6); expect(SY_PEAK / DEG).toBeLessThan(14);
    // slope at the origin = B*C
    expect(mf(1e-6, LAT) / 1e-6).toBeCloseTo(C_LAT, 3);
    expect(mf(1e-6, LONG) / 1e-6).toBeCloseTo(C_LONG, 3);
  });

  it('load sensitivity mu = mu0 (Fz/Fz0)^-n and structural load cap', () => {
    expect(muLoad(T.fz0N)).toBeCloseTo(T.mu0, 9);
    expect(muLoad(2 * T.fz0N) / muLoad(T.fz0N)).toBeCloseTo(Math.pow(2, -T.loadExponent), 9);
    // mu ≈ 1.02–1.15 at ≈ 16 kN per wheel (full suction)
    expect(muLoad(16_300)).toBeGreaterThan(1.0); expect(muLoad(16_300)).toBeLessThan(1.16);
    expect(peakForce(2 * T.maxLoadN)).toBeCloseTo(peakForce(T.maxLoadN), 6);
  });

  it('combined slip stays inside the friction circle and reduces to pure slip', () => {
    const o = { fx: 0, fy: 0 }, D = 5000;
    combinedForce(0.05, 0, D, o); expect(o.fy).toBe(0); expect(o.fx).toBeCloseTo(D * mf(0.05, LONG), 6);
    combinedForce(0, 0.1, D, o); expect(o.fx).toBe(0); expect(o.fy).toBeCloseTo(D * mf(0.1, LAT), 6);
    let maxF = 0;
    for (let a = 0; a < 2 * Math.PI; a += 0.05) for (const k of [0.3, 1, 2, 6]) {
      combinedForce(k * SX_PEAK * Math.cos(a), k * SY_PEAK * Math.sin(a), D, o);
      maxF = Math.max(maxF, Math.hypot(o.fx, o.fy));
    }
    expect(maxF).toBeLessThanOrEqual(D * (1 + 1e-9));
    expect(maxF).toBeGreaterThan(0.99 * D);
    // longitudinal slip reduces lateral force (combined)
    const pure = combinedForce(0, SY_PEAK * 0.5, D, o).fy;
    const comb = combinedForce(SX_PEAK, SY_PEAK * 0.5, D, o).fy;
    expect(comb).toBeLessThan(pure);
  });

  it('relaxation integrator is exact (composition of substeps = one step) and handles |vx| = 0', () => {
    const sigma = 0.35;
    const one = relax(0.02, 1.5, 20, sigma, 0.01);
    let s = 0.02; for (let i = 0; i < 100; i++) s = relax(s, 1.5, 20, sigma, 0.0001);
    expect(s).toBeCloseTo(one, 12);
    expect(relax(0.02, 1.5, 20, sigma, 1e6)).toBeCloseTo(1.5 / 20, 12); // steady state V/|vx|
    expect(relax(0.0, 0.7, 0, sigma, 0.01)).toBeCloseTo(0.7 * 0.01 / sigma, 12); // spring limit
  });

  it('suspension elements: digressive damper, progressive bump stop', () => {
    expect(damperForce(0.1)).toBeCloseTo(S.damperNsPerM * 0.1, 9);
    expect(damperForce(-0.1)).toBeCloseTo(-S.damperNsPerM * 0.1, 9);
    expect(damperForce(4) / 4).toBeLessThan(0.5 * S.damperNsPerM);
    expect(bumpStopForce(0.05)).toBe(0);
    const a = bumpStopForce(S.travelM - 0.01), b = bumpStopForce(S.travelM);
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(2.2 * a); // progressive (linear would be 1.67x)
    expect(steerLimitRad(0) / DEG).toBeCloseTo(ROADSTER.steering.maxAngleDeg, 9);
    expect(steerLimitRad(ROADSTER.steering.highSpeedMs) / DEG).toBeCloseTo(ROADSTER.steering.highSpeedAngleDeg, 9);
  });
});

describe('suspension + tires on the ground', () => {
  let r: Rig;
  beforeAll(async () => { r = await rig(); });

  it('static ride height and compression match the design (CoG ≈ 0.45 m, floor ≈ 0.10 m)', () => {
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 0, z: 0 }, 0));
    r.run(2.0);
    const st = r.sim.getState();
    const m = st.massKg;
    const sumN = st.wheels.reduce((s, w) => s + w.normalLoadN, 0);
    console.log('static', { cogY: st.pos.y, comp: st.wheels.map((w) => w.compression), loads: st.wheels.map((w) => w.normalLoadN), mass: m });
    expect(sumN / (m * G0)).toBeCloseTo(1, 3);                         // vertical equilibrium
    expect(st.pos.y).toBeGreaterThan(0.44); expect(st.pos.y).toBeLessThan(0.455);
    for (const w of st.wheels) {
      expect(w.contact).toBe(true);
      expect(w.compression).toBeGreaterThan(0.015); expect(w.compression).toBeLessThan(0.03);
    }
    // wet CoM aft of the dry CoG -> rear axle carries more
    expect(st.wheels[2].normalLoadN).toBeGreaterThan(st.wheels[0].normalLoadN);
    expect(st.wheels[0].normalLoadN).toBeCloseTo(st.wheels[1].normalLoadN, 0);
    expect(st.bodyContact).toBe(false);
    expect(st.groundContact).toBe(true);
  });

  it('standing still on flat ground: no creep, no jitter over 10 s', () => {
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 5, y: 0, z: 5 }, 37));
    r.run(2.5); // spawn transient (drop from the nominal spawn height) decays
    const p0 = { ...r.sim.getState().pos };
    let vmax = 0;
    r.run(10, () => { vmax = Math.max(vmax, r.sim.getState().speedMs); });
    const p1 = r.sim.getState().pos;
    const drift = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    console.log('flat creep', { drift, vmax });
    expect(drift).toBeLessThan(1e-4);
    expect(vmax).toBeLessThan(1e-3);
  });

  for (const brake of [{ brake: 1, handbrake: false }, { brake: 0, handbrake: true }]) {
    it(`10° hill (${brake.handbrake ? 'handbrake' : 'foot brake'}): holds without creeping, nose uphill and sideways`, () => {
      for (const sideways of [false, true]) {
        resetInputs(r);
        // 10° slope realised by tilting gravity (exactly equivalent for a rigid flat ground)
        const axis = sideways ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
        const g = qrot(qaxisAngle(axis, 10 * DEG), { x: 0, y: -G0, z: 0 });
        r.sim.world.gravity = g;
        r.sim.reset(spawnPose({ x: -20, y: 0, z: 10 }, 0));
        r.drive.brake = brake.brake; r.drive.handbrake = brake.handbrake;
        r.run(2.0);
        const p0 = { ...r.sim.getState().pos };
        let vmax = 0;
        r.run(10, () => { vmax = Math.max(vmax, r.sim.getState().speedMs); });
        const p1 = r.sim.getState().pos;
        const drift = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        console.log('hill', brake, { sideways, drift, vmax });
        r.sim.world.gravity = { x: 0, y: -G0, z: 0 };
        expect(drift).toBeLessThan(1e-3);
        expect(vmax).toBeLessThan(2e-3);
      }
    });
  }

  it('10° hill without brakes: the car rolls downhill (no artificial stiction)', () => {
    resetInputs(r);
    r.sim.world.gravity = qrot(qaxisAngle({ x: 1, y: 0, z: 0 }, 10 * DEG), { x: 0, y: -G0, z: 0 });
    r.sim.reset(spawnPose({ x: -20, y: 0, z: 10 }, 0));
    r.run(3.0);
    const v = r.sim.getState().linVel;
    r.sim.world.gravity = { x: 0, y: -G0, z: 0 };
    // gravity along -Z component: rolls with ≈ g sin10° minus rolling resistance and wheel inertia
    expect(v.z).toBeLessThan(-0.6 * G0 * Math.sin(10 * DEG) * 3);
  });

  it('steer +1 = right: negative road-wheel angle, negative yaw rate, Ackermann inner wheel steers more', () => {
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -100 }, 0, 10));
    r.drive.steer = 0.5; r.drive.throttle = 0.15;
    r.run(1.5);
    const st = r.sim.getState();
    expect(st.wheels[0].steerRad).toBeLessThan(0);
    expect(Math.abs(st.wheels[1].steerRad)).toBeGreaterThan(Math.abs(st.wheels[0].steerRad)); // FR is inner
    expect(st.angVel.y).toBeLessThan(-0.05);
    expect(st.pos.x).toBeLessThan(-0.5); // heading turns toward -X (right)
    expect(Math.abs(hudPitchDeg(st.quat))).toBeLessThan(3);
  });

  it('reverse gear drives backwards', () => {
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 0, z: 0 }, 0));
    r.drive.reverse = true; r.drive.throttle = 0.5;
    r.run(2.0);
    const st = r.sim.getState();
    expect(st.linVel.z).toBeLessThan(-3);
    expect(st.speedMs).toBeLessThan(ROADSTER.powertrain.maxWheelTorqueNm); // sanity
  });
});
