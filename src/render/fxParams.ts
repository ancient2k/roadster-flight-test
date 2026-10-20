// Mapping from simulation state to visual effect parameters. Pure (no three imports).
import type { NozzleState, WheelState } from '../shared/types';
import type { NozzleSpec } from '../shared/roadster';
import { clamp } from '../shared/math';
import type { SurfaceKind } from '../shared/environment';
import { ROADSTER } from '../shared/roadster';
import { MAX_SINK_FRACTION, SURFACES, slipSinkageFactor, staticSinkage } from '../sim/vehicle/surfaces';

export interface PlumeParams {
  /** 0..1 overall visibility (density). */
  intensity: number;
  /** Plume length in metres. */
  length: number;
  /** Exit radius (m) and the radius the plume grows to at its end. */
  radius0: number;
  radius1: number;
  /** Spacing of the shock cells (Mach diamonds) in metres; 0 = none (perfectly expanded). */
  cellSpacing: number;
  /** 0..1 contrast of the shock cells. */
  diamondStrength: number;
  /** Number of visible cells before the pattern dissolves into turbulence. */
  cellCount: number;
}

/**
 * Under-expanded cold-gas jet. Shock-cell spacing follows the Prandtl/Pack relation
 * L ≈ 1.22·D·sqrt(M_j² − 1); for an under-expanded sonic/supersonic jet the fully-expanded
 * jet Mach number grows with the pressure ratio. We use a simple fit:
 *   M_j² ≈ 1 + 0.9·ln(1 + NPR_eff), NPR_eff = pe/pa.
 * The visible plume is dominated by condensation (cold air, T drops below dew point) rather than
 * glow, so intensity follows mass flow.
 */
export function plumeParams(spec: NozzleSpec, n: NozzleState): PlumeParams {
  const nominalMdot = spec.nominalThrustN / 650; // ve ≈ 650 m/s
  const flow = clamp(n.massFlowKgS / Math.max(nominalMdot, 1e-6), 0, 1.5);
  const thrustFrac = clamp(n.thrustN / spec.nominalThrustN, 0, 1.5);
  const on = n.open || n.thrustN > 1 ? 1 : 0;
  const intensity = on * clamp(0.15 + 0.85 * Math.max(flow, thrustFrac), 0, 1.25);
  // Exit diameter from expansion ratio and throat area for the nominal thrust at 120 bar (Cf≈1.5).
  const throatArea = spec.nominalThrustN / (1.5 * 120e5);
  const exitDia = Math.sqrt((4 * throatArea * spec.expansionRatio) / Math.PI);
  const npr = Math.max(1, n.exitPressureRatio);
  const mj2 = 1 + 0.9 * Math.log(1 + npr);
  const cellSpacing = npr > 1.05 ? 1.22 * exitDia * Math.sqrt(mj2 - 1) * (1 + 0.15 * (npr - 1)) : 0;
  const diamondStrength = clamp((npr - 1) / 2.5, 0, 1) * clamp(intensity, 0, 1);
  const cellCount = clamp(Math.round(3 + 2.2 * Math.log(npr)), 3, 9);
  // Visible length: shock train + mixing region, scaled with thrust.
  const length = intensity > 0 ? clamp(cellSpacing * cellCount * 1.4 + 1.0 + 2.6 * thrustFrac, 0.8, 5.5) : 0;
  return {
    intensity,
    length,
    radius0: exitDia / 2,
    radius1: exitDia / 2 + length * 0.09,
    cellSpacing,
    diamondStrength,
    cellCount,
  };
}

/** Tyre smoke emission rate (particles/s) from slip. */
export function tireSmokeRate(w: WheelState, speedMs: number): number {
  if (!w.contact) return 0;
  const longSlip = Math.abs(w.slipRatio);
  const latSlip = Math.abs(w.slipAngleRad);
  // slip speed at the contact patch
  const slipSpeed = Math.abs(w.angularVel) * 0.35 * longSlip + speedMs * Math.sin(Math.min(latSlip, 1.2));
  const excess = Math.max(0, slipSpeed - 2.5);
  return clamp(excess * 22, 0, 260) * clamp(w.normalLoadN / 3000, 0.3, 1.6);
}

