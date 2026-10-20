// (Lead-Ergänzung): the Stonehenge stones as movable props – set stones held by their sockets, lintels loose.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createRoadsterSim } from '../../../src/sim/vehicle';
import { spawnPose, type RoadsterSim } from '../../../src/sim/core/roadsterSim';
import { EARTH } from '../../../src/shared/environment';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';
import type { PropObjectDef } from '../../../src/shared/props';

const DEFS: PropObjectDef[] = JSON.parse(fs.readFileSync('public/assets/worlds/earth_stonehenge/meta.json', 'utf8')).landmarks[0].dynamic;
const C = { x: 1000, z: 1000 };   // circle centre on the flat McGregor ground, away from the track furniture
const idx = (id: string) => DEFS.findIndex((d) => d.id === id);

/** Car aimed at a stone from `dist` m outside along the circle radius, at speed v. */
async function ram(id: string, v: number, seconds = 4, dist = 12, only = false): Promise<{ sim: RoadsterSim; maxDv: number }> {
  const defs = only ? DEFS.filter((d) => d.id === id) : DEFS;
  const sim = await createRoadsterSim({ ground: 'track', props: defs.map((def) => ({ landmarkId: 'stonehenge', pos: { x: C.x, y: 0, z: C.z }, headingDeg: 0, def })) });
  sim.setEnvironment(EARTH);
  const d = DEFS[idx(id)];
  const r = Math.hypot(d.origin[0], d.origin[2]), ux = d.origin[0] / r, uz = d.origin[2] / r;
  const heading = Math.atan2(-ux, -uz) * 180 / Math.PI;
  sim.reset(spawnPose({ x: C.x + d.origin[0] + ux * dist, y: 0, z: C.z + d.origin[2] + uz * dist }, heading, v));
  let maxDv = 0;
  for (let i = 0; i < 240 * seconds; i++) { sim.step(neutralDrive(), neutralSystems(), zeroThrust()); maxDv = Math.max(maxDv, sim.propImpactDv); }
  return { sim, maxDv };
}
const pos = (sim: RoadsterSim, id: string) => sim.props!.partPose(sim.props!.objects.findIndex((o) => o.def.id === id), 0).pos;
const oi = (sim: RoadsterSim, id: string) => sim.props!.objects.findIndex((o) => o.def.id === id);

