// Vehicle damage: data contract between the damage model (src/sim/vehicle/damage.ts), the renderer
// (dents, torn-off parts) and the UI (HUD top view, results screen). Body frame as in roadster.ts.
import type { Quat, Vec3 } from './math';

/**
 * 'off' = previous behaviour (a hard body impact is a collision); 'visual' = dents and parts that tear off, but
 * the car drives as if intact, never becomes a total loss and keeps the collision rule of 'off'; 'realistic'
 * (UI: "Full") = energy-based damage model with all functional effects and the total loss.
 */
export type DamageMode = 'off' | 'visual' | 'realistic';
export const DAMAGE_MODES: readonly DamageMode[] = ['off', 'visual', 'realistic'];

export const DAMAGE_ZONES = ['front', 'rear', 'left', 'right', 'underbody', 'roof'] as const;
export type DamageZone = typeof DAMAGE_ZONES[number];

/**
 * Parts that can be torn off. Wing, doors and wheels are nodes of the car model (GLB node contract); bumpers,
 * diffuser and the nozzle covers (brass bells of the rear main nozzles) are cut out of the Body mesh at runtime
 * by BODY_PART_CUTS. The model has no mirrors.
 */
export const DETACHABLE_PARTS = [
  'Wing', 'Door_L', 'Door_R', 'Bumper_F', 'Bumper_R', 'Diffuser', 'NozzleCover_L', 'NozzleCover_R',
  'Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR',
] as const;
export type DetachablePart = typeof DETACHABLE_PARTS[number];

export interface Box3 { min: Vec3; max: Vec3 }
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box3 =>
  ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });
export const inBox = (b: Box3, p: Vec3, margin = 0): boolean =>
  p.x >= b.min.x - margin && p.x <= b.max.x + margin && p.y >= b.min.y - margin && p.y <= b.max.y + margin
  && p.z >= b.min.z - margin && p.z <= b.max.z + margin;

/**
 * Geometry of each part (body frame = car model frame): `origin` = pose origin of the torn-off part (node origin
 * for model nodes), `box` = where it sits (contacts within it load the part; for the cut parts also the triangles
 * taken out of the Body mesh), `half` = half extents of its debris collider (box around `origin`; wheels use a
 * cylinder from ROADSTER.wheels instead) and `center` its centre relative to `origin` (default 0).
 */
export const PART_GEOMETRY: Record<DetachablePart, { origin: Vec3; box: Box3; half: Vec3; center?: Vec3 }> = {
  Wing: { origin: { x: 0, y: 0.46, z: -1.5 }, box: box(-0.85, 0.3, -2.3, 0.85, 0.75, -0.9), half: { x: 0.75, y: 0.05, z: 0.2 }, center: { x: 0, y: 0.02, z: -0.25 } },
  Door_L: { origin: { x: 0.6, y: 0.62, z: 0.15 }, box: box(0.75, -0.3, -0.63, 1.0, 0.75, 0.93), half: { x: 0.15, y: 0.38, z: 0.76 }, center: { x: 0.12, y: -0.52, z: 0 } },
  Door_R: { origin: { x: -0.6, y: 0.62, z: 0.15 }, box: box(-1.0, -0.3, -0.63, -0.75, 0.75, 0.93), half: { x: 0.15, y: 0.38, z: 0.76 }, center: { x: -0.12, y: -0.52, z: 0 } },
  Bumper_F: { origin: { x: 0, y: -0.18, z: 2.12 }, box: box(-1, -0.4, 1.95, 1, 0, 2.4), half: { x: 0.85, y: 0.14, z: 0.13 } },
  Bumper_R: { origin: { x: 0, y: 0.07, z: -1.95 }, box: box(-1, -0.12, -2.2, 1, 0.27, -1.82), half: { x: 0.8, y: 0.17, z: 0.1 } },
  Diffuser: { origin: { x: 0, y: -0.24, z: -1.85 }, box: box(-1, -0.4, -2.2, 1, -0.12, -1.55), half: { x: 0.78, y: 0.08, z: 0.22 } },
  NozzleCover_L: { origin: { x: 0.24, y: -0.2, z: -2.0 }, box: box(0, -0.3, -2.1, 0.5, -0.1, -1.9), half: { x: 0.18, y: 0.05, z: 0.05 } },
  NozzleCover_R: { origin: { x: -0.24, y: -0.2, z: -2.0 }, box: box(-0.5, -0.3, -2.1, 0, -0.1, -1.9), half: { x: 0.18, y: 0.05, z: 0.05 } },
  Wheel_FL: { origin: { x: 0.85, y: -0.095, z: 1.4 }, box: box(0.55, -0.45, 0.9, 1.1, 0.15, 1.9), half: { x: 0.15, y: 0.35, z: 0.35 } },
  Wheel_FR: { origin: { x: -0.85, y: -0.095, z: 1.4 }, box: box(-1.1, -0.45, 0.9, -0.55, 0.15, 1.9), half: { x: 0.15, y: 0.35, z: 0.35 } },
  Wheel_RL: { origin: { x: 0.86, y: -0.085, z: -1.25 }, box: box(0.55, -0.45, -1.75, 1.1, 0.15, -0.75), half: { x: 0.17, y: 0.36, z: 0.36 } },
  Wheel_RR: { origin: { x: -0.86, y: -0.085, z: -1.25 }, box: box(-1.1, -0.45, -1.75, -0.55, 0.15, -0.75), half: { x: 0.17, y: 0.36, z: 0.36 } },
};

