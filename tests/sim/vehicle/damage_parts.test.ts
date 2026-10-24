// Vehicle damage, torn-off parts and total loss (src/sim/vehicle/damage.ts): break thresholds per part,
// momentum-conserving release (the car loses the part's mass), debris limits, the total loss (drive, fans and
// nozzles dead), the repair on reset and the "Visual" level (parts fly, the car drives as if intact).
import { describe, expect, it } from 'vitest';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { setDamageMode, type DamageFactors, type VehicleBus } from '../../../src/sim/vehicle';
import { DEBRIS_LIFE_S, MAX_DEBRIS, PART_DMG, TANK_DMG, TOTAL_LOSS, WING_DMG } from '../../../src/sim/vehicle/damage';
import { BODY_PART_CUTS, COVER_PARTS, DETACHABLE_PARTS, PART_GEOMETRY, inBox, type DamageMode, type DetachablePart } from '../../../src/shared/damage';
import { ROADSTER } from '../../../src/shared/roadster';
import type { Vec3 } from '../../../src/shared/math';
import { resetInputs, rig, type Rig } from './helpers';

const ROAD = { x: 0, y: 0, z: -1300 };
/** Functional damage on the vehicle bus (what chassis / fans / aero read). */
const busDamage = (r: Rig): DamageFactors => (r.vm.damage as unknown as { bus: VehicleBus }).bus.damage;

async function standing(mode: DamageMode = 'realistic', speedMs = 0): Promise<Rig> {
  const r = await rig();
  resetInputs(r);
  setDamageMode(r.sim, mode);
  r.sim.reset(spawnPose(ROAD, 0, speedMs));
  r.run(0.2);
  return r;
}

/** Centre of a part's box and the direction of a hit there (into the car). */
function hitAt(part: DetachablePart): { p: Vec3; dir: Vec3 } {
  const b = PART_GEOMETRY[part].box;
  const p = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
  const o = PART_GEOMETRY[part].origin;
  const dir = Math.abs(o.x) > 0.3 ? { x: -Math.sign(o.x), y: 0, z: 0 } : o.y > 0.3 ? { x: 0, y: -0.7, z: 0.7 } : { x: 0, y: 0, z: -Math.sign(o.z) };
  return { p, dir };
}

const BOX_PARTS = DETACHABLE_PARTS.filter((p) => PART_DMG[p].breakJ < Infinity);

describe('break thresholds', () => {
  for (const part of BOX_PARTS) {
    it(`${part}: stays on below its break energy, torn off above it`, async () => {
      const r = await standing();
      const dm = r.vm.damage, { p, dir } = hitAt(part), eb = PART_DMG[part].breakJ;
      dm.inject(r.sim, p, dir, 0.9 * eb);
      expect(dm.state.lost).not.toContain(part);
      dm.inject(r.sim, p, dir, 0.2 * eb);
      expect(dm.partEnergy(part)).toBeGreaterThan(eb);
      expect(dm.state.lost).toContain(part);
      const deb = dm.debrisBodies().find((d) => d.part === part)!;
      expect(deb.massKg).toBe(PART_DMG[part].massKg);
      expect(deb.body.isDynamic()).toBe(true);
      // the debris starts at the part's place on the car
      const want = r.sim.toWorld(PART_GEOMETRY[part].origin), at = deb.body.translation();
      expect(Math.hypot(at.x - want.x, at.y - want.y, at.z - want.z)).toBeLessThan(0.05);
      r.sim.dispose();
    });
  }

  it('wheels: torn off by the suspension-link model, not by the part boxes', async () => {
    const r = await standing();
    r.vm.damage.inject(r.sim, { x: 0.98, y: -0.1, z: 1.4 }, { x: -1, y: 0, z: 0 }, 25_000);
    expect(r.vm.damage.state.lost).not.toContain('Wheel_FL');
    r.vm.damage.inject(r.sim, { x: 0.98, y: -0.1, z: 1.4 }, { x: -1, y: 0, z: 0 }, 10_000);
    expect(r.vm.damage.state.lost).toContain('Wheel_FL');
    expect(r.vm.damage.state.wheelLost[0]).toBe(true);
    r.sim.dispose();
  });
});

