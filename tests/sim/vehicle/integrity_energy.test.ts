import { describe, expect, it } from 'vitest';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { ROADSTER } from '../../../src/shared/roadster';
import { G0, hudPitchDeg } from '../../../src/shared/math';
import { kicker, resetInputs, rig } from './helpers';

const S = ROADSTER.suspension;

describe('landing and integrity', () => {
  for (const h of [1, 3]) {
    it(`drop from ${h} m onto flat ground: touchdown measured, bump stop / crash criterion`, async () => {
      const r = await rig();
      resetInputs(r);
      r.sim.reset(spawnPose({ x: 0, y: h, z: 0 }, 0));
      r.run(3.0);
      const L = r.vm.integrity.landings[0];
      const st = r.sim.getState();
      console.log(`drop ${h} m`, L, { crashed: st.crashed, finalY: st.pos.y });
      expect(L).toBeTruthy();
      const vExp = Math.sqrt(2 * G0 * (h + 0.01)); // wheels hang ≈ 1 cm above the ground at spawn (+ droop)
      expect(L.sinkMs).toBeGreaterThan(0.9 * vExp); expect(L.sinkMs).toBeLessThan(1.1 * vExp + 0.3);
      expect(L.peakCompressionM).toBeGreaterThan(0.06);
      if (h === 1) {
        expect(L.hard).toBe(false);
        expect(st.crashed).toBe(false);
        expect(L.peakBodyImpactMs).toBe(0);              // hydraulic stop catches it before the floor
        // lower bound for stopping 4.4 m/s within the 0.12 m travel at constant force: ≈ 9 g + 1 g
        expect(L.peakHudG).toBeGreaterThan(8); expect(L.peakHudG).toBeLessThan(25);
      } else {
        // 7.7 m/s sink exceeds integrity.maxLandingSinkMs (6 m/s) -> suspension bottoms, hard landing = crash
        expect(L.sinkMs).toBeGreaterThan(ROADSTER.integrity.maxLandingSinkMs);
        expect(L.bumpStop).toBe(true);
        expect(L.hard).toBe(true);
        expect(st.crashed).toBe(true);
      }
      // the car comes to rest on its wheels again
      expect(st.wheels.every((w) => w.contact)).toBe(true);
      expect(Math.abs(hudPitchDeg(st.quat))).toBeLessThan(2);
      r.sim.dispose();
    });
  }

  it('kicker at ≈ 22.6 m/s (fans off): no bottoming, no body contact, ≈ 3.5 g launch, clean take-off', async () => {
    const r = await rig();
    resetInputs(r);
    const k = kicker();
    r.sim.reset(spawnPose({ x: k.origin.x, y: 0, z: k.origin.z - 20 }, 0, 22.6));
    let maxComp = 0, body = false, peakF = 0, airborne = false, vLip = 0;
    r.run(2.5, () => {
      const st = r.sim.getState();
      const onKicker = st.pos.z > k.origin.z - 3 && !airborne;
      if (onKicker) {
        for (const w of st.wheels) maxComp = Math.max(maxComp, w.compression);
        body ||= st.bodyContact || r.sim.impactSpeed > 0;
        peakF = Math.max(peakF, r.sim.telemetry().gForce);
      }
      if (!airborne && st.pos.z > k.origin.z && st.wheels.every((w) => !w.contact)) { airborne = true; vLip = st.speedMs; }
      return airborne && st.t > 2;
    });
    console.log('kicker', { maxComp, body, peakHudG: peakF, airborne, vLip });
    expect(airborne).toBe(true);
    expect(maxComp).toBeLessThan(S.travelM);
    expect(body).toBe(false);
    expect(peakF).toBeGreaterThan(2.8); expect(peakF).toBeLessThan(4.5);
    expect(vLip).toBeGreaterThan(20);
    expect(r.sim.getState().crashed).toBe(false);
    r.sim.dispose();
  });
});

describe('energy balance and determinism', () => {
  it('coasting: Δ(kinetic) = −∫(drag + rolling resistance) dt within 3 %', async () => {
    const r = await rig();
    resetInputs(r);
    r.systems.aeroMode = 'lowDrag';
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 40));
    r.run(1.0);
    const st0 = r.sim.getState();
    const I = S.wheelInertiaKgM2;
    const ke = () => {
      const s = r.sim.getState();
      let e = 0.5 * s.massKg * s.speedMs ** 2;
      for (const w of s.wheels) e += 0.5 * I * w.angularVel ** 2;
      return e;
    };
    const e0 = ke(), y0 = st0.pos.y;
    let lost = 0;
    r.run(5, () => {
      const s = r.sim.getState();
      let rr = 0; for (const w of s.wheels) rr += ROADSTER.tire.rollingResistance * w.normalLoadN;
      lost += (s.aero.dragN + rr) * s.speedMs * r.sim.dt;
    });
    const s1 = r.sim.getState();
    const dE = e0 - ke() - s1.massKg * G0 * (s1.pos.y - y0);
    console.log('energy', { dE, lost, ratio: dE / lost });
    expect(Math.abs(dE / lost - 1)).toBeLessThan(0.03);
    r.sim.dispose();
  });

  it('battery power never exceeds the limit, regen while braking is negative and bounded', async () => {
    const r = await rig();
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 5));
    r.drive.throttle = 1;
    let pMax = 0;
    r.run(8, () => { pMax = Math.max(pMax, r.sim.getState().motorPowerW); });
    r.drive.throttle = 0; r.drive.brake = 0.6;
    let pMin = 0;
    r.run(2, () => { pMin = Math.min(pMin, r.sim.getState().motorPowerW); });
    console.log('power', { pMax, pMin });
    expect(pMax).toBeLessThanOrEqual(ROADSTER.powertrain.batteryPowerW * 1.001);
    expect(pMax).toBeGreaterThan(0.9 * ROADSTER.powertrain.batteryPowerW);
    expect(pMin).toBeLessThan(-50_000);
    expect(pMin).toBeGreaterThanOrEqual(-ROADSTER.powertrain.regenPowerW * 1.001);
    r.sim.dispose();
  });

  it('is bit-deterministic for identical inputs (driving, fans, braking, steering)', async () => {
    const run = async () => {
      const r = await rig();
      resetInputs(r);
      r.sim.reset(spawnPose({ x: 10, y: 0, z: -50 }, 15, 8));
      r.systems.fanMode = 'grip';
      r.run(6, (t) => {
        r.drive.throttle = t < 3 ? 0.8 : 0; r.drive.brake = t > 4 ? 0.7 : 0;
        r.drive.steer = Math.sin(t * 2) * 0.5;
      });
      const s = r.sim.getState();
      const out = [s.pos.x, s.pos.y, s.pos.z, s.quat.x, s.quat.y, s.quat.z, s.quat.w, s.fans.forceN, ...s.wheels.map((w) => w.angularVel)];
      r.sim.dispose();
      return out;
    };
    const a = await run(), b = await run();
    expect(a).toEqual(b);
  });
});
