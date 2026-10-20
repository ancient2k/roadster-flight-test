import { describe, expect, it } from 'vitest';
import { spawnPose } from '../../../src/sim/core/roadsterSim';
import { ROADSTER } from '../../../src/shared/roadster';
import { aeroCoeffs } from '../../../src/sim/vehicle';
import { resetInputs, rig } from './helpers';

const A = ROADSTER.aero;

describe('aerodynamics', () => {
  it('coefficients blend lowDrag -> highDownforce over the wing range', () => {
    const [lo, hi] = A.wingAngleRangeDeg;
    expect(aeroCoeffs(lo)).toEqual({ cd: A.cd.lowDrag, clA: A.clA.lowDrag });
    expect(aeroCoeffs(hi).cd).toBeCloseTo(A.cd.highDownforce, 12);
    expect(aeroCoeffs(hi).clA).toBeCloseTo(A.clA.highDownforce, 12);
  });

  it('drag and downforce follow ½ρv²·cd·A and ½ρv²·ClA; modes, fixed angle and auto wing work', async () => {
    const r = await rig();
    const v = 50;
    for (const mode of ['lowDrag', 'highDownforce'] as const) {
      resetInputs(r);
      r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, v));
      r.systems.aeroMode = mode;
      r.run(0.6, () => { r.drive.throttle = 0.3; });          // wing moves at its rate limit
      const st = r.sim.getState(), sp = st.speedMs;
      const c = aeroCoeffs(st.aero.wingAngleDeg);
      const q = 0.5 * A.airDensity * sp * sp;
      expect(st.aero.wingAngleDeg).toBe(mode === 'lowDrag' ? A.wingAngleRangeDeg[0] : A.wingAngleRangeDeg[1]);
      expect(st.aero.dragN).toBeCloseTo(q * c.cd * A.frontalAreaM2, -1);
      expect(st.aero.downforceN / (q * c.clA)).toBeGreaterThan(0.99);
      expect(st.aero.downforceN / (q * c.clA)).toBeLessThan(1.01);
    }
    // fixed angle overrides the mode
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, v));
    r.systems.wingAngleDeg = 12;
    r.run(0.6);
    expect(r.sim.getState().aero.wingAngleDeg).toBeCloseTo(12, 6);
    // auto: low drag on a fast straight, full wing when braking (air brake)
    resetInputs(r);
    r.sim.reset(spawnPose({ x: 0, y: 0, z: -1300 }, 0, 70));
    r.run(0.6, () => { r.drive.throttle = 0.5; });
    expect(r.sim.getState().aero.wingAngleDeg).toBeLessThan(2);
    r.run(0.6, () => { r.drive.throttle = 0; r.drive.brake = 1; });
    expect(r.sim.getState().aero.wingAngleDeg).toBeCloseTo(A.wingAngleRangeDeg[1], 6);
    r.sim.dispose();
  });
});