describe('release: momentum and mass', () => {
  it('a part torn off at 20 m/s: total momentum unchanged, the car loses the part\'s mass', async () => {
    const r = await standing('realistic', 20);
    const sim = r.sim, dm = r.vm.damage;
    const M0 = sim.getState().massKg, v0 = { ...sim.body.linvel() };
    const p0 = { x: M0 * v0.x, y: M0 * v0.y, z: M0 * v0.z };
    // 30 kJ on the wing tip behind the deck: 28 kJ beyond its break energy → a real kick
    dm.inject(sim, { x: 0, y: 0.7, z: -2.2 }, { x: 0, y: -0.7, z: 0.7 }, 30_000);
    expect(dm.state.lost).toEqual(['Wing']);
    const M1 = sim.getState().massKg, v1 = sim.body.linvel();
    const deb = dm.debrisBodies()[0], vd = deb.body.linvel();
    expect(M0 - M1).toBeCloseTo(PART_DMG.Wing.massKg, 9);
    expect(sim.detachedMassKg).toBe(PART_DMG.Wing.massKg);
    const p1 = { x: M1 * v1.x + deb.massKg * vd.x, y: M1 * v1.y + deb.massKg * vd.y, z: M1 * v1.z + deb.massKg * vd.z };
    const kick = Math.hypot(vd.x - v0.x, vd.y - v0.y, vd.z - v0.z);
    console.log('release', { M0, M1, kick, dp: [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z], dvCar: [v1.x - v0.x, v1.y - v0.y, v1.z - v0.z] });
    expect(kick).toBeGreaterThan(2);                       // the part flies off, it does not just drop
    expect(Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z)).toBeLessThan(1e-6 * Math.hypot(p0.x, p0.y, p0.z));
    // the car recoils against the kick (up-kick → car pushed down a little)
    expect(v1.y).toBeLessThan(v0.y);
    // the Rapier body really has the new mass (next step)
    r.run(1 / 240);
    expect(sim.body.mass()).toBeCloseTo(sim.getState().massKg, 3);
    sim.dispose();
  });

  it('the debris flies, lands and comes to rest on the ground', async () => {
    const r = await standing('realistic', 15);
    r.vm.damage.inject(r.sim, { x: 0, y: 0.7, z: -2.2 }, { x: 0, y: -0.7, z: 0.7 }, 10_000);
    const deb = r.vm.damage.debrisBodies()[0];
    let maxY = 0;
    r.run(6, () => { maxY = Math.max(maxY, deb.body.translation().y); });
    const p = deb.body.translation(), v = deb.body.linvel();
    console.log('wing debris', { maxY, p, v: Math.hypot(v.x, v.y, v.z), sleeping: deb.body.isSleeping() });
    expect(maxY).toBeGreaterThan(PART_GEOMETRY.Wing.origin.y + 0.3);
    expect(p.y).toBeGreaterThan(-0.05); expect(p.y).toBeLessThan(0.5);
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(0.1);
    r.sim.dispose();
  });
});

describe('functional effects of missing parts', () => {
  it('diffuser torn off: 15 % less downforce', async () => {
    const r = await standing();
    r.vm.damage.inject(r.sim, { x: 0, y: -0.25, z: -1.65 }, { x: 0, y: 1, z: 0 }, 3_500);
    expect(r.vm.damage.state.lost).toContain('Diffuser');
    expect(busDamage(r).downforceScale).toBeCloseTo(WING_DMG.diffuserDownforceScale, 9);
    r.sim.dispose();
  });
  it('nozzle cover (brass bells) torn off: the nozzles below lose the bell\'s thrust', async () => {
    const r = await standing();
    r.vm.damage.inject(r.sim, { x: 0.36, y: -0.2, z: -2.05 }, { x: 0, y: 0, z: 1 }, 1_700);
    expect(r.vm.damage.state.lost).toContain('NozzleCover_L');
    expect(r.vm.damage.state.nozzles[0]).toBe(1);
    expect(r.sim.propulsion.thrustScale[0]).toBeCloseTo(0.4, 9);
    r.sim.dispose();
  });
});

