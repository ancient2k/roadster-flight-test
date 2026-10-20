// Ad-hoc probe: fine-grained telemetry of one stunt in a time window (debugging the tuning).
//   STUNT=ramp_launch PHASE=climb T0=0 T1=2 DT=0.02 npx vitest run --config tools/gnc/vitest.config.ts tools/gnc/probe.tool.ts
import { it } from 'vitest';
import type { StuntId } from '../../src/shared/types';
import { applyTuneEnv } from './tune';
import { runStunt, vehicleFactory } from '../../tests/sim/stunts/helpers';

it('probe', async () => {
  const f = (await vehicleFactory())!;
  applyTuneEnv();
  const id = (process.env.STUNT ?? 'ramp_launch') as StuntId;
  const T0 = Number(process.env.T0 ?? 0), T1 = Number(process.env.T1 ?? 3), DT = Number(process.env.DT ?? 0.05);
  const lines: string[] = [];
  let last = -1;
  const { result, sim } = await runStunt(id, f, { maxS: 120, onStep: (s, ap) => {
    const st = ap.stunt, t = s.getState().t - (Number.isNaN(st.startT) ? Infinity : st.startT);
    if (t < T0 || t > T1 || t - last < DT - 1e-9) return;
    last = t;
    const tel = s.telemetry(), x = s.getState();
    lines.push(`${t.toFixed(3)} ${st.phase.padEnd(10)} alt ${tel.altitudeM.toFixed(2)} pitch ${tel.pitchDeg.toFixed(1)} roll ${tel.rollDeg.toFixed(0)} g ${tel.gForce.toFixed(2)} df ${tel.downforceKg.toFixed(0)} v ${tel.speedMs.toFixed(2)} vy ${x.linVel.y.toFixed(2)} air ${tel.airMassKg.toFixed(1)} duty ${tel.thrusterDuty.slice(4, 8).map((d) => d.toFixed(2)).join(',')}`);
  } });
  sim.dispose();
  console.log(lines.join('\n') + `\n${result.success ? 'OK' : 'FAIL ' + result.reason} metrics ${JSON.stringify(Object.fromEntries([...Object.keys(result.reference), 'landingBurnG', 'touchdownSinkMs', 'liftoffT', 'touchdownT', 'video_altitudeM_rms', 'video_g_rms', 'video_g_peakMaxErr', 'video_pitchDeg_rms', 'video_downforceKg_rms'].filter((k) => k in result.metrics).map((k) => [k, +result.metrics[k].toFixed(3)])))} air ${result.airUsedKg.toFixed(1)}`);
});
