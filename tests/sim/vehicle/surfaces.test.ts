// ground materials. Tire/soil model unit checks and per-surface driving tests (Earth asphalt,
// concrete, grass, sand; Moon regolith at 1/6 g; Mars soil at 0.38 g).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { ROADSTER } from '../../../src/shared/roadster';
import { DEG, G0, clamp, qaxisAngle, qrot } from '../../../src/shared/math';
import { EARTH, MARS, MOON, type Environment, type SurfaceKind } from '../../../src/shared/environment';
import { steerLimitRad } from '../../../src/sim/vehicle';
import { GEOM } from '../../../src/sim/vehicle/params';
import { ASPHALT_TIRE, combinedForce } from '../../../src/sim/vehicle/tire';
import {
  MARS_SOIL, REGOLITH, SAND, SURFACES, bulldozingResistance, compactionResistance, janosi, slipSinkageFactor, staticSinkage,
} from '../../../src/sim/vehicle/surfaces';
import { mean, prespinFans, rampPose, resetInputs, rig, wallRamp, type Rig } from './helpers';

const gOf = (e: Environment) => Math.hypot(e.gravity.x, e.gravity.y, e.gravity.z);
const W = ROADSTER.wheels;
/** Static rear axle share and CoG height / wheelbase (load transfer). */
const REAR_SHARE = W[0].pos.z / (W[0].pos.z - W[2].pos.z), H_L = ROADSTER.restCogHeightM / (W[0].pos.z - W[2].pos.z);
/** RWD traction ceiling a/g = mu (rear share + h/L a/g)  ->  a/g = mu rear / (1 - mu h/L). */
const rwdCeiling = (mu: number) => (mu * REAR_SHARE) / (1 - mu * H_L);

describe('surface tire / soil model (unit)', () => {
  it('asphalt profile is the original model; every profile stays inside the friction circle', () => {
    const a = { fx: 0, fy: 0 }, b = { fx: 0, fy: 0 };
    for (const [sx, sy] of [[0.05, 0], [0.2, 0.1], [-0.3, 0.05], [0.01, -0.4]]) {
      combinedForce(sx, sy, 5000, a);
      combinedForce(sx, sy, 5000, b, ASPHALT_TIRE);
      expect(b.fx).toBe(a.fx); expect(b.fy).toBe(a.fy);
      for (const k of Object.keys(SURFACES) as SurfaceKind[]) {
        combinedForce(sx, sy, 5000, b, SURFACES[k].tire);
        expect(Math.hypot(b.fx, b.fy)).toBeLessThanOrEqual(5000 * (1 + 1e-12));
      }
    }
  });

  it('soil shear curve (Janosi-Hanamoto): monotone, no peak and no fall-off, flatter than rubber', () => {
    let prev = 0;
    for (let x = 0.05; x < 60; x += 0.05) { const g = janosi(x); expect(g).toBeGreaterThan(prev); expect(g).toBeLessThan(1); prev = g; }
    const sand = SURFACES.sand.tire, asph = SURFACES.asphalt.tire;
    expect(sand.cLong).toBeLessThan(0.6 * asph.cLong);       // flat initial rise
    expect(sand.fx(0.1)).toBeLessThan(asph.fx(0.1));
    expect(sand.fx(1.0)).toBeGreaterThan(sand.fx(0.3));       // still rising at full slip (no drop)
    expect(asph.fx(1.0)).toBeLessThan(asph.fx(asph.sxN));     // rubber on asphalt falls off past the peak
    // peak force: Mohr-Coulomb  A c + W tan(phi), load-insensitive apart from the cohesion term
    expect(sand.peak(4000, 0)).toBeCloseTo(4000 * Math.tan(SAND.phiDeg * DEG), 6);
    expect(sand.peak(4000, 0.05)).toBeCloseTo(4000 * Math.tan(SAND.phiDeg * DEG) + 0.05 * SAND.cohesionPa, 6);
    expect(SURFACES.grass.tire.peak(4800, 0) / 4800).toBeCloseTo(0.55, 6);
  });

  it('Bekker sinkage / resistance: magnitudes and validation against the Apollo LRV', () => {
    const rear = W[2];
    const wE = (1950 * G0 * 0.528) / 2;
    const zSand = staticSinkage(wE, rear.width, rear.radius, SAND);
    const zMoon = staticSinkage((1950 * gOf(MOON) * 0.528) / 2, rear.width, rear.radius, REGOLITH);
    const zMars = staticSinkage((1950 * gOf(MARS) * 0.528) / 2, rear.width, rear.radius, MARS_SOIL);
    // LRV: ≈ 285 N per wheel on the Moon, 0.23 m wide, 0.82 m diameter; observed tracks ≈ 1.25 cm
    const zLrv = staticSinkage(700 * gOf(MOON) / 4, 0.23, 0.41, REGOLITH);
    console.log('sinkage cm', { zSand: zSand * 100, zMoon: zMoon * 100, zMars: zMars * 100, zLrv: zLrv * 100 });
    expect(zSand).toBeGreaterThan(0.008); expect(zSand).toBeLessThan(0.025);
    expect(zMoon).toBeGreaterThan(0.015); expect(zMoon).toBeLessThan(0.05);
    expect(zMars).toBeGreaterThan(0.015); expect(zMars).toBeLessThan(0.05);
    expect(zLrv).toBeGreaterThan(0.008); expect(zLrv).toBeLessThan(0.025);
    // resistance coefficients (compaction + bulldozing) / wheel load: packed sand 0.05–0.2
    const rSand = (compactionResistance(zSand, rear.width, SAND) + bulldozingResistance(zSand, rear.width, SAND, G0)) / wE;
    expect(rSand).toBeGreaterThan(0.05); expect(rSand).toBeLessThan(0.2);
    // a following wheel in the rut only compacts the extra depth
    expect(compactionResistance(zSand, rear.width, SAND, 0.9 * zSand)).toBeLessThan(0.3 * compactionResistance(zSand, rear.width, SAND));
    expect(slipSinkageFactor(0)).toBe(1); expect(slipSinkageFactor(0.2)).toBeCloseTo(1.2 / 0.9, 9);
    expect(slipSinkageFactor(1)).toBeGreaterThan(3.5);
  });
});

