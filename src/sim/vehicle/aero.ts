// Aerodynamics: drag (cd*A blended by the active wing angle), downforce (ClA blended), active wing
// (fixed angle, mode preset or automatic by speed / cornering / braking demand), centre of pressure.
// Still air (no wind). Drag opposes the air-relative velocity; downforce acts along -Y_body and
// scales with the forward airspeed squared.
import type { ForceModule, RoadsterSim, StepContext } from '@sim/core/roadsterSim';
import { clamp, qrot, v3, type Quat } from '@shared/math';
import type { AeroMode, VehicleState } from '@shared/types';
import { AERO, VEH_EXT } from './params';
import type { VehicleBus } from './bus';

const XA = VEH_EXT.aero;
const [WMIN, WMAX] = AERO.wingAngleRangeDeg;

/** Coefficients at a wing angle (deg): linear blend lowDrag (min angle) -> highDownforce (max). */
export function aeroCoeffs(wingDeg: number): { cd: number; clA: number } {
  const k = clamp((wingDeg - WMIN) / (WMAX - WMIN), 0, 1);
  return {
    cd: AERO.cd.lowDrag + (AERO.cd.highDownforce - AERO.cd.lowDrag) * k,
    clA: AERO.clA.lowDrag + (AERO.clA.highDownforce - AERO.clA.lowDrag) * k,
  };
}

export class AeroModule implements ForceModule {
  readonly name = 'aero';
  wingDeg: number = WMAX;
  dragN = 0; downforceN = 0; mode: AeroMode = 'auto';
  private readonly bus: VehicleBus;
  constructor(bus: VehicleBus) { this.bus = bus; }

  reset(_sim: RoadsterSim): void { this.bus.reset(); this.wingDeg = WMAX; this.dragN = 0; this.downforceN = 0; this.mode = 'auto'; }

  private targetWing(ctx: StepContext, vFwd: number): number {
    const s = ctx.systems;
    if (s.wingAngleDeg != null) return clamp(s.wingAngleDeg, WMIN, WMAX);
    if (s.aeroMode === 'lowDrag') return WMIN;
    if (s.aeroMode === 'highDownforce') return WMAX;
    const d = ctx.drive;
    if (d.brake > 0.2) return WMAX;                                         // air brake
    if (Math.abs(d.steer) > 0.15 || this.bus.tireUtilization > 0.6) return WMAX; // cornering demand
    // straight line: trim toward low drag above autoLowDragAboveMs
    const k = clamp((vFwd - 0.6 * XA.autoLowDragAboveMs) / (0.4 * XA.autoLowDragAboveMs), 0, 1);
    return WMAX + (WMIN - WMAX) * k;
  }

  apply(ctx: StepContext): void {
    const { sim, dt } = ctx;
    this.mode = ctx.systems.aeroMode;
    const q = sim.body.rotation() as Quat;
    const v = sim.body.linvel();
    const zb = qrot(q, { x: 0, y: 0, z: 1 });
    const vFwd = v.x * zb.x + v.y * zb.y + v.z * zb.z;
    const tgt = this.targetWing(ctx, vFwd);
    const st = XA.wingRateDegPerS * dt;
    this.wingDeg += clamp(tgt - this.wingDeg, -st, st);
    const { cd, clA } = aeroCoeffs(this.wingDeg);
    const sp = Math.hypot(v.x, v.y, v.z);
    const rho = sim.env.airDensity;           // 0 on the Moon / in space, ≈ 0.02 on Mars
    const qd = 0.5 * rho * sp * sp;
    const drag = qd * cd * AERO.frontalAreaM2;
    const vf = Math.max(0, vFwd);
    const down = 0.5 * rho * vf * vf * clA;
    this.dragN = drag; this.downforceN = down;
    this.bus.aeroDragN = drag; this.bus.aeroDownforceN = down;
    if (sp < 1e-6) return;
    const cp = sim.toWorld(AERO.centerOfPressure);
    const F = v3(-v.x / sp * drag, -v.y / sp * drag, -v.z / sp * drag);
    const dn = qrot(q, { x: 0, y: -down, z: 0 });
    F.x += dn.x; F.y += dn.y; F.z += dn.z;
    ctx.acc.addWorld(F, cp);
  }

  writeState(state: VehicleState): void {
    const a = state.aero;
    a.mode = this.mode; a.wingAngleDeg = this.wingDeg; a.dragN = this.dragN; a.downforceN = this.downforceN;
  }
}
