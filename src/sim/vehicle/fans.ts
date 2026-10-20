// Fan suction system ("fan car"). Four fans, each evacuating one quadrant plenum of the sealed
// underbody. Per plenum:
//   fan curve        dp = dp0 n^2 (1 - (Q / (Qmax n))^2)          (affinity laws, n = rpm fraction)
//   skirt leak       Q  = Cd * sum(l_i h_i) * sqrt(2 dp / rho)     (h_i from perimeter ray samples)
//   power limit      dp * Q <= eta * P_fan
// Closed-form equilibrium dp = dp0 n^2 / (1 + dp0 n^2 K^2 / (Qmax n)^2), K = Cd sum(l h) sqrt(2/rho),
// capped by dp <= (eta P / K)^(2/3). The plenum pressure relaxes toward it with the acoustic
// capacitance time constant; the rotor spools with spoolTimeS. Force dp*A/4 along -Y_body at each
// quadrant centroid -> unequal gaps produce a pressure moment.
// Grip mode without fanLevel: demand control (normal force needed for friction + pull-off margin).
// Surfaces: skirts seal worse on grass / loose soil (extra effective leak height per sample),
// the demand reference friction follows the surface; `dust` = underbody dust hint for the graphics.
import type { ForceModule, RoadsterSim, StepContext } from '@sim/core/roadsterSim';
import { clamp, qrot, v3, type Quat, type Vec3 } from '@shared/math';
import type { FanMode, VehicleState } from '@shared/types';
import { FANS, VEH_EXT } from './params';
import type { VehicleBus } from './bus';
import { SURFACES, surfaceAt, surfaceAtPoint } from './surfaces';

const XF = VEH_EXT.fans;
/** Reference density of the fan curve (shutoffDeltaPPa is specified for Earth sea-level air). */
const RHO_REF = VEH_EXT.aero.rho;
const GAMMA = 1.4;

interface Sample { pos: Vec3; len: number; quad: number; gap: number }

/** Skirt rectangle (width, length) from the shared floor area and perimeter. */
export function skirtRect(): { w: number; l: number } {
  const s = FANS.skirtPerimeterM / 2, p = FANS.floorAreaM2;
  const disc = Math.sqrt(Math.max(0, s * s - 4 * p));
  return { w: (s - disc) / 2, l: (s + disc) / 2 };
}

/**
 * Closed-form plenum equilibrium for one quadrant fan. Returns dp (Pa).
 * Fan affinity in density: dp0 ∝ rho n², Qmax ∝ n (volumetric), absorbed power ∝ rho n³.
 * K = Cd sum(l h) sqrt(2/rho) is the leak conductance at that density.
 */
export function plenumEquilibrium(rpm: number, K: number, rho: number = RHO_REF, dp0Full: number = FANS.shutoffDeltaPPa,
  qmaxFull: number = FANS.maxFlowM3s / FANS.count, pFan: number = FANS.powerPerFanW * FANS.efficiency): number {
  if (rpm <= 0 || rho <= 0) return 0;
  const dp0 = dp0Full * (rho / RHO_REF) * rpm * rpm, qm = qmaxFull * rpm;
  if (K <= 0) return dp0;
  const dpCurve = dp0 / (1 + (dp0 * K * K) / (qm * qm));
  const dpPower = Math.pow(pFan / K, 2 / 3);
  return Math.min(dpCurve, dpPower);
}

export class FanModule implements ForceModule {
  readonly name = 'fans';
  readonly samples: Sample[] = [];
  readonly quadDp = new Float64Array(4);
  readonly quadK = new Float64Array(4);
  readonly quadCentroid: Vec3[];
  rpm = 0; rpmTarget = 0; forceN = 0; flow = 0; power = 0; gapMean = 1; mode: FanMode = 'off';
  /** Dust sucked up / blown out under the skirts (0..1, graphics hint). */
  dust = 0;
  private dustiness = 0;
  /** Fraction of skirt samples over loose soil (sand, regolith, Mars soil) last step. */
  private soilFrac = 0;
  /** Fraction of skirt samples over a landmark (pyramid stone) last step. */
  private landmarkFrac = 0;
  private readonly bus: VehicleBus;
  private readonly cx: number; private readonly cz: number; private readonly floorY: number;