// ------------------------------------------------------------------------------------------ driving

interface Case { surface: SurfaceKind; env: Environment }
const CASES: Case[] = [
  { surface: 'asphalt', env: EARTH }, { surface: 'concrete', env: EARTH }, { surface: 'grass', env: EARTH },
  { surface: 'sand', env: EARTH }, { surface: 'regolith', env: MOON }, { surface: 'mars_soil', env: MARS },
];
const label = (c: Case) => `${c.surface} (${c.env.body})`;

async function surfRig(c: Case): Promise<Rig> {
  const r = await rig();
  r.sim.setEnvironment(c.env);
  r.sim.surface = c.surface;
  return r;
}

/**
 * Test driver holding heading 0 / lane x0 (steer > 0 = right). RWD at the traction limit on loose
 * ground power-oversteers; ESC only acts outside its 0.03 rad/s yaw dead band, a driver corrects earlier.
 */
function holdLane(r: Rig, x0: number): void {
  const st = r.sim.getState();
  const fwd = qrot(st.quat, { x: 0, y: 0, z: 1 });
  r.drive.steer = clamp(3 * fwd.x + 0.05 * (st.pos.x - x0) + 1.5 * st.angVel.y, -0.3, 0.3);
}

/** Full throttle from standstill (no fans, no jets) to 100 km/h. */
function accel100(r: Rig): { t: number; dist: number; maxRearSink: number; staticRearSink: number; dust: number } {
  resetInputs(r);
  r.sim.reset(spawnPose({ x: 0, y: 0, z: -2900 }, 0));
  r.run(2);
  const ch = r.vm.chassis;
  const staticRearSink = ch.wheels[2].sink;
  const t0 = r.sim.getState().t, z0 = r.sim.getState().pos.z;
  r.drive.throttle = 1;
  let t = -1, maxRearSink = 0, dust = 0;
  r.run(200, (tt) => {
    holdLane(r, 0);
    maxRearSink = Math.max(maxRearSink, ch.wheels[2].sink);
    dust = Math.max(dust, ch.wheels[2].dust);
    if (r.sim.getState().speedMs >= 100 / 3.6) { t = tt - t0; return true; }
  });
  return { t, dist: r.sim.getState().pos.z - z0, maxRearSink, staticRearSink, dust };
}

