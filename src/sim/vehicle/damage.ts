// Vehicle damage model (setting "Vehicle damage: Realistic"). Off = previous behaviour, untouched.
//
// Input: the chassis contacts the kernel records per step (RoadsterSim.bodyContacts: body-frame point,
// direction into the car, approach speed before/after the step, solver impulse) and the landings of the
// IntegrityModule. Energy absorbed per contact point: E = J·(v_pre + v_post)/2 (work of the contact impulse on
// the approach speed; = ½·m_eff·v² for a plastic one-step impact, ½·m_eff·v²·(1 − e²) with restitution e, and
// correct when the solver spreads the impulse over several steps). Against a movable prop only the car's speed
// is known: E = ½·J·v_pre (= ½·μ·v² of the plastic two-body impact, μ = reduced mass).
//
// Output: permanent crush per zone (Campbell crush stiffness), dents for the renderer, functional damage fed
// into the vehicle through narrow hooks — VehicleBus.damage (chassis: toe / grip / lost wheel, fans: skirt
// leak, aero: wing downforce) and Propulsion.thrustScale / leakAreaM2 — torn-off parts as Rapier bodies like
// the R12 props, and the total-loss decision (state.crashed). Everything is deterministic (no random numbers).
import { RAPIER, type BodyContact, type ForceModule, type RoadsterSim, type StepContext } from '@sim/core/roadsterSim';
import { GROUP_PROP, GROUP_WORLD, groups } from '@sim/core/world';
import { ROADSTER } from '@shared/roadster';
import { DEG, clamp, qaxisAngle, qrot, v3, type Quat, type Vec3 } from '@shared/math';
import type { VehicleState } from '@shared/types';
import {
  DAMAGE_ZONES, intactDamage, type DamageMode, type DamageState, type DamageZone, type Dent, type DetachablePart,
} from '@shared/damage';
import type { VehicleBus } from './bus';
import type { IntegrityModule } from './integrity';

/**
 * Crush stiffness per zone after Campbell (SAE 740565, 1974): force per unit width F/w = A + B·C over the
 * permanent crush C. Absorbed energy E = w·(A·C + B·C²/2 + G) with G = A²/(2B), the energy taken without
 * permanent crush. Inverse: C = (√(2·B·E/w) − A)/B for E/w > G, else 0.
 * Ranges from the crash-test-derived coefficient sets (Prasad SAE 900098 / 910121, Neptune SAE 980024):
 * front A ≈ 35–70 kN/m, B ≈ 0.5–1.5 MN/m²; rear similar but softer; sides A ≈ 15–35 kN/m, B ≈ 0.2–0.5 MN/m².
 * Cross-checks: 1.7 t into a rigid full-width barrier at 56 km/h (US-NCAP) = 207 kJ → C ≈ 0.48 m (measured
 * 0.45–0.65 m); no permanent crush below ≈ 6 km/h (G·w = 2.2 kJ), matching the 4–8 km/h bumper tests (ECE R42,
 * 49 CFR 581). Critical crush = structural failure of the survival cell / drive train → total loss:
 * front 0.45 m (front motor + battery front), rear 0.40 m (rear motors, COPVs at ≈ 0.5 m), side 0.25 m
 * (door to seat, FMVSS 214 intrusion range), floor 0.06 m (carbon tub over the battery pack), roof 0.12 m
 * (FMVSS 216: ≥ 3× vehicle weight over 127 mm of crush).
 */
export const CRUSH: Record<DamageZone, { A: number; B: number; widthM: number; criticalM: number }> = {
  front: { A: 50_000, B: 900_000, widthM: 1.6, criticalM: 0.45 },
  rear: { A: 45_000, B: 700_000, widthM: 1.6, criticalM: 0.40 },
  left: { A: 25_000, B: 350_000, widthM: 2.0, criticalM: 0.25 },
  right: { A: 25_000, B: 350_000, widthM: 2.0, criticalM: 0.25 },
  underbody: { A: 150_000, B: 8_000_000, widthM: 1.5, criticalM: 0.06 },
  roof: { A: 40_000, B: 900_000, widthM: 1.0, criticalM: 0.12 },
};

