// Roadster Gen 2 parameter register. Single source of truth for physics, GNC, render and UI.
// Provenance tags: [VIDEO] Tesla stream 15.10.2026 (docs/PHYSICS.md), [PRESS] Electrek et al.,
// [REVIEW] external second-opinion engineering review, [EST] engineering estimate / tuning.
// Body frame (right-handed, matches three.js for a car facing +Z): +X LEFT, +Y up, +Z forward,
// origin = dry CoG. Nose-up pitch = negative rotation about +X. Right side down = positive rotation about +Z.
import type { Vec3 } from './math';
import type { NozzleGroup, WheelId } from './types';

export interface NozzleSpec {
  id: number;
  name: string;
  group: NozzleGroup;
  pos: Vec3;            // body frame, m
  dir: Vec3;            // unit thrust direction ON THE CAR (exhaust goes opposite), body frame
                        // lift nozzles cant 12° so the exhaust points outward-down (thrust inward-up)
  nominalThrustN: number; // at regulator setpoint, sea level
  expansionRatio: number; // Ae/A*
}

export interface WheelSpec { id: WheelId; pos: Vec3; radius: number; width: number; driven: boolean; steered: boolean }

const S12 = Math.sin(12 * Math.PI / 180), C12 = Math.cos(12 * Math.PI / 180);