describe('total loss', () => {
  it('integrity below the threshold: drive, fans and nozzles dead; the wreck stays until the reset', async () => {
    const r = await standing();
    const sim = r.sim, dm = r.vm.damage;
    const bodies0 = sim.world.bodies.len();
    dm.inject(sim, { x: 0, y: -0.1, z: 2.2 }, { x: 0, y: 0, z: -1 }, 120_000);
    r.run(0.5);
    dm.inject(sim, { x: 0, y: -0.1, z: 2.2 }, { x: 0, y: 0, z: -1 }, 120_000);   // a second crash
    r.run(0.1);
    const d = sim.getState().damage!;
    expect(d.integrity).toBeLessThan(TOTAL_LOSS.integrityMin);
    expect(d.totalLoss).toBe(true);
    expect(sim.getState().crashed).toBe(true);
    expect(d.lost).toContain('Bumper_F');
    // full throttle, fans on, all nozzles open: nothing moves the car
    r.drive.throttle = 1; r.systems.fanMode = 'grip'; r.systems.fanLevel = 1; r.thr.duty.fill(1);
    r.run(3);
    const st = sim.getState();
    console.log('wreck', { speed: st.speedMs, fanRpm: st.fans.rpmNorm, thrust: Math.max(...st.nozzles.map((n) => n.thrustN)) });
    expect(st.speedMs).toBeLessThan(0.3);
    expect(st.fans.rpmNorm).toBeLessThan(0.01);
    expect(Math.max(...st.nozzles.map((n) => n.thrustN))).toBe(0);
    expect(busDamage(r).powerOff).toBe(true);
    // reset = repair: everything back, debris removed, mass restored
    r.drive.throttle = 0; r.thr.duty.fill(0); r.systems.fanMode = 'off';
    sim.reset(spawnPose(ROAD, 0, 0));
    const d2 = sim.getState().damage!;
    expect(d2.totalLoss).toBe(false); expect(d2.lost).toEqual([]); expect(d2.debris).toEqual([]); expect(d2.integrity).toBe(1);
    expect(sim.getState().crashed).toBe(false);
    expect(sim.world.bodies.len()).toBe(bodies0);
    expect(sim.detachedMassKg).toBe(0);
    expect(sim.getState().massKg).toBeCloseTo(ROADSTER.dryMassKg + ROADSTER.tank.fullMassKg, 6);
    expect(busDamage(r).powerOff).toBe(false);
    expect(Array.from(sim.propulsion.thrustScale).every((x) => x === 1)).toBe(true);
    r.drive.throttle = 1;
    r.run(2);
    expect(sim.getState().speedMs).toBeGreaterThan(5);   // drives again
    sim.dispose();
  });

  it('a heavy hit spread over two zones (no zone beyond its critical crush) is a total loss as well', async () => {
    const r = await standing();
    const dm = r.vm.damage;
    dm.inject(r.sim, { x: 0, y: 0.1, z: 2.2 }, { x: 0, y: 0, z: -1 }, 95_000);
    expect(dm.state.totalLoss).toBe(false);
    dm.inject(r.sim, { x: 0, y: 0.1, z: -2.0 }, { x: 0, y: 0, z: 1 }, 70_000);
    const d = dm.state;
    expect(d.severity).toBeLessThan(1);
    expect(d.totalLoss).toBe(true);
    r.sim.dispose();
  });

  it('two wheels torn off: total loss', async () => {
    const r = await standing();
    const dm = r.vm.damage;
    dm.inject(r.sim, { x: 0.98, y: -0.1, z: 1.4 }, { x: -1, y: 0, z: 0 }, 32_000);
    expect(dm.state.totalLoss).toBe(false);
    r.run(0.5);
    dm.inject(r.sim, { x: -0.98, y: -0.1, z: 1.4 }, { x: 1, y: 0, z: 0 }, 32_000);
    expect(dm.state.wheelLost.filter(Boolean).length).toBe(2);
    expect(dm.state.totalLoss).toBe(true);
    r.sim.dispose();
  });
});

