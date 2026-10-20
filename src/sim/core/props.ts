// movable, breakable landmarks ("props") as Rapier rigid bodies.
//
// An intact object (LM descent stage, LRV, rover, Roadster 1) is ONE dynamic rigid body carrying the colliders of
// all its parts (boxes/cylinders/hulls, density 0) with the summed mass properties (src/shared/props.ts). A part's
// connection (PropJointDef: the bolted/welded joint) breaks when the collision energy that reaches the part exceeds
// its capacity; the part's colliders then leave the object body and the part flies on as its own body with the
// velocity its material point had (v + ω × r), the rest keeps the velocity of its new centre of mass – total
// momentum is conserved exactly.
//
// Why not Rapier joints: impulse joints (fixed/revolute) were tried first – a leg jammed between the car and the
// ground let their error correction pump energy back, the 2 t LM jumped away with ≈ 80 % of the car's kinetic
// energy (a single 2 t box under the same blow behaves plastically). Multibody joints woke at once, sank 5 cm into
// the ground and sprang back. A welded assembly is exactly rigid, sleeps, and conserves momentum.
//
// Break measure (Rapier 0.21 JS exposes no joint impulses; rigid contacts resolve an impact in 1–3 steps, so forces
// would depend on the step size):
//
//   E = ½ m_eff v_n²,   1/m_eff = Σ_bodies [ 1/M + (r × n)ᵀ I⁻¹ (r × n) ]   (static ground / landmarks: 0)
//
// v_n = closing speed of the contact point along the contact normal BEFORE the step (pre-step velocities and
// centres of mass of both bodies), M, I = mass and world inertia of each body, r the lever arm from its centre of
// mass (a blow on a leg tip 5 m out meets less effective mass than a central one). ½ m_eff v_n² is the kinetic
// energy of the relative motion at the contact point that a perfectly plastic impact turns into deformation –
// independent of the step size and of the restitution. Conservative: all of it is assumed to reach the struck
// part (the car's crumple zone takes none). Resting bodies fall asleep (no cost) and wake when touched.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { DEG, qaxisAngle, qmul, qrot, type Quat, type Vec3 } from '@shared/math';
import {
  assemblyMassProperties, eulerQuat, partMassProperties, scaleObjectDef,
  type PropObjectDef, type PropPartDef, type PropPlacement, type PropPose, type PropShape,
} from '@shared/props';
import { GROUP_CAR, GROUP_PROP, GROUP_WORLD, groups, type WorldColliderInfo } from './world';

type R = typeof RAPIER_NS;

/** Window (s) over which the car sums the impulses exchanged with props (crash measure, roadsterSim.ts):
 *  longer than a rigid impact (1–3 steps), shorter than a push. */
export const BREAK_WINDOW_S = 0.05;

export interface PropBreakEvent { t: number; objectId: string; partId: string; energyJ: number; capacityJ: number }

/** A rigid body of the prop system with its state at the end of the previous step (pre-step state). */
interface BodyState { body: RAPIER_NS.RigidBody; v0: Vec3; w0: Vec3; c0: Vec3 }

interface PartState {
  id: string;
  def: PropPartDef;
  mass: number;
  /** The object body while attached, its own body once broken off. */
  owner: BodyState;
  colliders: RAPIER_NS.Collider[];
  attached: boolean;
  capacityJ: number;
  peakE: number;
}

interface ObjectState {
  placement: PropPlacement; def: PropObjectDef; main: BodyState; parts: PartState[]; massKg: number;
  /** Set in the ground and still held (fixed body). */
  anchored: boolean;
  /** Anchored: principal moments about the pivot (object axes) of stone + buried butt. */
  pivotI?: Vec3;
}

/**
 * Prop collision groups: props touch the car's hull, the static world and each other. They are not members of
 * WORLD, so the wheel shape casts (src/sim/vehicle/chassis.ts) and ground rays ignore them: tire forces act on the
 * car only, which would break momentum conservation in a push.
 */
export const PROP_GROUPS = groups(GROUP_PROP, GROUP_CAR | GROUP_WORLD | GROUP_PROP);

const v3c = (v: { x: number; y: number; z: number }): Vec3 => ({ x: v.x, y: v.y, z: v.z });
/** Velocity of the point c + r of a rigid motion (v at c, ω). */
const rigidVel = (v: Vec3, w: Vec3, r: Vec3): Vec3 => ({ x: v.x + w.y * r.z - w.z * r.y, y: v.y + w.z * r.x - w.x * r.z, z: v.z + w.x * r.y - w.y * r.x });

