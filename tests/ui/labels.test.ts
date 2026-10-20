import { describe, expect, it } from 'vitest';
import { CHECK_LABEL, REFERENCE_LABEL, airWarning, reasonText } from '../../src/ui/labels';
import { fmtRef } from '../../src/ui/menu/Menu';
import { TRACK } from '../../src/shared/track';
import { readFileSync, readdirSync } from 'node:fs';

describe('result labels and GNC reasons', () => {
  it('every metric the game sends has a German label (no raw keys)', () => {
    const keys = new Set([...TRACK.sites.flatMap((s) => Object.keys(s.reference)), 'airUsedKg', 'durationS']);
    for (const k of keys) expect(REFERENCE_LABEL[k], k).toBeDefined();
    expect(REFERENCE_LABEL.airUsedKg.label).toBe('Luftverbrauch');
    expect(REFERENCE_LABEL.durationS.label).toBe('Dauer');
    expect(fmtRef('airUsedKg', 42.37, 'metric')).toEqual({ value: '42,4', unit: 'kg' });
    expect(fmtRef('durationS', 12.345, 'imperial')).toEqual({ value: '12', unit: 's' });
  });
  it('success reason "ok" is hidden', () => {
    expect(reasonText('ok')).toBeNull();
    expect(reasonText('OK ')).toBeNull();
    expect(reasonText('')).toBeNull();
    expect(reasonText(undefined)).toBeNull();
  });
  it('translates the GNC failure reasons', () => {
    expect(reasonText('crash')).toBe('Kollision');
    expect(reasonText('timeout')).toBe('Zeitüberschreitung');
    expect(reasonText('timeout in landing_burn')).toBe('Zeitüberschreitung in Phase LANDING BURN');
    expect(reasonText('lost the wall (car recovered)')).toBe('Wandkontakt verloren (Auto gerettet)');
    expect(reasonText('checks failed: touchdown g ≤ 2.5, full roll 360°')).toBe('Referenzwerte verfehlt: Aufsetzen ≤ 2,5 g · volle 360°-Drehung');
    expect(reasonText('checks failed: leaves the top at ≈ 19.5 m (±15 %), landed upright')).toBe('Referenzwerte verfehlt: Absprung oben bei ≈ 19,5 m (±15 %) · aufrecht gelandet');
    expect(reasonText('aborted: insufficient air')).toBe('Abgebrochen: zu wenig Druckluft');
    expect(reasonText('aborted: valve test failed (LIFT_FL, YAW_R)')).toBe('Abgebrochen: Ventiltest fehlgeschlagen (LIFT_FL, YAW_R)');
    expect(reasonText('insufficient air: 120 kg < 160 kg')).toBe('zu wenig Druckluft: 120 kg < 160 kg');
    expect(reasonText('rotation bailed at 62 %: too low (car recovered)')).toBe('Drehung bei 62 % abgebrochen: zu niedrig (Auto gerettet)');
  });
  it('unknown reasons stay unchanged', () => {
    expect(reasonText('something new from GNC')).toBe('something new from GNC');
    expect(reasonText('checks failed: brand new check')).toBe('Referenzwerte verfehlt: brand new check');
  });
  it('covers every check name the stunt evaluators use', () => {
    const dir = 'src/sim/stunts';
    const names = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      for (const m of readFileSync(`${dir}/${f}`, 'utf8').matchAll(/\{\s*name:\s*'([^']+)'/g)) names.add(m[1]);
    }
    expect(names.size).toBeGreaterThan(10);
    for (const n of names) expect(CHECK_LABEL[n], n).toBeDefined();
  });
  it('low-air warning from the ManualAssist phase label', () => {
    expect(airWarning('LUFT KNAPP')).toBe('low');
    expect(airWarning('Luft knapp')).toBe('low');
    expect(airWarning('AUTO-LANDUNG')).toBe('autoland');
    expect(airWarning('AUTO-LANDUNG · LUFT KNAPP')).toBe('autoland');
    expect(airWarning('HOVER')).toBeNull();
    expect(airWarning('')).toBeNull();
  });
});
