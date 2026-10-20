import { describe, expect, it } from 'vitest';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { ROADSTER } from '../../../src/shared/roadster';
import { DEG, G0, hudPitchDeg, qaxisAngle, qrot, rollDeg } from '../../../src/shared/math';
import { EARTH, MARS, MOON, SPACE, type Environment } from '../../../src/shared/environment';
import { muLoad } from '../../../src/sim/vehicle/tire';
import { prespinFans, resetInputs, rig, type Rig } from './helpers';

const S = ROADSTER.suspension;
const gOf = (e: Environment) => Math.hypot(e.gravity.x, e.gravity.y, e.gravity.z);

async function envRig(env: Environment): Promise<Rig> {
  const r = await rig();
  r.sim.setEnvironment(env);
  return r;
}

function brakeDist(r: Rig, v0: number): number {
  resetInputs(r);
  r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, v0));
  r.run(0.5);
  const p0 = { ...r.sim.getState().pos }, v1 = r.sim.getState().speedMs;
  r.drive.brake = 1;
  r.run(40, () => r.sim.getState().speedMs < 0.02);
  const p = r.sim.getState().pos;
  return Math.hypot(p.x - p0.x, p.z - p0.z) * (v0 / v1) ** 2;
}

/** Sealed suction on flat ground at full fan level, after settling. */
function sealedSuction(r: Rig): { forceN: number; powerW: number; flow: number; gap: number } {
  resetInputs(r);
  r.sim.reset(spawnPose({ x: 0, y: 0, z: 0 }, 0));
  r.systems.fanMode = 'grip'; r.systems.fanLevel = 1; prespinFans(r);
  r.run(3);
  const f = r.sim.getState().fans;
  return { forceN: f.forceN, powerW: f.powerW, flow: f.flowM3s, gap: f.gapM };
}

describe('environments (Earth / Moon / Mars / space)', () => {
  it('Earth is the default and unchanged: env = EARTH', async () => {
    const r = await rig();
    expect(r.sim.env.body).toBe('earth');
    expect(r.sim.env.airDensity).toBe(EARTH.airDensity);
    expect(sealedSuction(r).forceN / G0).toBeGreaterThan(0.9 * ROADSTER.fans.targetMaxDownforceKg);
    r.sim.dispose();
  });

  it('Moon: suspension barely compresses (springs sized for 1 g), car stands still on flat ground and a 10° slope', async () => {
    const r = await envRig(MOON);
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 0, z: 0 }, 0));
    r.run(6); // low g -> slower settling
    const st = r.sim.getState();
    const sumN = st.wheels.reduce((s, w) => s + w.normalLoadN, 0);
    const cMean = st.wheels.reduce((s, w) => s + w.compression, 0) / 4;
    console.log('moon static', { comp: st.wheels.map((w) => w.compression), cogY: st.pos.y, sumN });
    expect(sumN / (st.massKg * gOf(MOON))).toBeCloseTo(1, 2);
    expect(cMean).toBeCloseTo((st.massKg * gOf(MOON)) / (4 * S.springNPerM), 3); // ≈ 3.6 mm
    expect(st.pos.y).toBeGreaterThan(0.46);                                       // rides ≈ 2 cm higher
    let vmax = 0;
    r.run(5, () => { vmax = Math.max(vmax, r.sim.getState().speedMs); });
    expect(vmax).toBeLessThan(1e-3);
    // 10° slope with the brake (tilted lunar gravity)
    resetInputs(r);
    r.sim.world.gravity = qrot(qaxisAngle({ x: 1, y: 0, z: 0 }, 10 * DEG), MOON.gravity);
    r.sim.reset(spawnPose({ x: 20, y: 0, z: 0 }, 0));
    r.drive.brake = 1;
    r.run(6);
    const p0 = { ...r.sim.getState().pos };
    r.run(10);
    const p1 = r.sim.getState().pos;
    r.sim.world.gravity = { ...MOON.gravity };
    expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeLessThan(1e-3);
    r.sim.dispose();
  });

  it('Moon: no suction and no aero (no atmosphere); braking distance ≈ g ratio / load-sensitive mu ratio longer', async () => {
    const e = await envRig(EARTH), m = await envRig(MOON);
    const fan = sealedSuction(m);
    expect(fan.forceN).toBe(0); expect(fan.powerW).toBe(0); expect(fan.flow).toBe(0);
    resetInputs(m);
    m.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 40));
    m.run(0.3);
    expect(m.sim.getState().aero.dragN).toBe(0); expect(m.sim.getState().aero.downforceN).toBe(0);
    const v0 = 100 / 3.6;
    const dE = brakeDist(e, v0), dM = brakeDist(m, v0);
    // load sensitivity mu ∝ Fz^-n: the lightly loaded lunar tires have a higher mu than on Earth
    const fzE = (1950 * G0) / 4, fzM = (1950 * gOf(MOON)) / 4;
    const expected = (G0 / gOf(MOON)) * (muLoad(fzE) / muLoad(fzM));
    console.log('moon braking', { dE, dM, ratio: dM / dE, gRatio: G0 / gOf(MOON), expected });
    expect(dM / dE).toBeGreaterThan(0.9 * expected); expect(dM / dE).toBeLessThan(1.15 * expected);
    expect(dM / dE).toBeGreaterThan(4); expect(dM / dE).toBeLessThan(G0 / gOf(MOON));
    e.sim.dispose(); m.sim.dispose();
  });

  it('Mars: sealed suction ≈ 1.7 % of Earth (fan dp ∝ rho), aero forces ∝ rho', async () => {
    const e = await envRig(EARTH), m = await envRig(MARS);
    const fe = sealedSuction(e), fm = sealedSuction(m);
    const rhoRatio = MARS.airDensity / EARTH.airDensity;
    console.log('mars suction', { earthKg: fe.forceN / G0, marsKg: fm.forceN / G0, ratio: fm.forceN / fe.forceN, rhoRatio, gapE: fe.gap, gapM: fm.gap });
    expect(fm.gap).toBeCloseTo(ROADSTER.fans.minGapM, 6);
    expect(fm.forceN / fe.forceN).toBeCloseTo(rhoRatio, 3);
    expect(fm.powerW / fe.powerW).toBeCloseTo(rhoRatio, 3);         // absorbed power ∝ rho (same volume flow)
    for (const r of [e, m]) {
      resetInputs(r);
      r.systems.aeroMode = 'highDownforce';
      r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 40));
      r.run(0.3);
    }
    const ae = e.sim.getState().aero, am = m.sim.getState().aero;
    const vr = (m.sim.getState().speedMs / e.sim.getState().speedMs) ** 2;
    expect(am.dragN / (ae.dragN * vr)).toBeCloseTo(rhoRatio, 3);
    expect(am.downforceN / (ae.downforceN * vr)).toBeCloseTo(rhoRatio, 2);
    e.sim.dispose(); m.sim.dispose();
  });

  it('space: no gravity, no air -> no fan or aero forces, the car keeps its velocity', async () => {
    const r = await envRig(SPACE);
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 50, z: 0 }, 0, 10));
    r.systems.fanMode = 'grip'; r.systems.fanLevel = 1; prespinFans(r);
    r.run(2);
    const st = r.sim.getState();
    expect(st.fans.forceN).toBe(0); expect(st.aero.dragN).toBe(0);
    expect(st.speedMs).toBeCloseTo(10, 4);
    expect(st.pos.y).toBeCloseTo(50 + ROADSTER.restCogHeightM, 3);
    r.sim.dispose();
  });
});