/** Heuristic brake-light state (VehicleState has no brake flag). */
export function brakeLightOn(longAccelBody: number, groundContact: boolean, speedMs: number): boolean {
  return groundContact && speedMs > 0.5 && longAccelBody < -2.5;
}

// ---------------------------------------------------------------- driving dust, ruts, scour
// (pure: the wheel state has no surface/sinkage fields yet – the render side derives them from the site
// surface and the R2 terramechanics functions, which are side-effect free)

/** Loose, deformable ground that throws dust and keeps tracks (R2 soils). */
export function isLooseSoil(kind: SurfaceKind | null | undefined): kind is 'regolith' | 'mars_soil' | 'sand' {
  return kind === 'regolith' || kind === 'mars_soil' || kind === 'sand';
}

/** Rim radius of a wheel (m) by its index in VehicleState.wheels (FL, FR, RL, RR). */
export const wheelSpec = (i: number) => ROADSTER.wheels[Math.max(0, Math.min(ROADSTER.wheels.length - 1, i))];

/** Contact-patch speeds of a wheel: rim speed |ω r| and the slip speed |ω r − v| (m/s). */
export function wheelSpeeds(w: WheelState, i: number, speedMs: number): { rim: number; slip: number } {
  const r = wheelSpec(i).radius;
  const rim = Math.abs(w.angularVel) * r;
  // longitudinal slip from the slip ratio (v·κ), lateral from the slip angle
  const slip = Math.abs(w.slipRatio) * Math.max(speedMs, rim) + speedMs * Math.sin(Math.min(Math.abs(w.slipAngleRad), 1.2));
  return { rim, slip };
}

/**
 * Dust emission rate (particles/s) of one wheel. The tread lifts grains off the soil at the rear of the
 * contact patch in proportion to the rim speed (rooster tail, Apollo 16 "Grand Prix" film); wheel spin
 * and side slip excavate more. 0 off the ground and on rigid surfaces (asphalt, concrete, grass).
 */
export function wheelDustRate(w: WheelState, i: number, speedMs: number, kind: SurfaceKind | null | undefined): number {
  if (!w.contact || !isLooseSoil(kind)) return 0;
  const { rim, slip } = wheelSpeeds(w, i, speedMs);
  if (rim < 0.4 && slip < 0.4) return 0;
  const dustiness = SURFACES[kind].dustiness;
  const rate = 40 * rim + 40 * slip;
  return clamp(rate, 0, 400) * dustiness * clamp(w.normalLoadN / 1500, 0.6, 1.4);
}

/**
 * Rut depth (m) the physics carves under this wheel: Bekker static sinkage under the wheel load,
 * deepened by the Lyasko slip sinkage (same functions and limits as src/sim/vehicle/chassis.ts, without
 * its low-pass filters). 0 on rigid surfaces.
 */
export function wheelSinkM(w: WheelState, i: number, speedMs: number, kind: SurfaceKind | null | undefined): number {
  if (!w.contact || !isLooseSoil(kind)) return 0;
  const soil = SURFACES[kind].soil;
  if (!soil) return 0;
  const spec = wheelSpec(i);
  const z0 = staticSinkage(Math.max(0, w.normalLoadN), spec.width, spec.radius, soil);
  const rim = Math.abs(w.angularVel) * spec.radius;
  const iSlip = (rim - speedMs) / Math.max(rim, speedMs, 0.5);
  return Math.min(z0 * slipSinkageFactor(iSlip), MAX_SINK_FRACTION * spec.radius);
}

/** Medium of a world body: gravity (m/s²) and air density (kg/m³). */
export interface DustMedium { g: number; rho: number }

/** Spawn options of one ejected grain: pure ballistics without air (Moon), slight drag in thin or dense air. */
export interface GrainOpts { vel: { x: number; y: number; z: number }; life: number; drag: number; buoyancy: number }