/** Permanent crush (m) of a zone after absorbing `energyJ`. */
export function crushFromEnergy(zone: DamageZone, energyJ: number): number {
  const c = CRUSH[zone];
  const e = Math.max(0, energyJ) / c.widthM;
  if (e <= (c.A * c.A) / (2 * c.B)) return 0;
  return (Math.sqrt(2 * c.B * e) - c.A) / c.B;
}

/** Energy (J) a zone absorbs up to a permanent crush of `crushM` (inverse of crushFromEnergy). */
export function energyForCrush(zone: DamageZone, crushM: number): number {
  const c = CRUSH[zone];
  return (c.widthM * (c.A + c.B * crushM) ** 2) / (2 * c.B);
}

/** Contacts approaching slower than this only scrape or rest (sliding along a ramp, sitting on the floor). */
export const VN_MIN_MS = 1.0;

/**
 * Wheels / suspension links [EST, engineering reasoning]: a contact within regionM of the hub, outboard of the
 * body sides, loads the links with `share` of its energy. Tie rods / control arms start to bend above yieldJ
 * (≈ a kerb strike at 15–20 km/h with a quarter-car mass of ≈ 490 kg: ½·490·2.5² ≈ 1.5 kJ lateral), the hub
 * carrier breaks at fullJ (wheel torn off). Bent links measured after kerb strikes: 1–6° of toe → maxToeDeg.
 * Hard landings: the energy above the suspension's design limit (integrity.maxLandingSinkMs, the sink the
 * hydraulic stop is sized for) goes into the links of the wheels in contact: ½·(m/4)·(v² − v_max²).
 */
export const WHEEL_DMG = { regionM: 0.5, outboardM: 0.55, share: 0.5, yieldJ: 1_500, fullJ: 15_000, maxToeDeg: 5, gripLoss: 0.4 };

/**
 * Nozzles (brass bells, feed lines) [EST]: a contact within regionM of a nozzle crushes the bell above yieldJ,
 * fully at fullJ. A crushed bell keeps the throat flow but loses the expansion: thrust coefficient of a bare
 * sonic orifice ≈ 1.27 vs ≈ 1.55 for the ε = 4 bell at 120 bar (ideal-nozzle tables, Sutton ch. 3); with a
 * pinched throat and a deflected jet → up to thrustLoss at d = 1. A cracked feed line between regulator and valve
 * leaks continuously at feed pressure: choked mass flow ṁ = 0.0404·A·p/√T (air, SI) through leakAreaM2·d²
 * (30 mm² ≈ a 6 mm crack in a main line → ≈ 0.86 kg/s at 120 bar: the 165 kg regulated budget is gone in ≈ 3 min).
 */
export const NOZZLE_DMG = {
  regionM: 0.45, yieldJ: 800, fullJ: 6_000, thrustLoss: 0.6,
  leakAreaM2: { main: 30e-6, lift: 20e-6, yaw: 8e-6 } as Record<string, number>,
};

/** Sliding fan skirts [EST]: low contacts (y < maxY) tear skirt segments of their quadrant; a fully torn
 *  quadrant leaks like an extra 20 mm gap along its whole length (5× the sealed gap → suction mostly gone). */
export const SKIRT_DMG = { maxY: -0.1, yieldJ: 1_000, fullJ: 10_000, extraGapM: 0.02 };

/** Rear wing on carbon struts [EST]: torn off above breakJ near it; without it the car keeps ≈ 30 % of the
 *  downforce (body + diffuser, ROADSTER.aero.clA lowDrag 0.40 vs highDownforce 2.60 m²). */
export const WING_DMG = { breakJ: 2_000, minZ: -2.3, maxZ: -0.9, minY: 0.3, downforceScale: 0.3 };