describe('level "Visual"', () => {
  it('parts fly and dents grow, but the car drives as if intact and is never written off', async () => {
    const r = await standing('visual', 20);
    const sim = r.sim, dm = r.vm.damage;
    const v0 = { ...sim.body.linvel() }, M0 = sim.getState().massKg;
    dm.inject(sim, { x: 0, y: 0.6, z: -1.5 }, { x: 0, y: -0.7, z: 0.7 }, 30_000);
    dm.inject(sim, { x: 0, y: -0.1, z: 2.2 }, { x: 0, y: 0, z: -1 }, 300_000);
    dm.inject(sim, { x: 0.98, y: -0.1, z: 1.4 }, { x: -1, y: 0, z: 0 }, 40_000);
    const d = dm.state;
    expect(d.mode).toBe('visual');
    expect(d.lost).toContain('Wing'); expect(d.lost).toContain('Bumper_F');
    expect(d.dents.length).toBeGreaterThan(0);
    expect(d.severity).toBeGreaterThan(1);
    expect(d.totalLoss).toBe(false);
    expect(d.wheelLost.some(Boolean)).toBe(false);            // a wheel never leaves the car in this level
    expect(sim.getState().massKg).toBe(M0);                    // no mass loss, no recoil
    expect(sim.body.linvel()).toEqual(v0);
    const bd = busDamage(r);
    expect([bd.downforceScale, bd.powerOff, Math.max(...bd.toeRad), Math.min(...bd.gripScale)]).toEqual([1, false, 0, 1]);
    expect(Array.from(sim.propulsion.thrustScale).every((x) => x === 1)).toBe(true);
    expect(sim.propulsion.leakAreaM2).toBe(0);
    // the collision rule of "Off" still applies to real impacts
    expect(sim.impactCrash).toBe(true);
    sim.dispose();
  });
});

describe('debris limits', () => {
  it(`at most ${MAX_DEBRIS} bodies (oldest first), each cleared after ${DEBRIS_LIFE_S} s`, async () => {
    const r = await standing();
    const sim = r.sim, dm = r.vm.damage;
    const bodies0 = sim.world.bodies.len();
    for (const part of BOX_PARTS) { const { p, dir } = hitAt(part); dm.inject(sim, p, dir, PART_DMG[part].breakJ * 1.05); }
    dm.inject(sim, { x: 0.98, y: -0.1, z: -1.25 }, { x: -1, y: 0, z: 0 }, 34_000);   // + a wheel
    const d = dm.state;
    expect(d.lost.length).toBe(BOX_PARTS.length + 1);
    expect(d.debris.length).toBe(MAX_DEBRIS);
    expect(d.debris.map((x) => x.part)).toEqual(d.lost.slice(-MAX_DEBRIS));
    expect(sim.world.bodies.len()).toBe(bodies0 + MAX_DEBRIS);
    r.run(DEBRIS_LIFE_S - 1);
    expect(d.debris.length).toBe(MAX_DEBRIS);
    r.run(2);
    expect(d.debris.length).toBe(0);
    expect(d.lost.length).toBe(BOX_PARTS.length + 1);          // still missing on the car
    expect(sim.world.bodies.len()).toBe(bodies0);
    sim.dispose();
  }, 60_000);
});