export const ROADSTER = {
  name: 'Roadster (Gen 2, "Rocket" configuration)',

  // ---------------------------------------------------------------- mass & geometry
  dims: { length: 4.35, width: 2.0, height: 1.12 },          // [EST] "smaller, low" [PRESS]
  dryMassKg: 1700,                                           // [PRESS] < 1700 kg
  dryInertia: { x: 2600, y: 2950, z: 700 },                  // kg m^2 about body axes [EST]
  restCogHeightM: 0.45,                                      // CoG above ground at static ride [EST]
  rideHeightM: 0.10,                                         // floor clearance at static ride [EST]
  /** Body-frame AABB of the chassis collider (approx; render model may differ in detail). */
  bodyBox: { min: { x: -0.98, y: -0.35, z: -2.10 }, max: { x: 0.98, y: 0.67, z: 2.25 } },
  /**
   * Chassis collision hull (body frame). Flat floor at y = -0.35 only between z ≈ -1.3 .. 1.5 (diffuser rises
   * from the rear axle, splitter ahead of the front axle); front and
   * rear ends rise to y = -0.20 (approach/departure angles) so the body clears the R10 wall ramp and the
   * R20 kicker under load (review).
   */
  hull: [
    // floor
    { x: 0.95, y: -0.35, z: 1.50 }, { x: -0.95, y: -0.35, z: 1.50 }, { x: 0.95, y: -0.35, z: -1.30 }, { x: -0.95, y: -0.35, z: -1.30 },
    // front lower lip / rear diffuser edge
    { x: 0.90, y: -0.20, z: 2.25 }, { x: -0.90, y: -0.20, z: 2.25 }, { x: 0.90, y: -0.20, z: -2.10 }, { x: -0.90, y: -0.20, z: -2.10 },
    // nose top / tail top
    { x: 0.85, y: 0.08, z: 2.25 }, { x: -0.85, y: 0.08, z: 2.25 }, { x: 0.90, y: 0.32, z: -2.10 }, { x: -0.90, y: 0.32, z: -2.10 },
    // beltline
    { x: 0.98, y: 0.25, z: 1.20 }, { x: -0.98, y: 0.25, z: 1.20 }, { x: 0.98, y: 0.30, z: -1.40 }, { x: -0.98, y: 0.30, z: -1.40 },
    // roof
    { x: 0.70, y: 0.67, z: 0.55 }, { x: -0.70, y: 0.67, z: 0.55 }, { x: 0.72, y: 0.62, z: -0.95 }, { x: -0.72, y: 0.62, z: -0.95 },
  ] as { x: number; y: number; z: number }[],

  // ---------------------------------------------------------------- wheels & suspension
  wheels: [
    { id: 'FL', pos: { x: 0.85, y: -0.095, z: 1.40 }, radius: 0.345, width: 0.295, driven: false, steered: true },
    { id: 'FR', pos: { x: -0.85, y: -0.095, z: 1.40 }, radius: 0.345, width: 0.295, driven: false, steered: true },
    { id: 'RL', pos: { x: 0.86, y: -0.085, z: -1.25 }, radius: 0.355, width: 0.345, driven: true, steered: false },
    { id: 'RR', pos: { x: -0.86, y: -0.085, z: -1.25 }, radius: 0.355, width: 0.345, driven: true, steered: false },
  ] as WheelSpec[],                                          // wheelbase 2.65 m [EST], RWD [PRESS]
  suspension: {
    springNPerM: 220_000,        // [REVIEW] 200-250 kN/m to carry 4.7 t suction
    damperNsPerM: 12_000,        // [REVIEW] 10-15 kNs/m
    travelM: 0.12,               // total travel [EST]
    restCompressionM: 0.03,      // compression at which wheels[].pos is the hub position (static ≈ 0.020-0.023 m at 1.95 t) [EST]
    bumpStopNPerM: 2_500_000,    // progressive end stop [EST]
    antiRollNPerM: { front: 60_000, rear: 40_000 },
    wheelInertiaKgM2: 1.4,
  },
  tire: {
    mu0: 1.35, fz0N: 4800, loadExponent: 0.15,     // mu = mu0 (Fz/Fz0)^-n  [REVIEW]
    pacejkaLat: { B: 10.5, C: 1.35, E: -0.4 },     // shape [EST]
    pacejkaLong: { B: 12.0, C: 1.65, E: -0.2 },
    relaxationLengthM: 0.35,
    maxLoadN: 30_000,                               // structural tire limit [EST]
    rollingResistance: 0.012,
  },
  steering: { maxAngleDeg: 32, highSpeedAngleDeg: 6, highSpeedMs: 70, rateDegPerS: 360 }, // steer-by-wire [VIDEO]

  // ---------------------------------------------------------------- powertrain
  powertrain: {
    batteryPowerW: 1_200_000,        // "over 1 MW" [PRESS]
    maxWheelTorqueNm: 6000,          // per driven wheel [EST]
    maxBrakeTorqueNm: 6500,          // per wheel [EST]
    regenPowerW: 400_000,
    topSpeedMs: 103,                 // 230 mph [VIDEO]
    retinaLimitG: 3.4,               // accel cap used by launch program to match 0.81 s [VIDEO] + [EST]
    batteryKWh: 120,                 // undisclosed; [EST]
  },

  // ---------------------------------------------------------------- aero
  aero: {
    frontalAreaM2: 1.85,
    cd: { lowDrag: 0.29, highDownforce: 0.42 },
    clA: { lowDrag: 0.40, highDownforce: 2.60 },   // downforce coefficient * area, m^2 [EST]
    wingAngleRangeDeg: [0, 28] as [number, number], // variable-pitch wing [VIDEO]
    centerOfPressure: { x: 0, y: 0.1, z: -0.30 },
    airDensity: 1.2,
  },

  // ---------------------------------------------------------------- fan suction ("fan car")
  fans: {
    count: 4, powerPerFanW: 20_000,  // [PRESS] 4 x ~20 kW
    efficiency: 0.60,
    shutoffDeltaPPa: 9_500,          // fan curve dp at zero flow [EST] -> ~4,720 kg at the minimum gap
    maxFlowM3s: 7.0,                 // fan curve flow at zero dp (all fans) [EST]
    floorAreaM2: 5.8,                // sealed underbody area [EST]
    skirtPerimeterM: 10.4,
    dischargeCoeff: 0.6,
    minGapM: 0.004,                  // sliding skirt seal at full contact [REVIEW ~9 mm effective @ 80 kW]
    skirtTravelM: 0.22,              // sprung sliding skirts cover the ride-height range + the R11 wall sagitta
    spoolTimeS: 1.5,                 // video shows ~3 s ramp-up; rest is demand control in grip mode
    targetMaxDownforceKg: 4700,      // [VIDEO] HUD on the wall ramp
    centerOfSuction: { x: 0, y: -0.35, z: -0.10 },
  },

  // ---------------------------------------------------------------- compressed air (COPV)
  tank: {
    count: 2, volumeM3: 0.600,       // two COPVs, 600 L [VIDEO]
    fullMassKg: 250,                 // [VIDEO]
    fullPressurePa: 690e5,           // 10,000 psi [PRESS]
    ambientTempK: 288,
    abelNobleB: 0.0012021,           // m^3/kg, calibrated to 690 bar @ 250 kg, 288 K [REVIEW]
    gasR: 287.05, gamma: 1.4, cv: 718,
    wallMassKg: 90, wallCp: 1000,    // liner + composite [EST]
    wallHeatTransferWPerK: 180,      // gas <-> wall hA [EST tuning]
    wallToAmbientWPerK: 25,
    regulatorSetpointPa: 120e5,      // [REVIEW] lower setpoint -> ~165 kg regulated budget
    regulatorMaxFlowKgS: 240,        // above this the feed pressure droops [EST]
    feedLossCoeff: 0.04,             // fractional pressure loss at max flow [EST]
    pos: { x: 0, y: 0.05, z: -0.55 },// behind the seats [PRESS]
    refillKgPerSRealistic: 250 / (6.5 * 3600), // 6-7 h [PRESS]
    refillKgPerSGame: 250 / 20,      // gameplay option
  },

  // ---------------------------------------------------------------- valves
  valves: { openDelayS: 0.008, closeDelayS: 0.006, minOnTimeS: 0.015, pwmPeriodS: 0.050 }, // [EST] + [REVIEW]

  // ---------------------------------------------------------------- nozzles (10 total) [VIDEO]
  // 4 main rear (Mach diamonds, > 80 kN total) [VIDEO]; 4 corner lift; 2 front yaw [PRESS].
  nozzles: [
    { id: 0, name: 'MAIN_1', group: 'main', pos: { x: 0.36, y: -0.20, z: -2.05 }, dir: { x: 0, y: 0, z: 1 }, nominalThrustN: 20_500, expansionRatio: 4 },
    { id: 1, name: 'MAIN_2', group: 'main', pos: { x: 0.12, y: -0.20, z: -2.05 }, dir: { x: 0, y: 0, z: 1 }, nominalThrustN: 20_500, expansionRatio: 4 },
    { id: 2, name: 'MAIN_3', group: 'main', pos: { x: -0.12, y: -0.20, z: -2.05 }, dir: { x: 0, y: 0, z: 1 }, nominalThrustN: 20_500, expansionRatio: 4 },
    { id: 3, name: 'MAIN_4', group: 'main', pos: { x: -0.36, y: -0.20, z: -2.05 }, dir: { x: 0, y: 0, z: 1 }, nominalThrustN: 20_500, expansionRatio: 4 },
    { id: 4, name: 'LIFT_FL', group: 'lift', pos: { x: 0.78, y: -0.30, z: 1.85 }, dir: { x: -S12, y: C12, z: 0 }, nominalThrustN: 15_000, expansionRatio: 4 },
    { id: 5, name: 'LIFT_FR', group: 'lift', pos: { x: -0.78, y: -0.30, z: 1.85 }, dir: { x: S12, y: C12, z: 0 }, nominalThrustN: 15_000, expansionRatio: 4 },
    { id: 6, name: 'LIFT_RL', group: 'lift', pos: { x: 0.78, y: -0.30, z: -1.80 }, dir: { x: -S12, y: C12, z: 0 }, nominalThrustN: 15_000, expansionRatio: 4 },
    { id: 7, name: 'LIFT_RR', group: 'lift', pos: { x: -0.78, y: -0.30, z: -1.80 }, dir: { x: S12, y: C12, z: 0 }, nominalThrustN: 15_000, expansionRatio: 4 },
    { id: 8, name: 'YAW_L', group: 'yaw', pos: { x: 0.85, y: 0.0, z: 2.00 }, dir: { x: -1, y: 0, z: 0 }, nominalThrustN: 3_000, expansionRatio: 3 },
    { id: 9, name: 'YAW_R', group: 'yaw', pos: { x: -0.85, y: 0.0, z: 2.00 }, dir: { x: 1, y: 0, z: 0 }, nominalThrustN: 3_000, expansionRatio: 3 },
  ] as NozzleSpec[],

  // ---------------------------------------------------------------- integrity / crash
  integrity: {
    maxLandingSinkMs: 6.0,          // vertical touchdown speed that bottoms the suspension hard [EST]
    crashBodyImpactMs: 4.0,         // chassis (non-wheel) impact speed -> crash [EST]
  },
} as const;

export type RoadsterConfig = typeof ROADSTER;

/** Wet mass and CoG including air, for quick checks. */
export function massWithAir(airKg: number): number { return ROADSTER.dryMassKg + airKg; }