/**
 * Time (s) until a grain launched upwards with vy from h0 above level ground lands again
 * (y(t) = h0 + vy t − g t²/2 = 0). Used as the particle's life: it dies on impact, no grain falls
 * through the ground.
 */
export function flightTime(vy: number, h0: number, g: number): number {
  if (g <= 0) return 4;
  return (vy + Math.sqrt(Math.max(0, vy * vy + 2 * g * Math.max(0, h0)))) / g;
}

/**
 * Drag rate (1/s) of a coarse grain (~0.1–0.3 mm) in the medium: none in vacuum, a trace in the
 * 600 Pa CO₂ of Mars (ρ ≈ 0.02 kg/m³), noticeable in Earth air. Linear in ρ (Newton drag of a grain
 * at a few m/s, k = 3 ρ C_d / (4 ρ_p d) · v ≈ 1/s per kg/m³).
 */
export function grainDrag(m: DustMedium): number { return m.rho <= 0 ? 0 : Math.min(2, m.rho * 0.9); }

/**
 * A ballistic grain: launched with `vel` from `h0` above the ground. Vacuum: no drag, no buoyancy, the
 * only acceleration is −g – sharp parabolas as in the Apollo LRV films. The life ends at the impact.
 */
export function ballisticGrain(vel: { x: number; y: number; z: number }, h0: number, m: DustMedium): GrainOpts {
  const drag = grainDrag(m);
  // with drag the grain lands a little earlier than the drag-free parabola: keep that as the bound
  const life = Math.min(12, flightTime(vel.y, h0, m.g));
  return { vel: { x: vel.x, y: vel.y, z: vel.z }, life, drag, buoyancy: -m.g };
}

/**
 * Position of a grain `t` seconds after its launch from `p0` – the same closed form as the particle vertex
 * stage (particles.ts): p = p0 + v·travel(t) + ½·a·t² with travel = t without drag, (1 − e^{−kt})/k with drag k.
 */
export function grainPos(p0: { x: number; y: number; z: number }, g: GrainOpts, t: number): { x: number; y: number; z: number } {
  const travel = g.drag < 0.001 ? t : (1 - Math.exp(-g.drag * t)) / g.drag;
  return { x: p0.x + g.vel.x * travel, y: p0.y + g.vel.y * travel + 0.5 * g.buoyancy * t * t, z: p0.z + g.vel.z * travel };
}

/**
 * time (s) until a grain launched from `p0` hits the real terrain `groundAt(x, z)` (not a level plane at
 * the launch point: downhill a grain flies longer, uphill it lands earlier). The trajectory is marched in steps
 * of at most `ds` metres of flight path and 0.05 s (so a narrow ridge is not jumped over; at most `maxSteps` steps) over
 * [0, tMax] and the first crossing refined by bisection. The grain starts a few cm above the ground; a crossing
 * counts only after it has risen or fallen past that start height. Returns tMax when it never lands within tMax.
 */
export function grainImpactTime(p0: { x: number; y: number; z: number }, g: GrainOpts,
  groundAt: (x: number, z: number) => number, tMax: number, ds = 0.04, maxSteps = 600): number {
  const above = (t: number) => { const p = grainPos(p0, g, t); const h = groundAt(p.x, p.z); return Number.isFinite(h) ? p.y - h : 1; };
  const speed = (t: number) => {
    const e = g.drag < 0.001 ? 1 : Math.exp(-g.drag * t);
    const vy = g.vel.y * e + g.buoyancy * t;
    return Math.hypot(g.vel.x * e, vy, g.vel.z * e);
  };
  const dtMin = tMax / maxSteps;
  let t0 = 0, risen = above(0) > 0;
  while (t0 < tMax) {
    const t1 = Math.min(tMax, t0 + Math.max(dtMin, Math.min(0.05, ds / Math.max(speed(t0), 1e-3))));
    const a1 = above(t1);
    if (!risen) {
      // (launched from just below the height field, e.g. into an uphill slope: it has to come up first;
      // a grain that stays buried dies at once instead of flying on underground)
      if (a1 > 0) risen = true;
      else if (t1 > 0.15) return t1;
    } else if (a1 <= 0) {
      let lo = t0, hi = t1;
      for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (above(m) > 0) lo = m; else hi = m; }
      return (lo + hi) / 2;
    }
    t0 = t1;
  }
  return tMax;
}