describe('driving and landing at low gravity (Moon 1/6 g, Mars 0.38 g)', () => {
  for (const env of [MOON, MARS]) {
    it(`${env.body}: full-throttle launch, slalom and full braking stay stable (TC/ESC/ABS)`, async () => {
      const r = await envRig(env);
      resetInputs(r);
      r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0));
      r.run(4);
      const g = gOf(env);
      let maxRoll = 0, maxPitch = 0, maxLong = 0, spin = 0;
      const watch = () => {
        const st = r.sim.getState();
        maxRoll = Math.max(maxRoll, Math.abs(rollDeg(st.quat)));
        maxPitch = Math.max(maxPitch, Math.abs(hudPitchDeg(st.quat)));
        maxLong = Math.max(maxLong, st.specificForce.z);
        const fwd = qrot(st.quat, { x: 0, y: 0, z: 1 });
        if (st.speedMs > 3) spin = Math.max(spin, Math.acos(Math.min(1, (fwd.x * st.linVel.x + fwd.z * st.linVel.z) / Math.hypot(st.linVel.x, st.linVel.z))));
      };
      r.drive.throttle = 1;
      r.run(6, watch);
      const vLaunch = r.sim.getState().speedMs;
      r.drive.throttle = 0.4;
      r.run(8, (t) => { r.drive.steer = 0.5 * Math.sin(t * 1.5); watch(); });
      r.drive.steer = 0; r.drive.throttle = 0; r.drive.brake = 1;
      r.run(25, () => { watch(); return r.sim.getState().speedMs < 0.02; });
      const st = r.sim.getState();
      const mu = muLoad((1950 * g) / 4);
      console.log(env.body, 'drive', { vLaunch, maxLongG: maxLong / g, muRear: mu, maxRoll, maxPitch, slipAngleDeg: spin / DEG, crashed: st.crashed });
      expect(st.crashed).toBe(false);
      expect(st.speedMs).toBeLessThan(0.05);
      expect(st.wheels.every((w) => w.contact)).toBe(true);
      // traction-limited launch: RWD can use at most ≈ mu * rear axle share of the weight
      expect(maxLong / g).toBeLessThan(1.15 * mu);
      expect(vLaunch).toBeGreaterThan(0.25 * mu * g * 6);
      expect(maxRoll).toBeLessThan(10); expect(maxPitch).toBeLessThan(10);
      expect(spin / DEG).toBeLessThan(15);           // no spin-out
      r.sim.dispose();
    });

    it(`${env.body}: drop from 1 m and 3 m lands on the wheels without bottoming out`, async () => {
      for (const h of [1, 3]) {
        const r = await envRig(env);
        resetInputs(r);
        r.sim.reset(spawnPose({ x: 0, y: h, z: 0 }, 0));
        r.run(8);
        const L = r.vm.integrity.landings[0];
        const st = r.sim.getState();
        const vExp = Math.sqrt(2 * gOf(env) * h);
        console.log(env.body, `drop ${h} m`, { sink: L.sinkMs, vExp, comp: L.peakCompressionM, bump: L.bumpStop, hudG: L.peakHudG, crashed: st.crashed });
        expect(L.sinkMs).toBeGreaterThan(0.85 * vExp); expect(L.sinkMs).toBeLessThan(1.15 * vExp + 0.2);
        expect(L.peakBodyImpactMs).toBe(0);
        expect(st.crashed).toBe(false);
        expect(st.wheels.every((w) => w.contact)).toBe(true);
        expect(r.sim.getState().speedMs).toBeLessThan(0.01);   // settled, no bouncing
        r.sim.dispose();
      }
    });
  }
});
