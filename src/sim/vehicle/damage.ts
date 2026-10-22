// Vehicle damage model (setting "Vehicle damage": Off / Visual / Full = mode 'realistic'). Off = previous
// behaviour, untouched. Visual = dents and torn-off parts only (the car drives as if intact, collision rule of Off).
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
// leak, aero: wing/diffuser downforce, total loss: drive and fans dead) and Propulsion.thrustScale / leakAreaM2 —
// torn-off parts as Rapier bodies (momentum-conserving release, the car loses their mass), and the total-loss
// decision (state.crashed). Everything is deterministic (no random numbers).
import { RAPIER, type BodyContact, type ForceModule, type RoadsterSim, type StepContext } from '@sim/core/roadsterSim';
import { GROUP_PROP, GROUP_WORLD, groups } from '@sim/core/world';
import { ROADSTER } from '@shared/roadster';
import { DEG, clamp, qaxisAngle, qrot, v3, type Quat, type Vec3 } from '@shared/math';
import type { VehicleState } from '@shared/types';
import {
  DAMAGE_ZONES, DETACHABLE_PARTS, PART_GEOMETRY, inBox, intactDamage,
  type DamageMode, type DamageState, type DamageZone, type Dent, type DetachablePart,
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

/** Rear wing on carbon struts [EST]: without it the car keeps ≈ 30 % of the downforce (body + diffuser,
 *  ROADSTER.aero.clA lowDrag 0.40 vs highDownforce 2.60 m²); without the diffuser another 15 % is gone. */
export const WING_DMG = { downforceScale: 0.3, diffuserDownforceScale: 0.85 };

/**
 * Detachable parts [EST, engineering reasoning]: mass (kg) and the impact energy (J) absorbed within the part's
 * box (PART_GEOMETRY, + HIT_MARGIN_M) at which its mounts fail. Mount loads: carbon wing struts and bumper
 * clips/brackets give way at a few kJ (bumper systems are sized for the 4–8 km/h tests, ECE R42 / 49 CFR 581:
 * ≈ 1–4 kJ without damage; a front fascia is usually torn off from ≈ 15–20 km/h on), door hinges and latch
 * (FMVSS 206: ≈ 11 kN longitudinal per hinge) take ≈ 10 kJ of side intrusion, the diffuser and the brass bells
 * of the main nozzles on their brackets less. Wheels are torn off by the suspension-link model (WHEEL_DMG.fullJ).
 * Masses: 21" wheel + tyre + hub/brake ≈ 32–34 kg, carbon door with glass ≈ 15 kg.
 */
export const PART_DMG: Record<DetachablePart, { massKg: number; breakJ: number }> = {
  Wing: { massKg: 9, breakJ: 2_000 },
  Door_L: { massKg: 15, breakJ: 10_000 },
  Door_R: { massKg: 15, breakJ: 10_000 },
  Bumper_F: { massKg: 7, breakJ: 5_000 },
  Bumper_R: { massKg: 6, breakJ: 4_000 },
  Diffuser: { massKg: 5, breakJ: 3_000 },
  NozzleCover_L: { massKg: 1.2, breakJ: 1_500 },
  NozzleCover_R: { massKg: 1.2, breakJ: 1_500 },
  Wheel_FL: { massKg: 32, breakJ: Infinity },
  Wheel_FR: { massKg: 32, breakJ: Infinity },
  Wheel_RL: { massKg: 34, breakJ: Infinity },
  Wheel_RR: { massKg: 34, breakJ: Infinity },
};
/** Contacts within this distance of a part's box load the part (the hull is a coarse convex hull). */
export const HIT_MARGIN_M = 0.1;
/** Nozzles (ROADSTER.nozzles indices) whose brass bell is the cover: torn off → bell gone (damage 1). */
const COVER_NOZZLES: Partial<Record<DetachablePart, number[]>> = { NozzleCover_L: [0, 1], NozzleCover_R: [2, 3] };

/**
 * Release of a torn-off part: it keeps the velocity of its attachment point plus a kick away from the car
 * (outward + up) whose energy is a share `kickShare` of the impact energy beyond the break energy,
 * ½·m·Δv² = kickShare·(E − E_break), limited to `kickMaxMs`; at least `kickMinMs`. The car gets the reaction
 * impulse −m·Δv and loses the part's mass (momentum conserved).
 */
export const RELEASE = { kickShare: 0.01, kickMinMs: 1.2, kickMaxMs: 7 };
/**
 * Debris limits (performance and clutter): at most MAX_DEBRIS bodies (the oldest goes first), each one removed
 * after DEBRIS_LIFE_S or when it has fallen far below the car (off the world). Resting debris sleeps in Rapier.
 */
export const MAX_DEBRIS = 8;
export const DEBRIS_LIFE_S = 45;

/**
 * Total loss (mode 'realistic'): structural integrity = 1 − severity (the worst zone's crush relative to its
 * critical crush, CRUSH.criticalM); below integrityMin the survival cell / drive train has failed. Also a total
 * loss: a heavy hit — more than heavyHitJ absorbed within hitWindowS (≈ 1.7 t at 50 km/h into a rigid wall,
 * beyond any crush a road car's drive train survives) —, maxWheelsLost torn-off wheels (the car sits on its
 * floor) and a rollover onto the roof/side. Then drive, fans and nozzles are dead until the reset.
 */
export const TOTAL_LOSS = { integrityMin: 0.02, heavyHitJ: 160_000, hitWindowS: 0.25, maxWheelsLost: 2 };

const WHEEL_PART: DetachablePart[] = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'];
const MAX_DENTS = 24;
/** Wheels touching down within this time after the first one belong to the same landing. */
const LANDING_WINDOW_S = 0.25;
const DENT_MERGE_M = 0.35;

const d01 = (e: number, y: number, f: number) => clamp((e - y) / (f - y), 0, 1);

/** Zone of a body-frame contact point with direction `dir` (into the car). */
export function zoneOf(p: Vec3, dir: Vec3): DamageZone {
  // above the beltline: the roof spans the cabin (hull z ≈ −0.95 … 0.55); behind it sit the deck and the wing
  if (p.y > 0.45) return p.z < -1.0 ? 'rear' : 'roof';
  if (p.y < -0.2 && dir.y > 0.6) return 'underbody';
  if (p.z > 1.6) return 'front';
  if (p.z < -1.65) return 'rear';
  return p.x >= 0 ? 'left' : 'right';
}

interface Debris { part: DetachablePart; body: RAPIER.RigidBody; massKg: number; t0: number }

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
  private partE: Record<DetachablePart, number> = Object.fromEntries(DETACHABLE_PARTS.map((p) => [p, 0])) as Record<DetachablePart, number>;
  private debris: Debris[] = [];
  private hitE = 0;
  private hitT0 = -Infinity;
  private t = 0;
  private landing: { t: number; sinkMs: number } | null = null;
  private landingCharged = [false, false, false, false];
  // per-step scratch
  private stepE: Record<DamageZone, number> = { front: 0, rear: 0, left: 0, right: 0, underbody: 0, roof: 0 };
  private stepP: Record<DamageZone, Vec3> = Object.fromEntries(DAMAGE_ZONES.map((z) => [z, v3()])) as Record<DamageZone, Vec3>;
  private stepD: Record<DamageZone, Vec3> = Object.fromEntries(DAMAGE_ZONES.map((z) => [z, v3()])) as Record<DamageZone, Vec3>;

  constructor(bus: VehicleBus, integrity: IntegrityModule) { this.bus = bus; this.integrity = integrity; }

  /** Functional effects and total loss (mode 'realistic' = "Full"); 'visual' only shows dents and debris. */
  get functional(): boolean { return this.mode === 'realistic'; }

  /** Switch the model on/off; takes full effect with the next sim.reset() (repair). */
  setMode(sim: RoadsterSim, mode: DamageMode): void {
    this.mode = mode;
    this.state.mode = mode;
    sim.recordBodyContacts = mode !== 'off';
    // 'visual' keeps the collision rule of 'off' (a hard body impact / hard landing is a crash)
    sim.impactCrash = !this.functional;
    this.integrity.crashOnHardLanding = !this.functional;
  }

  reset(sim: RoadsterSim): void {
    for (const d of this.debris) sim.world.removeRigidBody(d.body);
    this.debris = [];
    sim.setDetachedMass(0);
    for (const p of DETACHABLE_PARTS) this.partE[p] = 0;
    this.hitE = 0; this.hitT0 = -Infinity; this.t = 0;
    Object.assign(this.state, intactDamage(this.mode));
    for (const z of DAMAGE_ZONES) this.zoneE[z] = 0;
    this.dentE = [];
    this.wheelE.fill(0); this.wheelBend.fill(0); this.nozzleE.fill(0); this.skirtE.fill(0);
    this.landing = null; this.landingCharged.fill(false);
    this.bus.damage.reset();
    sim.propulsion.thrustScale.fill(1);
    sim.propulsion.leakAreaM2 = 0;
    this.setMode(sim, this.mode);
  }

  apply(_ctx: StepContext): void { /* effects reach the vehicle through bus.damage and the propulsion hooks */ }

  writeState(state: VehicleState, sim: RoadsterSim): void {
    if (this.mode === 'off') { state.damage = undefined; return; }
    state.damage = this.state;
    const ds = this.state;
    this.t = state.t;
    if (sim.bodyContacts.length) this.absorbContacts(sim, sim.bodyContacts);
    this.absorbLanding(state);
    this.updateFunctions(sim);
    this.updateDebris(sim);
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
      if (this.t - this.hitT0 > TOTAL_LOSS.hitWindowS) { this.hitT0 = this.t; this.hitE = 0; }
      this.hitE += e;
      // detachable parts (wheels: see the links below)
      for (const part of DETACHABLE_PARTS) if (PART_DMG[part].breakJ < Infinity && inBox(PART_GEOMETRY[part].box, c.p, HIT_MARGIN_M)) this.partE[part] += e;
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
    }
    for (const z of DAMAGE_ZONES) if (this.stepE[z] > 0) this.addZoneEnergy(z);
    if (rollover || this.hitE > TOTAL_LOSS.heavyHitJ) this.writeOff();
  }

  /** Total loss (mode 'realistic' only): drive, fans and nozzles dead until the reset. */
  private writeOff(): void {
    const ds = this.state;
    if (!this.functional || ds.totalLoss) return;
    ds.totalLoss = true; ds.rev++;
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
    const ds = this.state, bd = this.bus.damage, fx = this.functional;
    for (let i = 0; i < 4; i++) {
      const d = d01(this.wheelE[i], WHEEL_DMG.yieldJ, WHEEL_DMG.fullJ);
      ds.wheels[i] = d;
      const bend = d01(Math.abs(this.wheelBend[i]), WHEEL_DMG.yieldJ, WHEEL_DMG.fullJ);
      ds.toeDeg[i] = Math.sign(this.wheelBend[i]) * WHEEL_DMG.maxToeDeg * bend;
      // 'visual': a torn-off wheel would leave the car standing on an invisible one → wheels stay on
      if (d >= 1 && !ds.wheelLost[i] && fx) { ds.wheelLost[i] = true; this.detach(sim, WHEEL_PART[i], this.wheelE[i] - WHEEL_DMG.fullJ); }
      if (!fx) continue;
      bd.toeRad[i] = ds.toeDeg[i] * DEG;
      bd.gripScale[i] = 1 - WHEEL_DMG.gripLoss * d;
      bd.wheelLost[i] = ds.wheelLost[i] ? 1 : 0;
    }
    for (const part of DETACHABLE_PARTS) {
      const spec = PART_DMG[part];
      if (spec.breakJ === Infinity || ds.lost.includes(part) || this.partE[part] <= spec.breakJ) continue;
      for (const n of COVER_NOZZLES[part] ?? []) this.nozzleE[n] = Math.max(this.nozzleE[n], NOZZLE_DMG.fullJ);
      if (part === 'Wing') ds.wingLost = true;
      this.detach(sim, part, this.partE[part] - spec.breakJ);
    }
    let leak = 0;
    for (let i = 0; i < ROADSTER.nozzles.length; i++) {
      const d = d01(this.nozzleE[i], NOZZLE_DMG.yieldJ, NOZZLE_DMG.fullJ);
      ds.nozzles[i] = d;
      if (fx) sim.propulsion.thrustScale[i] = ds.totalLoss ? 0 : 1 - NOZZLE_DMG.thrustLoss * d;
      leak += d * d * (NOZZLE_DMG.leakAreaM2[ROADSTER.nozzles[i].group] ?? 0);
    }
    if (fx) sim.propulsion.leakAreaM2 = leak;
    for (let q = 0; q < 4; q++) {
      const d = d01(this.skirtE[q], SKIRT_DMG.yieldJ, SKIRT_DMG.fullJ);
      ds.skirts[q] = d;
      if (fx) bd.skirtLeakM[q] = SKIRT_DMG.extraGapM * d;
    }
    // structural integrity → total loss
    ds.integrity = clamp(1 - ds.severity, 0, 1);
    if (ds.integrity < TOTAL_LOSS.integrityMin || ds.wheelLost.filter(Boolean).length >= TOTAL_LOSS.maxWheelsLost) this.writeOff();
    if (!fx) return;
    bd.downforceScale = (ds.wingLost ? WING_DMG.downforceScale : 1) * (ds.lost.includes('Diffuser') ? WING_DMG.diffuserDownforceScale : 1);
    bd.powerOff = ds.totalLoss;
  }

  // ------------------------------------------------------------------ torn-off parts
  /**
   * Tear a part off: a dynamic Rapier body at the part's pose with the velocity of its attachment point plus a
   * kick away from the car (RELEASE). Mode 'realistic': the car loses the part's mass and takes the reaction
   * impulse, so the total momentum is unchanged.
   */
  private detach(sim: RoadsterSim, part: DetachablePart, surplusJ: number): void {
    const geo = PART_GEOMETRY[part], massKg = PART_DMG[part].massKg;
    const q = sim.body.rotation() as Quat;
    const pos = sim.toWorld(geo.origin);
    const vp = sim.pointVelocity(pos);
    // kick direction (body frame): away from the car's centre in the horizontal plane, and up
    const o = geo.origin;
    const side = Math.abs(o.x) > 0.3 ? Math.sign(o.x) : 0;
    const kb = { x: side, y: 0.9, z: side === 0 ? Math.sign(o.z) : 0 };
    const kl = Math.hypot(kb.x, kb.y, kb.z);
    const dv = clamp(Math.sqrt((2 * RELEASE.kickShare * Math.max(0, surplusJ)) / massKg), RELEASE.kickMinMs, RELEASE.kickMaxMs);
    const kick = qrot(q, { x: (kb.x / kl) * dv, y: (kb.y / kl) * dv, z: (kb.z / kl) * dv });
    const w = sim.body.angvel();
    const g = groups(GROUP_PROP, GROUP_WORLD | GROUP_PROP);   // world + props, never the car (no snagging)
    const body = sim.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z).setRotation(q)
      .setLinvel(vp.x + kick.x, vp.y + kick.y, vp.z + kick.z).setAngvel({ x: w.x, y: w.y, z: w.z })
      .setCcdEnabled(true).setLinearDamping(0.05).setAngularDamping(0.3));
    const wi = WHEEL_PART.indexOf(part);
    const c = geo.center ?? { x: 0, y: 0, z: 0 };
    const desc = wi >= 0
      ? RAPIER.ColliderDesc.cylinder(ROADSTER.wheels[wi].width / 2, ROADSTER.wheels[wi].radius).setRotation(qaxisAngle({ x: 0, y: 0, z: 1 }, 90 * DEG))
      : RAPIER.ColliderDesc.cuboid(geo.half.x, geo.half.y, geo.half.z).setTranslation(c.x, c.y, c.z);
    sim.world.createCollider(desc.setMass(massKg).setFriction(0.8).setRestitution(0.2).setCollisionGroups(g).setSolverGroups(g), body);
    if (this.functional) this.recoil(sim, pos, massKg, vp, kick);
    this.debris.push({ part, body, massKg, t0: this.t });
    this.state.lost.push(part);
    this.state.debris.push({ part, pos: { ...pos }, quat: { ...q } });
    this.state.rev++;
    if (this.debris.length > MAX_DEBRIS) this.removeDebris(sim, 0);
  }

  /** Momentum balance of a release: M·v = (M − m)·v' + m·(v_p + Δv); angular part from the kick impulse. */
  private recoil(sim: RoadsterSim, pos: Vec3, m: number, vp: Vec3, kick: Vec3): void {
    const M = sim.getState().massKg;
    const v = sim.body.linvel();
    sim.setDetachedMass(sim.detachedMassKg + m);
    const M1 = M - m;
    sim.body.setLinvel({
      x: (M * v.x - m * (vp.x + kick.x)) / M1,
      y: (M * v.y - m * (vp.y + kick.y)) / M1,
      z: (M * v.z - m * (vp.z + kick.z)) / M1,
    }, true);
    const com = sim.comWorld();
    const r = { x: pos.x - com.x, y: pos.y - com.y, z: pos.z - com.z };
    const j = { x: -m * kick.x, y: -m * kick.y, z: -m * kick.z };
    sim.body.applyTorqueImpulse({ x: r.y * j.z - r.z * j.y, y: r.z * j.x - r.x * j.z, z: r.x * j.y - r.y * j.x }, true);
  }

  private removeDebris(sim: RoadsterSim, i: number): void {
    sim.world.removeRigidBody(this.debris[i].body);
    this.debris.splice(i, 1);
    this.state.debris.splice(i, 1);
    this.state.rev++;
  }

  private updateDebris(sim: RoadsterSim): void {
    const carY = sim.body.translation().y;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const b = this.debris[i].body;
      const p = b.translation();
      if (this.t - this.debris[i].t0 > DEBRIS_LIFE_S || p.y < carY - 200) { this.removeDebris(sim, i); continue; }
      const d = this.state.debris[i], r = b.rotation();
      d.pos.x = p.x; d.pos.y = p.y; d.pos.z = p.z;
      d.quat.x = r.x; d.quat.y = r.y; d.quat.z = r.z; d.quat.w = r.w;
    }
  }

  /** Test/diagnostic access: the debris bodies (part, Rapier body, mass). */
  debrisBodies(): ReadonlyArray<{ part: DetachablePart; body: RAPIER.RigidBody; massKg: number }> { return this.debris; }
  /** Test/diagnostic access: impact energy absorbed within a part's box (J). */
  partEnergy(part: DetachablePart): number { return this.partE[part]; }
  /** Test/diagnostic access: absorbed energy per zone (J). */
  zoneEnergy(z: DamageZone): number { return this.zoneE[z]; }
  /** Test hook: deposit energy at a body-frame point as if a contact had absorbed it (direction into the car). */
  inject(sim: RoadsterSim, p: Vec3, dir: Vec3, energyJ: number): void {
    const vn = 2;
    this.absorbContacts(sim, [{ p, dir, vnPre: vn, vnPost: 0, impulse: energyJ / (0.5 * vn), prop: false }]);
    this.updateFunctions(sim);
    this.updateDebris(sim);
  }
}
