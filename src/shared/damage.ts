// Vehicle damage: data contract between the damage model (src/sim/vehicle/damage.ts), the renderer
// (dents, torn-off parts) and the UI (HUD top view, results screen). Body frame as in roadster.ts.
import type { Quat, Vec3 } from './math';

/** 'off' = previous behaviour (a hard body impact is a collision); 'realistic' = energy-based damage model. */
export type DamageMode = 'off' | 'realistic';
export const DAMAGE_MODES: readonly DamageMode[] = ['off', 'realistic'];

export const DAMAGE_ZONES = ['front', 'rear', 'left', 'right', 'underbody', 'roof'] as const;
export type DamageZone = typeof DAMAGE_ZONES[number];

/** Parts that can be torn off (names = GLB node contract of the car model). The model has no mirrors. */
export type DetachablePart = 'Wing' | 'Wheel_FL' | 'Wheel_FR' | 'Wheel_RL' | 'Wheel_RR';

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
  dents: Dent[];
  debris: DebrisPose[];
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
    dents: [], debris: [], totalLoss: false, severity: 0,
  };
}

/** Overall label for UI: none / light / heavy / total. */
export function damageLevel(d: Readonly<DamageState>): 'none' | 'light' | 'heavy' | 'total' {
  if (d.totalLoss) return 'total';
  const func = Math.max(...d.wheels, ...d.nozzles, ...d.skirts, d.wingLost ? 1 : 0);
  const worst = Math.max(d.severity, func);
  if (worst <= 0.005 && d.dents.length === 0) return 'none';
  return worst < 0.35 ? 'light' : 'heavy';
}
