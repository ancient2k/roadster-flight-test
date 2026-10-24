// Vehicle damage model (src/sim/vehicle/damage.ts): impact energy → crush/dents, functional consequences,
// total loss, repair on reset, and "off" = previous behaviour.
import { describe, expect, it } from 'vitest';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { CRUSH, crushFromEnergy, energyForCrush, setDamageMode } from '../../../src/sim/vehicle';
import { ROADSTER } from '../../../src/shared/roadster';
import { damageLevel } from '../../../src/shared/damage';
import { qaxisAngle, qmul, DEG } from '../../../src/shared/math';
import { resetInputs, rig, type Rig } from './helpers';

const SEMI = { x: -62, z: -17 };   // 14 m west of the Semi obstacle (box face at x = −48.3), heading +X

async function damagedRig(mode: 'off' | 'realistic' = 'realistic'): Promise<Rig> {
  const r = await rig();
  resetInputs(r);
  setDamageMode(r.sim, mode);
  return r;
}

describe('crush stiffness (Campbell)', () => {
  it('US-NCAP 56 km/h full-width barrier (1.7 t, 207 kJ) → 0.45–0.55 m frontal crush', () => {
    const e = 0.5 * 1700 * (56 / 3.6) ** 2;
    const c = crushFromEnergy('front', e);
    console.log('NCAP crush', c);
    expect(c).toBeGreaterThan(0.45); expect(c).toBeLessThan(0.55);
  });
  it('no permanent crush below the bumper-test energy (≈ 6 km/h), monotonic, inverse consistent', () => {
    const g = energyForCrush('front', 0);
    expect(0.5 * 1700 * (g / (0.5 * 1700)) ).toBeCloseTo(g);
    expect(Math.sqrt(2 * g / 1700) * 3.6).toBeGreaterThan(4); expect(Math.sqrt(2 * g / 1700) * 3.6).toBeLessThan(8);
    expect(crushFromEnergy('front', 0.99 * g)).toBe(0);
    for (const z of Object.keys(CRUSH) as (keyof typeof CRUSH)[]) {
      let prev = -1;
      for (const e of [5e3, 2e4, 5e4, 1e5, 3e5]) { const c = crushFromEnergy(z, e); expect(c).toBeGreaterThanOrEqual(prev); prev = c; }
      expect(crushFromEnergy(z, energyForCrush(z, 0.2))).toBeCloseTo(0.2, 6);
    }
    // sides are softer than the front
    expect(crushFromEnergy('left', 3e4)).toBeGreaterThan(crushFromEnergy('front', 3e4));
  });
});

