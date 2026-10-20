// Prints the wrench envelope and air budgets (input for docs/PHYSICS.md).
import { it } from 'vitest';
import { stuntAirBudget, wrenchEnvelope, effectiveExhaustVelocity } from '../../src/sim/gnc/feasibility';
import type { StuntId } from '../../src/shared/types';

it('budget table', () => {
  for (const air of [250, 200, 165, 120, 85, 50]) {
    const e = wrenchEnvelope(air);
    console.log(`air ${air} kg m=${e.massKg.toFixed(0)} reg=${e.regulated} lift=${(e.maxLiftN / 1e3).toFixed(1)} kN T/W=${e.liftTW.toFixed(2)} fwd=${(e.maxForwardN / 1e3).toFixed(1)} kN ve=${effectiveExhaustVelocity(air).toFixed(0)}`);
    console.log('  maxM [Mx+,Mx-,My+,My-,Mz+,Mz-] kNm', e.maxMoment.map((x) => (x / 1e3).toFixed(1)).join(' '));
    console.log('  M@1g [pitch,yaw,roll] kNm', e.momentAtHover.map((x) => (x / 1e3).toFixed(1)).join(' '), ' M@1.8g', e.momentAtBrake.map((x) => (x / 1e3).toFixed(1)).join(' '), ' alpha@1g', e.alphaAtHover.map((x) => x.toFixed(1)).join(' '));
  }
  for (const s of ['kickflip', 'ground_flip', 'ramp_launch', 'zero60', 'ramp_hang'] as StuntId[]) {
    const b = stuntAirBudget(s);
    console.log(`${s}: total ${b.totalKg.toFixed(1)} kg reserve(165) ${b.reserveKg.toFixed(1)} kg`);
    for (const p of b.phases) console.log(`   ${p.phase}: ${(p.impulseNs / 1e3).toFixed(1)} kNs -> ${p.airKg.toFixed(1)} kg (${p.note})`);
  }
});