/**
 * Parts cut out of the Body mesh (render): every Body triangle whose centroid lies in the part's box (and that
 * uses one of `materials`, if given) belongs to the part. Checked in this order, the first match wins (the brass
 * bells sit inside the diffuser box). Boxes measured on roadster.glb (centroid bounds per material).
 */
export const BODY_PART_CUTS: Array<{ part: DetachablePart; materials?: string[] }> = [
  { part: 'NozzleCover_L', materials: ['Brass_Nozzle'] },
  { part: 'NozzleCover_R', materials: ['Brass_Nozzle'] },
  { part: 'Diffuser' },
  { part: 'Bumper_R' },
  { part: 'Bumper_F' },
];

/** One dent of the body (body frame): pushed `depthM` along `dir` (unit, into the car) around `p`. */
export interface Dent { zone: DamageZone; p: Vec3; dir: Vec3; depthM: number; radiusM: number }

/** World pose of a torn-off part (its rigid body), same origin as the part's node in the car model. */
export interface DebrisPose { part: DetachablePart; pos: Vec3; quat: Quat }

export interface DamageState {
  mode: DamageMode;
  /** Increments with every visible change (dent grows, part torn off); 0 = intact (after a repair/restart). */
  rev: number;
  /** Permanent crush depth per zone (m). */
  crushM: Record<DamageZone, number>;
  /** Crush relative to the zone's critical crush (≥ 1 = structural failure → total loss). */
  zones: Record<DamageZone, number>;
  /** Energy absorbed by the structure so far (J). */
  energyJ: number;
  /** Per wheel FL, FR, RL, RR: damage 0..1, toe error (deg, + = towards +X/left), torn off. */
  wheels: number[];
  toeDeg: number[];
  wheelLost: boolean[];
  /** Per nozzle (ROADSTER.nozzles order): damage 0..1. */
  nozzles: number[];
  /** Air leaking out of damaged feed lines (kg/s, last step). */
  leakKgS: number;
  /** Per fan quadrant (0 left front, 1 right front, 2 left rear, 3 right rear): skirt damage 0..1. */
  skirts: number[];
  wingLost: boolean;
  /** Parts torn off so far, in order (the debris of some may already be cleared, see `debris`). */
  lost: DetachablePart[];
  dents: Dent[];
  /** Torn-off parts still lying around (count and lifetime limited). */
  debris: DebrisPose[];
  /** Structural integrity 1 (intact) .. 0; below INTEGRITY_MIN (mode 'realistic') the car is a total loss. */
  integrity: number;
  /** Total loss (mode 'realistic' only): drive, fans and nozzles dead until the car is reset. */
  totalLoss: boolean;
  /** max over zones of `zones` (0..1+). */
  severity: number;
}

const zoneRecord = (): Record<DamageZone, number> => ({ front: 0, rear: 0, left: 0, right: 0, underbody: 0, roof: 0 });

export function intactDamage(mode: DamageMode = 'off'): DamageState {
  return {
    mode, rev: 0, crushM: zoneRecord(), zones: zoneRecord(), energyJ: 0,
    wheels: [0, 0, 0, 0], toeDeg: [0, 0, 0, 0], wheelLost: [false, false, false, false],
    nozzles: new Array(10).fill(0), leakKgS: 0, skirts: [0, 0, 0, 0], wingLost: false,
    lost: [], dents: [], debris: [], integrity: 1, totalLoss: false, severity: 0,
  };
}

/** Overall label for UI: none / light / heavy / total. */
export function damageLevel(d: Readonly<DamageState>): 'none' | 'light' | 'heavy' | 'total' {
  if (d.totalLoss) return 'total';
  const func = Math.max(...d.wheels, ...d.nozzles, ...d.skirts, d.wingLost ? 1 : 0);
  const worst = Math.max(d.severity, func);
  if (worst <= 0.005 && d.dents.length === 0 && d.lost.length === 0) return 'none';
  return worst < 0.35 ? 'light' : 'heavy';
}