  constructor(bus: VehicleBus) {
    this.bus = bus;
    const { w, l } = skirtRect();
    const c = FANS.centerOfSuction;
    this.cx = c.x; this.cz = c.z; this.floorY = c.y;
    const add = (x: number, z: number, len: number) => {
      const quad = (x >= this.cx ? 0 : 1) + (z >= this.cz ? 0 : 2);
      this.samples.push({ pos: { x, y: this.floorY, z }, len, quad, gap: 1 });
    };
    const nl = XF.samplesLong, ns = XF.samplesShort;
    for (let i = 0; i < nl; i++) {
      const z = this.cz - l / 2 + (l * (i + 0.5)) / nl;
      add(this.cx + w / 2, z, l / nl); add(this.cx - w / 2, z, l / nl);
    }
    for (let i = 0; i < ns; i++) {
      const x = this.cx - w / 2 + (w * (i + 0.5)) / ns;
      add(x, this.cz + l / 2, w / ns); add(x, this.cz - l / 2, w / ns);
    }
    // quadrant 0: +x(left) front, 1: right front, 2: left rear, 3: right rear
    this.quadCentroid = [0, 1, 2, 3].map((q) => ({
      x: this.cx + ((q & 1) ? -w / 4 : w / 4), y: this.floorY, z: this.cz + ((q & 2) ? -l / 4 : l / 4),
    }));
  }

  reset(_sim: RoadsterSim): void {
    this.rpm = 0; this.rpmTarget = 0; this.forceN = 0; this.flow = 0; this.power = 0; this.gapMean = 1; this.mode = 'off';
    this.dust = 0; this.dustiness = 0; this.soilFrac = 0; this.landmarkFrac = 0;
    this.quadDp.fill(0); this.quadK.fill(0);
    for (const s of this.samples) s.gap = 1;
  }

  /** Gap samples along -Y_body from the skirt line to the nearest static surface. */
  private sampleGaps(sim: RoadsterSim, yb: Vec3): void {
    const down = { x: -yb.x, y: -yb.y, z: -yb.z };
    // start well inside the floor: on a tight concave curve (the stream ramp's R 8 m curl) the surface rises
    // above the skirt line at the ends of the car (≈ 0.13 m behind the rear axle); a ray starting below the
    // surface saw nothing and counted the fully compressed (sealed) skirt as wide open
    const lift = 0.30;
    const o = v3();
    let dusty = 0, soil = 0, landmark = 0;
    for (const s of this.samples) {
      sim.toWorld({ x: s.pos.x, y: s.pos.y + lift, z: s.pos.z }, o);
      const hit = sim.castRay(o, down, XF.maxRayM + lift);
      const d = hit ? Math.max(0, hit.dist - lift) : XF.maxRayM;
      const surf = SURFACES[hit ? surfaceAtPoint(hit.info?.kind, sim, hit.point.x, hit.point.z) : surfaceAt(undefined, sim.surface)];
      const leak = surf.skirtLeakM;
      s.gap = clamp(d - FANS.skirtTravelM + leak, FANS.minGapM + leak, XF.maxRayM);
      dusty += surf.dustiness;
      if (hit && surf.soil) soil++;
      if (hit?.info?.kind === 'landmark') landmark++;
    }
    this.soilFrac = soil / this.samples.length;
    this.landmarkFrac = landmark / this.samples.length;
    this.dustiness = dusty / this.samples.length;
  }

  private demandRpm(ctx: StepContext, fullForceN: number): number {
    const lvl = ctx.systems.fanLevel;
    if (lvl != null) return clamp(lvl, 0, 1);
    const bus = this.bus;
    if (bus.contactCount === 0 || fullForceN <= 0) return XF.idleRpm;
    const d = ctx.drive;
    // full suction on demand only where the skirt can seal: on loose soil it mostly sinks the wheels and pulls
    // the floor into the sand (the car bogs down), so there the computed requirement applies. Off the McGregor
    // track also not while the floor scrapes (a hump, a pyramid crest): full suction would pin the floor down
    // and high-centre the car (the stunts' suction profile on the track is validated against the stream).
    const scraping = ctx.state.bodyContact && ctx.sim.groundKind !== 'track';
    if (this.soilFrac < 0.5 && !scraping && (d.launchMode || d.throttle > 0.6 || d.brake > 0.5 || bus.tireUtilization > 0.75)) return 1;
    const m = ctx.state.massKg, n = bus.surfaceNormal, g = ctx.sim.env.gravity;
    const gn = g.x * n.x + g.y * n.y + g.z * n.z;
    const gN = -m * gn;                                     // gravity pressing (+) / pulling off (-)
    const gT = m * Math.hypot(g.x - gn * n.x, g.y - gn * n.y, g.z - gn * n.z); // along the surface
    // on a stone landmark steeper than 30° (pyramid face): hold full suction regardless of the pedals – easing
    // off the throttle on a 52° face must not drop the car's only hold on the wall. (Not on the McGregor ramps:
    // the stunts' suction profile is validated against the stream telemetry.)
    if (!scraping && this.landmarkFrac > 0.5 && gT > 0.5 * m * Math.hypot(g.x, g.y, g.z)) return 1;
    const fNeed = Math.max(gT, bus.tireForceN);
    let req = XF.demandMargin * fNeed / (XF.demandMuRef * bus.muScale) - gN;
    if (gN < 0) req += (XF.pullOffMargin - 1) * -gN;
    const n2 = clamp(req / fullForceN, 0, 1);
    return clamp(Math.sqrt(n2), XF.idleRpm, 1);
  }