/** Full braking 100–0 km/h (normalised to exactly 100 km/h). */
function brake100(r: Rig): { dist: number; meanG: number; minRoll: number } {
  const v0 = 100 / 3.6;
  resetInputs(r);
  r.sim.reset(spawnPose({ x: 0, y: 0, z: -2900 }, 0, v0));
  r.run(0.5);
  const p0 = { ...r.sim.getState().pos }, v1 = r.sim.getState().speedMs;
  r.drive.brake = 1;
  let minRoll = Infinity;
  r.run(120, () => {
    holdLane(r, 0);
    const st = r.sim.getState();
    if (st.speedMs > 3) for (const w of r.vm.chassis.wheels) minRoll = Math.min(minRoll, (w.omega * w.r) / st.speedMs);
    return st.speedMs < 0.02;
  });
  const p = r.sim.getState().pos;
  const d = Math.hypot(p.x - p0.x, p.z - p0.z);
  return { dist: d * (v0 / v1) ** 2, meanG: (v1 * v1) / (2 * d) / G0, minRoll };
}

/** Closed-loop skidpad (left turn) with slowly rising speed; max sustained lateral acceleration in units of local g. */
function skidpad(r: Rig, R: number, v0: number, g: number): number {
  resetInputs(r);
  const c = { x: -300, z: 300 };
  r.sim.reset(spawnPose({ x: c.x + R, y: 0, z: c.z }, 180, v0));
  let vt = v0, best = 0, lost = 0;
  const win: number[] = [];
  const nWin = Math.round(1 / r.sim.dt);
  r.run(150, () => {
    const st = r.sim.getState(), p = st.pos, v = st.linVel;
    const rx = p.x - c.x, rz = p.z - c.z, d = Math.hypot(rx, rz);
    const tx = rz / d, tz = -rx / d;
    const sp = Math.hypot(v.x, v.z);
    const psiErr = Math.asin(clamp((v.z * tx - v.x * tz) / Math.max(sp, 0.1), -1, 1));
    const delta = Math.atan(GEOM.wheelbase / R) + 0.04 * (d - R) + 0.8 * psiErr + 0.15 * (sp / R - st.angVel.y);
    r.drive.steer = clamp(-delta / steerLimitRad(sp), -1, 1);
    r.drive.throttle = clamp(0.6 * (vt - sp), 0, 1);
    vt += 0.03 * g * r.sim.dt;
    win.push(st.specificForce.x);
    if (win.length > nWin) win.shift();
    if (Math.abs(d - R) < 1.5 && win.length === nWin) best = Math.max(best, mean(win) / g);
    if (Math.abs(d - R) > 6) lost++;
    return lost > nWin;
  });
  return best;
}

/** Hill start on a 15° slope (tilted gravity): brake hold, then full throttle; uphill progress after 8 s. */
function hillStart(r: Rig, env: Environment, fans: boolean): { up: number; rollBack: number; v: number } {
  resetInputs(r);
  r.sim.world.gravity = qrot(qaxisAngle({ x: 1, y: 0, z: 0 }, 15 * DEG), env.gravity);
  r.sim.reset(spawnPose({ x: 30, y: 0, z: -2000 }, 0));
  if (fans) { r.systems.fanMode = 'grip'; prespinFans(r, 1); }
  r.drive.brake = 1;
  r.run(3);
  const z0 = r.sim.getState().pos.z;
  r.drive.brake = 0; r.drive.throttle = 1;
  let minZ = z0;
  r.run(8, () => { holdLane(r, 30); minZ = Math.min(minZ, r.sim.getState().pos.z); });
  const st = r.sim.getState();
  r.sim.world.gravity = { ...env.gravity };
  return { up: st.pos.z - z0, rollBack: z0 - minZ, v: st.speedMs };
}