describe('Stonehenge stones', () => {
  it('masses from volume × density: sarsen upright ≈ 20 t, trilithon 30–45 t, lintel ≈ 5–7 t, bluestone 1–3 t', () => {
    const m = (id: string) => DEFS[idx(id)].parts[0].massKg / 1000;
    expect(m('stone0')).toBeGreaterThan(18); expect(m('stone0')).toBeLessThan(30);
    expect(m('stone31')).toBeGreaterThan(30); expect(m('stone31')).toBeLessThan(45);
    expect(m('stone27')).toBeGreaterThan(5); expect(m('stone27')).toBeLessThan(8);
    expect(m('stone60')).toBeGreaterThan(1); expect(m('stone60')).toBeLessThan(3);
    expect(DEFS.filter((d) => d.anchor).length).toBe(70);
  });
  it('at rest everything stays where it is (lintels on their uprights)', async () => {
    const { sim } = await ram('stone0', 0, 3, 40);
    for (const id of ['stone26', 'stone27', 'stone33', 'stone36']) {
      const p = pos(sim, id), d = DEFS[idx(id)];
      expect(Math.hypot(p.x - C.x - d.origin[0], p.y - d.origin[1], p.z - C.z - d.origin[2])).toBeLessThan(0.05);   // settling on the uprights
    }
    expect(sim.props!.events).toHaveLength(0);
    sim.dispose();
  });
  it('a sarsen upright at 15 m/s (54 km/h): the car bounces off and crashes, the stone does not move', async () => {
    const { sim, maxDv } = await ram('stone1', 15);
    expect(sim.props!.anchored(idx('stone1'))).toBe(true);
    const p = pos(sim, 'stone1'), d = DEFS[idx('stone1')];
    expect(Math.hypot(p.x - C.x - d.origin[0], p.z - C.z - d.origin[2])).toBeLessThan(1e-3);
    expect(maxDv).toBeGreaterThan(10);   // wall-like: the car loses (and reverses) its speed
    expect(sim.getState().crashed).toBe(true);
    // the blow reached the socket with far less than its capacity
    expect(sim.props!.peakEnergy(idx('stone1'), 0)).toBeLessThan(DEFS[idx('stone1')].anchor!.breakEnergyJ);
    sim.dispose();
  });
  it('55 m/s breaks the socket, but the lintel braces the upright and it stays standing', async () => {
    const { sim } = await ram('stone1', 55, 4, 20);
    expect(sim.props!.events.some((e) => e.objectId === 'stone1' && e.partId === 'anchor')).toBe(true);
    expect(pos(sim, 'stone27').y).toBeGreaterThan(DEFS[idx('stone27')].origin[1] - 0.2);
    sim.dispose();
  });
  it('90 m/s: the upright topples and its lintel falls', async () => {
    const { sim } = await ram('stone1', 90, 5, 25);
    expect(sim.props!.anchored(idx('stone1'))).toBe(false);
    // stone 27 rests on stones 0 and 1
    expect(pos(sim, 'stone27').y).toBeLessThan(DEFS[idx('stone27')].origin[1] - 1.5);
    sim.dispose();
  });
  it('a car flying into a lintel at 20 m/s pushes it off its uprights', async () => {
    const sim = await createRoadsterSim({ ground: 'track', props: DEFS.map((def) => ({ landmarkId: 'stonehenge', pos: { x: C.x, y: 0, z: C.z }, headingDeg: 0, def })) });
    sim.setEnvironment(EARTH);
    const d = DEFS[idx('stone27')];
    const r = Math.hypot(d.origin[0], d.origin[2]), ux = d.origin[0] / r, uz = d.origin[2] / r;
    // CoG 0.72 m above the lintel underside: the hull (0.35 m below the CoG) clears the upright tops, flying inward
    sim.reset(spawnPose({ x: C.x + d.origin[0] + ux * 3.0, y: d.origin[1] + 0.72 - 0.45, z: C.z + d.origin[2] + uz * 3.0 }, Math.atan2(-ux, -uz) * 180 / Math.PI, 20));
    for (let i = 0; i < 240 * 3; i++) { sim.step(neutralDrive(), neutralSystems(), zeroThrust()); if (process.env.DBG && i % 20 === 0) { const st = sim.getState(); console.log('L', i, (st.pos.x - C.x).toFixed(2), st.pos.y.toFixed(2), (st.pos.z - C.z).toFixed(2), 'v', st.linVel.x.toFixed(1), st.linVel.y.toFixed(1), st.linVel.z.toFixed(1), sim.contacts.map((c) => c.id).join(','), 'lintel', JSON.stringify(pos(sim, 'stone27'))); } }
    expect(pos(sim, 'stone27').y).toBeLessThan(d.origin[1] - 1.5);
    expect(sim.props!.anchored(idx('stone0'))).toBe(true);
    expect(sim.props!.anchored(idx('stone1'))).toBe(true);
    sim.dispose();
  });
  it('a sarsen upright holds even at 35 m/s (126 km/h) – the socket takes it', async () => {
    const { sim } = await ram('stone1', 35, 3, 20);
    expect(sim.props!.anchored(idx('stone1'))).toBe(true);
    expect(sim.props!.peakEnergy(idx('stone1'), 0)).toBeGreaterThan(5000);
    sim.dispose();
  });
  it('a bluestone (≈ 2 t) is knocked over at 8 m/s, a lying bluestone is shoved', async () => {
    const a = await ram('stone60', 8, 3, 14, true);
    expect(a.sim.props!.anchored(oi(a.sim, 'stone60'))).toBe(false);
    const p = pos(a.sim, 'stone60'), d = DEFS[idx('stone60')];
    expect(Math.hypot(p.x - C.x - d.origin[0], p.z - C.z - d.origin[2])).toBeGreaterThan(0.3);
    a.sim.dispose();
    const b = await ram('stone50', 6, 3, 12, true);
    const q = pos(b.sim, 'stone50'), e = DEFS[idx('stone50')];
    expect(Math.hypot(q.x - C.x - e.origin[0], q.z - C.z - e.origin[2])).toBeGreaterThan(0.3);
    b.sim.dispose();
  });
});
