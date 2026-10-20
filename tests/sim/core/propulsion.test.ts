import { describe, expect, it } from 'vitest';
import { Tank } from '../../../src/sim/core/tank';
import { NozzleModel } from '../../../src/sim/core/nozzle';
import { Propulsion } from '../../../src/sim/core/propulsion';
import { ValveBank } from '../../../src/sim/core/valves';
import { ROADSTER } from '../../../src/shared/roadster';
import { SIM_DT } from '../../../src/shared/types';

describe('tank (Abel-Noble open system)', () => {
  it('full tank is ~690 bar at 250 kg / 288 K', () => {
    const t = new Tank();
    expect(t.pressure / 1e5).toBeCloseTo(690, 0);
    expect(t.T).toBeCloseTo(288, 6);
  });
  it('adiabatic blowdown cools the gas and conserves mass exactly', () => {
    const t = new Tank({ ...ROADSTER.tank, wallHeatTransferWPerK: 0, wallToAmbientWPerK: 0 });
    let removed = 0;
    for (let i = 0; i < 240; i++) { t.step(SIM_DT, 90); removed += 90 * SIM_DT; }
    expect(t.m).toBeCloseTo(250 - removed, 6);
    expect(t.T).toBeLessThan(250);
    // Cross-check: ~160 kg remaining -> ~214 K, ~239 bar (calorically simple Abel-Noble)
    expect(t.m).toBeCloseTo(160, 0);
    expect(t.T).toBeGreaterThan(200); expect(t.T).toBeLessThan(228);
    expect(t.pressure / 1e5).toBeGreaterThan(220); expect(t.pressure / 1e5).toBeLessThan(260);
  });
  it('wall heat transfer warms a cold gas back toward the wall', () => {
    const t = new Tank();
    for (let i = 0; i < 240; i++) t.step(SIM_DT, 90);
    const Tcold = t.T;
    let prev = Tcold;
    for (let k = 0; k < 6; k++) {
      for (let i = 0; i < 240 * 10; i++) t.step(SIM_DT, 0);
      expect(t.T).toBeGreaterThan(prev); prev = t.T; // monotonic re-warming (tau ~ 10 min)
    }
    expect(t.T).toBeGreaterThan(Tcold + 5);
  });
});

describe('nozzle', () => {
  it('main nozzle hits nominal thrust at the regulator set point', () => {
    const spec = ROADSTER.nozzles[0];
    const n = new NozzleModel(spec);
    const o = n.compute(ROADSTER.tank.regulatorSetpointPa, 288);
    expect(o.thrustN).toBeCloseTo(spec.nominalThrustN, -1);
    // effective exhaust velocity in the plausible cold-gas range
    const veff = o.thrustN / o.mdot;
    expect(veff).toBeGreaterThan(550); expect(veff).toBeLessThan(720);
    // underexpanded -> Mach diamonds
    expect(o.exitPressureRatio).toBeGreaterThan(1.5);
  });
  it('thrust scales with feed pressure', () => {
    const n = new NozzleModel(ROADSTER.nozzles[4]);
    const a = n.compute(120e5, 288).thrustN, b = n.compute(60e5, 288).thrustN;
    expect(b / a).toBeGreaterThan(0.45); expect(b / a).toBeLessThan(0.52);
  });
});

describe('valves', () => {
  it('sigma-delta reproduces the requested duty on average', () => {
    const v = new ValveBank(1);
    for (const d of [0.1, 0.35, 0.6, 0.9]) {
      v.reset();
      let open = 0; const N = 240 * 4;
      for (let i = 0; i < N; i++) open += v.step(SIM_DT, [d])[0];
      expect(open / N).toBeCloseTo(d, 1);
    }
  });
  it('respects the opening delay', () => {
    const v = new ValveBank(1);
    expect(v.step(SIM_DT, [1])[0]).toBe(0); // 4.2 ms < 8 ms delay
    expect(v.step(SIM_DT, [1])[0]).toBeGreaterThan(0);
    expect(v.step(SIM_DT, [1])[0]).toBe(1);
  });
});

describe('propulsion system', () => {
  it('4 mains: >80 kN, ~120 kg/s, regulated budget ~ 0.7-1.5 s', () => {
    const p = new Propulsion();
    p.reset();
    const duty = [1, 1, 1, 1, 0, 0, 0, 0, 0, 0];
    let t = 0, peak = 0, regulatedTime = 0, impulse = 0;
    while (p.tank.m > 5 && t < 10) {
      p.step(SIM_DT, duty, false);
      let F = 0; for (let i = 0; i < 4; i++) F += p.states[i].thrustN;
      peak = Math.max(peak, F); impulse += F * SIM_DT;
      if (p.tank.regulated && F > 0) regulatedTime += SIM_DT;
      t += SIM_DT;
    }
    expect(peak).toBeGreaterThan(80_000);
    expect(regulatedTime).toBeGreaterThan(0.7); expect(regulatedTime).toBeLessThan(2.0);
    // total impulse of the whole charge: 250 kg * ~460..650 m/s (exhaust velocity falls as the gas cools)
    expect(impulse).toBeGreaterThan(105_000); expect(impulse).toBeLessThan(170_000);
  });
  it('mass removed equals integrated nozzle mass flow', () => {
    const p = new Propulsion(); p.reset();
    let m = 0;
    for (let i = 0; i < 480; i++) { p.step(SIM_DT, [0, 0, 0, 0, 0.7, 0.7, 0.7, 0.7, 0.2, 0], false); m += p.totalMassFlow * SIM_DT; }
    expect(250 - p.tank.m).toBeCloseTo(m, 6);
  });
  it('hover-class lift: 4 lift nozzles > 1.5 g of the full vehicle', () => {
    const p = new Propulsion(); p.reset();
    const thr = p.availableThrust();
    const lift = [4, 5, 6, 7].reduce((s, i) => s + thr[i] * ROADSTER.nozzles[i].dir.y, 0);
    expect(lift / ((ROADSTER.dryMassKg + 250) * 9.80665)).toBeGreaterThan(2.8);
  });
});