/** Debris bodies (torn-off parts): mass (kg), origin = node origin of the car model (body frame). */
const PARTS: Record<DetachablePart, { massKg: number; origin: Vec3 }> = {
  Wing: { massKg: 9, origin: { x: 0, y: 0.46, z: -1.5 } },
  Wheel_FL: { massKg: 32, origin: { ...ROADSTER.wheels[0].pos } },   // 21" wheel + tyre + hub/brake ≈ 32 kg
  Wheel_FR: { massKg: 32, origin: { ...ROADSTER.wheels[1].pos } },
  Wheel_RL: { massKg: 34, origin: { ...ROADSTER.wheels[2].pos } },
  Wheel_RR: { massKg: 34, origin: { ...ROADSTER.wheels[3].pos } },
};
const WHEEL_PART: DetachablePart[] = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'];
const MAX_DENTS = 24;
/** Wheels touching down within this time after the first one belong to the same landing. */
const LANDING_WINDOW_S = 0.25;
const DENT_MERGE_M = 0.35;

const d01 = (e: number, y: number, f: number) => clamp((e - y) / (f - y), 0, 1);

/** Zone of a body-frame contact point with direction `dir` (into the car). */
export function zoneOf(p: Vec3, dir: Vec3): DamageZone {
  if (p.y > 0.45) return 'roof';
  if (p.y < -0.2 && dir.y > 0.6) return 'underbody';
  if (p.z > 1.6) return 'front';
  if (p.z < -1.65) return 'rear';
  return p.x >= 0 ? 'left' : 'right';
}

interface Debris { part: DetachablePart; body: RAPIER.RigidBody }

export class DamageModule implements ForceModule {
  readonly name = 'damage';
  mode: DamageMode = 'off';
  readonly state: DamageState = intactDamage();
  private readonly bus: VehicleBus;
  private readonly integrity: IntegrityModule;
  private zoneE: Record<DamageZone, number> = { front: 0, rear: 0, left: 0, right: 0, underbody: 0, roof: 0 };
  private dentE: number[] = [];
  private wheelE = [0, 0, 0, 0];
  private wheelBend = [0, 0, 0, 0];      // signed bending energy (sign = toe direction)
  private nozzleE = new Array(ROADSTER.nozzles.length).fill(0);
  private skirtE = [0, 0, 0, 0];
  private wingE = 0;
  private debris: Debris[] = [];
  private landing: { t: number; sinkMs: number } | null = null;
  private landingCharged = [false, false, false, false];
  // per-step scratch
  private stepE: Record<DamageZone, number> = { front: 0, rear: 0, left: 0, right: 0, underbody: 0, roof: 0 };
  private stepP: Record<DamageZone, Vec3> = Object.fromEntries(DAMAGE_ZONES.map((z) => [z, v3()])) as Record<DamageZone, Vec3>;
  private stepD: Record<DamageZone, Vec3> = Object.fromEntries(DAMAGE_ZONES.map((z) => [z, v3()])) as Record<DamageZone, Vec3>;

  constructor(bus: VehicleBus, integrity: IntegrityModule) { this.bus = bus; this.integrity = integrity; }

  /** Switch the model on/off; takes full effect with the next sim.reset() (repair). */
  setMode(sim: RoadsterSim, mode: DamageMode): void {
    this.mode = mode;
    this.state.mode = mode;
    const on = mode === 'realistic';
    sim.recordBodyContacts = on;
    sim.impactCrash = !on;
    this.integrity.crashOnHardLanding = !on;
  }

  reset(sim: RoadsterSim): void {
    for (const d of this.debris) sim.world.removeRigidBody(d.body);
    this.debris = [];
    Object.assign(this.state, intactDamage(this.mode));
    for (const z of DAMAGE_ZONES) this.zoneE[z] = 0;
    this.dentE = [];
    this.wheelE.fill(0); this.wheelBend.fill(0); this.nozzleE.fill(0); this.skirtE.fill(0); this.wingE = 0;
    this.landing = null; this.landingCharged.fill(false);
    this.bus.damage.reset();
    sim.propulsion.thrustScale.fill(1);
    sim.propulsion.leakAreaM2 = 0;
    this.setMode(sim, this.mode);
  }

  apply(_ctx: StepContext): void { /* effects reach the vehicle through bus.damage and the propulsion hooks */ }

  writeState(state: VehicleState, sim: RoadsterSim): void {
    if (this.mode !== 'realistic') { state.damage = undefined; return; }
    state.damage = this.state;
    const ds = this.state;
    if (sim.bodyContacts.length) this.absorbContacts(sim, sim.bodyContacts);
    this.absorbLanding(state);
    this.updateFunctions(sim);
    this.updateDebris();
    ds.leakKgS = sim.propulsion.leakKgS;
    if (ds.totalLoss) state.crashed = true;
  }

