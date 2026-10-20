// GNC public API for the integration (src/game): Autopilot (auto mode) and ManualAssist (free flight).
import { DEG, qaxisAngle, v3 } from '@shared/math';
import { siteFor } from '@shared/track';
import type { DriveInput, SpawnPose, StuntId, SystemsInput, ThrusterCommand } from '@shared/types';
import type { RoadsterSim } from '../core/roadsterSim';
import { createStunt, type GncEvent, type Stunt, type StuntOptions, type StuntResult } from '../stunts';

export type { GncEvent, StuntResult, StuntOptions } from '../stunts';
export { FlightControl } from './flight';
export { Allocator, LEVELS } from './allocator';
export { AttitudeController } from './attitude';
export { wrenchEnvelope, stuntAirBudget, requiredAirKg } from './feasibility';

export interface GncOutput {
  drive: DriveInput;
  systems: SystemsInput;
  thrust: ThrusterCommand;
  phase: string;
  events: GncEvent[];
}

/**
 * Auto mode: flies one stunt on the given sim (which the caller steps with the returned commands).
 * Usage per fixed step: `const o = ap.update(); sim.step(o.drive, o.systems, o.thrust);`
 */
export class Autopilot {
  readonly sim: RoadsterSim;
  readonly stuntId: StuntId;
  readonly stunt: Stunt;
  private started = false;

  constructor(sim: RoadsterSim, stunt: StuntId, opts: StuntOptions = {}) {
    this.sim = sim;
    this.stuntId = stunt;
    this.stunt = createStunt(stunt, sim, opts);
  }

  /** Spawn pose of the stunt site (pass to sim.reset before the first update). */
  static spawn(stunt: StuntId): SpawnPose {
    const s = siteFor(stunt).spawn;
    return { pos: { ...s.pos }, quat: qaxisAngle(v3(0, 1, 0), s.headingDeg * DEG), speedMs: s.speedMs };
  }

  update(): GncOutput {
    if (!this.started) { this.stunt.start(); this.started = true; }
    const { events } = this.stunt.step();
    return { drive: this.stunt.drive, systems: this.stunt.systems, thrust: this.stunt.thrust, phase: this.stunt.phase, events };
  }

  get phase(): string { return this.stunt.phase; }
  result(): StuntResult | null { return this.stunt.finished; }
}

export { ManualAssist, type ManualAxes, type ManualStatus } from './manual';
export { estimateReserve } from './reserve';
