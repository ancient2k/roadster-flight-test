// movable, breakable landmarks (src/sim/core/props.ts) and ramming Roadster 1.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createRoadsterSim } from '../../../src/sim/vehicle';
import { spawnPose, type RoadsterSim } from '../../../src/sim/core/roadsterSim';
import { MARS, MOON, SPACE } from '../../../src/shared/environment';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';
import { ROADSTER1_PROP, objectMass, type PropObjectDef, type PropPlacement } from '../../../src/shared/props';

const metaDyn = (site: string): PropObjectDef[] => JSON.parse(fs.readFileSync(`public/assets/worlds/${site}/meta.json`, 'utf8')).landmarks[0].dynamic;
const LM = metaDyn('moon_tranquility')[0];
const [FALCON, LRV] = metaDyn('moon_hadley');
const PERS = metaDyn('mars_jezero')[0];
const CUR = metaDyn('mars_gale')[0];
const LEG = LM.parts.findIndex((p) => p.id === 'leg_pz');

/** LM on the flat McGregor ground (Moon gravity), car approaching its +Z (ladder) leg along −Z. */
async function ramLM(v: number, seconds = 4): Promise<{ sim: RoadsterSim; crashed: boolean; maxDv: number }> {
  const sim = await createRoadsterSim({ ground: 'track', props: [{ landmarkId: 'lm', pos: { x: 300, y: 0, z: 300 }, headingDeg: 0, def: LM }] });
  sim.setEnvironment(MOON);
  sim.reset(spawnPose({ x: 300, y: 0, z: 300 + 4.72 + 12 }, 180, v));
  let maxDv = 0;
  for (let i = 0; i < 240 * seconds; i++) { sim.step(neutralDrive(), neutralSystems(), zeroThrust()); maxDv = Math.max(maxDv, sim.propImpactDv); }
  return { sim, crashed: sim.getState().crashed, maxDv };
}
const tiltDeg = (q: { x: number; z: number }) => 2 * Math.asin(Math.min(1, Math.hypot(q.x, q.z))) * 180 / Math.PI;

describe('prop definitions (meta.json)', () => {
  it('total masses are the published ones', () => {
    expect(objectMass(LM)).toBeCloseTo(2034, 6);       // LM-5 Eagle descent stage
    expect(objectMass(FALCON)).toBeCloseTo(2809, 6);   // LM-10 Falcon descent stage
    expect(objectMass(LRV)).toBeCloseTo(210, 6);       // LRV-1
    expect(objectMass(PERS)).toBeCloseTo(1025, 6);
    expect(objectMass(CUR)).toBeCloseTo(899, 6);
    expect(objectMass(ROADSTER1_PROP)).toBe(1250);
  });
  it('every part but the main body hangs on a breakable joint', () => {
    for (const d of [LM, FALCON, LRV, PERS, CUR]) {
      expect(d.parts[0].joint).toBeUndefined();
      for (const p of d.parts.slice(1)) { expect(p.joint).toBeDefined(); expect(p.joint!.breakEnergyJ).toBeGreaterThan(0); }
    }
  });
});

