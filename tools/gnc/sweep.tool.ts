// Offline tuning sweeps (results -> src/sim/stunts/tuning.ts constants + docs/PHYSICS.md).
//   npx vitest run --config tools/gnc/vitest.config.ts tools/gnc/sweep.tool.ts
import { it } from 'vitest';
import { TUNING } from '../../src/sim/stunts/tuning';
import { runStunt, vehicleFactory } from '../../tests/sim/stunts/helpers';

it('kickflip entry speed: launch g vs apex (full stunt incl. kicker)', async () => {
  const f = (await vehicleFactory())!;
  const base = TUNING.kickflip.entrySpeedMs;
  const rows: string[] = [];
  let best = { v: base, cost: Infinity };
  for (let v = 18.6; v <= 23.01; v += 0.4) {
    TUNING.kickflip.entrySpeedMs = v;
    const { result, sim } = await runStunt('kickflip', f, { maxS: 60 });
    sim.dispose();
    const m = result.metrics;
    // fit both video figures, normalised by their acceptance bands
    const cost = ((m.launchG - 3.5) / 0.7) ** 2 + ((m.maxAltitudeM - 7.7) / (0.15 * 7.7)) ** 2;
    if (result.success && cost < best.cost) best = { v, cost };
    rows.push(`v ${v.toFixed(1)} m/s: launch ${m.launchG.toFixed(2)} g, apex ${m.maxAltitudeM.toFixed(2)} m, tdG ${m.touchdownG.toFixed(2)}, air ${result.airUsedKg.toFixed(0)} kg, cost ${cost.toFixed(2)} ${result.success ? 'OK' : result.reason}`);
  }
  TUNING.kickflip.entrySpeedMs = base;
  console.log(rows.join('\n') + `\nBEST entry speed ${best.v.toFixed(1)} m/s (cost ${best.cost.toFixed(2)})`);
});

it('ramp_launch entry speed (video: 1.4 g at the ramp entry, top after ≈ 5 s)', async () => {
  const f = (await vehicleFactory())!;
  const base = TUNING.rampLaunch.entrySpeedMs;
  const rows: string[] = [];
  for (const v of [6, 7, 8, 9, 10]) {
    TUNING.rampLaunch.entrySpeedMs = v;
    let tEnter = NaN, gEntry = 0;
    const { result, sim } = await runStunt('ramp_launch', f, { maxS: 90, onStep: (s, ap) => {
      if (ap.phase === 'climb' && Number.isNaN(tEnter)) tEnter = s.getState().t;
      if (ap.phase === 'climb' && s.getState().t - tEnter < 1.5) gEntry = Math.max(gEntry, s.telemetry().gForce);
    } });
    sim.dispose();
    const m = result.metrics;
    rows.push(`v ${v} m/s: entry g ${gEntry.toFixed(2)}, ramp→top ${(m.liftoffT - tEnter).toFixed(1)} s, tdG ${m.touchdownG.toFixed(2)}, air ${result.airUsedKg.toFixed(0)} kg ${result.success ? 'OK' : result.reason}`);
  }
  TUNING.rampLaunch.entrySpeedMs = base;
  console.log(rows.join('\n'));
});
