// RoadsterSim: the single physics "truth" (implements the shared VehicleSim contract).
// The kernel handles mass properties, tick order, propulsion and telemetry. Ground-vehicle
// physics (suspension/tires, powertrain, fans, aero) plug in as ForceModules (src/sim/vehicle).
import RAPIER from '@dimforge/rapier3d-compat';
import { ROADSTER } from '@shared/roadster';
import {
  G0, DEG, PitchTracker, qaxisAngle, qrot, qrotInv, rollDeg, v3, v3add, v3cross, v3scale, v3sub,
  type Quat, type Vec3,
} from '@shared/math';
import {
  NOZZLE_COUNT, SIM_DT, WHEEL_IDS,
  type DriveInput, type SpawnPose, type SystemsInput, type TelemetryFrame, type ThrusterCommand,
  type VehicleSim, type VehicleState,
} from '@shared/types';
import { Propulsion } from './propulsion';
import { EARTH, type Environment, type SurfaceKind } from '@shared/environment';
import { PropSystem, BREAK_WINDOW_S, rotTerm } from './props';
import type { PropPlacement } from '@shared/props';
import { GROUP_CAR, GROUP_PROP, GROUP_WORLD, buildLandmarkColliders, buildTerrainColliders, buildTrackColliders, groups, type LandmarkShape, type WorldColliderInfo } from './world';

/** heightAboveGroundM when no ground is found below the car (space, off the terrain, very high). */
export const NO_GROUND_M = 10_000;

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}
export { RAPIER };

/** Accumulates forces/torques about the current centre of mass (world frame). */
export class ForceAccumulator {
  readonly force = v3();
  readonly torque = v3();
  com = v3();
  private tmp = v3(); private tmp2 = v3();
  clear(com: Vec3): void { this.force.x = this.force.y = this.force.z = 0; this.torque.x = this.torque.y = this.torque.z = 0; this.com = com; }
  /** Force and application point in world frame. */
  addWorld(F: Vec3, pWorld: Vec3): void {
    v3add(this.force, F, this.force);
    v3sub(pWorld, this.com, this.tmp);
    v3add(this.torque, v3cross(this.tmp, F, this.tmp2), this.torque);
  }
  /** Force applied at the centre of mass (no torque). */
  addAtCom(F: Vec3): void { v3add(this.force, F, this.force); }
  addTorque(T: Vec3): void { v3add(this.torque, T, this.torque); }
}

export interface StepContext {
  dt: number;
  t: number;
  sim: RoadsterSim;
  drive: DriveInput;
  systems: SystemsInput;
  acc: ForceAccumulator;
  /** State at the beginning of the step (previous result). */
  state: VehicleState;
}

export interface ForceModule {
  readonly name: string;
  reset(sim: RoadsterSim): void;
  /** Add forces for this step (tick order step 5). */
  apply(ctx: StepContext): void;
  /** Fill module-owned parts of the state after the Rapier step (tick order step 7). */
  writeState?(state: VehicleState, sim: RoadsterSim): void;
}

/** One chassis contact point of the last step, recorded for the damage model (RoadsterSim.recordBodyContacts). */
export interface BodyContact {
  /** Contact point on the chassis (body frame). */
  p: Vec3;
  /** Direction of the contact impulse on the car (body frame, unit: into the car). */
  dir: Vec3;
  /** Approach speed of the chassis point towards the obstacle before / after the step (m/s, < 0 = separating). */
  vnPre: number;
  vnPost: number;
  /** Normal impulse of the solver at this point in the step (N s). */
  impulse: number;
  /** Contact with a movable prop (only the car's speed is known: absorbed energy ≈ ½·J·vnPre). */
  prop: boolean;
}

export interface RoadsterSimOptions {
  modules?: ForceModule[];
  /** Optional per-run parameter scaling for robustness tests. */
  massScale?: number;
  inertiaScale?: number;
  /** Fixed step override (default SIM_DT = 1/240) — for step-size convergence tests only. */
  dt?: number;
  /** Ground of the world: McGregor track (default), a heightmap terrain, or none (space). */
  ground?: 'track' | 'terrain' | 'space';
  /** Landmark collision shapes (pyramid hulls, exact stone/rover meshes) → static colliders. */
  landmarks?: LandmarkShape[];
  /** Decoded heightmap (see src/shared/worlds.ts) when ground = 'terrain'. */
  terrain?: { heights: Float32Array; size: number; extentM: number; fineCenter?: { x: number; z: number }; fineAreas?: { minX: number; maxX: number; minZ: number; maxZ: number }[] };
  /** movable, breakable landmarks (dynamic bodies whose parts break off, src/sim/core/props.ts). */
  props?: PropPlacement[];
  /** Valve timing overrides (Monte Carlo robustness: 4–16 ms delays). */
  valves?: Partial<{ openDelayS: number; closeDelayS: number; minOnTimeS: number; pwmPeriodS: number }>;
}