describe('impact energy → damage (realistic)', () => {
  it('6 m/s into the Semi: front dent, absorbed ≈ kinetic energy, no total loss, run goes on', async () => {
    const r = await damagedRig();
    r.sim.reset(spawnPose({ x: SEMI.x, y: 0, z: SEMI.z }, 90, 6));
    r.run(3.5);
    const st = r.sim.getState(), d = st.damage!;
    const ke = 0.5 * st.massKg * 36;
    console.log('6 m/s', { E: d.energyJ, ke, crush: d.crushM.front, dents: d.dents.length });
    expect(d.mode).toBe('realistic');
    expect(d.energyJ / ke).toBeGreaterThan(0.75); expect(d.energyJ / ke).toBeLessThan(1.05);
    expect(d.crushM.front).toBeGreaterThan(0.1); expect(d.crushM.front).toBeLessThan(0.25);
    expect(d.crushM.rear + d.crushM.left + d.crushM.right + d.crushM.roof).toBe(0);
    const dent = d.dents.find((x) => x.zone === 'front')!;
    expect(dent.dir.z).toBeLessThan(-0.9);            // pushed backwards into the car
    expect(dent.p.z).toBeGreaterThan(2.0);
    expect(dent.depthM).toBeCloseTo(d.crushM.front, 6);
    expect(d.rev).toBeGreaterThan(0);
    expect(d.totalLoss).toBe(false);
    expect(st.crashed).toBe(false);
    expect(damageLevel(d)).not.toBe('none');
    r.sim.dispose();
  });

  it('the same impact with the setting off: no damage state, collision as before (crashed)', async () => {
    const r = await damagedRig('off');
    r.sim.reset(spawnPose({ x: SEMI.x, y: 0, z: SEMI.z }, 90, 6));
    r.run(3.5);
    const st = r.sim.getState();
    expect(st.damage).toBeUndefined();
    expect(st.crashed).toBe(true);
    expect(r.sim.bodyContacts.length).toBe(0);   // nothing recorded on the hot path
    r.sim.dispose();
  });

  it('15 m/s (54 km/h) into the Semi: front crush beyond the critical depth → total loss ends the run', async () => {
    const r = await damagedRig();
    r.sim.reset(spawnPose({ x: SEMI.x, y: 0, z: SEMI.z }, 90, 15));
    r.run(2.5);
    const st = r.sim.getState(), d = st.damage!;
    console.log('15 m/s', { E: d.energyJ, crush: d.crushM.front, noz: d.nozzles });
    expect(d.crushM.front).toBeGreaterThan(CRUSH.front.criticalM);
    expect(d.totalLoss).toBe(true);
    expect(st.crashed).toBe(true);
    expect(damageLevel(d)).toBe('total');
    // the front yaw nozzles sit in the crumple zone
    expect(Math.max(d.nozzles[8], d.nozzles[9])).toBeGreaterThan(0.5);
    r.sim.dispose();
  });

  it('3 m drop: hard landing bends the suspension links instead of ending the run', async () => {
    const r = await damagedRig();
    r.sim.reset(spawnPose({ x: 0, y: 3, z: 0 }, 0));
    r.run(3);
    const st = r.sim.getState(), d = st.damage!;
    console.log('drop', { wheels: d.wheels, toe: d.toeDeg, E: d.energyJ });
    expect(r.vm.integrity.landings[0].hard).toBe(true);
    expect(st.crashed).toBe(false);
    for (let i = 0; i < 4; i++) {
      expect(d.wheels[i]).toBeGreaterThan(0.1); expect(d.wheels[i]).toBeLessThan(0.6);
      expect(Math.abs(d.toeDeg[i])).toBeGreaterThan(0.3);
    }
    expect(Math.sign(d.toeDeg[0])).toBe(1); expect(Math.sign(d.toeDeg[1])).toBe(-1);   // toe-out
    expect(d.wheelLost.some(Boolean)).toBe(false);
    r.sim.dispose();
  });

  it('rolled onto the roof: total loss', async () => {
    const r = await damagedRig();
    const q = qmul(qaxisAngle({ x: 0, y: 1, z: 0 }, 0), qaxisAngle({ x: 0, y: 0, z: 1 }, 180 * DEG));
    r.sim.reset({ pos: { x: 0, y: 1.6, z: 0 }, quat: q, speedMs: 0 });
    r.run(2);
    const st = r.sim.getState();
    expect(st.damage!.totalLoss).toBe(true);
    expect(st.crashed).toBe(true);
    r.sim.dispose();
  });
});

