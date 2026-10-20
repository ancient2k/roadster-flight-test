// Time-aligned sim vs video (VIDEO_REFERENCE) for ramp_hang, ramp_launch and kickflip: per reference
// sample the sim value at t_ref + startT, plus the per-channel RMS / max error / best HUD lag.
//   npx vitest run --config tools/gnc/vitest.config.ts tools/gnc/video.tool.ts
//   STUNTS=ramp_launch npx vitest run --config tools/gnc/vitest.config.ts tools/gnc/video.tool.ts
import { it } from 'vitest';
import { FT } from '../../src/shared/math';
import { VIDEO_REFERENCE } from '../../src/shared/reference';
import type { StuntId } from '../../src/shared/types';
import { formatVideoFit, sampleTrace } from '../../src/sim/stunts/validation';
import { runStunt, vehicleFactory } from '../../tests/sim/stunts/helpers';
import { applyTuneEnv } from './tune';

const IDS = (process.env.STUNTS?.split(',') ?? ['ramp_launch', 'kickflip', 'ramp_hang']) as StuntId[];

it('sim vs video, time aligned', async () => {
  const f = (await vehicleFactory())!;
  applyTuneEnv();
  for (const id of IDS) {
    const { result, sim } = await runStunt(id, f, { maxS: 120 });
    sim.dispose();
    const ref = VIDEO_REFERENCE[id]!;
    const lines = [`${id}: ${result.success ? 'OK' : 'FAIL ' + result.reason} startT ${result.startT.toFixed(2)} s, air ${result.airUsedKg.toFixed(1)} kg`];
    lines.push('   t | alt video  sim |  pitch video  sim |  g video  sim | df video  sim | phase');
    for (const s of ref) {
      const t = s.t + result.startT;
      const fr = result.trace.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      lines.push(`${s.t.toFixed(2).padStart(5)} | ${s.altitudeFt !== undefined ? (s.altitudeFt * FT).toFixed(1).padStart(5) : '    -'} ${sampleTrace(result.trace, t, 'altitudeM').toFixed(1).padStart(5)} | ` +
        `${s.pitchDeg !== undefined ? s.pitchDeg.toFixed(0).padStart(6) : '     -'} ${sampleTrace(result.trace, t, 'pitchDeg').toFixed(0).padStart(5)} | ` +
        `${s.g !== undefined ? s.g.toFixed(2).padStart(5) : '    -'} ${sampleTrace(result.trace, t, 'g').toFixed(2).padStart(5)} | ` +
        `${s.downforceKg !== undefined ? s.downforceKg.toFixed(0).padStart(5) : '    -'} ${sampleTrace(result.trace, t, 'downforceKg').toFixed(0).padStart(5)} | ${fr.phase}`);
    }
    lines.push(formatVideoFit(result.video ?? null));
    lines.push('   metrics: ' + Object.keys(result.reference).map((k) => `${k} ${result.metrics[k]?.toFixed(2)} (video ${result.reference[k]})`).join(', '));
    console.log(lines.join('\n'));
  }
});
