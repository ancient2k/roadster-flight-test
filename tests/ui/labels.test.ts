import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_KEY, CHECK_LABEL, REFERENCE_LABEL, STUNTS, airWarning, phaseLabel, reasonText } from '../../src/ui/labels';
import { fmtRef } from '../../src/ui/menu/Menu';
import { TRACK } from '../../src/shared/track';
import { setLocale, tMaybe } from '../../src/i18n';
import { readFileSync, readdirSync } from 'node:fs';

describe('result labels and GNC reasons (English source)', () => {
  it('every metric the game sends has a label (no raw keys)', () => {
    const keys = new Set([...TRACK.sites.flatMap((s) => Object.keys(s.reference)), 'airUsedKg', 'durationS']);
    for (const k of keys) expect(REFERENCE_LABEL[k], k).toBeDefined();
    expect(REFERENCE_LABEL.airUsedKg.label).toBe('Air used');
    expect(REFERENCE_LABEL.durationS.label).toBe('Duration');
    expect(fmtRef('airUsedKg', 42.37, 'metric')).toEqual({ value: '42.4', unit: 'kg' });
    expect(fmtRef('maxDownforceKg', 4712.4, 'metric')).toEqual({ value: '4,712', unit: 'kg' });
    expect(fmtRef('durationS', 12.345, 'imperial')).toEqual({ value: '12', unit: 's' });
  });
  it('success reason "ok" is hidden', () => {
    expect(reasonText('ok')).toBeNull();
    expect(reasonText('OK ')).toBeNull();
    expect(reasonText('')).toBeNull();
    expect(reasonText(undefined)).toBeNull();
  });
  it('translates the GNC failure reasons', () => {
    expect(reasonText('crash')).toBe('Collision');
    expect(reasonText('timeout')).toBe('Timeout');
    expect(reasonText('timeout in landing_burn')).toBe('Timeout in phase LANDING BURN');
    expect(reasonText('timeout in climb')).toBe('Timeout in phase CLIMB');
    expect(reasonText('lost the wall (car recovered)')).toBe('Lost contact with the wall (car recovered)');
    expect(reasonText('checks failed: touchdown g ≤ 2.5, full roll 360°')).toBe('Reference values missed: Touchdown ≤ 2.5 g · full 360° roll');
    expect(reasonText('aborted: insufficient air')).toBe('Aborted: not enough compressed air');
    expect(reasonText('aborted: valve test failed (LIFT_FL, YAW_R)')).toBe('Aborted: valve test failed (LIFT_FL, YAW_R)');
    expect(reasonText('rotation bailed at 62 %: too low (car recovered)')).toBe('Rotation aborted at 62 %: too low (car recovered)');
  });
  it('unknown reasons stay unchanged', () => {
    expect(reasonText('something new from GNC')).toBe('something new from GNC');
    expect(reasonText('checks failed: brand new check')).toBe('Reference values missed: brand new check');
  });
  it('covers every check name the stunt evaluators use', () => {
    const dir = 'src/sim/stunts';
    const names = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      for (const m of readFileSync(`${dir}/${f}`, 'utf8').matchAll(/\{\s*name:\s*'([^']+)'/g)) names.add(m[1]);
    }
    expect(names.size).toBeGreaterThan(10);
    for (const n of names) { expect(CHECK_KEY[n], n).toBeDefined(); expect(CHECK_LABEL[n], n).toBeTruthy(); }
  });
  it('every stunt phase id the evaluators can enter has a HUD label', () => {
    const ids = new Set<string>();
    for (const f of readdirSync('src/sim/stunts').filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(`src/sim/stunts/${f}`, 'utf8');
      for (const m of src.matchAll(/^\s{4,6}([a-z_0-9]+): \{/gm)) ids.add(m[1]);
    }
    for (const id of ['spool', 'approach', 'climb', 'hold', 'done', 'precheck', 'rescue']) expect(ids.has(id), id).toBe(true);
    // phases built by helpers (rotatePhase/landingPhase names) plus the ManualAssist ids
    for (const id of ['half_flip', 'roll', 'land', 'liftoff', 'LOW_AIR', 'AUTOLAND', 'ROTATE']) ids.add(id);
    for (const id of ids) expect(tMaybe(`phase.${id}`), id).not.toBeNull();
    expect(phaseLabel('half_flip')).toBe('HALF FLIP');
    expect(phaseLabel('LOW_AIR')).toBe('LOW AIR');
    expect(phaseLabel('brand_new')).toBe('BRAND NEW');
  });
  it('low-air warning from the ManualAssist phase id', () => {
    expect(airWarning('LOW_AIR')).toBe('low');
    expect(airWarning('low_air')).toBe('low');
    expect(airWarning('AUTOLAND')).toBe('autoland');
    expect(airWarning('HOVER')).toBeNull();
    expect(airWarning('')).toBeNull();
  });
});

describe('German (the original UI texts)', () => {
  beforeAll(() => setLocale('de'));
  afterAll(() => setLocale('en'));
  it('labels, numbers and reasons in German', () => {
    expect(REFERENCE_LABEL.airUsedKg.label).toBe('Luftverbrauch');
    expect(fmtRef('airUsedKg', 42.37, 'metric')).toEqual({ value: '42,4', unit: 'kg' });
    expect(STUNTS[0].title).toBe('Kopfüber-Rampe');
    expect(reasonText('crash')).toBe('Kollision');
    expect(reasonText('timeout in climb')).toBe('Zeitüberschreitung in Phase AUFFAHRT');
    expect(reasonText('lost the wall (car recovered)')).toBe('Wandkontakt verloren (Auto gerettet)');
    expect(reasonText('checks failed: touchdown g ≤ 2.5, full roll 360°')).toBe('Referenzwerte verfehlt: Aufsetzen ≤ 2,5 g · volle 360°-Drehung');
    expect(reasonText('checks failed: leaves the top at ≈ 20.7 m (±15 %), landed upright')).toBe('Referenzwerte verfehlt: Absprung oben bei ≈ 20,7 m (±15 %) · aufrecht gelandet');
    expect(reasonText('aborted: valve test failed (LIFT_FL, YAW_R)')).toBe('Abgebrochen: Ventiltest fehlgeschlagen (LIFT_FL, YAW_R)');
    expect(reasonText('insufficient air: 120 kg < 160 kg')).toBe('zu wenig Druckluft: 120 kg < 160 kg');
    expect(reasonText('rotation bailed at 62 %: too low (car recovered)')).toBe('Drehung bei 62 % abgebrochen: zu niedrig (Auto gerettet)');
    expect(phaseLabel('LOW_AIR')).toBe('LUFT KNAPP');
  });
});