const makeState = (): VehicleState => ({
  t: 0, pos: v3(), quat: { x: 0, y: 0, z: 0, w: 1 }, linVel: v3(), angVel: v3(), specificForce: v3(0, G0, 0),
  massKg: ROADSTER.dryMassKg,
  wheels: WHEEL_IDS.map((id) => ({
    id, contact: false, compression: 0, suspensionForceN: 0, slipRatio: 0, slipAngleRad: 0, angularVel: 0, steerRad: 0,
    normalLoadN: 0, contactPoint: v3(), surfaceNormal: v3(0, 1, 0),
  })),
  tank: { airMassKg: 0, pressurePa: 0, gasTempK: 288, wallTempK: 288, feedPressurePa: 0, regulated: false },
  nozzles: Array.from({ length: NOZZLE_COUNT }, () => ({ open: false, thrustN: 0, massFlowKgS: 0, exitPressureRatio: 1 })),
  fans: { mode: 'off', deltaPPa: 0, flowM3s: 0, powerW: 0, forceN: 0, gapM: 1, rpmNorm: 0 },
  aero: { mode: 'auto', wingAngleDeg: 0, dragN: 0, downforceN: 0 },
  speedMs: 0, motorPowerW: 0, brakeInput: 0, groundContact: false, bodyContact: false, heightAboveGroundM: 0, crashed: false,
});

export class RoadsterSim implements VehicleSim {
  readonly world: RAPIER.World;
  readonly body: RAPIER.RigidBody;
  readonly chassis: RAPIER.Collider;
  readonly colliderInfo: Map<number, WorldColliderInfo>;
  propulsion = new Propulsion();
  readonly modules: ForceModule[];
  readonly acc = new ForceAccumulator();
  readonly gravity = { x: 0, y: -G0, z: 0 };
  /** Ground material of the current site (tire model per surface; ramps on McGregor are concrete). */
  surface: SurfaceKind = 'asphalt';
  /** World rectangles where the terrain is bedrock/pavement instead of the site material (Giza: the pyramid
   *  courts are levelled limestone, not loose sand). */
  hardGround: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  /** Current physical environment (Phase 2 worlds). Vehicle modules read airDensity from here. */
  env: Environment = { ...EARTH };
  /** The compressor can deliver air here: an atmosphere to draw in, or the on-board supply ("Compressor: Fun"). */
  get compressorAvailable(): boolean { return this.env.canRefill || this.propulsion.refillOnboard; }
  private state = makeState();
  private prevVel = v3();
  private prevAngVel = v3();
  /** World centre of mass at the end of the previous step. */
  private prevCom = v3();
  /** Largest normal impact speed of a chassis contact in the last step (m/s). */
  impactSpeed = 0;
  private skipContacts = false;
  /** Ground type of this world (altitude reference: track = pad plane y = 0, terrain = ground below the car). */
  groundKind: 'track' | 'terrain' | 'space' = 'track';
  private gFilt = G0;
  private massKey = -1;
  private phaseLabel = '';
  private readonly pitch = new PitchTracker();
  private hudPitch = 0;
  private massScale: number;
  private inertiaScale: number;
  /** Fixed step of this instance. */
  readonly dt: number;
  /** Body-frame centre of mass (moves with air mass). */
  readonly comBody = v3();
  bodyContactSpeed = 0;
  /** World colliders the chassis touches this step. */
  readonly contacts: WorldColliderInfo[] = [];
  /** movable landmarks of this world (null if none). */
  readonly props: PropSystem | null;
  /** Car Δv (m/s) from impulses exchanged with props in the last BREAK_WINDOW_S – the crash measure for light objects. */
  propImpactDv = 0;
  /** Damage-model hooks (src/sim/vehicle/damage.ts): record the chassis contacts of each step, and whether a
   *  hard body impact / upper-body contact ends the run here (off: the damage model decides). */
  recordBodyContacts = false;
  readonly bodyContacts: BodyContact[] = [];
  impactCrash = true;
  private propRing: Float64Array;
  private propRingK = 0;

