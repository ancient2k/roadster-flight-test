// Feasibility: attainable wrench set of the 10 nozzles (positive duties only) and the air budgets.
import { describe, expect, it } from 'vitest';
import { FLIGHT_DESIGN, requiredAirKg, stuntAirBudget, wrenchEnvelope } from '../../../src/sim/gnc/feasibility';
import { nominalMassProps } from '../../../src/sim/gnc/massProps';
import { TUNING } from '../../../src/sim/stunts/tuning';
import type { StuntId } from '../../../src/shared/types';

const STUNTS: StuntId[] = ['kickflip', 'ground_flip', 'ramp_launch', 'zero60', 'ramp_hang'];

describe('wrench envelope (positive duties, current thrust, moments about the wet CoM)', () => {
  const full = wrenchEnvelope(250);
  it('lift T/W ≈ 3 with a full tank; mains > 80 kN', () => {
    expect(full.liftTW).toBeGreaterThan(2.9);
    expect(full.maxForwardN).toBeGreaterThan(80_000);
  });
  it('enough attitude authority while braking at 1.8 g for every manoeuvre', () => {
    const I = nominalMassProps(250).inertia;
    const alphaBrake = full.momentAtBrake.map((m, i) => m / [I.x, I.y, I.z][i]);
    // roll: kickflip / finale / half flip pulses
    expect(full.alphaAtHover[2]).toBeGreaterThan(TUNING.kickflip.rollAccel);
    // pitch/roll/yaw corrections during the landing burn
    expect(alphaBrake[0]).toBeGreaterThan(5);
    expect(alphaBrake[2]).toBeGreaterThan(5);
    expect(alphaBrake[1]).toBeGreaterThan(2);
  });
  it('blowdown (50 kg left) still has > 2 g lift for a landing', () => {
    expect(wrenchEnvelope(50).liftTW).toBeGreaterThan(2.0);
  });
});

describe('air budget per stunt (shared propulsion kernel, tank cooling included)', () => {
  for (const s of STUNTS) {
    it(`${s}: fits in the regulated range (${FLIGHT_DESIGN.regulatedBudgetKg} kg) and the 250 kg charge`, () => {
      const b = stuntAirBudget(s);
      expect(b.totalKg).toBeLessThanOrEqual(FLIGHT_DESIGN.regulatedBudgetKg);
      expect(b.withinTotal).toBe(true);
      expect(requiredAirKg(s)).toBeLessThanOrEqual(250);
    });
  }
});