export class PropSystem {
  readonly objects: ObjectState[] = [];
  readonly events: PropBreakEvent[] = [];
  /** Collider handle → (object, part) index. */
  private readonly owner = new Map<number, { o: number; p: number }>();
  private t = 0;

  constructor(
    private readonly RAPIER: R, private readonly world: RAPIER_NS.World, private readonly placements: PropPlacement[],
    private readonly info: Map<number, WorldColliderInfo>, private readonly dt: number,
    /** The car: chassis collider handle, pre-step velocity of a world point, 1/m_eff at a point along a normal. */
    private readonly car: { handle: () => number; pointVelocity0: (p: Vec3) => Vec3; invMassAt: (p: Vec3, n: Vec3) => number },
  ) {
    this.build();
  }

  /** Number of part connections still intact. */
  get intactJoints(): number { return this.objects.reduce((a, o) => a + o.parts.filter((p, i) => i > 0 && p.attached).length, 0); }

  /** Is this collider part of a prop? */
  isProp(handle: number): boolean { return this.owner.has(handle); }

  private makeBody(pos: Vec3, rot: Quat, parts: PropPartDef[], v: Vec3, w: Vec3): BodyState {
    const mp = assemblyMassProperties(parts);
    // created awake: a body created asleep had no ground contacts when it woke (it fell 2.4 cm before they came);
    // at rest Rapier puts it to sleep after ≈ 1.5 s
    const body = this.world.createRigidBody(
      this.RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation(rot)
        .setCcdEnabled(mp.mass < 150).setLinearDamping(0).setAngularDamping(0)
        .setAdditionalMassProperties(mp.mass, { x: mp.com[0], y: mp.com[1], z: mp.com[2] }, { x: mp.inertia[0], y: mp.inertia[1], z: mp.inertia[2] }, mp.frame),
    );
    body.setLinvel(v, false);
    body.setAngvel(w, false);
    const c = qrot(rot, { x: mp.com[0], y: mp.com[1], z: mp.com[2] });
    return { body, v0: { ...v }, w0: { ...w }, c0: { x: pos.x + c.x, y: pos.y + c.y, z: pos.z + c.z } };
  }

  private addColliders(o: number, p: number, pd: PropPartDef, b: BodyState, label: string): RAPIER_NS.Collider[] {
    return pd.shapes.map((sh) => {
      const c = this.world.createCollider(
        this.shapeDesc(sh).setDensity(0).setFriction(pd.friction ?? 0.6).setRestitution(pd.restitution ?? 0)
          .setRestitutionCombineRule(this.RAPIER.CoefficientCombineRule.Min)
          .setCollisionGroups(PROP_GROUPS).setSolverGroups(PROP_GROUPS),
        b.body,
      );
      this.owner.set(c.handle, { o, p });
      this.info.set(c.handle, { kind: 'prop', id: label });
      return c;
    });
  }

  private build(): void {
    this.placements.forEach((pl, oi) => {
      const d = scaleObjectDef(pl.def, pl.scale ?? 1);
      const qh = qaxisAngle({ x: 0, y: 1, z: 0 }, pl.headingDeg * DEG);
      const o = qrot(qh, { x: d.origin[0], y: d.origin[1], z: d.origin[2] });
      const pos = { x: pl.pos.x + o.x, y: pl.pos.y + o.y, z: pl.pos.z + o.z };
      const rot = qmul(qh, qaxisAngle({ x: 0, y: 1, z: 0 }, d.yawDeg * DEG));
      const main = this.makeBody(pos, rot, d.parts, pl.linVel ?? { x: 0, y: 0, z: 0 }, pl.angVel ?? { x: 0, y: 0, z: 0 });
      const st: ObjectState = { placement: pl, def: d, main, parts: [], massKg: 0, anchored: !!d.anchor };
      if (d.anchor) {
        // held by its socket: fixed until a blow overcomes it; rotates about the bottom of the buried butt
        main.body.setBodyType(this.RAPIER.RigidBodyType.Fixed, false);
        st.pivotI = pivotInertia(d);
      }
      d.parts.forEach((pd, pi) => {
        st.parts.push({
          id: pd.id, def: pd, mass: pd.massKg, owner: main, colliders: this.addColliders(oi, pi, pd, main, `${d.id}:${pd.id}`),
          attached: true, capacityJ: pi > 0 ? pd.joint?.breakEnergyJ ?? Infinity : Infinity, peakE: 0,
        });
        st.massKg += pd.massKg;
      });
      this.objects.push(st);
    });
  }

