// Ground vehicle: suspension (shape-cast per wheel along body -Y), tires (transient Pacejka,
// combined slip), wheel spin dynamics, powertrain (RWD, power/torque limits, TC, launch, accel
// governor, regen), brakes (implicit stiction, ABS), handbrake, steer-by-wire.
// Ground material per wheel: the collider under the wheel picks the tire profile (McGregor
// ramps = concrete, else sim.surface); on deformable soil the wheel sinks in (Bekker, slip sinkage)
// and feels compaction + bulldozing resistance as a rolling-resistance torque (implicit stiction).
// One ForceModule; the pieces are coupled through wheel spin and normal load.
import { RAPIER, type ForceModule, type RoadsterSim, type StepContext } from '@sim/core/roadsterSim';
import { GROUP_CAR, GROUP_WORLD, groups } from '@sim/core/world';
import { ROADSTER, type WheelSpec } from '@shared/roadster';
import {
  DEG, G0, clamp, qaxisAngle, qmul, qrot, v3, v3cross, v3dot, v3norm, v3set, type Quat, type Vec3,
} from '@shared/math';
import type { VehicleState } from '@shared/types';
import type { SurfaceKind } from '@shared/environment';
import { combinedForce, relax } from './tire';
import {
  DIG_LENGTH_M, FOOTPRINT_M, MAX_SINK_FRACTION, SINK_GEOM_TAU_S, SINK_LOAD_TAU_S, SOIL_SHEAR_LENGTH_M, SURFACES,
  bulldozingResistance, compactionResistance, slipSinkageFactor, staticSinkage, surfaceAtPoint, type SurfaceParams,
} from './surfaces';
import { GEOM, PT, STEER, SUSP, TIRE, VEH_EXT } from './params';
import type { VehicleBus } from './bus';

const XS = VEH_EXT.suspension, XT = VEH_EXT.tire, XP = VEH_EXT.powertrain;
const Q_AXIS_X: Quat = qaxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2); // cylinder axis Y -> body X
const CAST_GROUPS = groups(GROUP_CAR, GROUP_WORLD);

export class Wheel {
  readonly spec: WheelSpec;
  readonly r: number;
  readonly I = SUSP.wheelInertiaKgM2;
  readonly cyl: RAPIER.Cylinder;
  // dynamic state
  omega = 0; sx = 0; sy = 0; steer = 0; driveCmd = 0;
  // per-step results
  contact = false; c = 0; cdot = 0; strutN = 0; N = 0; fx = 0; fy = 0; D = 0;
  driveTorque = 0; brakeTorque = 0; vx = 0; vy = 0;
  bumpStopN = 0;
  /** Ground material under the wheel and its parameters. */
  surface: SurfaceKind = 'asphalt';
  prof: SurfaceParams = SURFACES.asphalt;
  /** Sinkage into deformable soil (m) = load part + slip (excavation) part; 0 on rigid surfaces. */
  sink = 0; zLoad = 0; zSlip = 0;
  /** Wheel load seen by the soil (low-passed with SINK_LOAD_TAU_S) (N). */
  nSoil = 0;
  /** Soil motion resistance (compaction + bulldozing) this step (N). */
  rSoil = 0;
  /** Dust thrown by this wheel (0..1, graphics hint). */
  dust = 0;
  readonly p = v3(); readonly n = v3(0, 1, 0); readonly ex = v3(0, 0, 1); readonly ey = v3(1, 0, 0);
  constructor(spec: WheelSpec) {
    this.spec = spec;
    this.r = spec.radius;
    this.cyl = new RAPIER.Cylinder((spec.width * XS.castWidthFactor) / 2, spec.radius);
  }
  reset(): void {
    this.omega = 0; this.sx = 0; this.sy = 0; this.steer = 0; this.driveCmd = 0;
    this.contact = false; this.c = 0; this.cdot = 0; this.strutN = 0; this.N = 0; this.fx = 0; this.fy = 0; this.D = 0;
    this.driveTorque = 0; this.brakeTorque = 0; this.vx = 0; this.vy = 0; this.bumpStopN = 0;
    this.surface = 'asphalt'; this.prof = SURFACES.asphalt;
    this.sink = 0; this.zLoad = 0; this.zSlip = 0; this.nSoil = 0; this.rSoil = 0; this.dust = 0;
  }
}

