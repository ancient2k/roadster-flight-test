// Headless drive of a track-editor level with the full vehicle model and the course driver: a flat field (sand, as
// at Boca Chica) with the level's colliders and painted asphalt, ASSIST as a player has it, the time trial running.
import { createRoadsterSim, setDamageMode } from '../../../src/sim/vehicle';
import type { DamageMode } from '../../../src/shared/damage';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { ManualController, SimSession } from '../../../src/game/session';
import { ManualAssist } from '../../../src/sim/gnc';
import { CourseDriver } from '../../../src/sim/gnc/courseDriver';
import { LevelRun } from '../../../src/game/levelRun';
import { courseLine, courseStart, type LaneArea, type LaneSpeeds } from '../../../src/shared/lanes';
import { levelPhysics } from '../../../src/shared/levelPhysics';
import { pavedLookup } from '../../../src/shared/paved';
import { environmentFor } from '../../../src/shared/worlds';
import type { Level } from '../../../src/shared/level';

export const AREA: LaneArea = { minX: -480, minZ: -360, tileM: 20, y: 0 };

export interface DriveResult {
  /** The driver reached the end of the line (open course) or completed the lap (closed). */
  done: boolean;
  finished: boolean;
  timeS: number;
  missed: number;
  penaltyS: number;
  /** Why the drive was stopped early, if it was. */
  fail: string | null;
  /** Part index (level.parts) where the car was when it failed. */
  failPart: number | null;
  maxOffLineM: number;
  /** Parts the car was on when the time trial reported skipped sections. */
  skipped?: number[];
}

export async function driveLevel(level: Level, { maxS = 120, speedScale = 1, damage = 'off' as DamageMode, trace = null as ((t: number, info: Record<string, unknown>) => void) | null, speeds = undefined as LaneSpeeds | undefined, assist = 'ASSIST' as 'ASSIST' | 'STABILIZED' | 'RAW', fan = 'off' as 'off' | 'grip' | 'highspeed', handling = 'fun' as 'fun' | 'realistic' } = {}): Promise<DriveResult> {
  const line = courseLine(level, AREA, speeds);
  const start = courseStart(level, AREA);
  if (!line || !start) throw new Error('level without a start piece');
  const N = 129;
  const sim = await createRoadsterSim({
    ground: 'terrain', terrain: { heights: new Float32Array(N * N), size: N, extentM: 4000, fineCenter: { x: 0, z: 0 } },
    landmarks: levelPhysics(level, AREA).shapes,
  });
  try {
    sim.setEnvironment(environmentFor('earth_bocachica'));
    sim.surface = 'sand';
    sim.hardGround = [];
    sim.paved = pavedLookup(levelPhysics(level, AREA).paved);
    sim.handling = handling;
    setDamageMode(sim, damage);
    let mc: ManualController | null = null;
    const spawn = spawnPose({ x: start.x, y: AREA.y, z: start.z }, start.headingDeg, 0);
    const session = new SimSession(sim, { kind: 'manual', spawn }, (s) => (mc = new ManualController(s, new ManualAssist())));
    mc!.assist = assist;
    mc!.fanMode = fan;
    const run = new LevelRun(level, { ...AREA });
    const driver = new CourseDriver(line.pts, line.closed, speedScale);
    const fx = {
      boost: (dx: number, dz: number, dv: number) => { const m = sim.getState().massKg; sim.body.applyImpulse({ x: dx * dv * m, y: 0, z: dz * dv * m }, true); },
      refill: () => {},
    };
    const dt = 1 / 60, steps = Math.round(dt / sim.dt);
    let slow = 0, maxOff = 0, airT = 0;
    const skipped: number[] = [];
    for (let t = 0; t < maxS; t += dt) {
      const s = sim.getState();
      mc!.drive = driver.update(s);
      for (let k = 0; k < steps; k++) session.step();
      const st = sim.getState();
      const evs = run.update(dt, { x: st.pos.x, y: st.pos.y, z: st.pos.z, vx: st.linVel.x, vz: st.linVel.z, speedMs: st.speedMs, grounded: st.groundContact }, fx);
      for (const e of evs) if (e.kind === 'skipped') skipped.push(line.pts[Math.min(driver.i, line.pts.length - 1)].part);
      if (t > 3) maxOff = Math.max(maxOff, driver.offLine);
      const part = line.pts[Math.min(driver.i, line.pts.length - 1)].part;
      if (trace) {
        const q = st.quat, upY = 1 - 2 * (q.x * q.x + q.z * q.z), lp = line.pts[Math.min(driver.i, line.pts.length - 1)];
        trace(t, { part, i: driver.i, x: st.pos.x.toFixed(1), y: st.pos.y.toFixed(1), z: st.pos.z.toFixed(1), lx: lp.x.toFixed(1), ly: lp.y.toFixed(1), lz: lp.z.toFixed(1), v: st.speedMs.toFixed(1), upY: upY.toFixed(2), off: driver.offLine.toFixed(1), thr: mc!.drive.throttle.toFixed(2), brk: mc!.drive.brake.toFixed(2), vt: driver.targetMs.toFixed(1), steer: mc!.drive.steer.toFixed(2), fan: st.fans.mode, contact: st.groundContact, body: st.bodyContact, comp: st.wheels.map((w) => w.compression.toFixed(2)).join('/'), E: (0.5 * st.speedMs ** 2 + 9.81 * st.pos.y).toFixed(0), jets: st.nozzles.filter((n) => n.open).length, ...(() => { const c = sim.modules.find((m) => m.name === 'chassis') as unknown as { esc: number; escYawDemand: number; wheels: { driveTorque: number; brakeTorque: number; omega: number; fx: number; N: number }[] }; return { esc: c.esc.toFixed(2), yawD: c.escYawDemand.toFixed(2), td: c.wheels.map((w) => Math.round(w.driveTorque)).join('/'), tb: c.wheels.map((w) => Math.round(w.brakeTorque)).join('/'), fx: c.wheels.map((w) => Math.round(w.fx)).join('/'), N: c.wheels.map((w) => Math.round(w.N)).join('/') }; })(), thrustN: Math.round(st.nozzles.reduce((a, n) => a + n.thrustN, 0)) });
      }
      const res = (fail: string | null): DriveResult => ({ skipped, done: driver.done, finished: run.state === 'finished', timeS: t, missed: run.missed, penaltyS: run.penalty, fail, failPart: fail ? part : null, maxOffLineM: maxOff });
      if ((line.closed && run.state === 'finished') || (driver.done && !line.closed)) return res(null);
      slow = st.speedMs < 1 ? slow + dt : 0;
      if (t > 4 && slow > 3) return res('stuck');
      airT = st.groundContact || st.bodyContact ? 0 : airT + dt;
      if (t > 3 && driver.offLine > 12 && airT === 0) return res(`off the line by ${driver.offLine.toFixed(1)} m`);
      if (airT > 6) return res('airborne for 6 s');
      if (st.damage?.totalLoss) return res('total loss');
    }
    return { done: driver.done, finished: run.state === 'finished', timeS: maxS, missed: run.missed, penaltyS: run.penalty, fail: 'timeout', failPart: line.pts[Math.min(driver.i, line.pts.length - 1)].part, maxOffLineM: maxOff };
  } finally {
    sim.dispose();
  }
}