/**
 * A ballistic grain launched from `p0` that dies where its parabola meets the terrain. Without a
 * height function the level-ground flight time of ballisticGrain stays.
 */
export function terrainGrain(vel: { x: number; y: number; z: number }, p0: { x: number; y: number; z: number },
  m: DustMedium, groundAt: ((x: number, z: number) => number) | null): GrainOpts {
  const h0 = groundAt ? p0.y - groundAt(p0.x, p0.z) : 0.05;
  const g = ballisticGrain(vel, Math.max(0, h0), m);
  if (!groundAt) return g;
  // (downhill the grain may fly far past the level-ground time – search the whole particle life of 12 s)
  return { ...g, life: grainImpactTime(p0, g, groundAt, 12) };
}

/**
 * Launch velocity (ground frame) of a rooster-tail grain. A tread point φ behind the contact moves at
 * (v − ωr·cos φ) forward and ωr·sin φ upward (rolling: v(1 − cos φ), v sin φ – the cycloid); the
 * grain leaves with a fraction of that velocity. φ = 8–30°: grains released later hit the wheel arch
 * (the LRV fenders did the same job). Wheel spin (ωr > v) throws them backwards. `fwd` = unit travel
 * direction (horizontal), `v` = ground speed, `rim` = ωr; `r1..r3` in [0,1).
 */
export function roosterVelocity(rim: number, v: number, fwd: { x: number; z: number },
  r1: number, r2: number, r3: number): { x: number; y: number; z: number } {
  const phi = (8 + 22 * r2) * Math.PI / 180;
  const k = 0.3 + 0.6 * r1;
  const along = (v - rim * Math.cos(phi)) * k;
  const up = rim * Math.sin(phi) * k;
  // sideways spray off the tread shoulders
  const side = (r3 - 0.5) * 0.5 * rim * k * Math.sin(phi) + (r3 - 0.5) * 0.3;
  return { x: fwd.x * along - fwd.z * side, y: up, z: fwd.z * along + fwd.x * side };
}

/** Tint (linear, sprite base colour) of dust per soil: grey regolith, ochre Martian dust, tan desert sand. */
export function dustTint(kind: SurfaceKind | null | undefined): [number, number, number] {
  // (sprites are lit like a thin sphere-ish puff, the ground by n·l at a low sun: a dust cloud in full sun
  // reads brighter than the soil it came from – the Apollo rooster tails shine against the ground)
  if (kind === 'regolith') return [0.62, 0.6, 0.57];
  if (kind === 'mars_soil') return [0.62, 0.40, 0.25];
  if (kind === 'sand') return [0.70, 0.56, 0.40];
  return [0.62, 0.52, 0.4];
}

/**
 * grain diameters (m) drawn for a soil – a power-law spread from fine grains to coarse clods (the
 * sprites show grain packets, so the sizes are those of visible clumps, not of the 50–100 µm median of
 * the regolith) – and the sky fill on the grains as a fraction of the sun: none in vacuum, the bright
 * dusty Martian sky, Earth's blue sky.
 */
export function grainSizes(kind: SurfaceKind | null | undefined, rho: number): { dMin: number; dMax: number; sky: number } {
  const sky = rho <= 0 ? 0 : rho < 0.5 ? 0.12 : 0.2;
  if (kind === 'sand') return { dMin: 0.002, dMax: 0.012, sky };
  if (kind === 'mars_soil') return { dMin: 0.003, dMax: 0.02, sky };
  return { dMin: 0.003, dMax: 0.025, sky };
}