/** Standstill without inputs on flat ground: creep over 10 s after settling (m), and sinkage at rest. */
function standstill(r: Rig): { creep: number; sink: number[]; loads: number[] } {
  resetInputs(r);
  r.sim.reset(spawnPose({ x: -40, y: 0, z: -2000 }, 0));
  r.run(4);
  const p0 = { ...r.sim.getState().pos };
  r.run(10);
  const p1 = r.sim.getState().pos;
  return {
    creep: Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z),
    sink: r.vm.chassis.wheels.map((w) => w.sink), loads: r.vm.chassis.wheels.map((w) => w.N),
  };
}

const results: Record<string, unknown> = {};
afterAll(async () => {
  // R2_OUT=<file>: dump the measured numbers (report table)
  if (process.env.R2_OUT) (await import('node:fs')).writeFileSync(process.env.R2_OUT, 'R2 surface results ' + JSON.stringify(results, null, 1));
});

for (const c of CASES) {
  describe(`driving on ${label(c)}`, () => {
    let r: Rig;
    const g = gOf(c.env);
    const prof = SURFACES[c.surface];
    const mu = prof.tire.muNominal;
    beforeAll(async () => { r = await surfRig(c); });
    afterAll(() => r.sim.dispose());

    it('standstill: no creep, sinkage = Bekker static sinkage (0 on rigid surfaces)', () => {
      const s = standstill(r);
      results[`${label(c)} standstill`] = s;
      expect(s.creep).toBeLessThan(1e-3);
      for (let i = 0; i < 4; i++) {
        const exp = prof.soil ? staticSinkage(s.loads[i], W[i].width, W[i].radius, prof.soil) : 0;
        // plastic soil keeps the deepest settling transient: within a few % of the static Bekker value
        if (prof.soil) { expect(s.sink[i]).toBeGreaterThan(0.005); expect(s.sink[i] / exp).toBeGreaterThan(0.98); expect(s.sink[i] / exp).toBeLessThan(1.1); }
        else expect(s.sink[i]).toBe(0);
      }
      expect(r.sim.getState().wheels.every((w) => w.contact)).toBe(true);
      expect(r.vm.chassis.wheels.every((w) => w.surface === c.surface)).toBe(true);
    });

    it('0–100 km/h, full throttle, no fans/jets', () => {
      const a = accel100(r);
      const aMean = 100 / 3.6 / a.t;
      results[`${label(c)} 0-100`] = { ...a, aMeanG: aMean / g };
      expect(a.t).toBeGreaterThan(0);
      expect(r.sim.getState().crashed).toBe(false);
      expect(aMean / g).toBeLessThan(rwdCeiling(mu));
      if (prof.soil) {
        // soil: compaction/bulldozing eat a large part of the gross traction; slip sinkage while launching
        expect(aMean / g).toBeLessThan(0.75 * rwdCeiling(mu));
        expect(a.maxRearSink).toBeGreaterThan(1.05 * a.staticRearSink);
        expect(a.maxRearSink).toBeLessThan(3 * a.staticRearSink);
        expect(a.dust).toBeGreaterThan(0.5);
      } else expect(aMean / g).toBeGreaterThan(0.85 * rwdCeiling(mu));
    });

    it('braking 100–0 km/h', () => {
      const b = brake100(r);
      results[`${label(c)} 100-0`] = b;
      expect(b.minRoll).toBeGreaterThan(0.4);           // ABS keeps the wheels turning
      expect(r.sim.getState().speedMs).toBeLessThan(0.05);
    });

    it('skidpad R = 40 m, tires only', () => {
      const lat = skidpad(r, 40, c.env.body === 'earth' ? 8 : 3, g);
      results[`${label(c)} skidpad`] = { latG: lat, latEarthG: (lat * g) / G0 };
      // rubber: ≈ mu; soil: the Janosi curve still rises at 15° slip angle and the rear axle also has
      // to push the car through the soil -> clearly below tan(phi)
      if (prof.soil) { expect(lat).toBeGreaterThan(0.5 * mu); expect(lat).toBeLessThan(0.9 * mu); }
      else { expect(lat).toBeGreaterThan(0.85 * mu); expect(lat).toBeLessThan(1.05 * mu); }
    });

    it('hill start on 15°', () => {
      const h = hillStart(r, c.env, false);
      results[`${label(c)} hill15`] = h;
      expect(r.sim.getState().crashed).toBe(false);
      expect(h.rollBack).toBeLessThan(0.05);              // brake release never lets the car roll back
      if (!prof.soil) {
        expect(h.up).toBeGreaterThan(5);
      } else {
        // RWD budget on 15°: rear normal share ≈ 0.55 cos15 + h/L sin15, gross traction at the TC target
        // slip 0.55 tan(phi) janosi(..) ≈ 0.27 W  vs  W sin15 = 0.26 W + tire RR + front compaction/bulldozing
        // -> the car cannot pull away without help; it stays put (TC prevents digging in)
        expect(Math.abs(h.up)).toBeLessThan(0.5);
        expect(r.vm.chassis.wheels[2].sink).toBeLessThan(2.5 * staticSinkage(r.vm.chassis.wheels[2].N, W[2].width, W[2].radius, prof.soil));
        if (c.env.body === 'earth') {
          // with fan suction (only with an atmosphere) the normal load triples -> pulls away easily
          const hf = hillStart(r, c.env, true);
          results[`${label(c)} hill15 fans`] = hf;
          expect(hf.up).toBeGreaterThan(30);
        }
      }
    });
  });
}