  apply(ctx: StepContext): void {
    const { sim, dt, systems } = ctx;
    this.mode = systems.fanMode;
    const rho = sim.env.airDensity;
    const q = sim.body.rotation() as Quat;
    const yb = qrot(q, { x: 0, y: 1, z: 0 });
    this.sampleGaps(sim, yb);
    const sq = rho > 0 ? Math.sqrt(2 / rho) : 0; // no atmosphere: K = 0 and dp0 = 0 -> no suction
    this.quadK.fill(0);
    let gapLen = 0, len = 0;
    for (const s of this.samples) { this.quadK[s.quad] += FANS.dischargeCoeff * s.len * s.gap * sq; gapLen += s.len * s.gap; len += s.len; }
    this.gapMean = gapLen / len;
    if (this.mode === 'highspeed') for (let i = 0; i < 4; i++) this.quadK[i] += FANS.dischargeCoeff * (XF.highspeedFlapAreaM2 / 4) * sq;
    // rotor target
    const aQ = FANS.floorAreaM2 / 4;
    let fullF = 0;
    for (let i = 0; i < 4; i++) fullF += plenumEquilibrium(1, this.quadK[i], rho) * aQ;
    this.rpmTarget = this.mode === 'off' ? 0 : this.mode === 'highspeed' ? XF.highspeedRpm : this.demandRpm(ctx, fullF);
    const tau = Math.max(FANS.spoolTimeS / 3, 1e-3);
    this.rpm += (this.rpmTarget - this.rpm) * -Math.expm1(-dt / tau);
    // plenum pressures
    const vq = XF.plenumVolumeM3 / 4, qmF = FANS.maxFlowM3s / FANS.count;
    const fb = v3(), pw = v3();
    let force = 0, flow = 0, power = 0;
    for (let i = 0; i < 4; i++) {
      const K = this.quadK[i];
      const eq = plenumEquilibrium(this.rpm, K, rho);
      let dp = this.quadDp[i];
      // linearized plenum time constant tau = (V / rho c^2) / (dQleak/ddp + |dQfan/ddp|)
      const dpRef = Math.max(eq, 1);
      const dLeak = K / (2 * Math.sqrt(dpRef));
      const dp0 = FANS.shutoffDeltaPPa * (rho / RHO_REF) * this.rpm * this.rpm, qm = qmF * this.rpm;
      const dFan = dp0 > 0 ? qm / (2 * dp0 * Math.sqrt(Math.max(1 - dpRef / dp0, 0.02))) : 0;
      const rhoC2 = GAMMA * Math.max(sim.env.ambientPressurePa, 1); // plenum capacitance V / (rho c^2)
      const tp = clamp((vq / rhoC2) / Math.max(dLeak + dFan, 1e-9), 1e-3, 0.5);
      dp += (eq - dp) * -Math.expm1(-dt / tp);
      this.quadDp[i] = dp;
      const Q = K * Math.sqrt(Math.max(dp, 0));
      flow += Q;
      power += (dp * Q) / FANS.efficiency;
      const F = dp * aQ;
      force += F;
      if (F > 0) {
        qrot(q, { x: 0, y: -F, z: 0 }, fb);
        sim.toWorld(this.quadCentroid[i], pw);
        ctx.acc.addWorld(fb, pw);
      }
    }
    this.forceN = force; this.flow = flow; this.power = power;
    // leak jets of ~sqrt(2 dp / rho) (> 50 m/s at full suction) pick up loose grains along the skirts
    this.dust = this.dustiness * clamp((2 * flow) / FANS.maxFlowM3s, 0, 1);
    this.bus.fanForceN = force;
  }

  writeState(state: VehicleState): void {
    const f = state.fans;
    f.mode = this.mode;
    f.deltaPPa = (this.quadDp[0] + this.quadDp[1] + this.quadDp[2] + this.quadDp[3]) / 4;
    f.flowM3s = this.flow;
    f.powerW = this.power;
    f.forceN = this.forceN;
    f.gapM = this.gapMean;
    f.rpmNorm = this.rpm;
  }
}
