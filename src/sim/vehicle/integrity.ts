// Integrity: touchdown / landing measurement (sink speed, peak compression, bump-stop engagement,
// peak strut load, peak specific force) and the hard-landing crash criterion.
// Chassis impacts (normal speed > crashBodyImpactMs, roof/upper-side contact) are handled by the kernel.
import type { ForceModule, RoadsterSim, StepContext } from '@sim/core/roadsterSim';
import { G0, v3len } from '@shared/math';
import type { VehicleState } from '@shared/types';
import { ROADSTER } from '@shared/roadster';
import { SUSP, VEH_EXT } from './params';
import type { ChassisModule } from './chassis';

export interface LandingEvent {
  t: number;
  sinkMs: number;            // approach speed along the surface normal at first wheel contact
  airtimeS: number;
  peakCompressionM: number;  // max over wheels within the evaluation window
  bumpStop: boolean;         // progressive stop engaged
  bottomed: boolean;         // full travel reached
  peakStrutN: number;
  peakG: number;             // unfiltered |specific force| / g0 (single-step pulses)
  peakHudG: number;          // 10 Hz low-pass g (telemetry gForce, like the stream HUD)
  peakBodyImpactMs: number;  // kernel chassis impact speed within the window
  hard: boolean;             // sink > maxLandingSinkMs -> crash
}

const WINDOW_S = 0.6;
const AIR_MIN_S = 0.08;      // ignore brief wheel chatter

export class IntegrityModule implements ForceModule {
  readonly name = 'integrity';
  readonly landings: LandingEvent[] = [];
  current: LandingEvent | null = null;
  /** false with the damage model on: a hard landing bends the suspension (damage.ts) instead of ending the run. */
  crashOnHardLanding = true;
  private airborneSince = -1;
  private windowEnd = -1;
  private lastVel = { x: 0, y: 0, z: 0 };
  private readonly chassis: ChassisModule;
  constructor(chassis: ChassisModule) { this.chassis = chassis; }

  get lastLanding(): LandingEvent | null { return this.landings.length ? this.landings[this.landings.length - 1] : null; }

  reset(_sim: RoadsterSim): void {
    this.landings.length = 0; this.current = null; this.airborneSince = -1; this.windowEnd = -1;
  }

  apply(ctx: StepContext): void {
    const v = ctx.sim.body.linvel();
    this.lastVel.x = v.x; this.lastVel.y = v.y; this.lastVel.z = v.z;
  }

  writeState(state: VehicleState, sim: RoadsterSim): void {
    const t = state.t;
    const anyContact = this.chassis.wheels.some((w) => w.contact);
    if (!anyContact) {
      if (this.airborneSince < 0) this.airborneSince = t;
    } else if (this.airborneSince >= 0) {
      const air = t - this.airborneSince;
      this.airborneSince = -1;
      if (air >= AIR_MIN_S) {
        let sink = 0;
        for (const w of this.chassis.wheels) {
          if (!w.contact) continue;
          const vn = -(this.lastVel.x * w.n.x + this.lastVel.y * w.n.y + this.lastVel.z * w.n.z);
          sink = Math.max(sink, vn);
        }
        this.current = {
          t, sinkMs: sink, airtimeS: air, peakCompressionM: 0, bumpStop: false, bottomed: false,
          peakStrutN: 0, peakG: 0, peakHudG: 0, peakBodyImpactMs: 0, hard: sink > ROADSTER.integrity.maxLandingSinkMs,
        };
        this.landings.push(this.current);
        this.windowEnd = t + WINDOW_S;
      }
    }
    const L = this.current;
    if (L && t <= this.windowEnd) {
      for (const w of this.chassis.wheels) {
        L.peakCompressionM = Math.max(L.peakCompressionM, w.c);
        L.peakStrutN = Math.max(L.peakStrutN, w.strutN);
        if (w.c > SUSP.travelM - VEH_EXT.suspension.bumpStopLengthM) L.bumpStop = true;
        if (w.c >= SUSP.travelM) L.bottomed = true;
      }
      L.peakG = Math.max(L.peakG, v3len(state.specificForce) / G0);
      L.peakHudG = Math.max(L.peakHudG, sim.telemetry().gForce);
      L.peakBodyImpactMs = Math.max(L.peakBodyImpactMs, sim.impactSpeed);
      if (L.hard && this.crashOnHardLanding) state.crashed = true;
    } else if (L && t > this.windowEnd) {
      this.current = null;
    }
  }
}
