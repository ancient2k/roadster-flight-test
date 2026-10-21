// Pyramid regression tests beyond the synthetic straight climb :
//  - all 9 real Giza pyramid models (GLB vertices → fit → frustum mesh + talus): fit plausible, mesh closed,
//    the car climbs the north face from the plateau and holds on the face with the brakes;
//  - diagonal approach into a corner ridge and steering into the arris: the car demonstrably reaches the
//    arris (< 2 m, > 3 m up) without penetration, NaN or crash;
//  - uneven ground in front of the talus (bedrock court): climb and park level on the summit.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readGlbFile } from '../../assets/glbFile';
import { createRoadsterSim, vehicleModules } from '../../../src/sim/vehicle';
import { spawnPose, type RoadsterSim } from '../../../src/sim/core/roadsterSim';
import { CREST_R, fitPyramid, halfWidthAt, pyramidHeightAt, pyramidHullMesh, pyramidTalus, type PyramidFit } from '../../../src/shared/pyramid';
import { hudPitchDeg } from '../../../src/shared/math';
import { neutralDrive, neutralSystems, zeroThrust } from '../../../src/shared/types';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const DEG = Math.PI / 180;

/** World-space POSITION vertices of a single-mesh GLB placed like landmarkMatrix() does. */
function glbPoints(file: string, x: number, y: number, z: number, headingDeg: number): Float32Array {
  const buf = readGlbFile(root + 'public/assets/worlds/earth_giza/' + file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const c = Math.cos(headingDeg * DEG), s = Math.sin(headingDeg * DEG);
  const out: number[] = [];
  for (const mesh of json.meshes) for (const prim of mesh.primitives) {
    const acc = json.accessors[prim.attributes.POSITION];
    const bv = json.bufferViews[acc.bufferView];
    const off = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0), stride = bv.byteStride ?? 12;
    for (let i = 0; i < acc.count; i++) {
      const px = buf.readFloatLE(off + i * stride), py = buf.readFloatLE(off + i * stride + 4), pz = buf.readFloatLE(off + i * stride + 8);
      // rotation about +Y by heading (three.js: x' = c x + s z, z' = -s x + c z)
      out.push(x + c * px + s * pz, y + py, z - s * px + c * pz);
    }
  }
  return new Float32Array(out);
}

const meta = JSON.parse(readFileSync(root + 'public/assets/worlds/earth_giza/meta.json', 'utf8'));
const PYRAMIDS: { file: string; y: number; headingDeg: number }[] = meta.landmarks.filter((l: { collider?: string }) => l.collider === 'pyramid');