describe('functional consequences', () => {
  /** Coast straight ahead at 20 m/s (steer 0) for 3 s; returns the heading change (deg). */
  const headingDrift = (r: Rig): number => {
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 20));
    r.run(0.5);
    const q0 = r.sim.getState().quat;
    const h0 = Math.atan2(2 * (q0.w * q0.y + q0.x * q0.z), 1 - 2 * (q0.y * q0.y + q0.x * q0.x));
    r.run(3);
    const q = r.sim.getState().quat;
    const h = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    return (h - h0) / DEG;
  };

  it('bent front-left link (side impact at the wheel): toe error pulls the car to one side', async () => {
    const intact = await damagedRig();
    const dIntact = headingDrift(intact);
    const r = await damagedRig();
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 0));
    // lateral hit just ahead of the FL hub, pushing it inward (−X): 12 kJ, half into the links
    const dm = r.vm.damage;
    dm.inject(r.sim, { x: 0.98, y: -0.05, z: 1.6 }, { x: -1, y: 0, z: 0 }, 12_000);
    const toe = r.sim.getState().damage ?? dm.state;
    console.log('toe', toe.toeDeg, toe.wheels);
    expect(Math.abs(dm.state.toeDeg[0])).toBeGreaterThan(0.5);
    // headingDrift resets the sim (= repair): re-apply the hit after the reset through the run callback
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 20));
    dm.inject(r.sim, { x: 0.98, y: -0.05, z: 1.6 }, { x: -1, y: 0, z: 0 }, 12_000);
    r.run(0.5);
    const q0 = r.sim.getState().quat;
    const h0 = Math.atan2(2 * (q0.w * q0.y + q0.x * q0.z), 1 - 2 * (q0.y * q0.y + q0.x * q0.x));
    r.run(3);
    const q = r.sim.getState().quat;
    const dBent = (Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)) - h0) / DEG;
    console.log('heading drift intact / bent', dIntact, dBent);
    expect(Math.abs(dIntact)).toBeLessThan(0.5);
    expect(Math.abs(dBent)).toBeGreaterThan(3);
    expect(Math.sign(dBent)).toBe(Math.sign(dm.state.toeDeg[0]));   // pulls towards the toe error
    intact.sim.dispose(); r.sim.dispose();
  });

  it('crushed main nozzles: less thrust and a feed-line leak drains the tank with the valves shut', async () => {
    const r = await damagedRig();
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 0));
    r.run(1);
    const dm = r.vm.damage;
    dm.inject(r.sim, { x: 0.1, y: -0.2, z: -2.1 }, { x: 0, y: 0, z: 1 }, 9_000);
    const d = dm.state;
    console.log('nozzles', d.nozzles.slice(0, 4), 'scale', Array.from(r.sim.propulsion.thrustScale.slice(0, 4)), 'leak area', r.sim.propulsion.leakAreaM2);
    expect(d.nozzles[1]).toBeGreaterThan(0.5); expect(d.nozzles[2]).toBeGreaterThan(0.5);
    expect(r.sim.propulsion.thrustScale[1]).toBeLessThan(0.75);
    expect(d.nozzles[4] + d.nozzles[5] + d.nozzles[8] + d.nozzles[9]).toBe(0); // front nozzles untouched
    const m0 = r.sim.propulsion.tank.m;
    r.run(10);
    const lost = m0 - r.sim.propulsion.tank.m;
    const st = r.sim.getState();
    console.log('leak', { lost, leakKgS: st.damage!.leakKgS });
    expect(st.damage!.leakKgS).toBeGreaterThan(0.2);
    expect(lost).toBeGreaterThan(2);
    expect(lost / (st.damage!.leakKgS * 10)).toBeGreaterThan(0.95);   // ≈ constant leak at the regulated feed pressure
    expect(lost / (st.damage!.leakKgS * 10)).toBeLessThan(1.05);
    // thrust of MAIN_2 vs MAIN_2 of an intact car, fired alone for 0.3 s
    r.thr.duty.fill(0); r.thr.duty[1] = 1;
    r.run(0.3);
    const tDam = r.sim.getState().nozzles[1].thrustN;
    const ok = await damagedRig();
    ok.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 0));
    ok.thr.duty.fill(0); ok.thr.duty[1] = 1;
    ok.run(0.3);
    const tOk = ok.sim.getState().nozzles[1].thrustN;
    console.log('thrust damaged / intact', tDam, tOk, d.nozzles[1]);
    expect(tDam / tOk).toBeLessThan(1 - 0.6 * d.nozzles[1] + 0.05);
    // the brass bells (nozzle covers) of the hit side were torn off with the hit
    expect(d.lost).toContain('NozzleCover_L');
    r.sim.dispose(); ok.sim.dispose();
  });

  it('torn fan skirt: less suction at full fan speed', async () => {
    const suction = async (hit: boolean) => {
      const r = await damagedRig();
      r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 0));
      if (hit) r.vm.damage.inject(r.sim, { x: 0.5, y: -0.35, z: 0.8 }, { x: 0, y: 1, z: 0 }, 12_000);
      r.systems.fanMode = 'grip'; r.systems.fanLevel = 1;
      r.run(5);
      const f = r.sim.getState().fans.forceN;
      const dmg = r.vm.damage.state.skirts.slice();
      r.sim.dispose();
      return { f, dmg };
    };
    const ok = await suction(false), torn = await suction(true);
    console.log('suction intact / torn', ok, torn);
    expect(torn.dmg[0]).toBeGreaterThan(0.9);
    expect(torn.f).toBeLessThan(0.85 * ok.f);
  });

  it('wheel torn off: no contact at that corner, a Rapier body takes over; reset repairs everything', async () => {
    const r = await damagedRig();
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 0));
    r.run(1);
    const bodies0 = r.sim.world.bodies.len();
    r.vm.damage.inject(r.sim, { x: 0.98, y: -0.25, z: -1.25 }, { x: -1, y: 0, z: 0 }, 34_000);   // below the rear quarter
    r.vm.damage.inject(r.sim, { x: 0.3, y: 0.62, z: -1.6 }, { x: 0, y: -0.7, z: 0.7 }, 3_000);   // wing
    const d = r.vm.damage.state;
    expect(d.wheelLost[2]).toBe(true);
    expect(d.wingLost).toBe(true);
    expect(d.debris.map((x) => x.part).sort()).toEqual(['Wheel_RL', 'Wing']);
    expect(r.sim.world.bodies.len()).toBe(bodies0 + 2);
    const y0 = d.debris[0].pos.y;
    r.run(2);
    const st = r.sim.getState();
    expect(st.wheels[2].contact).toBe(false);
    // the car rests on the RL corner of its body (the diagonal wheel may lift): no total loss, still driving
    expect(st.wheels.filter((w) => w.contact).length).toBeGreaterThanOrEqual(2);
    expect(st.crashed).toBe(false);
    expect(st.damage!.debris[0].pos.y).toBeLessThan(y0);   // the wheel fell
    expect(st.damage!.debris[0].pos.y).toBeGreaterThan(0.1);   // and lies on the ground
    // restart = repair
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 0));
    r.run(1);
    const s2 = r.sim.getState().damage!;
    expect(s2.rev).toBe(0);
    expect(s2.debris.length + s2.dents.length).toBe(0);
    expect(s2.wheelLost.some(Boolean) || s2.wingLost).toBe(false);
    expect(r.sim.world.bodies.len()).toBe(bodies0);
    expect(Array.from(r.sim.propulsion.thrustScale).every((x) => x === 1)).toBe(true);
    expect(r.sim.propulsion.leakAreaM2).toBe(0);
    expect(r.sim.getState().wheels.every((w) => w.contact)).toBe(true);
    r.sim.dispose();
  });

  it('wing torn off: downforce drops to ≈ 30 %', async () => {
    const df = async (hit: boolean) => {
      const r = await damagedRig();
      r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 50));
      if (hit) r.vm.damage.inject(r.sim, { x: 0.3, y: 0.62, z: -1.6 }, { x: 0, y: -0.7, z: 0.7 }, 3_000);
      r.systems.aeroMode = 'highDownforce';
      r.run(1);
      const v = r.sim.getState().aero.downforceN / r.sim.getState().speedMs ** 2;
      r.sim.dispose();
      return v;
    };
    const ok = await df(false), lost = await df(true);
    expect(lost / ok).toBeCloseTo(0.3, 2);
  });
});