describe('step-size convergence on soil (120 / 240 / 480 Hz)', () => {
  it('sand: braking distance and 0–100 time differ < 3 %', async () => {
    const res: Record<number, { brake: number; t100: number }> = {};
    for (const hz of [120, 240, 480]) {
      const r = await rig({ dt: 1 / hz });
      r.sim.surface = 'sand';
      res[hz] = { brake: brake100(r).dist, t100: accel100(r).t };
      r.sim.dispose();
    }
    results['sand convergence'] = res;
    for (const k of ['brake', 't100'] as const) {
      expect(Math.abs(res[120][k] - res[480][k]) / res[480][k]).toBeLessThan(0.03);
      expect(Math.abs(res[240][k] - res[480][k]) / res[480][k]).toBeLessThan(0.03);
    }
  });
});

describe('surface detection and fans', () => {
  it('McGregor ramps are concrete even when the site surface is something else', async () => {
    const r = await rig();
    r.sim.surface = 'sand';
    resetInputs(r);
    const rp = rampPose(wallRamp(), 20);
    r.sim.reset(rp.spawn);
    r.drive.brake = 1; r.systems.fanMode = 'grip'; r.systems.fanLevel = 1; prespinFans(r);
    r.run(0.5);
    expect(r.vm.chassis.wheels.every((w) => w.contact && w.surface === 'concrete')).toBe(true);
    expect(r.vm.chassis.wheels.every((w) => w.sink === 0)).toBe(true);
    r.sim.dispose();
  });

  it('skirts seal worse on grass and sand (less sealed suction), loose ground throws dust', async () => {
    const out: Record<string, { kg: number; gap: number; dust: number }> = {};
    for (const s of ['asphalt', 'grass', 'sand'] as SurfaceKind[]) {
      const r = await rig();
      r.sim.surface = s;
      resetInputs(r);
      r.sim.reset(spawnPose({ x: 0, y: 0, z: 0 }, 0));
      r.systems.fanMode = 'grip'; r.systems.fanLevel = 1; prespinFans(r);
      r.run(3);
      const f = r.sim.getState().fans;
      out[s] = { kg: f.forceN / G0, gap: f.gapM, dust: r.vm.fans.dust };
      r.sim.dispose();
    }
    results['sealed suction'] = out;
    expect(out.grass.kg).toBeLessThan(out.sand.kg);
    expect(out.sand.kg).toBeLessThan(out.asphalt.kg);
    expect(out.asphalt.dust).toBe(0); expect(out.sand.dust).toBeGreaterThan(0.5);
  });
});
