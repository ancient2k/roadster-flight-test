// Step-size convergence of the flight phases: the same airborne stunt phases at
// 240 / 480 / 960 Hz (sim AND control rate; the game runs at 240 Hz). Apex altitude and air used must agree
// within 2 % / 3 % of the 960 Hz run: the air used scatters non-monotonically by ±2–2.5 % between rates (valve
// pulse quantisation; e.g. ground_flip 161.3 / 163.1 / 159.7 kg at 240 / 480 / 960 Hz), the apex converges
// within 1.5 %. Valve timing (15 ms minimum on-time, 8/6 ms delays) is time based in the kernel.
// (Below the game rate, at 120 Hz, the ramp_launch landing on the stream-shaped wall sinks ≈ 1 m/s instead of
// 0.5 m/s – coarser valve PWM – so 120 Hz is no longer part of the convergence claim.)
import { describe, expect, it } from 'vitest';
import { kickflipLipSpawn, rampTopSpawn } from './spawns';
import { runStunt, summary, vehicleFactory, type RunOptions } from './helpers';
import { TUNING } from '../../../src/sim/stunts/tuning';
import type { StuntId } from '../../../src/shared/types';

const factory = await vehicleFactory();
const RATES = [240, 480, 960];

const CASES: [string, StuntId, () => RunOptions][] = [
  ['kickflip from the lip (roll + landing)', 'kickflip', () => { const sp = kickflipLipSpawn(18.4); return { spawn: sp.spawn, setup: sp.setup, ap: { startPhase: 'climb' }, maxS: 20 }; }],
  ['ramp_launch from the top (half flip + 1.4 g landing)', 'ramp_launch', () => { const sp = rampTopSpawn(TUNING.rampLaunch.releaseBeforeEndM, TUNING.rampLaunch.exitSpeedMs); return { spawn: sp.spawn, setup: sp.setup, ap: { startPhase: 'release' }, maxS: 15 }; }],
  ['ground_flip (take-off, roll, landing)', 'ground_flip', () => ({ maxS: 30 })],
];

describe.skipIf(!factory)('flight phases: step-size convergence 240/480/960 Hz', () => {
  for (const [name, id, opts] of CASES) {
    it(`${name}: apex within 2 %, air within 3 %`, async () => {
      const rows: { hz: number; apex: number; air: number; sink: number }[] = [];
      for (const hz of RATES) {
        const o = opts();
        const { result, sim } = await runStunt(id, factory!, { ...o, sim: { dt: 1 / hz } });
        sim.dispose();
        // from the lip there is no kicker, so the launch-g check does not apply (as in flight.test.ts)
        const failed = result.checks.filter((c) => !c.ok && c.name !== 'launch g 3.5 ±0.7').map((c) => c.name);
        expect(failed, `${hz} Hz: ${summary(result)}`).toEqual([]);
        rows.push({ hz, apex: result.metrics.maxAltitudeM, air: result.airUsedKg, sink: result.metrics.touchdownSinkMs });
      }
      const ref = rows[rows.length - 1];
      console.log(`${id}: ` + rows.map((r) => `${r.hz} Hz apex ${r.apex.toFixed(3)} m (${(100 * (r.apex / ref.apex - 1)).toFixed(2)} %), air ${r.air.toFixed(2)} kg (${(100 * (r.air / ref.air - 1)).toFixed(2)} %), sink ${r.sink.toFixed(2)}`).join(' | '));
      for (const r of rows) {
        expect(Math.abs(r.apex / ref.apex - 1), `${r.hz} Hz apex`).toBeLessThan(0.02);
        expect(Math.abs(r.air / ref.air - 1), `${r.hz} Hz air`).toBeLessThan(0.03);
      }
    }, 600_000);
  }
});