describe('setting off = previous behaviour', () => {
  it('is bit-identical to a sim whose damage module was never configured (driving, braking, landing)', async () => {
    const run = async (configure: boolean) => {
      const r = await rig();
      resetInputs(r);
      if (configure) setDamageMode(r.sim, 'off');
      r.sim.reset(spawnPose({ x: 10, y: 1.5, z: -50 }, 15, 8));
      r.systems.fanMode = 'grip';
      r.run(5, (t) => { r.drive.throttle = t < 3 ? 0.8 : 0; r.drive.brake = t > 4 ? 0.7 : 0; r.drive.steer = Math.sin(t * 2) * 0.5; });
      const s = r.sim.getState();
      const out = [s.pos.x, s.pos.y, s.pos.z, s.quat.x, s.quat.y, s.quat.z, s.quat.w, s.tank.airMassKg, ...s.wheels.map((w) => w.angularVel)];
      expect(s.damage).toBeUndefined();
      r.sim.dispose();
      return out;
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it('maxLandingSinkMs criterion unchanged with damage off', () => {
    expect(ROADSTER.integrity.maxLandingSinkMs).toBe(6);
  });
});

describe('setting and session', () => {
  it('settings: default auto (off below Ultra), persisted enum, invalid/legacy values fall back to auto', async () => {
    const { sanitizeSettings, defaultSettings, damageForSettings, SettingsStore } = await import('../../../src/ui/settings');
    expect(defaultSettings().realism.damage).toBe('auto');
    expect(damageForSettings(defaultSettings())).toBe('off');
    expect(sanitizeSettings({ realism: { damage: 'realistic' } }).realism.damage).toBe('realistic');
    expect(sanitizeSettings({ realism: { damage: 'arcade' } }).realism.damage).toBe('auto');
    const legacy = sanitizeSettings({ realism: { crashDamage: false } }) as unknown as { realism: Record<string, unknown> };
    expect(legacy.realism.crashDamage).toBeUndefined();
    expect(legacy.realism.damage).toBe('auto');
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    new SettingsStore(storage).update((d) => { d.realism.damage = 'realistic'; }, 'realism.damage');
    expect(new SettingsStore(storage).get().realism.damage).toBe('realistic');
  });

  it('a total loss does not end a free run (the wreck waits for the reset); with damage off a crash does not either', async () => {
    const { SimSession, ManualController } = await import('../../../src/game/session');
    for (const mode of ['realistic', 'off'] as const) {
      const r = await rig();
      setDamageMode(r.sim, mode);
      const s = new SimSession(r.sim, { kind: 'manual', spawn: spawnPose({ x: SEMI.x, y: 0, z: SEMI.z }, 90, 16) }, (sim) => new ManualController(sim, null));
      for (let i = 0; i < 240 * 3 && s.outcome.status === 'running'; i++) s.step();
      console.log(mode, s.outcome, r.sim.getState().crashed);
      expect(r.sim.getState().crashed).toBe(true);
      expect(s.outcome.status).toBe('running');
      if (mode === 'realistic') {
        expect(r.sim.getState().damage!.totalLoss).toBe(true);
        s.restart();   // = the reset key
        expect(r.sim.getState().damage!.totalLoss).toBe(false);
        expect(r.sim.getState().crashed).toBe(false);
      }
      r.sim.dispose();
    }
  });
});