  /** Use RoadsterSim.create() (async Rapier init). */
  private constructor(opts: RoadsterSimOptions) {
    this.world = new RAPIER.World(this.gravity);
    this.dt = opts.dt ?? SIM_DT;
    this.world.timestep = this.dt;
    const ground = opts.ground ?? 'track';
    this.groundKind = ground;
    if (ground === 'terrain') {
      if (!opts.terrain) throw new Error('ground "terrain" needs opts.terrain');
      this.colliderInfo = buildTerrainColliders(RAPIER, this.world, opts.terrain.heights, opts.terrain.size, opts.terrain.extentM, { fineCenter: opts.terrain.fineCenter, fineAreas: opts.terrain.fineAreas });
      if (opts.landmarks?.length) {
        for (const [h, i] of buildLandmarkColliders(RAPIER, this.world, opts.landmarks)) this.colliderInfo.set(h, i);
      }
    } else if (ground === 'space') {
      this.colliderInfo = new Map();
    } else {
      this.colliderInfo = buildTrackColliders(RAPIER, this.world);
    }
    // Prime the broad phase with the static world: Rapier's scene queries only see colliders after a step,
    // and the wheel casts of the very first tick must already hit the ground.
    this.world.step();
    this.body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setCcdEnabled(true).setAngularDamping(0).setLinearDamping(0),
    );
    const g = groups(GROUP_CAR, GROUP_WORLD | GROUP_PROP);
    const hullPts = new Float32Array(ROADSTER.hull.flatMap((p) => [p.x, p.y, p.z]));
    const hullDesc = RAPIER.ColliderDesc.convexHull(hullPts);
    if (!hullDesc) throw new Error('chassis hull failed');
    this.chassis = this.world.createCollider(
      hullDesc
        .setDensity(0).setFriction(0.5).setRestitution(0.05)
        .setCollisionGroups(g).setSolverGroups(g)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );
    this.props = opts.props?.length
      ? new PropSystem(RAPIER, this.world, opts.props, this.colliderInfo, this.dt, {
        handle: () => this.chassis.handle,
        pointVelocity0: (pt) => v3add(this.prevVel, v3cross(this.prevAngVel, v3sub(pt, this.prevCom))),
        invMassAt: (pt, n) => 1 / this.state.massKg + rotTerm(this.body, this.prevCom, pt, n),
      })
      : null;
    this.propRing = new Float64Array(Math.max(1, Math.round(BREAK_WINDOW_S / this.dt)) * 3);
    this.modules = opts.modules ?? [];
    if (opts.valves) this.propulsion = new Propulsion(undefined, { ...ROADSTER.valves, ...opts.valves });
    this.massScale = opts.massScale ?? 1;
    this.inertiaScale = opts.inertiaScale ?? 1;
  }

  static async create(opts: RoadsterSimOptions = {}): Promise<RoadsterSim> {
    await initRapier();
    return new RoadsterSim(opts);
  }

  setPhaseLabel(s: string): void { this.phaseLabel = s; }

  /** Switch the physical environment (gravity, ambient pressure, air density). */
  setEnvironment(env: Environment): void {
    this.env = { ...env, gravity: { ...env.gravity } };
    this.gravity.x = env.gravity.x; this.gravity.y = env.gravity.y; this.gravity.z = env.gravity.z;
    this.world.gravity = { ...env.gravity };
    this.propulsion.ambientPressure = env.ambientPressurePa;
  }

  /** spawn.pos = point on the ground under the car; the CoG is placed at restCogHeight above it. */
  reset(spawn: SpawnPose, opts: { airMassKg?: number } = {}): void {
    this.propulsion.reset(opts.airMassKg ?? ROADSTER.tank.fullMassKg);
    this.props?.reset();
    this.propRing.fill(0); this.propImpactDv = 0;
    const up = qrot(spawn.quat, { x: 0, y: ROADSTER.restCogHeightM, z: 0 });
    const p = v3add(spawn.pos, up);
    this.body.setTranslation(p, true);
    this.body.setRotation(spawn.quat, true);
    const fwd = qrot(spawn.quat, { x: 0, y: 0, z: 1 });
    const v = v3scale(fwd, spawn.speedMs ?? 0);
    this.body.setLinvel(v, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.resetForces(true); this.body.resetTorques(true);
    this.massKey = -1;
    this.updateMassProperties(true);
    this.state = makeState();
    this.phaseLabel = '';
    this.pitch.reset();
    this.prevVel = { ...v };
    this.prevAngVel = v3();
    this.impactSpeed = 0;
    this.gFilt = G0;
    this.bodyContactSpeed = 0;
    for (const m of this.modules) m.reset(this);
    // The narrow phase still holds the contacts of the pre-teleport pose: skip contact evaluation once.
    this.skipContacts = true;
    this.deriveState(0);
    this.skipContacts = false;
  }

  private updateMassProperties(force = false): void {
    const air = this.propulsion.tank.m;
    const key = Math.round(air * 2); // update every 0.5 kg
    if (!force && key === this.massKey) return;
    this.massKey = key;
    const dry = ROADSTER.dryMassKg * this.massScale;
    const m = dry + air;
    const tp = ROADSTER.tank.pos;
    const com = { x: (air * tp.x) / m, y: (air * tp.y) / m, z: (air * tp.z) / m };
    this.comBody.x = com.x; this.comBody.y = com.y; this.comBody.z = com.z;
    // principal inertia about the combined CoM (diagonal approximation; products neglected)
    const I = ROADSTER.dryInertia, s = this.inertiaScale * this.massScale;
    const d = { x: -com.x, y: -com.y, z: -com.z };           // dry CoG relative to combined CoM
    const a = { x: tp.x - com.x, y: tp.y - com.y, z: tp.z - com.z };
    const ix = I.x * s + dry * (d.y * d.y + d.z * d.z) + air * (a.y * a.y + a.z * a.z);
    const iy = I.y * s + dry * (d.x * d.x + d.z * d.z) + air * (a.x * a.x + a.z * a.z);
    const iz = I.z * s + dry * (d.x * d.x + d.y * d.y) + air * (a.x * a.x + a.y * a.y);
    this.body.setAdditionalMassProperties(m, com, { x: ix, y: iy, z: iz }, { x: 0, y: 0, z: 0, w: 1 }, true);
  }

  /** World-space centre of mass. */
  comWorld(out: Vec3 = v3()): Vec3 {
    const p = this.body.translation(), q = this.body.rotation();
    const c = qrot(q as Quat, this.comBody, out);
    return v3add(c, p as Vec3, out);
  }

  /** Body-frame point -> world. */
  toWorld(pBody: Vec3, out: Vec3 = v3()): Vec3 {
    const p = this.body.translation(), q = this.body.rotation();
    qrot(q as Quat, pBody, out);
    return v3add(out, p as Vec3, out);
  }
  /** Body-frame direction -> world. */
  dirToWorld(dBody: Vec3, out: Vec3 = v3()): Vec3 { return qrot(this.body.rotation() as Quat, dBody, out); }

  /** Velocity of a world point attached to the body. */
  pointVelocity(pWorld: Vec3, out: Vec3 = v3()): Vec3 {
    const v = this.body.linvel(), w = this.body.angvel();
    const c = this.comWorld();
    const r = v3sub(pWorld, c);
    v3cross(w as Vec3, r, out);
    return v3add(out, v as Vec3, out);
  }

  /** Raycast against the static world only (excludes the car). */
  castRay(origin: Vec3, dir: Vec3, maxDist: number): { dist: number; point: Vec3; normal: Vec3; info?: WorldColliderInfo } | null {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, groups(GROUP_CAR, GROUP_WORLD), undefined, this.body);
    if (!hit) return null;
    const pt = ray.pointAt(hit.timeOfImpact);
    return { dist: hit.timeOfImpact, point: { x: pt.x, y: pt.y, z: pt.z }, normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z }, info: this.colliderInfo.get(hit.collider.handle) };
  }

  step(drive: DriveInput, systems: SystemsInput, thrusters: ThrusterCommand): void {
    const dt = this.dt;
    const st = this.state;
    // 3+4. valves, regulator, nozzles, tank
    this.propulsion.step(dt, thrusters.duty, systems.refill && this.compressorAvailable);
    this.updateMassProperties();
    // 5. forces
    this.body.resetForces(true); this.body.resetTorques(true);
    const com = this.comWorld();
    this.acc.clear(com);
    const q = this.body.rotation() as Quat;
    const fw = v3(), pw = v3();
    for (const f of this.propulsion.forces) {
      if (f.forceBody.x === 0 && f.forceBody.y === 0 && f.forceBody.z === 0) continue;
      qrot(q, f.forceBody, fw);
      this.toWorld(f.pointBody, pw);
      this.acc.addWorld(fw, pw);
    }
    const ctx: StepContext = { dt, t: st.t, sim: this, drive, systems, acc: this.acc, state: st };
    for (const m of this.modules) m.apply(ctx);
    this.body.addForce(this.acc.force, true);
    this.body.addTorque(this.acc.torque, true);
    // 6. integrate
    this.world.step();
    this.props?.afterStep();
    // 7. derive state
    this.deriveState(dt);
    this.state.brakeInput = drive.handbrake ? 1 : Math.max(0, Math.min(1, drive.brake));
  }

  private deriveState(dt: number): void {
    const s = this.state;
    const p = this.body.translation(), q = this.body.rotation() as Quat;
    const v = this.body.linvel(), w = this.body.angvel();
    s.t += dt;
    s.pos.x = p.x; s.pos.y = p.y; s.pos.z = p.z;
    s.quat.x = q.x; s.quat.y = q.y; s.quat.z = q.z; s.quat.w = q.w;
    s.linVel.x = v.x; s.linVel.y = v.y; s.linVel.z = v.z;
    s.angVel.x = w.x; s.angVel.y = w.y; s.angVel.z = w.z;
    s.speedMs = Math.hypot(v.x, v.y, v.z);
    this.hudPitch = this.pitch.update(s.quat, s.angVel);
    s.massKg = ROADSTER.dryMassKg * this.massScale + this.propulsion.tank.m;
    if (dt > 0) {
      const a = { x: (v.x - this.prevVel.x) / dt, y: (v.y - this.prevVel.y) / dt, z: (v.z - this.prevVel.z) / dt };
      const fWorld = v3sub(a, this.gravity);
      qrotInv(q, fWorld, s.specificForce);
      const alpha = dt / (dt + 1 / (2 * Math.PI * 10));
      this.gFilt += alpha * (Math.hypot(fWorld.x, fWorld.y, fWorld.z) - this.gFilt);
    }
    // tank + nozzles
    Object.assign(s.tank, this.propulsion.tank.state());
    for (let i = 0; i < NOZZLE_COUNT; i++) Object.assign(s.nozzles[i], this.propulsion.states[i]);
    // chassis contact
    // Chassis contacts: impact speed = pre-step velocity of the contact point along the contact normal.
    let contact = false, roofOnGround = false, impact = 0;
    this.contacts.length = 0;
    const com = this.comWorld();
    // impulses exchanged with movable landmarks (a light object is pushed away, it is no wall)
    let pjx = 0, pjy = 0, pjz = 0;
    const rec = this.recordBodyContacts && dt > 0;
    this.bodyContacts.length = 0;
    if (!this.skipContacts) this.world.contactPairsWith(this.chassis, (other) => {
      let touching = false;
      const prop = this.props?.isProp(other.handle) ?? false;
      this.world.contactPair(this.chassis, other, (manifold, flipped) => {
        const nc = manifold.numContacts();
        if (nc === 0) return;
        const n = manifold.normal();
        if (prop) {
          let J = 0;
          for (let i = 0; i < nc; i++) {
            J += manifold.contactImpulse(i);
            if (manifold.contactDist(i) <= 0.002 || manifold.contactImpulse(i) > 1e-6) touching = true;
            if (rec && manifold.contactImpulse(i) > 1e-6) this.recordContact(manifold, flipped, i, true);
          }
          // the normal points from the manifold's first shape to the second: impulse on the chassis
          const sg = flipped ? J : -J;
          pjx += n.x * sg; pjy += n.y * sg; pjz += n.z * sg;
          return;
        }
        for (let i = 0; i < nc; i++) {
          // Rapier keeps speculative contacts (positive distance) in the manifold. A point counts as a real
          // touch if it is (almost) touching OR the solver applied an impulse there this step (a hard impact
          // is resolved within the step and can end with a positive distance).
          if (manifold.contactDist(i) > 0.002 && manifold.contactImpulse(i) <= 1e-6) continue;
          touching = true;
          const lp = flipped ? manifold.localContactPoint2(i) : manifold.localContactPoint1(i);
          if (!lp) continue;
          // chassis collider frame == body frame (no collider offset)
          if (lp.y > 0.1) roofOnGround = true;
          const pw = this.toWorld(lp as Vec3);
          const r = v3sub(pw, com);
          const vp = v3add(this.prevVel, v3cross(this.prevAngVel, r));
          impact = Math.max(impact, Math.abs(vp.x * n.x + vp.y * n.y + vp.z * n.z));
          if (rec && manifold.contactImpulse(i) > 1e-6) this.recordContact(manifold, flipped, i, false);
        }
      });
      if (touching) {
        contact = true;
        const info = this.colliderInfo.get(other.handle);
        if (info) this.contacts.push(info);
      }
    });
    this.impactSpeed = impact;
    if (dt > 0) {
      const r = this.propRing, k = this.propRingK * 3;
      r[k] = pjx; r[k + 1] = pjy; r[k + 2] = pjz;
      this.propRingK = (this.propRingK + 1) % (r.length / 3);
      let jx = 0, jy = 0, jz = 0;
      for (let i = 0; i < r.length; i += 3) { jx += r[i]; jy += r[i + 1]; jz += r[i + 2]; }
      this.propImpactDv = Math.hypot(jx, jy, jz) / s.massKg;
    }
    if (contact && !s.bodyContact) this.bodyContactSpeed = impact;
    s.bodyContact = contact;
    const down = this.castRay(s.pos, { x: 0, y: -1, z: 0 }, NO_GROUND_M);
    s.heightAboveGroundM = down ? down.dist : NO_GROUND_M;
    for (const m of this.modules) m.writeState?.(s, this);
    s.groundContact = s.wheels.some((wh) => wh.contact);
    if (this.impactCrash) {
      // Crash: hard body impact anywhere, or the upper body (roof/sides) touching anything.
      if (contact && (impact > ROADSTER.integrity.crashBodyImpactMs || roofOnGround)) s.crashed = true;
      // Light movable objects: the car's own velocity change decides (≈ v for a wall, ≈ μ/m·v for a 210 kg rover)
      if (this.propImpactDv > ROADSTER.integrity.crashBodyImpactMs) s.crashed = true;
    }
    this.prevVel.x = v.x; this.prevVel.y = v.y; this.prevVel.z = v.z;
    this.prevAngVel.x = w.x; this.prevAngVel.y = w.y; this.prevAngVel.z = w.z;
    this.comWorld(this.prevCom);
  }

  /** Damage hook: one chassis contact point (approach speeds from the pre-/post-step motion of the car). */
  private recordContact(m: RAPIER.TempContactManifold, flipped: boolean, i: number, prop: boolean): void {
    const lp = flipped ? m.localContactPoint2(i) : m.localContactPoint1(i);
    if (!lp) return;
    const n = m.normal();
    // the normal points from the manifold's first shape to the second: impulse direction on the chassis
    const sg = flipped ? 1 : -1;
    const d = { x: n.x * sg, y: n.y * sg, z: n.z * sg };
    const pw = this.toWorld(lp as Vec3);
    const pre = v3add(this.prevVel, v3cross(this.prevAngVel, v3sub(pw, this.prevCom)));
    const post = this.pointVelocity(pw);
    const q = this.body.rotation() as Quat;
    this.bodyContacts.push({
      p: { x: lp.x, y: lp.y, z: lp.z }, dir: qrotInv(q, d), impulse: m.contactImpulse(i), prop,
      vnPre: -(pre.x * d.x + pre.y * d.y + pre.z * d.z), vnPost: -(post.x * d.x + post.y * d.y + post.z * d.z),
    });
  }

  getState(): Readonly<VehicleState> { return this.state; }

  telemetry(): TelemetryFrame {
    const s = this.state;
    return {
      t: s.t,
      // Stream HUD convention: 0 when standing on the ground. On terrain the reference is the ground below the car;
      // in space there is no ground (0).
      altitudeM: this.groundKind === 'track' ? Math.max(0, s.pos.y - ROADSTER.restCogHeightM)
        : this.groundKind === 'terrain' && s.heightAboveGroundM < NO_GROUND_M ? Math.max(0, s.heightAboveGroundM - ROADSTER.restCogHeightM) : 0,
      pitchDeg: this.hudPitch,
      rollDeg: rollDeg(s.quat),
      gForce: this.gFilt / G0,
      downforceKg: (s.fans.forceN + s.aero.downforceN) / G0,
      speedMs: s.speedMs,
      tankPressureBar: s.tank.pressurePa / 1e5,
      airMassKg: s.tank.airMassKg,
      thrusterDuty: Array.from(this.propulsion.dutyActual),
      fanDeltaPKPa: s.fans.deltaPPa / 1000,
      phase: this.phaseLabel,
    };
  }

  dispose(): void { this.world.free(); }
}

/** Ground spawn pose from a heading in degrees. */
export function spawnPose(pos: Vec3, headingDeg: number, speedMs = 0): SpawnPose {
  return { pos, quat: qaxisAngle({ x: 0, y: 1, z: 0 }, headingDeg * DEG), speedMs };
}