describe('Apollo LM descent stage', () => {
  it('at rest it stays put, asleep, all four legs and the engine on', async () => {
    const { sim } = await ramLM(0, 2);
    const b = sim.props!.partPose(0, 0);
    expect(Math.hypot(b.pos.x - 300, b.pos.y, b.pos.z - 300)).toBeLessThan(1e-3);
    expect(sim.props!.intactJoints).toBe(5);
    expect(sim.props!.sleeping(0)).toBe(true);
    sim.dispose();
  });
  it('rammed at 4 m/s it is shoved, the leg holds (below its 28.7 kJ)', async () => {
    const { sim, maxDv } = await ramLM(4);
    const b = sim.props!.partPose(0, 0);
    expect(300 - b.pos.z).toBeGreaterThan(0.5);      // pushed along −Z
    expect(sim.props!.intactJoints).toBe(5);
    // closing energy ½ m_eff v²: at most the central value ½ μ v² (μ of car and 2034 kg), less for a blow on the
    // leg 4.7 m from the centre of mass (lever arm → smaller effective mass)
    const m = sim.getState().massKg, mu = (m * 2034) / (m + 2034);
    const ratio = sim.props!.peakEnergy(0, LEG) / (0.5 * mu * 16);
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThanOrEqual(1);
    // nearly plastic: the car loses about 2034 / (m + 2034) of its speed, not all of it
    expect(maxDv).toBeGreaterThan(1.5);
    expect(maxDv).toBeLessThan(3.5);
    sim.dispose();
  });
  it('the leg holds at 9 m/s and breaks off at 13 m/s (threshold ≈ 10 m/s)', async () => {
    const lo = await ramLM(9);
    expect(lo.sim.props!.jointIntact(0, LEG)).toBe(true);
    expect(lo.sim.props!.events.filter((e) => e.partId.startsWith('leg'))).toHaveLength(0);
    lo.sim.dispose();
    const hi = await ramLM(13);
    expect(hi.sim.props!.jointIntact(0, LEG)).toBe(false);
    const ev = hi.sim.props!.events.find((e) => e.partId === 'leg_pz')!;
    expect(ev.energyJ).toBeGreaterThan(28_700);
    // the leg flies on by itself: it is no longer where the body's frame puts it
    const b = hi.sim.props!.partPose(0, 0), l = hi.sim.props!.partPose(0, LEG);
    expect(Math.hypot(l.pos.x - b.pos.x, l.pos.y - b.pos.y, l.pos.z - b.pos.z)).toBeGreaterThan(0.5);
    // a 2 t lander is no light object: the car stops hard (crash) – Δv of the car well over 4 m/s
    expect(hi.crashed).toBe(true);
    hi.sim.dispose();
  });
  it('a restart puts it back together where it stood', async () => {
    const { sim } = await ramLM(13, 2);
    expect(sim.props!.intactJoints).toBeLessThan(5);
    sim.reset(spawnPose({ x: 300, y: 0, z: 330 }, 180, 0));
    expect(sim.props!.intactJoints).toBe(5);
    expect(sim.props!.events).toHaveLength(0);
    const b = sim.props!.partPose(0, 0);
    expect(Math.hypot(b.pos.x - 300, b.pos.y, b.pos.z - 300)).toBeLessThan(1e-6);
    expect(tiltDeg(b.quat)).toBeLessThan(1e-3);
    sim.dispose();
  });
});

describe('light objects: impulse transfer instead of a wall', () => {
  it('ramming the 210 kg LRV at 8 m/s throws it away without crashing the car', async () => {
    const sim = await createRoadsterSim({ ground: 'track', props: [{ landmarkId: 'lrv', pos: { x: 300, y: 0, z: 300 }, headingDeg: 0, def: { ...LRV, origin: [0, 0, 0], yawDeg: 0 } }] });
    sim.setEnvironment(MOON);
    sim.reset(spawnPose({ x: 300.6, y: 0, z: 300 + 14 }, 180, 8));
    let maxDv = 0;
    for (let i = 0; i < 240 * 3; i++) { sim.step(neutralDrive(), neutralSystems(), zeroThrust()); maxDv = Math.max(maxDv, sim.propImpactDv); }
    const c = sim.props!.partPose(0, 0);
    expect(300 - c.pos.z).toBeGreaterThan(3);
    expect(maxDv).toBeGreaterThan(0.2);
    expect(maxDv).toBeLessThan(4);
    expect(sim.getState().crashed).toBe(false);
    sim.dispose();
  });
});

