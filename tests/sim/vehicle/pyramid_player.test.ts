// Pyramids driven like a player on the keyboard (R14 report: "you get stuck on the edge"): digital W/S/A/D keys
// shaped by the keyboard ramps of the input mapper, fans in GRIP on demand control (manual mode, fanLevel
// null), uneven throttle (hysteresis plus random lifts), oblique approach, stopping on the summit edge and
// pulling away again, parking on the platform and driving down the far face.
// Cause found: the floor grounded on the R 6 m summit edge (sag L²/8R = 15 cm > 10 cm ride height), the
// front wheels lifted, the demand control backed off (scraping) and the car hung there at full throttle
// whenever it arrived slowly or stopped on the edge. Fix: crest radius 12 m (src/shared/pyramid.ts).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readGlbFile } from '../../assets/glbFile';
import { createRoadsterSim, vehicleModules } from '../../../src/sim/vehicle';
import { steepStoneWithoutGrip } from '../../../src/sim/vehicle/fans';
import type { RoadsterSim } from '../../../src/sim/core/roadsterSim';
import { CREST_R, TALUS_R, axisSlopes, crestRadii, fitPyramid, halfWidthAt, pyramidHeightAt, pyramidHullMesh, pyramidTalus, triangleHeightField, type PyramidFit } from '../../../src/shared/pyramid';
import { hudPitchDeg, qaxisAngle, qmul } from '../../../src/shared/math';
import { KB_RAMP } from '../../../src/input/mapping';
import { neutralDrive, neutralSystems, zeroThrust, type VehicleState } from '../../../src/shared/types';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const DEG = Math.PI / 180;

/** World-space POSITION vertices of a Giza pyramid GLB, centred at the origin (heading kept). */
function glbPoints(file: string, headingDeg: number): Float32Array {
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
      out.push(c * px + s * pz, py, -s * px + c * pz);
    }
  }
  return new Float32Array(out);
}

const meta = JSON.parse(readFileSync(root + 'public/assets/worlds/earth_giza/meta.json', 'utf8'));
const PYR: { file: string; headingDeg: number }[] = meta.landmarks.filter((l: { collider?: string }) => l.collider === 'pyramid');

interface Site { sim: RoadsterSim; fit: PyramidFit; g0: number; ch: number; sh: number }

async function site(file: string): Promise<Site> {
  const p = PYR.find((x) => x.file === file)!;
  const fit = fitPyramid(glbPoints(p.file, p.headingDeg), 0, 0, p.headingDeg * DEG);
  const g0 = fit.y0 + 2; // the models are embedded ≈ 2 m
  const n = 257, extentM = 768;
  const sim = await createRoadsterSim({
    ground: 'terrain', terrain: { heights: new Float32Array(n * n).fill(g0), size: n, extentM },
    landmarks: [{ id: 'pyr', kind: 'mesh', data: pyramidHullMesh(fit), outward: true }, { id: 'pyr_talus', kind: 'mesh', data: pyramidTalus(fit, () => g0) }],
  });
  sim.surface = 'sand';
  sim.hardGround = [{ minX: -fit.ax - 40, maxX: fit.ax + 40, minZ: -fit.az - 40, maxZ: fit.az + 40 }];
  return { sim, fit, g0, ch: Math.cos(fit.heading), sh: Math.sin(fit.heading) };
}

/** Pyramid-local (x, z) → world, and world → local (faces ±x / ±z; the climbs go up the -z face toward +z). */
const toW = (S: Site, lx: number, lz: number) => ({ x: S.ch * lx - S.sh * lz, z: S.sh * lx + S.ch * lz });
const toL = (S: Site, x: number, z: number) => ({ x: S.ch * x + S.sh * z, z: -S.sh * x + S.ch * z });
/** World heading (deg, 0 = +z) of a direction given in the pyramid frame. */
const headingW = (S: Site, lx: number, lz: number) => { const w = toW(S, lx, lz); return Math.atan2(w.x, w.z) / DEG; };

/** Deterministic pseudo-random numbers (the player's twitchy right foot). */
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