  // ------------------------------------------------------------------ contacts → energies
  private absorbContacts(sim: RoadsterSim, contacts: readonly BodyContact[]): void {
    const ds = this.state;
    for (const z of DAMAGE_ZONES) { this.stepE[z] = 0; const p = this.stepP[z], d = this.stepD[z]; p.x = p.y = p.z = d.x = d.y = d.z = 0; }
    const up = qrot(sim.body.rotation() as Quat, { x: 0, y: 1, z: 0 });
    let rollover = false;
    for (const c of contacts) {
      // rollover: the upper body touching while the car lies on its side or roof
      if (c.p.y > 0.1 && up.y < 0.25 && !c.prop) rollover = true;
      if (c.vnPre < VN_MIN_MS || c.impulse <= 0) continue;
      const e = c.prop ? 0.5 * c.impulse * c.vnPre : Math.max(0, 0.5 * c.impulse * (c.vnPre + c.vnPost));
      if (e <= 0) continue;
      const z = zoneOf(c.p, c.dir);
      this.stepE[z] += e;
      const sp = this.stepP[z], sd = this.stepD[z];
      sp.x += e * c.p.x; sp.y += e * c.p.y; sp.z += e * c.p.z;
      sd.x += e * c.dir.x; sd.y += e * c.dir.y; sd.z += e * c.dir.z;
      ds.energyJ += e;
      // wheels / links
      for (let i = 0; i < 4; i++) {
        const w = ROADSTER.wheels[i].pos;
        const dx = c.p.x - w.x, dz = c.p.z - w.z;
        // horizontal hits only: the floor bottoming out next to a hub loads the floor, not the links
        if (Math.abs(c.p.x) < WHEEL_DMG.outboardM || Math.hypot(dx, dz) > WHEEL_DMG.regionM || c.p.y > 0.15 || Math.abs(c.dir.y) > 0.7) continue;
        const ew = WHEEL_DMG.share * e;
        this.wheelE[i] += ew;
        // toe direction = sense of the yaw moment of the impact about the hub (+ = towards +X/left)
        const tau = dz * c.dir.x - dx * c.dir.z;
        const toeOut = w.x > 0 ? 1 : -1;
        this.wheelBend[i] += ew * (Math.abs(tau) > 1e-3 ? Math.sign(tau) : toeOut);
      }
      // nozzles
      for (let i = 0; i < ROADSTER.nozzles.length; i++) {
        const n = ROADSTER.nozzles[i].pos;
        const dist = Math.hypot(c.p.x - n.x, c.p.y - n.y, c.p.z - n.z);
        if (dist < NOZZLE_DMG.regionM) this.nozzleE[i] += e * (1 - dist / NOZZLE_DMG.regionM);
      }
      // skirts
      if (c.p.y < SKIRT_DMG.maxY) this.skirtE[(c.p.x >= 0 ? 0 : 1) + (c.p.z >= -0.1 ? 0 : 2)] += e;
      // wing
      if (c.p.z < WING_DMG.maxZ && c.p.z > WING_DMG.minZ && c.p.y > WING_DMG.minY) this.wingE += e;
    }
    for (const z of DAMAGE_ZONES) if (this.stepE[z] > 0) this.addZoneEnergy(z);
    if (rollover && !ds.totalLoss) { ds.totalLoss = true; ds.rev++; }
  }