/** Speed-dependent steering limit (rad): maxAngle at standstill -> highSpeedAngle at highSpeedMs. */
export function steerLimitRad(v: number): number {
  const t = clamp(Math.abs(v) / STEER.highSpeedMs, 0, 1);
  const k = 1 - (1 - t) * (1 - t);
  return (STEER.maxAngleDeg + (STEER.highSpeedAngleDeg - STEER.maxAngleDeg) * k) * DEG;
}

/** Digressive damper force for compression rate v (m/s, + = compressing). */
export function damperForce(v: number): number {
  const d = SUSP.damperNsPerM, k = XS.damperKneeMs, a = Math.abs(v);
  const f = a <= k ? d * a : d * k + d * XS.damperHighSpeedRatio * (a - k);
  return v < 0 ? -f : f;
}

/** Position-sensitive hydraulic bump stop: extra compression damping in the last part of travel. */
export function hydraulicStopForce(c: number, cdot: number): number {
  if (cdot <= 0) return 0;
  const start = SUSP.travelM - XS.hydroStopLengthM;
  const k = clamp((c - start) / XS.hydroStopLengthM, 0, 1);
  return XS.hydroStopNsPerM * k * cdot;
}

/** Progressive bump stop force at compression c. */
export function bumpStopForce(c: number): number {
  const d = c - (SUSP.travelM - XS.bumpStopLengthM);
  return d > 0 ? SUSP.bumpStopNPerM * d * (1 + d / XS.bumpProgM) : 0;
}

export class ChassisModule implements ForceModule {
  readonly name = 'chassis';
  readonly wheels: Wheel[];
  steerAngle = 0;         // road-wheel reference angle (rad, + = left)
  motorPowerW = 0;
  /** Stability-control torque factor of the last step (1 = inactive). */
  esc = 1;
  /** ESC yaw-moment request (-1..1, + = yaw left) of the last step. */
  escYawDemand = 0;
  /** Diagnostics: wheel contacts found by shape cast vs. ray fallback. */
  castHits = 0; rayFallbacks = 0; normalFixes = 0;
  private readonly bus: VehicleBus;
  private tmp = v3(); private tmp2 = v3(); private F = v3();

  constructor(bus: VehicleBus) {
    this.bus = bus;
    this.wheels = ROADSTER.wheels.map((s) => new Wheel(s));
  }

  reset(sim: RoadsterSim): void {
    this.steerAngle = 0; this.motorPowerW = 0;
    const v = sim.body.linvel();
    const fwd = sim.dirToWorld({ x: 0, y: 0, z: 1 });
    const vf = v.x * fwd.x + v.y * fwd.y + v.z * fwd.z;
    for (const w of this.wheels) { w.reset(); w.omega = vf / w.r; }
  }