function signedVolume(t: Float32Array): number {
  let vol = 0;
  for (let i = 0; i < t.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.subarray(i, i + 9);
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

/** Every edge of a closed mesh is shared by exactly two triangles, once in each direction. */
function edgesPaired(t: Float32Array): boolean {
  const key = (i: number) => `${t[i].toFixed(3)},${t[i + 1].toFixed(3)},${t[i + 2].toFixed(3)}`;
  const count = new Map<string, number>();
  for (let i = 0; i < t.length; i += 9) {
    const v = [key(i), key(i + 3), key(i + 6)];
    for (let k = 0; k < 3; k++) { const e = `${v[k]}>${v[(k + 1) % 3]}`; count.set(e, (count.get(e) ?? 0) + 1); }
  }
  for (const [e, n] of count) {
    const [a, b] = e.split('>');
    if (n !== 1 || count.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

interface Run { maxY: number; crashed: boolean; penetrated: boolean; finite: boolean; sim: RoadsterSim; log: string[]; minArrisM: number; maxYNearArris: number }

/** Horizontal distance of (x, z) to the (-,-) arris of a pyramid centred at the origin (the line x = z). */
const arrisDist = (x: number, z: number) => (x < 0 && z < 0 ? Math.abs(x - z) / Math.SQRT2 : Infinity);

/** Drive at heading `headingDeg` from (x0, z0), cruise vSet, fans on demand (as in the manual mode), keep the line x = xLine. */
function drive(sim: RoadsterSim, fit: PyramidFit, x0: number, y0: number, z0: number, headingDeg: number, seconds: number,
  opts: { vSet?: number; xLine?: number | null; parkFlat?: boolean; holdBelowTopM?: number; capTop?: number } = {}): Run {
  const d = neutralDrive(), sys = neutralSystems(), thr = zeroThrust();
  sys.fanMode = 'grip'; sys.fanLevel = null;
  vehicleModules(sim).fans.rpm = 1;
  sim.reset(spawnPose({ x: x0, y: y0, z: z0 }, headingDeg));
  let maxY = -Infinity, crashed = false, penetrated = false, finite = true, parked = 0, minArrisM = Infinity, maxYNearArris = -Infinity;
  const log: string[] = [];
  for (let i = 0; i < Math.round(seconds / sim.dt); i++) {
    const s = sim.getState();
    const pitch = hudPitchDeg(s.quat);
    const vSet = s.pos.y > fit.yTop - 12 ? Math.min(opts.vSet ?? 7, opts.capTop ?? 6.5) : (opts.vSet ?? 7);
    if (opts.parkFlat && s.pos.y > fit.yTop - 2 && (parked > 0 || Math.abs(pitch) < 8)) { d.throttle = 0; d.brake = 1; parked++; }
    else if (opts.holdBelowTopM != null && (parked > 0 || s.pos.y > fit.yTop - opts.holdBelowTopM)) { d.throttle = 0; d.brake = 1; parked++; }
    else {
      d.brake = 0;
      d.throttle = s.pos.y > fit.yTop - 3 && pitch < 25 ? 0 : s.speedMs < vSet ? 1 : 0;
    }
    if (opts.xLine != null) d.steer = Math.max(-0.3, Math.min(0.3, (s.linVel.x + 0.3 * (s.pos.x - opts.xLine)) * 0.5));
    sim.step(d, sys, thr);
    if (![s.pos.x, s.pos.y, s.pos.z, s.speedMs].every(Number.isFinite)) { finite = false; break; }
    // the CoG must never end up below the stone surface (tunnelling into the pyramid)
    // (measured against the rounded crest of the collider, which lies up to ≈ 1.3 m below the sharp frustum edge)
    if (s.pos.y < pyramidHeightAt(fit, s.pos.x, s.pos.z, CREST_R) - 0.2 && !penetrated) { penetrated = true; log.push(`PENETRATED t=${s.t.toFixed(2)}`); }
    if (s.crashed && !crashed) log.push(`CRASH t=${s.t.toFixed(2)} contacts=${JSON.stringify(sim.contacts)}`);
    if (i % 240 === 0 || (s.crashed && !crashed)) log.push(`t=${s.t.toFixed(1)} x=${s.pos.x.toFixed(1)} y=${s.pos.y.toFixed(1)} z=${s.pos.z.toFixed(1)} v=${s.speedMs.toFixed(1)} p=${pitch.toFixed(0)} w=${s.wheels.filter((w) => w.contact).length} fan=${(s.fans.forceN / 9.81).toFixed(0)} body=${s.bodyContact} surf=${(pyramidHeightAt(fit, s.pos.x, s.pos.z)).toFixed(1)}`);
    maxY = Math.max(maxY, s.pos.y); crashed ||= s.crashed;
    if (s.pos.y > 1) { const da = arrisDist(s.pos.x, s.pos.z); minArrisM = Math.min(minArrisM, da); if (da < 2) maxYNearArris = Math.max(maxYNearArris, s.pos.y); }
    if (parked > 240 * 3) break;
  }
  return { maxY, crashed, penetrated, finite, sim, log, minArrisM, maxYNearArris };
}

async function worldFor(fit: PyramidFit, groundAt: (x: number, z: number) => number, n = 257, extentM = 768): Promise<RoadsterSim> {
  const heights = new Float32Array(n * n);
  const cell = extentM / (n - 1);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) heights[r * n + c] = groundAt(-extentM / 2 + c * cell, -extentM / 2 + r * cell);
  const sim = await createRoadsterSim({
    ground: 'terrain', terrain: { heights, size: n, extentM },
    landmarks: [{ id: 'pyr', kind: 'mesh', data: pyramidHullMesh(fit), outward: true }, { id: 'pyr_talus', kind: 'mesh', data: pyramidTalus(fit, groundAt) }],
  });
  sim.surface = 'sand';
  sim.hardGround = [{ minX: -fit.ax - 40, maxX: fit.ax + 40, minZ: -fit.az - 40, maxZ: fit.az + 40 }];
  return sim;
}

describe('real Giza pyramids (GLB → fit → collision)', () => {
  it('all 9 pyramids are marked drivable', () => { expect(PYRAMIDS.length).toBe(9); });

  for (const p of PYRAMIDS) {
    it(`${p.file}: plausible fit, closed outward mesh; climbs the north face and holds with the brakes`, async () => {
      // centred at the origin (heading kept), ground 2 m above the model's lowest point (it is embedded)
      const pts = glbPoints(p.file, 0, 0, 0, p.headingDeg);
      const fit = fitPyramid(pts, 0, 0, p.headingDeg * DEG);
      const slope = fit.slope / DEG;
      expect(slope).toBeGreaterThan(p.file.match(/g3[bc]/) ? 45 : 50); expect(slope).toBeLessThan(60);   // Giza 51–53°; G3-b/c: 4 tall steps (enclosing face ≈ 49°)
      expect(fit.yTop - fit.y0).toBeGreaterThan(10);
      // the frustum encloses every model point (the car rides on the outer stone edges, never inside them)
      let worst = -Infinity;
      for (let i = 0; i < pts.length; i += 3) {
        if (pts[i + 1] > fit.yTop + 1e-3) continue; // thin things above the summit (Khufu's mast)
        const [hx, hz] = halfWidthAt(fit, pts[i + 1]);
        const lx = Math.abs(Math.cos(-fit.heading) * pts[i] - Math.sin(-fit.heading) * pts[i + 2]);
        const lz = Math.abs(Math.sin(-fit.heading) * pts[i] + Math.cos(-fit.heading) * pts[i + 2]);
        worst = Math.max(worst, lx - hx, lz - hz);
      }
      expect(worst).toBeLessThan(0.01);
      const mesh = pyramidHullMesh(fit);
      expect(signedVolume(mesh)).toBeGreaterThan(0);
      expect(edgesPaired(mesh)).toBe(true);
      const g0 = fit.y0 + 2;
      const sim = await worldFor(fit, () => g0);
      const flat = Math.min(fit.bx, fit.bz) > 4;  // a platform to park on (Khufu); pointed tops: stop on the face
      // small pyramids (< 20 m): the talus is a large part of the climb, so take a run-up (8 m/s) to carry
      // the momentum over the crest (8° breakover angle: the floor scrapes there)
      const small = fit.yTop - fit.y0 < 20;
      const r = drive(sim, fit, 0, g0 + 0.6, -fit.az - 30, 0, 45, { xLine: 0, parkFlat: flat, holdBelowTopM: flat ? undefined : 6, vSet: small ? 8 : 7, capTop: small ? 8 : 6.5 });
      const info = `fit slope=${slope.toFixed(1)} H=${(fit.yTop - fit.y0).toFixed(1)} a=${fit.ax.toFixed(1)}/${fit.az.toFixed(1)} b=${fit.bx.toFixed(1)}/${fit.bz.toFixed(1)}\n${r.log.join('\n')}`;
      expect(r.finite, info).toBe(true);
      expect(r.crashed, info).toBe(false);
      expect(r.penetrated, info).toBe(false);
      expect(r.maxY, info).toBeGreaterThan(fit.yTop - (flat ? 1 : 7));   // up to the summit (pointed tops: just below the apex)
      const s = sim.getState();
      expect(s.speedMs, info).toBeLessThan(0.5);
      if (flat) expect(Math.abs(hudPitchDeg(s.quat)), info).toBeLessThan(8);
      expect(s.crashed).toBe(false);
      expect(s.wheels.filter((w) => w.contact).length).toBeGreaterThanOrEqual(3);
      sim.dispose();
    }, 120_000);
  }
});

describe('pyramid edge cases (synthetic Khufu-like, 100 m base)', () => {
  const S = 51.84 * DEG, A = 50, B = 6, Y0 = -2, H = (A - B) * Math.tan(S);
  const synth = () => {
    const pts: number[] = [];
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push(sx * A, Y0, sz * A, sx * B, Y0 + H, sz * B);
    return fitPyramid(new Float32Array(pts), 0, 0, Math.PI);
  };

  for (const v of [5, 9]) {
    it(`diagonal approach into the corner ridge at ${v} m/s: no penetration, no NaN, no crash`, async () => {
      const fit = synth();
      const sim = await worldFor(fit, () => 0);
      // from the south-west, heading 45° (+x +z) straight at the (-A, -A) corner
      const r = drive(sim, fit, -A - 25, 0.6, -A - 25, 45, 20, { vSet: v });
      // it really got there: within 2 m of the arris, up on the talus/stone (> 1 m). Straight up the convex
      // arris it cannot go (the car straddles the ridge on two wheels) – it must stop there safely
      expect(r.minArrisM, r.log.join('\n')).toBeLessThan(2);
      expect(r.maxYNearArris, r.log.join('\n')).toBeGreaterThan(1);
      expect(r.finite).toBe(true);
      expect(r.penetrated).toBe(false);
      expect(r.crashed).toBe(false);
      sim.dispose();
    }, 120_000);
  }

  it('across the ridge: driving up a face while steering into the arris', async () => {
    const fit = synth();
    const sim = await worldFor(fit, () => 0);
    // up the -z face but 20 m off centre and drifting toward the -x arris (no line keeping)
    const d = neutralDrive(), sys = neutralSystems(), thr = zeroThrust();
    sys.fanMode = 'grip'; sys.fanLevel = null; vehicleModules(sim).fans.rpm = 1;
    sim.reset(spawnPose({ x: -20, y: 0.6, z: -A - 25 }, 0));
    let penetrated = false, finite = true, crashedBeforeArris = false, minArris = Infinity, maxYNear = -Infinity;
    for (let i = 0; i < 240 * 20; i++) {
      const s = sim.getState();
      d.throttle = s.speedMs < 6 ? 1 : 0;
      d.steer = s.pos.y > 5 ? 0.15 : 0; // steer right (toward -x, +X is left) into the arris
      sim.step(d, sys, thr);
      if (![s.pos.x, s.pos.y, s.pos.z].every(Number.isFinite)) { finite = false; break; }
      if (s.pos.y < pyramidHeightAt(fit, s.pos.x, s.pos.z, CREST_R) - 0.2) penetrated = true;
      if (s.crashed && minArris >= 2) crashedBeforeArris = true;
      if (s.pos.y > 3) { const da = arrisDist(s.pos.x, s.pos.z); minArris = Math.min(minArris, da); if (da < 2) maxYNear = Math.max(maxYNear, s.pos.y); }
    }
    expect(minArris).toBeLessThan(2);      // reached the arris …
    expect(maxYNear).toBeGreaterThan(3);   // … on the stone, not down on the sand
    expect(finite).toBe(true);
    expect(penetrated).toBe(false);
    // safe up to the arris; steering on over the sharp convex ridge the skirt loses its seal and the car may
    // topple down the other face (it does at 6 m/s) – as a real car would
    expect(crashedBeforeArris).toBe(false);
    sim.dispose();
  }, 120_000);

  it('uneven bedrock court in front of the talus: climbs and parks level on the summit', async () => {
    const fit = synth();
    const ground = (x: number, z: number) => 0.25 * Math.sin(x / 6) * Math.sin(z / 7) + 0.12 * Math.sin(x / 2.3 + z / 3.1);
    const sim = await worldFor(fit, ground);
    const r = drive(sim, fit, 0, ground(0, -A - 30) + 0.6, -A - 30, 0, 45, { xLine: 0, parkFlat: true });
    const s = sim.getState();
    const info = r.log.join('\n');
    expect(r.finite, info).toBe(true);
    expect(r.crashed, info).toBe(false);
    expect(r.penetrated, info).toBe(false);
    expect(r.maxY, info).toBeGreaterThan(fit.yTop);
    expect(Math.abs(hudPitchDeg(s.quat))).toBeLessThan(8);
    expect(s.speedMs).toBeLessThan(0.5);
    sim.dispose();
  }, 120_000);
});
