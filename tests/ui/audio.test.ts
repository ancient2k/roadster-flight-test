import { describe, expect, it } from 'vitest';
import * as M from '../../src/audio/model';

describe('procedural audio model', () => {
  it('jet loudness is monotonic, 0 at rest, 1 at full thrust', () => {
    expect(M.jetGain(0)).toBe(0);
    expect(M.jetGain(1)).toBe(1);
    let prev = 0;
    for (let f = 0.05; f <= 1; f += 0.05) { const g = M.jetGain(f); expect(g).toBeGreaterThan(prev); prev = g; }
    expect(M.jetGain(0.1)).toBeGreaterThan(0.1); // light PWM pulses stay audible
    expect(M.thrustFrac(30000, 20500)).toBe(1);
  });
  it('crackle needs an under-expanded jet', () => {
    expect(M.crackleAmount(1.0, 1)).toBe(0);
    expect(M.crackleAmount(6, 1)).toBeGreaterThan(0.9);
    expect(M.crackleAmount(6, 0)).toBe(0);
  });
  it('screech frequency is in the audible kHz range and drops with pressure ratio', () => {
    const lo = M.screechHz(1.5), hi = M.screechHz(6);
    expect(lo).toBeGreaterThanOrEqual(1500);
    expect(hi).toBeLessThanOrEqual(12000);
    expect(hi).toBeLessThan(lo);
  });
  it('fan blade-pass 3 kHz at full spool, gain grows with spool', () => {
    expect(M.fanBpfHz(1)).toBe(3000);
    expect(M.fanBpfHz(0)).toBe(0);
    expect(M.fanGain(0.5, 0)).toBeLessThan(M.fanGain(1, 0));
    expect(M.fanGain(1, 80000)).toBe(1);
  });
  it('motor fundamental follows speed (9:1, 3 pole pairs)', () => {
    expect(M.motorHz(0)).toBe(0);
    const hz = M.motorHz(26.8224); // 60 mph
    expect(hz).toBeGreaterThan(300);
    expect(hz).toBeLessThan(400);
    expect(M.motorGain(0, 0)).toBe(0);
    expect(M.motorGain(1.2e6, 20)).toBeGreaterThan(0.85);
  });
  it('tyre squeal only with slip, contact and speed', () => {
    expect(M.squealAmount(0.02, 0.01, true, 20)).toBe(0);
    expect(M.squealAmount(0.3, 0, true, 20)).toBeGreaterThan(0.5);
    expect(M.squealAmount(0.3, 0, false, 20)).toBe(0);
    expect(M.squealAmount(0.3, 0, true, 0.5)).toBe(0);
  });
  it('impact strength scales with sink speed and saturates at the bump-stop limit', () => {
    expect(M.impactStrength(0.2)).toBe(0);
    expect(M.impactStrength(-3)).toBeGreaterThan(0.4);
    expect(M.impactStrength(-10)).toBe(1);
  });
  it('edge detector', () => {
    const e = new M.Edge();
    expect(e.rising(true)).toBe(true);
    expect(e.rising(true)).toBe(false);
    expect(e.rising(false)).toBe(false);
    expect(e.rising(true)).toBe(true);
  });
});