  apply(ctx: StepContext): void {
    const { sim, dt, drive } = ctx;
    const q = sim.body.rotation() as Quat;
    const yb = qrot(q, { x: 0, y: 1, z: 0 });
    const zb = qrot(q, { x: 0, y: 0, z: 1 });
    const m = ctx.state.massKg;
    const vlin = sim.body.linvel();
    const vFwd = vlin.x * zb.x + vlin.y * zb.y + vlin.z * zb.z;

    // ---------------------------------------------------------- steering (by wire)
    const target = -clamp(drive.steer, -1, 1) * steerLimitRad(vFwd);
    const maxStep = STEER.rateDegPerS * DEG * dt;
    this.steerAngle += clamp(target - this.steerAngle, -maxStep, maxStep);
    const tanD = Math.tan(this.steerAngle);
    const dmg = this.bus.damage; // damage.ts: bent links (toe), worn tyres/rims (grip), torn-off wheels
    for (const w of this.wheels) {
      const toe = dmg.toeRad[this.wheels.indexOf(w)];
      if (!w.spec.steered) { w.steer = toe; continue; }
      const ideal = Math.atan2(GEOM.wheelbase * tanD, GEOM.wheelbase - w.spec.pos.x * tanD);
      w.steer = this.steerAngle + XS_ACK * (ideal - this.steerAngle) + toe;
    }

    // ---------------------------------------------------------- suspension geometry (casts)
    const dirDown = { x: -yb.x, y: -yb.y, z: -yb.z };
    const travel = SUSP.travelM, margin = XS.castMarginM;
    let nContact = 0; const nSum = v3();
    for (const w of this.wheels) {
      const s = w.spec;
      if (dmg.wheelLost[this.wheels.indexOf(w)]) { w.contact = false; w.c = 0; w.cdot = 0; w.sink = 0; w.zLoad = 0; w.zSlip = 0; w.nSoil = 0; continue; }
      const startBody = { x: s.pos.x, y: s.pos.y - SUSP.restCompressionM + travel + margin, z: s.pos.z };
      const start = sim.toWorld(startBody);
      const qs = qmul(q, qmul(qaxisAngle({ x: 0, y: 1, z: 0 }, w.steer), Q_AXIS_X));
      const hit = sim.world.castShape(start, qs, dirDown, w.cyl, 0, travel + margin, true, undefined, CAST_GROUPS, undefined, sim.body);
      let toi: number;
      let kind: string | undefined;
      if (hit) {
        kind = sim.colliderInfo.get(hit.collider.handle)?.kind;
        toi = hit.time_of_impact;
        // contact normal (collider outward, world) and contact point projected onto the wheel mid-plane
        v3set(w.n, hit.normal1.x, hit.normal1.y, hit.normal1.z);
        const cx = start.x - yb.x * toi, cy = start.y - yb.y * toi, cz = start.z - yb.z * toi;
        const axis = qrot(qs, { x: 0, y: 1, z: 0 }, this.tmp);
        const wx = hit.witness1.x - cx, wy = hit.witness1.y - cy, wz = hit.witness1.z - cz;
        const along = wx * axis.x + wy * axis.y + wz * axis.z;
        v3set(w.p, hit.witness1.x - along * axis.x, hit.witness1.y - along * axis.y, hit.witness1.z - along * axis.z);
        this.castHits++;
      } else {
        // Fallback: GJK shape casts are unreliable against very large colliders (f32); ray from the hub.
        const ray = sim.castRay(start, dirDown, travel + margin + w.r);
        if (!ray) { w.contact = false; w.c = 0; w.cdot = 0; w.sink = 0; w.zLoad = 0; w.zSlip = 0; w.nSoil = 0; continue; }
        kind = ray.info?.kind;
        toi = ray.dist - w.r;
        v3set(w.n, ray.normal.x, ray.normal.y, ray.normal.z);
        v3set(w.p, ray.point.x, ray.point.y, ray.point.z);
        this.rayFallbacks++;
      }
      let ny = v3dot(w.n, yb);
      if (ny < 0) { w.n.x = -w.n.x; w.n.y = -w.n.y; w.n.z = -w.n.z; ny = -ny; }
      if (hit && ny < XS.normalTrustCos) {
        // GJK against triangle meshes can report internal-edge normals (nearly tangential) -> use
        // the face normal under the hub from a ray instead (prevents impulsive backward forces).
        const ray = sim.castRay(start, dirDown, travel + margin + w.r + 0.3);
        if (ray) {
          v3set(w.n, ray.normal.x, ray.normal.y, ray.normal.z);
          ny = v3dot(w.n, yb);
          if (ny < 0) { w.n.x = -w.n.x; w.n.y = -w.n.y; w.n.z = -w.n.z; ny = -ny; }
          this.normalFixes++;
        }
      }
      w.surface = surfaceAtPoint(kind, sim, w.p.x, w.p.z);
      w.prof = SURFACES[w.surface];
      // sunk into soil: the wheel stands w.sink below the rigid surface (rut); unloaded inside a rut -> no contact
      w.c = travel + margin - toi - w.sink;
      if (w.sink > 0 && w.c <= 0) { w.contact = false; w.c = 0; w.cdot = 0; continue; }
      w.contact = true;
      const vp = sim.pointVelocity(w.p, this.tmp2);
      w.cdot = -v3dot(vp, w.n) / Math.max(ny, 0.3);
      // contact frame: ex = wheel heading projected into the ground plane, ey = n x ex (left)
      const head = qrot(q, { x: Math.sin(w.steer), y: 0, z: Math.cos(w.steer) });
      const hn = v3dot(head, w.n);
      v3norm(v3set(w.ex, head.x - hn * w.n.x, head.y - hn * w.n.y, head.z - hn * w.n.z), w.ex);
      v3cross(w.n, w.ex, w.ey);
      w.vx = v3dot(vp, w.ex); w.vy = v3dot(vp, w.ey);
      nContact++; nSum.x += w.n.x; nSum.y += w.n.y; nSum.z += w.n.z;
    }
    this.bus.contactCount = nContact;
    if (nContact > 0) v3norm(nSum, this.bus.surfaceNormal);

    // ---------------------------------------------------------- strut forces (spring, damper, bump stop, ARB)
    const [fl, fr, rl, rr] = this.wheels;
    const arbF = SUSP.antiRollNPerM.front * (fl.c - fr.c);
    const arbR = SUSP.antiRollNPerM.rear * (rl.c - rr.c);
    const arb = [arbF, -arbF, arbR, -arbR];
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.contact) { w.strutN = 0; w.N = 0; w.D = 0; w.bumpStopN = 0; continue; }
      w.bumpStopN = bumpStopForce(w.c);
      w.strutN = Math.max(0, SUSP.springNPerM * w.c + damperForce(w.cdot) + hydraulicStopForce(w.c, w.cdot) + w.bumpStopN + arb[i]);
      w.N = w.strutN / Math.max(v3dot(w.n, yb), 0.3);
      w.D = w.prof.tire.peak(w.N, w.spec.width * (FOOTPRINT_M + Math.sqrt(2 * w.r * w.sink))) * dmg.gripScale[i];
    }
    this.updateSoil(sim, dt, vFwd);
    let muSum = 0;
    for (const w of this.wheels) if (w.contact) muSum += w.prof.tire.muNominal / TIRE.mu0;
    this.bus.muScale = nContact > 0 ? muSum / nContact : 1;

    // ---------------------------------------------------------- powertrain + brakes (torque requests)
    this.computeTorques(ctx, m, zb, vFwd);

    // ---------------------------------------------------------- tire / wheel spin substeps
    const nSub = Math.max(1, Math.ceil(dt / XT.substepS - 1e-9));
    const h = dt / nSub;
    let util = 0, fsum = 0;
    for (const w of this.wheels) {
      this.integrateWheel(w, h, nSub, m, drive.handbrake, drive.launchMode);
      if (w.contact) {
        const F = this.F;
        F.x = w.N * w.n.x + w.fx * w.ex.x + w.fy * w.ey.x;
        F.y = w.N * w.n.y + w.fx * w.ex.y + w.fy * w.ey.y;
        F.z = w.N * w.n.z + w.fx * w.ex.z + w.fy * w.ey.z;
        ctx.acc.addWorld(F, w.p);
        const ft = Math.hypot(w.fx, w.fy);
        fsum += ft;
        if (w.D > 0) util = Math.max(util, ft / w.D);
      }
    }
    this.bus.tireUtilization = util;
    this.bus.tireForceN = fsum;
  }

  private computeTorques(ctx: StepContext, m: number, zb: Vec3, vFwd: number): void {
    const { drive, dt } = ctx;
    const dir = drive.reverse ? -1 : 1;
    const thr = clamp(drive.throttle, 0, 1), brk = clamp(drive.brake, 0, 1);
    const driven = this.wheels.filter((w) => w.spec.driven);
    const rD = driven[0].r;
    const pMech = PT.batteryPowerW * XP.driveEfficiency;
    // accel governor (specific force along body +Z): feed-forward from forces already accumulated
    let tGov = Infinity, tGovMin = -Infinity;
    if (drive.accelLimitG != null) {
      const fOther = v3dot(ctx.acc.force, zb);
      const fAllow = m * drive.accelLimitG * G0 - fOther;
      tGov = (fAllow * rD) / driven.length;
      if (tGov < 0) tGovMin = tGov; // may regen-brake against the thrusters
    }
    const omegaMax = PT.topSpeedMs / rD;
    // stability control (ESC): cut drive torque when yaw rate departs from the steering reference
    // or the body side-slip grows (RWD at the traction limit is otherwise yaw-unstable)
    const esc = this.escFactor(ctx, zb, vFwd);
    this.esc = esc;
    let power = 0;
    for (const w of this.wheels) {
      // friction brake capacity
      let tb = brk * PT.maxBrakeTorqueNm * (w.spec.driven || !w.spec.steered ? XP.brakeBiasRear : 1);
      if (drive.handbrake && !w.spec.steered) tb = PT.maxBrakeTorqueNm;
      let td = 0;
      if (w.spec.driven) {
        const om = Math.abs(w.omega);
        let tAvail = Math.min(PT.maxWheelTorqueNm, pMech / driven.length / Math.max(om, 1e-3));
        // rpm limiter (top speed) / reverse speed limit
        const lim = dir > 0 ? omegaMax : XP.reverseMaxMs / rD;
        if (w.omega * dir > 0) tAvail *= clamp((lim - om) / (0.01 * omegaMax), 0, 1);
        let req = dir * thr * tAvail * esc;
        if (dir > 0 && Number.isFinite(tGov)) req = Math.min(req, tGov);
        // regen: part of the rear braking via the motors (forward motion only)
        if (brk > 0 && Math.abs(w.vx) > 2 && w.contact) {
          const tReg = Math.min(XP.regenShareOfRearBrake * tb, PT.maxWheelTorqueNm,
            PT.regenPowerW / driven.length / Math.max(om, 1e-3));
          req -= Math.sign(w.omega) * tReg;
          tb -= tReg;
        }
        if (tGovMin > -Infinity && thr > 0) {
          const tRegMax = Math.min(PT.maxWheelTorqueNm, PT.regenPowerW / driven.length / Math.max(om, 1e-3));
          req = Math.max(tGovMin, -tRegMax);
        }
        // torque slew (launch mode: none)
        if (!drive.launchMode) {
          const ds = XP.torqueSlewNmPerS * dt;
          req = w.driveCmd + clamp(req - w.driveCmd, -ds, ds);
        }
        w.driveCmd = req;
        td = req;
      }
      w.driveTorque = td;
      // ESC selective braking: braking the left (+X) wheels yaws the car left (+Y) and vice versa
      const side = Math.sign(w.spec.pos.x);
      if (this.escYawDemand * side > 0) tb = Math.max(tb, Math.abs(this.escYawDemand) * XP.escBrakeTorqueNm * (w.spec.steered ? 1 : 0.5));
      w.brakeTorque = Math.max(0, tb);
      // electrical power (mech at the wheel / efficiency, regen * efficiency)
      const pm = td * w.omega;
      power += pm >= 0 ? pm / XP.driveEfficiency : pm * XP.regenEfficiency;
    }
    this.motorPowerW = power;
  }

  /** 1 = no intervention ... 0 = drive torque fully cut. */
  private escFactor(ctx: StepContext, zb: Vec3, vFwd: number): number {
    this.escYawDemand = 0;
    if (vFwd < 5 || this.bus.contactCount < 3) return 1;
    const sim = ctx.sim;
    const v = sim.body.linvel(), w = sim.body.angvel();
    const n = this.bus.surfaceNormal;
    const yawRate = w.x * n.x + w.y * n.y + w.z * n.z;
    // reachable lateral acceleration from the current tire capacity (suction raises it)
    let dSum = 0; for (const wh of this.wheels) dSum += wh.D;
    const gEnv = Math.hypot(sim.env.gravity.x, sim.env.gravity.y, sim.env.gravity.z);
    const muG = Math.max(0.3 * gEnv, (1.05 * dSum) / ctx.state.massKg, 0.5);
    const rRef = clamp((vFwd * Math.tan(this.steerAngle)) / GEOM.wheelbase, -muG / vFwd, muG / vFwd);
    const yawErr = Math.abs(yawRate - rRef);
    // side-slip: lateral body velocity in the surface plane
    const left = v3cross(n, zb, this.tmp);
    const beta = Math.abs(Math.atan2(v.x * left.x + v.y * left.y + v.z * left.z, vFwd));
    const e = Math.max((yawErr - XP.escYawDeadbandRadS) / XP.escYawRangeRadS, (beta - XP.escBetaDeadbandRad) / XP.escBetaRangeRad);
    // yaw-moment request for selective wheel braking: sign = direction the car must yaw (+ = left)
    this.escYawDemand = clamp((yawErr - XP.escYawDeadbandRadS) / XP.escYawRangeRadS, 0, 1) * Math.sign(rRef - yawRate);
    return clamp(1 - e, 0, 1);
  }

  /**
   * Soil state per wheel: load sinkage (plastic: follows a load increase within SINK_LOAD_TAU_S,
   * recovers only by rolling onto fresh soil over one shear length), slip sinkage (excavation over
   * DIG_LENGTH_M of slip distance), compaction + bulldozing resistance (a rear wheel running in the
   * front rut only compacts the extra depth), dust hint.
   */
  private updateSoil(sim: RoadsterSim, dt: number, vFwd: number): void {
    const gv = sim.env.gravity, g = Math.hypot(gv.x, gv.y, gv.z);
    let dustMax = 0;
    for (let k = 0; k < 4; k++) {
      const w = this.wheels[k], s = w.prof.soil;
      w.rSoil = 0;
      const vx = w.contact ? w.vx : vFwd, ax = Math.abs(vx);
      const vSlip = w.omega * w.r - vx;
      w.dust = w.contact ? w.prof.dustiness * clamp(0.1 * Math.abs(vSlip) + 0.02 * ax, 0, 1) : 0;
      dustMax = Math.max(dustMax, w.dust);
      if (!s) { w.sink = 0; w.zLoad = 0; w.zSlip = 0; w.nSoil = 0; continue; }
      const b = w.spec.width;
      const kLoad = -Math.expm1(-dt / SINK_LOAD_TAU_S);
      w.nSoil += ((w.contact ? w.N : 0) - w.nSoil) * kLoad;
      const z0 = staticSinkage(w.nSoil, b, w.r, s);
      const iSlip = vSlip / Math.max(Math.abs(w.omega * w.r), ax, 0.5);
      const zs0 = z0 * (slipSinkageFactor(iSlip) - 1);
      const roll = -Math.expm1(-(ax * dt) / SOIL_SHEAR_LENGTH_M);
      w.zLoad += (z0 - w.zLoad) * (z0 > w.zLoad ? kLoad : roll);
      const dig = -Math.expm1(-((Math.abs(vSlip) + ax) * dt) / DIG_LENGTH_M);
      w.zSlip += (zs0 - w.zSlip) * (zs0 > w.zSlip ? dig : roll);
      const zRut = Math.min(w.zLoad + w.zSlip, MAX_SINK_FRACTION * w.r);
      w.sink += (zRut - w.sink) * -Math.expm1(-dt / SINK_GEOM_TAU_S);
      if (!w.contact) continue;
      let zPrev = 0;
      if (!w.spec.steered) {
        const f = this.wheels[k - 2];
        if (f && f.contact && f.prof.soil && vx > 0.5) zPrev = Math.min(f.sink, w.sink);
      }
      w.rSoil = compactionResistance(w.sink, b, s, zPrev) + bulldozingResistance(w.sink - zPrev, b, s, g);
    }
    this.bus.dust = dustMax;
  }

  /** Substepped tire relaxation + wheel spin with implicit brake stiction, TC and ABS. */
  private integrateWheel(w: Wheel, h: number, n: number, m: number, handbrake: boolean, launch: boolean): void {
    const sigma = TIRE.relaxationLengthM, r = w.r, I = w.I;
    const vx = w.vx, vy = w.vy, ax = Math.abs(vx);
    const out = { fx: 0, fy: 0 };
    let fxs = 0, fys = 0;
    if (!w.contact || w.D <= 0) {
      w.sx = 0; w.sy = 0;
      for (let k = 0; k < n; k++) w.omega = brakeStep(w.omega + (h * w.driveTorque) / I, (w.brakeTorque * h) / I);
      w.fx = 0; w.fy = 0;
      return;
    }
    const D = w.D, tp = w.prof.tire;
    const mEff = m / 4;
    const fade = clamp(1 - ax / XT.lowSpeedDampFadeMs, 0, 1);
    const cx = fade * 2 * XT.lowSpeedZeta * Math.sqrt((tp.cLong * D / sigma) * mEff);
    const cy = fade * 2 * XT.lowSpeedZeta * Math.sqrt((tp.cLat * D / sigma) * mEff);
    // tire hysteresis + soil compaction/bulldozing as a Coulomb torque (never reverses omega -> no creep)
    const tRR = (tp.rollingResistance * w.N + w.rSoil) * r;
    const lam = XP.slipConvergencePerS;
    const absOn = ax > XP.absMinSpeedMs && !(handbrake && !w.spec.steered) && w.brakeTorque > 0;
    const tcOn = w.spec.driven && w.driveTorque !== 0;
    for (let k = 0; k < n; k++) {
      w.sx = relax(w.sx, w.omega * r - vx, ax, sigma, h);
      w.sy = relax(w.sy, -vy, ax, sigma, h);
      combinedForce(w.sx, w.sy, D, out, tp);
      let fx = out.fx - cx * (vx - w.omega * r);
      let fy = out.fy - cy * vy;
      const fm = Math.hypot(fx, fy);
      if (fm > D) { fx *= D / fm; fy *= D / fm; }
      // available peak longitudinal slip given the lateral demand (friction circle in slip space)
      const latUse = Math.min(Math.abs(w.sy) / tp.syN, 0.95);
      const latRoot = Math.sqrt(1 - latUse * latUse);
      const sxAvail = tp.tcSlip * latRoot;
      const omNoDrive = w.omega - (h * fx * r) / I;
      let omFree = omNoDrive + (h * w.driveTorque) / I;
      if (tcOn) {
        const st = sxAvail * (launch ? XP.launchSlipFactor : XP.tcSlipFactor);
        if (w.driveTorque > 0) {
          const omLim = (vx + ax * w.sx + sigma * lam * (st - w.sx)) / r;
          if (omFree > omLim) omFree = Math.max(omLim, omNoDrive);
        } else if (w.driveTorque < 0) {
          const omLim = (vx + ax * w.sx + sigma * lam * (-st - w.sx)) / r;
          if (omFree < omLim) omFree = Math.min(omLim, omNoDrive);
        }
      }
      let om = brakeStep(omFree, ((w.brakeTorque + tRR) * h) / I);
      if (absOn) {
        const st = tp.absSlip * latRoot;
        if (vx > 0) {
          const omMin = (vx + ax * w.sx + sigma * lam * (-st - w.sx)) / r;
          om = Math.max(om, Math.min(omFree, omMin));
        } else {
          const omMax = (vx + ax * w.sx + sigma * lam * (st - w.sx)) / r;
          om = Math.min(om, Math.max(omFree, omMax));
        }
      }
      w.omega = om;
      fxs += fx; fys += fy;
    }
    w.fx = fxs / n; w.fy = fys / n;
  }

  writeState(state: VehicleState): void {
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i], s = state.wheels[i];
      s.contact = w.contact;
      s.compression = w.c;
      s.suspensionForceN = w.strutN;
      s.slipRatio = w.sx;
      s.slipAngleRad = -Math.atan(w.sy);
      s.angularVel = w.omega;
      s.steerRad = w.steer;
      s.normalLoadN = w.N;
      s.contactPoint.x = w.p.x; s.contactPoint.y = w.p.y; s.contactPoint.z = w.p.z;
      s.surfaceNormal.x = w.n.x; s.surfaceNormal.y = w.n.y; s.surfaceNormal.z = w.n.z;
    }
    state.motorPowerW = this.motorPowerW;
  }
}

const XS_ACK = VEH_EXT.steering.ackermann;

/** Coulomb brake/rolling-resistance torque as an implicit stiction: never reverses omega. */
function brakeStep(omega: number, dOmega: number): number {
  if (Math.abs(omega) <= dOmega) return 0;
  return omega - Math.sign(omega) * dOmega;
}