type Phase = 'climb' | 'crest' | 'park' | 'over' | 'descend' | 'done';
interface Opts { vLo?: number; vHi?: number; seed?: number; stopOnCrestPitch?: number | null; descend?: boolean }
interface Result { phase: Phase; maxY: number; parkedLevel: boolean; crashed: boolean; penetrated: boolean; finite: boolean; log: string[]; end: VehicleState }

/**
 * The player: W pressed below vLo, released above vHi, plus random 0.2–0.5 s lifts; A/D aim at the summit;
 * on the summit edge (pitch < 30°) off the throttle – optionally stop there with S – and if the car stands
 * still, W again until it is level; then S to park for 3 s; then (descend) W over the far edge and down the
 * far face braking with S above 6 m/s, until back on the sand.
 */
function play(S: Site, seconds: number, o: Opts = {}): Result {
  const { sim, fit, g0 } = S;
  const vLo = o.vLo ?? 3, vHi = o.vHi ?? 5, rnd = rng(o.seed ?? 1);
  const d = neutralDrive(), sys = neutralSystems(), thr = zeroThrust();
  sys.fanMode = 'grip'; sys.fanLevel = null;
  const key = { W: false, S: false, A: false, D: false };
  let phase: Phase = 'climb', lift = 0, stillS = 0, parkS = 0, stopped = false, parkedLevel = false;
  let maxY = -Infinity, crashed = false, penetrated = false, finite = true;
  const log: string[] = [];
  const slew = (x: number, on: boolean, rise: number, fall: number) => (on ? Math.min(1, x + sim.dt / rise) : Math.max(0, x - sim.dt / fall));
  const top = fit.yTop;
  for (let i = 0; i < Math.round(seconds / sim.dt) && phase !== 'done'; i++) {
    const s = sim.getState();
    const pitch = hudPitchDeg(s.quat), v = s.speedMs, L = toL(S, s.pos.x, s.pos.z);
    const q = s.quat, fwd = toL(S, 2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
    const q2w = { x: 2 * (q.x * q.z + q.w * q.y), y: 2 * (q.y * q.z - q.w * q.x), z: 1 - 2 * (q.x * q.x + q.y * q.y) }; // body +Z in world
    if (i % 24 === 0) { // the player reacts ten times a second
      if (lift > 0) lift -= 0.1; else if (rnd() < 0.04) lift = 0.2 + 0.3 * rnd();
      if (phase === 'climb') {
        key.S = false;
        // rolling back after a lift: W again at once (the speed shown is unsigned, the player sees the car roll back)
        const vF = s.linVel.x * q2w.x + s.linVel.y * q2w.y + s.linVel.z * q2w.z;
        key.W = vF < 0 || (lift <= 0 && (key.W ? v < vHi : v < vLo));
        if (s.pos.y > top - 8 && pitch < Math.max(30, o.stopOnCrestPitch ?? 0)) phase = 'crest';
      }
      if (phase === 'crest') {
        if (o.stopOnCrestPitch != null && !stopped && pitch < o.stopOnCrestPitch) {
          // stop on the edge with the nose still up, then pull away again
          key.W = false; key.S = true;
          if (v < 0.2) { stopped = true; key.S = false; }
        } else {
          // off the gas as the nose tips; standing still → W until level
          key.S = false; stillS = v < 0.3 ? stillS + 0.1 : 0;
          key.W = (stopped && v < 2) || stillS > 0.6 || (key.W && v < 3);
        }
        if (Math.abs(pitch) < 6 && s.pos.y > top - 1.5) phase = 'park';
      }
      if (phase === 'park') {
        key.W = false; key.S = true;
        parkS = v < 0.5 ? parkS + 0.1 : 0;
        if (parkS >= 3) { parkedLevel = Math.abs(pitch) < 8; phase = o.descend ? 'over' : 'done'; }
      }
      if (phase === 'over') { key.S = false; key.W = v < 2.5; if (pitch < -20) phase = 'descend'; }
      if (phase === 'descend') {
        key.S = key.S ? v > 3 : v > 6; key.W = !key.S && v < 1; // auto-hold stopped it: roll on
        if (s.pos.y < g0 + 1 && L.z > fit.az) phase = 'done';
      }
      // aim at the summit (A = steer left = +x); a human corrects in bursts with a deadband
      if (phase !== 'park') {
        const want = phase === 'descend' || phase === 'over' ? Math.atan2(-L.x, 30) : Math.atan2(-L.x, Math.max(5, -L.z));
        const e = want - Math.atan2(fwd.x, fwd.z);
        key.A = e > 0.06; key.D = e < -0.06;
      } else key.A = key.D = false;
    }
    d.throttle = slew(d.throttle, key.W, KB_RAMP.pedalRise, KB_RAMP.pedalFall);
    d.brake = slew(d.brake, key.S, KB_RAMP.pedalRise, KB_RAMP.pedalFall);
    const steerKey = (key.D ? 1 : 0) - (key.A ? 1 : 0);
    d.steer = steerKey === 0 ? Math.sign(d.steer) * Math.max(0, Math.abs(d.steer) - sim.dt / KB_RAMP.steerReturn)
      : Math.max(-1, Math.min(1, d.steer + steerKey * sim.dt / KB_RAMP.steerRise));
    // the game's auto-hold (ManualController): standing on the wheels without pedals holds the brakes
    const drv = s.groundContact && v < 0.6 && d.throttle < 0.02 && d.brake < 0.02 ? { ...d, brake: 0.6 } : d;
    sim.step(drv, sys, thr);
    const n = sim.getState();
    if (![n.pos.x, n.pos.y, n.pos.z, n.speedMs].every(Number.isFinite)) { finite = false; break; }
    maxY = Math.max(maxY, n.pos.y);
    if (n.crashed && !crashed) log.push(`CRASH t=${n.t.toFixed(2)} ${JSON.stringify(sim.contacts)}`);
    crashed ||= n.crashed;
    // the CoG never ends up below the (rounded) stone surface
    if (n.pos.y < pyramidHeightAt(fit, n.pos.x, n.pos.z, CREST_R) - 0.2 && !penetrated) { penetrated = true; log.push(`PENETRATED t=${n.t.toFixed(2)}`); }
    if (i % 240 === 0) log.push(`t=${n.t.toFixed(0)} ${phase} y-top=${(n.pos.y - top).toFixed(1)} z=${L.z.toFixed(1)} x=${L.x.toFixed(1)} v=${v.toFixed(1)} p=${pitch.toFixed(0)} w=${n.wheels.map((w) => (w.contact ? 1 : 0)).join('')} fan=${(n.fans.forceN / 9.81).toFixed(0)}kg body=${n.bodyContact ? 1 : 0} keys=${Object.entries(key).filter(([, on]) => on).map(([k]) => k).join('')}`);
  }
  return { phase, maxY, parkedLevel, crashed, penetrated, finite, log, end: sim.getState() };
}

/** Spawn on the -z face 2 m below the rounded summit edge, rolling up at v0 with the fans already sealing
 *  (small pyramids, where that is down on the talus: on the sand 15 m before the foot). */
function spawnBelowCrest(S: Site, v0: number) {
  const { fit } = S;
  const [, Rz] = crestRadii(fit), [, th] = axisSlopes(fit);
  const y = fit.yTop - Rz * (1 - Math.cos(th)) - 2;
  if (y < S.g0 + TALUS_R * (1 - Math.cos(th)) + 3) { spawnOnSand(S, 15, 0); return; }
  const hz = fit.bz + (fit.yTop - y) / Math.tan(th);
  const off = 0.55; // CoG above the face along its normal
  const p = toW(S, 0, -hz - off * Math.sin(th));
  const q = qmul(qaxisAngle({ x: 0, y: 1, z: 0 }, headingW(S, 0, 1) * DEG), qaxisAngle({ x: 1, y: 0, z: 0 }, -th));
  S.sim.reset({ pos: { x: p.x, y: y + off * Math.cos(th), z: p.z }, quat: q, speedMs: v0 });
  vehicleModules(S.sim).fans.rpm = 1;
}

/** Spawn on the sand `dist` m before the -z foot, `lateral` m off the centre line, heading angDeg off the face normal. */
function spawnOnSand(S: Site, dist: number, angDeg: number, lateral = 0) {
  const a = angDeg * DEG;
  const p = toW(S, lateral, -S.fit.az - dist);
  S.sim.reset({ pos: { x: p.x, y: S.g0 + 0.6, z: p.z }, quat: qaxisAngle({ x: 0, y: 1, z: 0 }, headingW(S, Math.sin(a), Math.cos(a)) * DEG), speedMs: 0 });
}

const info = (r: Result, S: Site) => `fit H=${(S.fit.yTop - S.fit.y0).toFixed(1)} b=${S.fit.bx.toFixed(1)}/${S.fit.bz.toFixed(1)} R=${crestRadii(S.fit).map((x) => x.toFixed(1)).join('/')} phase=${r.phase} maxY-top=${(r.maxY - S.fit.yTop).toFixed(2)}\n${r.log.join('\n')}`;

function expectClean(r: Result, S: Site) {
  const m = info(r, S);
  expect(r.finite, m).toBe(true);
  expect(r.crashed, m).toBe(false);
  expect(r.penetrated, m).toBe(false);
  expect(r.phase, m).toBe('done');
  expect(r.parkedLevel, m).toBe(true);
}

describe('pyramids driven like a player (keyboard, fans GRIP on demand)', () => {
  it('crest geometry: the floor sag over the wheelbase on the rounded summit edge stays below the ride height', () => {
    const L = 2.65;
    for (const p of PYR) {
      const fit = fitPyramid(glbPoints(p.file, p.headingDeg), 0, 0, p.headingDeg * DEG);
      if (Math.min(fit.bx, fit.bz) < 4) continue; // Menkaure: pointed top (≈ 4 x 7 m), no platform to drive onto
      // 7.3 cm at R 12 m; where the platform limits R: Khafre 8.2 cm, G1-c's 8.5 m deep platform 9.9 cm (ride height 10 cm)
      for (const R of crestRadii(fit)) expect(L * L / (8 * R), p.file).toBeLessThan(0.1);
    }
  });

  it('ground below the base (parts of the south side of Khufu): no riser between the talus and the face', () => {
    for (const p of PYR) {
      const pts = glbPoints(p.file, p.headingDeg);
      const y0 = fitPyramid(pts, 0, 0, p.headingDeg * DEG).y0;
      for (const sink of [-3, 2, 8]) {
        const g0 = y0 + sink;
        const f = fitPyramid(pts, 0, 0, p.headingDeg * DEG, () => g0);
        const hull = triangleHeightField(pyramidHullMesh(f)), tal = triangleHeightField(pyramidTalus(f, () => g0));
        const c = Math.cos(f.heading), sn = Math.sin(f.heading);
        // in along the middle of the -z face: from the sand over the fillet onto the face, never more than the
        // face's own rise per 0.25 m
        let prev = g0, step = 0;
        for (let d = 20; d > -25; d -= 0.25) {
          const lx = 3, lz = -f.az - d, x = c * lx + sn * lz, z = -sn * lx + c * lz;
          const h = Math.max(g0, hull(x, z), tal(x, z));
          step = Math.max(step, h - prev);
          prev = h;
        }
        expect(step, `${p.file} ground ${sink} m above the base`).toBeLessThan(0.25 * Math.tan(f.slope) + 0.1);
      }
    }
  });

  it('talus on high sand (Khufu sits several metres deep): the face stays on its line until the fillet has merged', () => {
    for (const p of PYR) {
      for (const sink of [2, 6, 10]) {
        const pts = glbPoints(p.file, p.headingDeg);
        const y0 = fitPyramid(pts, 0, 0, p.headingDeg * DEG).y0, g0 = y0 + sink;
        const fit = fitPyramid(pts, 0, 0, p.headingDeg * DEG, () => g0);
        const [thx, thz] = axisSlopes(fit);
        const t = pyramidTalus(fit, () => g0);
        const c = Math.cos(-fit.heading), sn = Math.sin(-fit.heading);
        let worst = 0;
        for (let i = 0; i < t.length; i += 3) {
          const lx = Math.abs(c * t[i] - sn * t[i + 2]), lz = Math.abs(sn * t[i] + c * t[i + 2]), y = t[i + 1];
          const [hx, hz] = halfWidthAt(fit, y);
          if (lz < hz - 2 && y - g0 > TALUS_R * (1 - Math.cos(thx)) + 0.01) worst = Math.max(worst, lx - hx);
          if (lx < hx - 2 && y - g0 > TALUS_R * (1 - Math.cos(thz)) + 0.01) worst = Math.max(worst, lz - hz);
        }
        expect(worst, `${p.file} sunk ${sink} m`).toBeLessThan(0.02);
      }
    }
  });

  it('talus: the fillet meets each face tangentially, its top never stands proud of the face (G3-c: 53° / 46° faces)', () => {
    for (const p of PYR) {
      const fit = fitPyramid(glbPoints(p.file, p.headingDeg), 0, 0, p.headingDeg * DEG);
      const g0 = fit.y0 + 2, [thx, thz] = axisSlopes(fit);
      const t = pyramidTalus(fit, () => g0);
      const c = Math.cos(-fit.heading), sn = Math.sin(-fit.heading);
      let worst = 0;
      for (let i = 0; i < t.length; i += 3) {
        const lx = Math.abs(c * t[i] - sn * t[i + 2]), lz = Math.abs(sn * t[i] + c * t[i + 2]), y = t[i + 1];
        const [hx, hz] = halfWidthAt(fit, y);
        // proud of a face above the height where the fillet should have merged into it (away from the corners)
        if (lz < hz - 2 && y - g0 > TALUS_R * (1 - Math.cos(thx)) + 0.01) worst = Math.max(worst, lx - hx);
        if (lx < hx - 2 && y - g0 > TALUS_R * (1 - Math.cos(thz)) + 0.01) worst = Math.max(worst, lz - hz);
      }
      expect(worst, p.file).toBeLessThan(0.02);
    }
  });

  // the core regression: arrive at walking pace, stop on the edge with the nose still up, pull away again –
  // every pyramid with a summit platform (Menkaure's top is pointed)
  for (const p of PYR.filter((x) => x.file !== 'giza_menkaure.glb')) {
    for (const stopAt of [null, 45, 35, 25]) { // 45°: floor just onto the edge (where R 6 m hung at 47°)
      it(`${p.file}: ${stopAt == null ? 'crawls over the summit edge' : `stops on the summit edge at ${stopAt}° pitch, pulls away`} and parks level`, async () => {
        const S = await site(p.file);
        spawnBelowCrest(S, 2.5);
        const r = play(S, 25, { vLo: 2, vHi: 3.5, stopOnCrestPitch: stopAt, seed: 7 + (stopAt ?? 0) });
        expectClean(r, S);
        expect(r.end.pos.y).toBeGreaterThan(S.fit.yTop - 0.5);
        S.sim.dispose();
      }, 120_000);
    }
  }

  it('HUD hint: on the steep stone without GRIP the fans are called for, not on the sand or with GRIP', async () => {
    const S = await site('giza_khufu.glb');
    spawnBelowCrest(S, 0);
    const d = neutralDrive(), sys = neutralSystems(), thr = zeroThrust();
    sys.fanMode = 'grip'; d.brake = 1;
    for (let i = 0; i < 120; i++) S.sim.step(d, sys, thr);
    expect(steepStoneWithoutGrip(S.sim, 'grip')).toBe(false);
    expect(steepStoneWithoutGrip(S.sim, 'off')).toBe(true);
    expect(steepStoneWithoutGrip(S.sim, 'highspeed')).toBe(true);
    spawnOnSand(S, 20, 0);
    for (let i = 0; i < 240; i++) S.sim.step(d, sys, thr);
    expect(steepStoneWithoutGrip(S.sim, 'off')).toBe(false);
    S.sim.dispose();
  }, 60_000);

  it('Khufu from the sand: uneven throttle, up the face, over the edge, parks on the platform, down the far face', async () => {
    const S = await site('giza_khufu.glb');
    spawnOnSand(S, 25, 0);
    const r = play(S, 150, { vLo: 3, vHi: 6, seed: 3, descend: true });
    expectClean(r, S); // 'done' = back on the sand behind the far foot
    S.sim.dispose();
  }, 300_000);

  it('Khafre from the sand at 25° off the face normal and 12 m off centre, aiming at the summit, stops on the edge: parks level', async () => {
    const S = await site('giza_khafre.glb');
    spawnOnSand(S, 30, 25, 12);
    const r = play(S, 120, { vLo: 3, vHi: 5, seed: 11, stopOnCrestPitch: 30 });
    expectClean(r, S);
    S.sim.dispose();
  }, 300_000);
});


