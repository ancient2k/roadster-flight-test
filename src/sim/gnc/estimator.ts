// State estimate = true state + optional sensor noise (seeded, deterministic). No Math.random.
import { qmul, qnorm, v3, type Quat, type Vec3 } from '@shared/math';
import type { VehicleState } from '@shared/types';

/** mulberry32 PRNG + Box–Muller normal. */
export class Rng {
  private s: number;
  private spare: number | null = null;
  constructor(seed: number) { this.s = seed >>> 0 || 0x9e3779b9; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal(): number {
    if (this.spare !== null) { const s = this.spare; this.spare = null; return s; }
    let u = 0, v = 0;
    while (u <= 1e-12) u = this.next();
    v = this.next();
    const r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * v;
    this.spare = r * Math.sin(th);
    return r * Math.cos(th);
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
}

export interface NoiseSpec { posM: number; velMs: number; attRad: number; rateRadS: number; heightM: number; airKg: number }
export const SENSOR_NOISE: NoiseSpec = { posM: 0.03, velMs: 0.05, attRad: 0.004, rateRadS: 0.01, heightM: 0.03, airKg: 0.5 };

export interface StateEstimate {
  t: number;
  pos: Vec3;
  vel: Vec3;
  q: Quat;
  wWorld: Vec3;
  airKg: number;
  /** CoG height above the surface below (raycast). */
  height: number;
  speed: number;
  groundContact: boolean;
  bodyContact: boolean;
  /** Sum of the wheel normal loads (suspension load cells), N. */
  wheelLoadN: number;
}

export const newEstimate = (): StateEstimate => ({
  t: 0, pos: v3(), vel: v3(), q: { x: 0, y: 0, z: 0, w: 1 }, wWorld: v3(), airKg: 0, height: 0, speed: 0,
  groundContact: false, bodyContact: false, wheelLoadN: 0,
});

export class Estimator {
  readonly est = newEstimate();
  private rng: Rng | null;
  private noise: NoiseSpec;
  private readonly dq: Quat = { x: 0, y: 0, z: 0, w: 1 };

  constructor(seed: number | null = null, noise: NoiseSpec = SENSOR_NOISE) {
    this.rng = seed === null ? null : new Rng(seed);
    this.noise = noise;
  }

  update(s: Readonly<VehicleState>): StateEstimate {
    const e = this.est, r = this.rng, n = this.noise;
    const g = r ? () => r.normal() : () => 0;
    e.t = s.t;
    e.pos.x = s.pos.x + n.posM * g(); e.pos.y = s.pos.y + n.posM * g(); e.pos.z = s.pos.z + n.posM * g();
    e.vel.x = s.linVel.x + n.velMs * g(); e.vel.y = s.linVel.y + n.velMs * g(); e.vel.z = s.linVel.z + n.velMs * g();
    e.wWorld.x = s.angVel.x + n.rateRadS * g(); e.wWorld.y = s.angVel.y + n.rateRadS * g(); e.wWorld.z = s.angVel.z + n.rateRadS * g();
    if (r) {
      const hx = 0.5 * n.attRad * g(), hy = 0.5 * n.attRad * g(), hz = 0.5 * n.attRad * g();
      this.dq.x = hx; this.dq.y = hy; this.dq.z = hz; this.dq.w = 1;
      qnorm(qmul(s.quat, this.dq, e.q), e.q);
    } else { e.q.x = s.quat.x; e.q.y = s.quat.y; e.q.z = s.quat.z; e.q.w = s.quat.w; }
    e.airKg = s.tank.airMassKg + n.airKg * g();
    e.height = s.heightAboveGroundM + n.heightM * g();
    e.speed = Math.hypot(e.vel.x, e.vel.y, e.vel.z);
    // (afloat on the water counts as ground: no height hold, no automatic landing)
    e.groundContact = s.groundContact || !!s.afloat;
    e.bodyContact = s.bodyContact;
    let load = 0;
    for (const w of s.wheels) load += w.normalLoadN;
    e.wheelLoadN = load;
    return e;
  }
}
