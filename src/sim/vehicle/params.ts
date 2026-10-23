// vehicle-physics parameters. Everything is derived from ROADSTER (src/shared/roadster.ts);
// the few values that are not (yet) in the shared register live in VEH_EXT with provenance and
// are candidates for the shared register. LOCAL OVERRIDES of shared values are marked as such.
import { ROADSTER } from '@shared/roadster';

const W = ROADSTER.wheels;

export const GEOM = {
  wheelbase: W[0].pos.z - W[2].pos.z,                     // 2.65 m
  trackFront: W[0].pos.x - W[1].pos.x,                    // 1.70 m
  trackRear: W[2].pos.x - W[3].pos.x,                     // 1.72 m
};

/** Values not (yet) in ROADSTER. [EST] engineering estimates; candidates for the shared register. */
export const VEH_EXT = {
  suspension: {
    /** Digressive damper: linear slope up to the knee, reduced slope above (high-speed blow-off). */
    damperKneeMs: 0.25,
    damperHighSpeedRatio: 0.30,
    /** Bump-stop engagement before the end of travel; progressive F = k d (1 + d / bumpProgM). */
    bumpStopLengthM: 0.025,
    bumpProgM: 0.01,
    /** Past the end of travel the stop force stays at its value this far in (rim/body take over). */
    bottomOutM: 0.015,
    /** Share of the stop force missing on rebound (elastomer bumper + bottomed tyre/rim hysteresis), blended in over
     *  the first bumpReboundBlendMs of rebound speed so that small oscillations at the stop do not chatter. */
    bumpHysteresis: 0.8,
    bumpReboundBlendMs: 0.15,
    /** The hysteresis applies after an impact: it fades in between these compression speeds at the stop (m/s). */
    bumpImpactMs: [1.5, 3.5] as [number, number],
    /** Lowest cosine between the contact normal and the strut axis used for the strut rate and load (≈ 53°). */
    minStrutCos: 0.6,
    /** Hydraulic (position-sensitive) bump stop as on landing/off-road dampers: compression damping
     *  rises linearly to hydroStopNsPerM over the last hydroStopLengthM of travel. */
    hydroStopLengthM: 0.04,
    hydroStopNsPerM: 60_000,
    /** Shape cast starts this far above the top of travel (inside the wheel arch). */
    castMarginM: 0.15,
    /** Effective tire width for the cylinder shape cast (rounded shoulders). */
    castWidthFactor: 0.8,
    /** Shape-cast normals deviating more than ~20° from body +Y are re-checked with a ray. */
    normalTrustCos: 0.94,
  },
  tire: {
    /** Low-speed damping fades out linearly up to this contact speed (m/s). */
    lowSpeedDampFadeMs: 3.0,
    /** Damping ratio of the tire-deflection mode at standstill. */
    lowSpeedZeta: 0.7,
    /** Target internal wheel/tire substep (s). Number of substeps = ceil(dt / this). */
    substepS: 1 / 2400,
  },
  powertrain: {
    driveEfficiency: 0.93,           // battery -> wheel
    regenEfficiency: 0.90,
    torqueSlewNmPerS: 60_000,        // per wheel, normal mode (launch mode: unlimited)
    reverseMaxMs: 12,
    tcSlipFactor: 0.85,              // normal TC: below the peak slip (keeps lateral reserve)
    escYawDeadbandRadS: 0.03,        // stability control: yaw-rate error dead band
    escYawRangeRadS: 0.12,           //   ... full torque cut at deadband + range
    escBetaDeadbandRad: 0.04,        //   side-slip dead band (2.3°)
    escBetaRangeRad: 0.08,
    escBrakeTorqueNm: 2500,          // selective-braking torque at full yaw demand (front; rear 50 %)
    launchSlipFactor: 1.0,           // launch control holds peak slip
    slipConvergencePerS: 40,         // lambda of the slip feedback linearization
    absMinSpeedMs: 1.5,              // below this ABS/TC are off (standstill hold)
    brakeBiasRear: 0.75,             // rear friction torque share of maxBrakeTorqueNm
    regenShareOfRearBrake: 0.5,
  },
  steering: {
    ackermann: 0.6,                  // fraction of ideal Ackermann
  },
  fans: {
    plenumVolumeM3: 0.58,            // floor area x ride height
    highspeedFlapAreaM2: 0.35,       // opened front/rear flaps in highspeed mode
    highspeedRpm: 0.6,
    idleRpm: 0.23,                   // demand regulation floor in grip mode (~250 kg sealed, video flat value)
    demandMargin: 1.5,               // grip-mode demand: normal force = margin * friction need / mu_ref
    demandMuRef: 1.1,                // conservative high-load friction coefficient for the demand
    pullOffMargin: 2.5,              // extra factor on gravity pulling the car off the surface (inverted)
    samplesLong: 8,                  // perimeter ray samples per long side
    samplesShort: 4,                 // per short side
    maxRayM: 1.5,
  },
  aero: {
    wingRateDegPerS: 90,
    autoLowDragAboveMs: 45,
    /** Reference density of the shared aero/fan data; the live value comes from sim.env.airDensity. */
    rho: ROADSTER.aero.airDensity,
  },
};

export const SUSP = ROADSTER.suspension;
export const TIRE = ROADSTER.tire;
export const PT = ROADSTER.powertrain;
export const STEER = ROADSTER.steering;
export const FANS = ROADSTER.fans;
export const AERO = ROADSTER.aero;