describe('body panels and interior', () => {
  const PANELS: DetachablePart[] = ['Hood', 'Deck', 'Roof', 'Fender_L', 'Fender_R', 'Quarter_L', 'Quarter_R'];

  it('every panel has a cut region, a debris collider inside its box and a plausible mass', () => {
    for (const part of PANELS) {
      expect(BODY_PART_CUTS.some((c) => c.part === part)).toBe(true);
      const g = PART_GEOMETRY[part];
      expect(inBox(g.box, g.origin)).toBe(true);
      expect(PART_DMG[part].massKg).toBeGreaterThan(2); expect(PART_DMG[part].massKg).toBeLessThan(20);
      expect(PART_DMG[part].breakJ).toBeGreaterThan(1_000); expect(PART_DMG[part].breakJ).toBeLessThan(20_000);
      expect(COVER_PARTS).toContain(part);
    }
  });

  it('a wreck: the car loses exactly the mass of what was torn off, momentum conserved', async () => {
    const r = await standing('realistic', 10);
    const sim = r.sim, dm = r.vm.damage;
    const M0 = sim.getState().massKg;
    for (const part of PANELS) { const { p, dir } = hitAt(part); dm.inject(sim, p, dir, PART_DMG[part].breakJ * 1.1); }
    const d = dm.state;
    for (const part of PANELS) expect(d.lost).toContain(part);
    const lostKg = d.lost.reduce((s, p) => s + PART_DMG[p].massKg, 0);
    expect(sim.detachedMassKg).toBeCloseTo(lostKg, 9);
    expect(M0 - sim.getState().massKg).toBeCloseTo(lostKg, 9);
    // debris + car: momentum (bodies limited to MAX_DEBRIS, all of them still there)
    expect(dm.debrisBodies().length).toBe(Math.min(d.lost.length, MAX_DEBRIS));
    r.run(1 / 240);
    expect(sim.body.mass()).toBeCloseTo(sim.getState().massKg, 3);
    sim.dispose();
  });

  it('the wing stands on the deck: deck torn off → wing goes with it', async () => {
    const r = await standing();
    const dm = r.vm.damage;
    // hit at the front edge of the deck, outside the wing's box
    dm.inject(r.sim, { x: 0, y: 0.6, z: -0.7 }, { x: 0, y: -1, z: 0 }, PART_DMG.Deck.breakJ * 1.1);
    expect(dm.partEnergy('Wing')).toBe(0);
    expect(dm.state.lost).toEqual(['Deck', 'Wing']);
    expect(dm.state.wingLost).toBe(true);
    expect(busDamage(r).downforceScale).toBeCloseTo(WING_DMG.downforceScale, 9);
    r.sim.dispose();
  });

  it('COPV bay hit (Full): the tanks vent at tank pressure until the reset', async () => {
    const r = await standing();
    const sim = r.sim, dm = r.vm.damage;
    // below the fittings' yield: no leak
    dm.inject(sim, { x: 0.96, y: 0.1, z: -1.0 }, { x: -1, y: 0, z: 0 }, 0.9 * TANK_DMG.yieldJ);
    expect(dm.tankEnergy()).toBeCloseTo(0.9 * TANK_DMG.yieldJ, 6);
    expect(dm.state.tank).toBe(0);
    expect(sim.propulsion.tankLeakAreaM2).toBe(0);
    dm.inject(sim, { x: 0.96, y: 0.1, z: -1.0 }, { x: -1, y: 0, z: 0 }, TANK_DMG.fullJ);
    expect(dm.state.tank).toBe(1);
    expect(sim.propulsion.tankLeakAreaM2).toBeCloseTo(TANK_DMG.fullAreaM2, 12);
    const m0 = sim.getState().tank.airMassKg;
    r.run(1);
    const st = sim.getState();
    // choked flow 0.0404·A·p/√T at ≈ 690 bar: ≈ 13 kg/s at the start
    console.log('tank vent', { m0, m1: st.tank.airMassKg, leak: st.damage!.leakKgS });
    expect(m0 - st.tank.airMassKg).toBeGreaterThan(6); expect(m0 - st.tank.airMassKg).toBeLessThan(16);
    expect(st.damage!.leakKgS).toBeGreaterThan(5);
    sim.reset(spawnPose(ROAD, 0, 0));
    expect(sim.propulsion.tankLeakAreaM2).toBe(0);
    expect(dm.tankEnergy()).toBe(0);
    expect(sim.getState().damage!.tank).toBe(0);
    sim.dispose();
  });

  it('Visual: the tank damage is shown but nothing leaks', async () => {
    const r = await standing('visual');
    r.vm.damage.inject(r.sim, { x: 0.96, y: 0.1, z: -1.0 }, { x: -1, y: 0, z: 0 }, TANK_DMG.fullJ);
    expect(r.vm.damage.state.tank).toBe(1);
    expect(r.sim.propulsion.tankLeakAreaM2).toBe(0);
    const m0 = r.sim.getState().tank.airMassKg;
    r.run(0.5);
    expect(r.sim.getState().tank.airMassKg).toBeCloseTo(m0, 3);
    r.sim.dispose();
  });
});
