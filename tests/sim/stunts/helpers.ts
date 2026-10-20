// Shared scenario runner for stunt tests and tools.
import { RoadsterSim, type RoadsterSimOptions } from '../../../src/sim/core/roadsterSim';
import { Autopilot, type StuntOptions, type StuntResult } from '../../../src/sim/gnc';
import type { SpawnPose, StuntId } from '../../../src/shared/types';
import { ROADSTER } from '../../../src/shared/roadster';

export type SimFactory = (opts: Omit<RoadsterSimOptions, 'modules'>) => Promise<RoadsterSim>;

/** vehicle physics if available, else the bare kernel (flight phases only). */
export async function vehicleFactory(): Promise<SimFactory | null> {
  try {
    const mod = await import('../../../src/sim/vehicle');
    return (o) => mod.createRoadsterSim(o);
  } catch { return null; }
}

export const kernelFactory: SimFactory = (o) => RoadsterSim.create(o);

export interface RunOptions {
  sim?: Omit<RoadsterSimOptions, 'modules'>;
  ap?: StuntOptions;
  spawn?: SpawnPose;
  airKg?: number;
  maxS?: number;
  /** Valve delays (s) for robustness runs. */
  valveDelay?: { open: number; close: number };
  /** Called after reset (e.g. to set an initial velocity / angular velocity). */
  setup?: (sim: RoadsterSim) => void;
  /** Per-step hook. */
  onStep?: (sim: RoadsterSim, ap: Autopilot) => void;
  /** Reuse a sim instance (must have been created with the same factory and options). */
  reuse?: RoadsterSim;
}

export async function runStunt(id: StuntId, factory: SimFactory, o: RunOptions = {}): Promise<{ result: StuntResult; sim: RoadsterSim; ap: Autopilot }> {
  const simOpts = { ...(o.sim ?? {}) };
  if (o.valveDelay) simOpts.valves = { ...(simOpts.valves ?? {}), openDelayS: o.valveDelay.open, closeDelayS: o.valveDelay.close };
  const sim = o.reuse ?? await factory(simOpts);
  sim.reset(o.spawn ?? Autopilot.spawn(id), o.airKg !== undefined ? { airMassKg: o.airKg } : {});
  o.setup?.(sim);
  const ap = new Autopilot(sim, id, o.ap ?? {});
  const n = Math.round((o.maxS ?? 120) / sim.dt);
  for (let k = 0; k < n && !ap.result(); k++) {
    const c = ap.update();
    sim.step(c.drive, c.systems, c.thrust);
    o.onStep?.(sim, ap);
  }
  const result = ap.result() ?? { stunt: id, success: false, reason: 'did not finish', metrics: {}, reference: {}, checks: [], trace: [], airUsedKg: 0, durationS: sim.getState().t, startT: 0 };
  return { result, sim, ap };
}

/**
 * Tyre friction variation for robustness runs: scales the Pacejka peak friction μ0 of the shared tyre
 * model for the duration of fn (restored afterwards). Interim until the vehicle modules expose a
 * per-sim option (proposed to the lead: RoadsterSimOptions.tireMuScale); the MC test checks the
 * scaling actually reaches the tyre model (tire.muLoad), so a refactor cannot silently disable it.
 */
export async function withTireMuScale<T>(scale: number, fn: () => Promise<T>): Promise<T> {
  const t = ROADSTER.tire as { mu0: number };
  const base = t.mu0;
  t.mu0 = base * scale;
  try { return await fn(); } finally { t.mu0 = base; }
}

export function summary(r: StuntResult): string {
  return `${r.stunt} ${r.success ? 'OK' : 'FAIL'} (${r.reason}) air ${r.airUsedKg.toFixed(1)} kg, t ${r.durationS.toFixed(1)} s\n` +
    r.checks.map((c) => `   ${c.ok ? '✓' : '✗'} ${c.name}: ${Number.isFinite(c.value) ? c.value.toFixed(3) : c.value} (${c.target})`).join('\n');
}