  private shapeDesc(sh: PropShape): RAPIER_NS.ColliderDesc {
    const { RAPIER } = this;
    if (sh.kind === 'box') {
      const d = RAPIER.ColliderDesc.cuboid(sh.h[0], sh.h[1], sh.h[2]).setTranslation(sh.c[0], sh.c[1], sh.c[2]);
      return sh.rotDeg ? d.setRotation(eulerQuat(sh.rotDeg)) : d;
    }
    if (sh.kind === 'cyl') {
      // as a 24-sided prism (convex hull): flat polygonal faces give stable resting contacts on the ground tiles
      const pts: number[] = [];
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * 2 * Math.PI, u = Math.cos(a) * sh.r, v = Math.sin(a) * sh.r;
        for (const h of [-sh.hh, sh.hh]) {
          const p = sh.axis === 'x' ? [h, u, v] : sh.axis === 'y' ? [u, h, v] : [u, v, h];
          pts.push(sh.c[0] + p[0], sh.c[1] + p[1], sh.c[2] + p[2]);
        }
      }
      const d = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
      if (!d) throw new Error('prop cylinder hull failed');
      return d;
    }
    const d = RAPIER.ColliderDesc.convexHull(new Float32Array(sh.pts));
    if (!d) throw new Error('prop hull failed');
    return d;
  }

  /** All bodies of an object (main body and broken-off parts). */
  private static bodies(o: ObjectState): Set<BodyState> { return new Set([o.main, ...o.parts.map((p) => p.owner)]); }

  /** Remove every prop body (colliders go with it). */
  private clear(): void {
    for (const o of this.objects) {
      for (const p of o.parts) for (const c of p.colliders) this.info.delete(c.handle);
      for (const b of PropSystem.bodies(o)) this.world.removeRigidBody(b.body);
    }
    this.objects.length = 0;
    this.owner.clear();
  }

  /** Back to the initial poses, everything intact (session restart). */
  reset(): void {
    this.clear();
    this.events.length = 0;
    this.t = 0;
    this.build();
  }

  /** Pre-step velocity of a world point on a body. */
  private static pointVel0(b: BodyState, pt: Vec3): Vec3 {
    return rigidVel(b.v0, b.w0, { x: pt.x - b.c0.x, y: pt.y - b.c0.y, z: pt.z - b.c0.z });
  }

  /** 1/m_eff of the body a prop collider sits on, at a world point along n: 1/M + (r × n)ᵀ I⁻¹ (r × n). */
  invMassAt(handle: number, pt: Vec3, n: Vec3): number {
    const w = this.owner.get(handle);
    if (!w) return 0;
    const b = this.objects[w.o].parts[w.p].owner;
    return b.body.invMass() + rotTerm(b.body, b.c0, pt, n);
  }

  /**
   * Anchored stone: a blow along n at pt (closing speed vn > 0, partner 1/m_eff invOther) – the stone, pinned at
   * its pivot, takes the impulse J = vn / (1/m_p + invOther) with 1/m_p = (r × n)ᵀ I_p⁻¹ (r × n); the kinetic
   * energy J²/(2 m_p) it would get must be absorbed by the socket. Returns [energy, J].
   */
  private anchorBlow(o: ObjectState, pt: Vec3, n: Vec3, vn: number, invOther: number): [number, number] {
    const d = o.def, a = d.anchor!, I = o.pivotI!;
    const t = o.main.body.translation(), q = o.main.body.rotation() as Quat;
    const qi = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    const rl = qrot(qi, { x: pt.x - t.x, y: pt.y - t.y + 0, z: pt.z - t.z });
    rl.y += a.depthM;                                        // from the pivot (0, −depth, 0)
    const nl = qrot(qi, n);
    const ux = rl.y * nl.z - rl.z * nl.y, uy = rl.z * nl.x - rl.x * nl.z, uz = rl.x * nl.y - rl.y * nl.x;
    // overturning only: the packed socket of a 2 × 1 m section does not let the stone twist about its long axis
    // (a free twist would make a blow on the stone's edge meet just ≈ 12 t instead of ≈ 70 t)
    const invP = ux * ux / I.x + uz * uz / I.z;
    void uy;
    const J = vn / (invP + invOther);
    return [invP > 0 ? 0.5 * J * J * invP : 0, J];
  }

  private checkAnchor(o: ObjectState, oi: number, carH: number): void {
    let best = { E: 0, J: 0, pt: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 0, z: 0 } };
    for (const c of o.parts[0].colliders) {
      this.world.contactPairsWith(c, (other) => {
        const ob = other.parent();
        if (!ob || ob.isFixed()) return;                       // ground, other stones still standing
        const w = this.owner.get(other.handle);
        this.world.contactPair(c, other, (m, flipped) => {
          const nc = m.numSolverContacts();
          if (!nc) return;
          const nr = m.normal(), sg = flipped ? 1 : -1;
          const n = { x: sg * nr.x, y: sg * nr.y, z: sg * nr.z };
          for (let i = 0; i < nc; i++) {
            const pt = m.solverContactPoint(i);
            if (!pt) continue;
            const vo = other.handle === carH ? this.car.pointVelocity0(pt) : w ? PropSystem.pointVel0(this.objects[w.o].parts[w.p].owner, pt) : { x: 0, y: 0, z: 0 };
            const vn = vo.x * n.x + vo.y * n.y + vo.z * n.z;   // partner moving along the push = closing
            if (vn <= 0) continue;
            const inv = other.handle === carH ? this.car.invMassAt(pt, n) : this.invMassAt(other.handle, pt, n);
            const [E, J] = this.anchorBlow(o, pt, n, vn, inv);
            if (E > best.E) best = { E, J, pt: v3c(pt), n };
          }
        });
      });
    }
    o.parts[0].peakE = Math.max(o.parts[0].peakE, best.E);
    const cap = o.def.anchor!.breakEnergyJ;
    if (best.E <= cap) return;
    // the socket gives way: the stone is free and keeps the energy the socket could not take
    o.anchored = false;
    const b = o.main.body;
    b.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
    // The packing has given way: the stone tips over the far edge of its base (the side the blow pushes it to)
    // with the kinetic energy E − capacity; gravity then decides whether it falls (a sarsen needs ≈ 13 kJ to bring
    // its centre of mass over the edge). Turning about the buried pivot would drive the visible base into the ground.
    const Erem = best.E - cap;
    const nh = { x: best.n.x, y: 0, z: best.n.z }, nl = Math.hypot(nh.x, nh.z) || 1;
    nh.x /= nl; nh.z /= nl;
    const axis = { x: nh.z, y: 0, z: -nh.x };                 // up × n: the top moves along n
    const t = b.translation(), q = b.rotation() as Quat;
    const sh = o.def.parts[0].shapes[0] as { h: [number, number, number] };
    const nlocal = qrot({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, nh);
    const reach = Math.abs(nlocal.x) * sh.h[0] + Math.abs(nlocal.z) * sh.h[2];   // half extent of the base along n
    const edge = { x: t.x + nh.x * reach, y: t.y, z: t.z + nh.z * reach };
    const c = b.worldCom();
    const r = { x: c.x - edge.x, y: c.y - edge.y, z: c.z - edge.z };
    const e = b.effectiveWorldInvInertia().elements;
    const ia = axis.x * (e[0] * axis.x + e[2] * axis.z) + axis.z * (e[2] * axis.x + e[5] * axis.z);
    const ra = r.x * axis.x + r.z * axis.z;
    const d2 = r.x * r.x + r.y * r.y + r.z * r.z - ra * ra;  // squared distance of the CoM from the edge axis
    const Iedge = 1 / ia + b.mass() * d2;
    const om = Math.sqrt((2 * Erem) / Iedge);
    const w = { x: axis.x * om, y: 0, z: axis.z * om };
    b.setAngvel(w, true);
    b.setLinvel(rigidVel({ x: 0, y: 0, z: 0 }, w, r), true);
    this.events.push({ t: this.t, objectId: o.def.id, partId: 'anchor', energyJ: best.E, capacityJ: cap });
    void oi;
  }

  /** After world.step(): collision energy per attached part, break overloaded connections, keep the state. */
  afterStep(): void {
    this.t += this.dt;
    const carH = this.car.handle();
    this.objects.forEach((o, oi) => {
      if (o.anchored) { this.checkAnchor(o, oi, carH); return; }
      if (o.main.body.isSleeping()) return;
      o.parts.forEach((p, pi) => {
        if (pi === 0 || !p.attached) return;
        let E = 0;
        for (const c of p.colliders) {
          this.world.contactPairsWith(c, (other) => {
            const w = this.owner.get(other.handle);
            const ob = other.parent();
            const isStatic = !ob || ob.isFixed();
            this.world.contactPair(c, other, (m, flipped) => {
              const nc = m.numSolverContacts();
              if (!nc) return;
              // manifold normal points from its first shape to the second; n = direction of the push on this part
              const nr = m.normal(), sg = flipped ? 1 : -1;
              const n = { x: sg * nr.x, y: sg * nr.y, z: sg * nr.z };
              for (let i = 0; i < nc; i++) {
                const pt = m.solverContactPoint(i);
                if (!pt) continue;
                const vp = PropSystem.pointVel0(o.main, pt);
                let vo = { x: 0, y: 0, z: 0 };
                if (!isStatic) {
                  if (other.handle === carH) vo = this.car.pointVelocity0(pt);
                  else if (w) vo = PropSystem.pointVel0(this.objects[w.o].parts[w.p].owner, pt);
                }
                // closing speed: the part moves against the push direction relative to the partner
                const vn = (vp.x - vo.x) * n.x + (vp.y - vo.y) * n.y + (vp.z - vo.z) * n.z;
                if (vn >= 0) continue;
                const inv = this.invMassAt(c.handle, pt, n)
                  + (isStatic ? 0 : other.handle === carH ? this.car.invMassAt(pt, n) : this.invMassAt(other.handle, pt, n));
                E = Math.max(E, (0.5 * vn * vn) / inv);
              }
            });
          });
        }
        p.peakE = Math.max(p.peakE, E);
        if (E > p.capacityJ) this.detach(oi, pi, E);
      });
    });
    for (const o of this.objects) for (const b of PropSystem.bodies(o)) {
      if (o.anchored) continue;
      const c = b.body.worldCom();
      b.c0.x = c.x; b.c0.y = c.y; b.c0.z = c.z;
      if (b.body.isSleeping()) { b.v0.x = b.v0.y = b.v0.z = 0; b.w0.x = b.w0.y = b.w0.z = 0; continue; }
      const v = b.body.linvel(), w = b.body.angvel();
      b.v0.x = v.x; b.v0.y = v.y; b.v0.z = v.z; b.w0.x = w.x; b.w0.y = w.y; b.w0.z = w.z;
    }
  }

  /** The part's connection fails: it becomes its own body moving like its material did. */
  private detach(oi: number, pi: number, energyJ: number): void {
    const o = this.objects[oi], p = o.parts[pi], main = o.main.body;
    const t = v3c(main.translation()), q = main.rotation() as Quat;
    const v = v3c(main.linvel()), w = v3c(main.angvel()), cm = v3c(main.worldCom());
    const pcom = partMassProperties(p.def).com;
    const pc = qrot(q, { x: pcom[0], y: pcom[1], z: pcom[2] });
    const vp = rigidVel(v, w, { x: t.x + pc.x - cm.x, y: t.y + pc.y - cm.y, z: t.z + pc.z - cm.z });
    for (const c of p.colliders) { this.info.delete(c.handle); this.owner.delete(c.handle); this.world.removeCollider(c, false); }
    const own = this.makeBody(t, q, [p.def], vp, w);
    p.owner = own;
    p.attached = false;
    p.colliders = this.addColliders(oi, pi, p.def, own, `${o.def.id}:${p.id}`);
    // the rest shrinks by the part and moves like its new centre of mass did: m·v_part + (M − m)·v_rest = M·v
    const mp = assemblyMassProperties(o.parts.filter((x) => x.attached).map((x) => x.def));
    main.setAdditionalMassProperties(mp.mass, { x: mp.com[0], y: mp.com[1], z: mp.com[2] }, { x: mp.inertia[0], y: mp.inertia[1], z: mp.inertia[2] }, mp.frame, true);
    const nc = qrot(q, { x: mp.com[0], y: mp.com[1], z: mp.com[2] });
    main.setLinvel(rigidVel(v, w, { x: t.x + nc.x - cm.x, y: t.y + nc.y - cm.y, z: t.z + nc.z - cm.z }), true);
    this.events.push({ t: this.t, objectId: o.def.id, partId: p.id, energyJ, capacityJ: p.capacityJ });
  }

  /** Current world poses of all parts, in placement/part order (body origin = object frame origin). */
  poses(out: PropPose[] = []): PropPose[] {
    let i = 0;
    for (const o of this.objects) for (const p of o.parts) {
      const t = p.owner.body.translation(), q = p.owner.body.rotation();
      const e = out[i] ??= { pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 } };
      e.pos.x = t.x; e.pos.y = t.y; e.pos.z = t.z;
      e.quat.x = q.x; e.quat.y = q.y; e.quat.z = q.z; e.quat.w = q.w;
      i++;
    }
    out.length = i;
    return out;
  }

  /** Centre-of-mass velocity of an object's main body (world frame). */
  velocity(objectIndex: number): Vec3 { return v3c(this.objects[objectIndex].main.body.linvel()); }

  /** Total linear momentum of an object (main body and broken-off parts, kg·m/s). */
  momentum(objectIndex: number): Vec3 {
    const m = { x: 0, y: 0, z: 0 };
    for (const b of PropSystem.bodies(this.objects[objectIndex])) {
      const v = b.body.linvel(), k = b.body.mass();
      m.x += k * v.x; m.y += k * v.y; m.z += k * v.z;
    }
    return m;
  }

  /** World pose of a part's body. */
  partPose(objectIndex: number, partIndex: number): { pos: Vec3; quat: Quat } {
    const b = this.objects[objectIndex].parts[partIndex].owner.body;
    const t = b.translation(), q = b.rotation();
    return { pos: { x: t.x, y: t.y, z: t.z }, quat: { x: q.x, y: q.y, z: q.z, w: q.w } };
  }

  /** Is the object still held by its socket? */
  anchored(objectIndex: number): boolean { return this.objects[objectIndex].anchored; }

  /** Is the object (main body) asleep? */
  sleeping(objectIndex: number): boolean { return this.objects[objectIndex].main.body.isSleeping(); }

  /** Peak break energy seen by a part (J) – tests and the report. */
  peakEnergy(objectIndex: number, partIndex: number): number { return this.objects[objectIndex].parts[partIndex].peakE; }
  jointIntact(objectIndex: number, partIndex: number): boolean { return this.objects[objectIndex].parts[partIndex].attached; }
}