  private addZoneEnergy(z: DamageZone): void {
    const ds = this.state, e = this.stepE[z];
    const p = this.stepP[z], d = this.stepD[z];
    p.x /= e; p.y /= e; p.z /= e;
    const dl = Math.hypot(d.x, d.y, d.z) || 1;
    d.x /= dl; d.y /= dl; d.z /= dl;
    this.zoneE[z] += e;
    // merge into a nearby dent of the zone, else a new one (or the nearest when the list is full)
    let best = -1, bestD = Infinity;
    for (let i = 0; i < ds.dents.length; i++) {
      const dn = ds.dents[i];
      if (dn.zone !== z) continue;
      const dd = Math.hypot(dn.p.x - p.x, dn.p.y - p.y, dn.p.z - p.z);
      if (dd < bestD) { bestD = dd; best = i; }
    }
    if (best >= 0 && (bestD < DENT_MERGE_M || ds.dents.length >= MAX_DENTS)) {
      const dn = ds.dents[best], e0 = this.dentE[best], k = e / (e0 + e);
      dn.p.x += (p.x - dn.p.x) * k; dn.p.y += (p.y - dn.p.y) * k; dn.p.z += (p.z - dn.p.z) * k;
      const nx = dn.dir.x * (1 - k) + d.x * k, ny = dn.dir.y * (1 - k) + d.y * k, nz = dn.dir.z * (1 - k) + d.z * k;
      const nl = Math.hypot(nx, ny, nz) || 1;
      dn.dir.x = nx / nl; dn.dir.y = ny / nl; dn.dir.z = nz / nl;
      this.dentE[best] += e;
    } else if (ds.dents.length < MAX_DENTS) {
      ds.dents.push({ zone: z, p: { ...p }, dir: { ...d }, depthM: 0, radiusM: 0.2 });
      this.dentE.push(e);
    }
    // zone crush and the dents' share of it
    const crush = crushFromEnergy(z, this.zoneE[z]);
    ds.crushM[z] = crush;
    ds.zones[z] = crush / CRUSH[z].criticalM;
    let changed = false;
    for (let i = 0; i < ds.dents.length; i++) {
      const dn: Dent = ds.dents[i];
      if (dn.zone !== z) continue;
      const depth = crush * this.dentE[i] / this.zoneE[z];
      if (Math.abs(depth - dn.depthM) > 0.001) changed = true;
      dn.depthM = depth;
      dn.radiusM = clamp(0.2 + 0.8 * depth, 0.2, 0.65);
    }
    if (changed) ds.rev++;
    ds.severity = Math.max(...DAMAGE_ZONES.map((k) => ds.zones[k]));
    if (ds.severity >= 1 && !ds.totalLoss) { ds.totalLoss = true; ds.rev++; }
  }

  // ------------------------------------------------------------------ hard landings → suspension links
  private absorbLanding(state: VehicleState): void {
    const L = this.integrity.current;
    if (L && L.t === state.t) { this.landing = { t: L.t, sinkMs: L.sinkMs }; this.landingCharged.fill(false); }
    const ld = this.landing;
    if (!ld) return;
    // the wheels touch down one after another (pitch/roll at touchdown): charge each one as it lands
    if (state.t - ld.t > LANDING_WINDOW_S) { this.landing = null; return; }
    const vMax = ROADSTER.integrity.maxLandingSinkMs;
    if (ld.sinkMs <= vMax) return;
    const eW = 0.5 * (state.massKg / 4) * (ld.sinkMs * ld.sinkMs - vMax * vMax);
    for (let i = 0; i < 4; i++) {
      if (!state.wheels[i].contact || this.landingCharged[i]) continue;
      this.landingCharged[i] = true;
      this.wheelE[i] += eW;
      this.wheelBend[i] += eW * (ROADSTER.wheels[i].pos.x > 0 ? 1 : -1); // links bend upward → toe-out
      this.state.energyJ += eW;
    }
  }