describe('Mars rovers', () => {
  it.each([['Perseverance', PERS], ['Curiosity', CUR]] as const)('%s rammed at 9 m/s: shoved, a wheel breaks off, nothing explodes', async (_n, def) => {
    const sim = await createRoadsterSim({ ground: 'track', props: [{ landmarkId: def.id, pos: { x: 300, y: 0, z: 300 }, headingDeg: 0, def }] });
    sim.setEnvironment(MARS);
    sim.reset(spawnPose({ x: 300.3, y: 0, z: 314 }, 180, 9));
    let maxV = 0;
    for (let i = 0; i < 240 * 4; i++) {
      sim.step(neutralDrive(), neutralSystems(), zeroThrust());
      for (const p of sim.props!.objects[0].parts) { const v = p.owner.body.linvel(); maxV = Math.max(maxV, Math.hypot(v.x, v.y, v.z)); }
    }
    const b = sim.props!.partPose(0, 0);
    expect(Number.isFinite(b.pos.x + b.pos.y + b.pos.z)).toBe(true);
    expect(300 - b.pos.z).toBeGreaterThan(2);
    expect(sim.props!.events.some((e) => e.partId.startsWith('wheel'))).toBe(true);
    expect(maxV).toBeLessThan(20);
    sim.dispose();
  });
});

describe('breaking off conserves momentum', () => {
  it('a wheel torn off the LRV in free space: car + rover + wheel keep the momentum', async () => {
    const sim = await createRoadsterSim({ ground: 'space', props: [{ landmarkId: 'lrv', pos: { x: 0, y: 0, z: 0 }, headingDeg: 0, def: { ...LRV, origin: [0, 0, 0], yawDeg: 0 } }] });
    sim.setEnvironment(SPACE);
    // aim the car's nose at the front-left wheel (x = +0.8, z = +1.1, y = 0.41)
    sim.reset(spawnPose({ x: 0.8, y: 0.0, z: 10 }, 180, 12));
    const m = sim.getState().massKg, p0z = -m * 12;
    for (let i = 0; i < 240 * 2; i++) sim.step(neutralDrive(), neutralSystems(), zeroThrust());
    expect(sim.props!.events.length).toBeGreaterThan(0);
    const st = sim.getState(), pr = sim.props!.momentum(0);
    const p1 = { x: m * st.linVel.x + pr.x, y: m * st.linVel.y + pr.y, z: m * st.linVel.z + pr.z };
    expect(Math.hypot(p1.x, p1.y, p1.z - p0z) / Math.abs(p0z)).toBeLessThan(0.005);
    sim.dispose();
  });
});

describe('ramming Roadster 1 in space', () => {
  const place = (): PropPlacement => ({ landmarkId: 'roadster1', pos: { x: 0, y: 0, z: 0 }, headingDeg: 0, def: ROADSTER1_PROP });
  it('momentum is conserved and Roadster 1 takes up Δv = J / m', async () => {
    const sim = await createRoadsterSim({ ground: 'space', props: [place()] });
    sim.setEnvironment(SPACE);
    sim.reset(spawnPose({ x: 0, y: -0.2, z: 9 }, 180, 6));
    const m = sim.getState().massKg;
    const p0 = { x: 0, y: 0, z: m * sim.getState().linVel.z };
    for (let i = 0; i < 240 * 3; i++) sim.step(neutralDrive(), neutralSystems(), zeroThrust());
    const st = sim.getState(), pr = sim.props!.momentum(0);
    const p1 = { x: m * st.linVel.x + pr.x, y: m * st.linVel.y + pr.y, z: m * st.linVel.z + pr.z };
    expect(Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z) / Math.abs(p0.z)).toBeLessThan(0.005);
    const v = sim.props!.velocity(0);
    expect(v.z).toBeLessThan(-2);                       // pushed along the car's direction
    expect(v.z).toBeGreaterThan(-2 * m * 6 / (m + 1250) - 0.1);   // at most the elastic limit
    expect(Math.abs(v.z * 1250 - pr.z)).toBeLessThan(1e-6 + Math.abs(pr.z) * 1e-9);
    sim.dispose();
  });
});