/** (r × n)ᵀ I⁻¹ (r × n) for a body (world inverse inertia), r = pt − com. */
export function rotTerm(body: RAPIER_NS.RigidBody, com: Vec3, pt: Vec3, n: Vec3): number {
  const rx = pt.x - com.x, ry = pt.y - com.y, rz = pt.z - com.z;
  const ux = ry * n.z - rz * n.y, uy = rz * n.x - rx * n.z, uz = rx * n.y - ry * n.x;
  const e = body.effectiveWorldInvInertia().elements;   // upper triangle, row major: 11 12 13 22 23 33
  return ux * (e[0] * ux + e[1] * uy + e[2] * uz) + uy * (e[1] * ux + e[3] * uy + e[4] * uz) + uz * (e[2] * ux + e[4] * uy + e[5] * uz);
}

/**
 * Principal moments about the pivot (bottom of the buried butt, object frame (0, −depth, 0)) of a set stone:
 * box of the main shape's cross-section from −depth to its top, mass = visible + buried (uniform).
 */
export function pivotInertia(d: PropObjectDef): Vec3 {
  const a = d.anchor!, sh = d.parts[0].shapes[0];
  if (sh.kind !== 'box') throw new Error('anchored prop needs a box as first shape');
  const M = d.parts[0].massKg + a.buriedMassKg;
  const bx = 2 * sh.h[0], bz = 2 * sh.h[2], L = sh.c[1] + sh.h[1] + a.depthM;   // full length from the pivot
  // box about its centre + parallel axis to the pivot (centre L/2 above it)
  return {
    x: (M / 12) * (L * L + bz * bz) + M * (L / 2) ** 2,
    y: (M / 12) * (bx * bx + bz * bz),
    z: (M / 12) * (L * L + bx * bx) + M * (L / 2) ** 2,
  };
}