  // ------------------------------------------------------------------ energies → functions
  private updateFunctions(sim: RoadsterSim): void {
    const ds = this.state, bd = this.bus.damage;
    for (let i = 0; i < 4; i++) {
      const d = d01(this.wheelE[i], WHEEL_DMG.yieldJ, WHEEL_DMG.fullJ);
      ds.wheels[i] = d;
      const bend = d01(Math.abs(this.wheelBend[i]), WHEEL_DMG.yieldJ, WHEEL_DMG.fullJ);
      ds.toeDeg[i] = Math.sign(this.wheelBend[i]) * WHEEL_DMG.maxToeDeg * bend;
      bd.toeRad[i] = ds.toeDeg[i] * DEG;
      bd.gripScale[i] = 1 - WHEEL_DMG.gripLoss * d;
      if (d >= 1 && !ds.wheelLost[i]) { ds.wheelLost[i] = true; bd.wheelLost[i] = 1; this.detach(sim, WHEEL_PART[i]); }
    }
    let leak = 0;
    for (let i = 0; i < ROADSTER.nozzles.length; i++) {
      const d = d01(this.nozzleE[i], NOZZLE_DMG.yieldJ, NOZZLE_DMG.fullJ);
      ds.nozzles[i] = d;
      sim.propulsion.thrustScale[i] = 1 - NOZZLE_DMG.thrustLoss * d;
      leak += d * d * (NOZZLE_DMG.leakAreaM2[ROADSTER.nozzles[i].group] ?? 0);
    }
    sim.propulsion.leakAreaM2 = leak;
    for (let q = 0; q < 4; q++) {
      const d = d01(this.skirtE[q], SKIRT_DMG.yieldJ, SKIRT_DMG.fullJ);
      ds.skirts[q] = d;
      bd.skirtLeakM[q] = SKIRT_DMG.extraGapM * d;
    }
    if (!ds.wingLost && this.wingE > WING_DMG.breakJ) { ds.wingLost = true; this.detach(sim, 'Wing'); }
    bd.downforceScale = ds.wingLost ? WING_DMG.downforceScale : 1;
  }

  // ------------------------------------------------------------------ torn-off parts
  private detach(sim: RoadsterSim, part: DetachablePart): void {
    const spec = PARTS[part];
    const q = sim.body.rotation() as Quat;
    const pos = sim.toWorld(spec.origin);
    const v = sim.pointVelocity(pos);
    // thrown outward/upward a little (the joint fails under the impact load) – deterministic
    const out = qrot(q, { x: spec.origin.x > 0.1 ? 1.2 : spec.origin.x < -0.1 ? -1.2 : 0, y: 0.8, z: spec.origin.x === 0 ? -0.8 : 0 });
    const w = sim.body.angvel();
    const g = groups(GROUP_PROP, GROUP_WORLD | GROUP_PROP);   // world + props, never the car (no snagging)
    const body = sim.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z).setRotation(q)
      .setLinvel(v.x + out.x, v.y + out.y, v.z + out.z).setAngvel({ x: w.x, y: w.y, z: w.z })
      .setCcdEnabled(true).setLinearDamping(0.05).setAngularDamping(0.2));
    const desc = part === 'Wing'
      ? RAPIER.ColliderDesc.cuboid(0.75, 0.05, 0.2).setTranslation(0, 0.02, -0.25)
      : RAPIER.ColliderDesc.cylinder(ROADSTER.wheels[WHEEL_PART.indexOf(part)].width / 2, ROADSTER.wheels[WHEEL_PART.indexOf(part)].radius)
        .setRotation(qaxisAngle({ x: 0, y: 0, z: 1 }, 90 * DEG));
    sim.world.createCollider(desc.setMass(spec.massKg).setFriction(0.8).setRestitution(0.2).setCollisionGroups(g).setSolverGroups(g), body);
    this.debris.push({ part, body });
    this.state.debris.push({ part, pos: { ...pos }, quat: { ...q } });
    this.state.rev++;
  }

  private updateDebris(): void {
    for (let i = 0; i < this.debris.length; i++) {
      const b = this.debris[i].body, d = this.state.debris[i];
      const p = b.translation(), r = b.rotation();
      d.pos.x = p.x; d.pos.y = p.y; d.pos.z = p.z;
      d.quat.x = r.x; d.quat.y = r.y; d.quat.z = r.z; d.quat.w = r.w;
    }
  }

  /** Test/diagnostic access: absorbed energy per zone (J). */
  zoneEnergy(z: DamageZone): number { return this.zoneE[z]; }
  /** Test hook: deposit energy at a body-frame point as if a contact had absorbed it (direction into the car). */
  inject(sim: RoadsterSim, p: Vec3, dir: Vec3, energyJ: number): void {
    const vn = 2;
    this.absorbContacts(sim, [{ p, dir, vnPre: vn, vnPost: 0, impulse: energyJ / (0.5 * vn), prop: false }]);
    this.updateFunctions(sim);
  }
}
