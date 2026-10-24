import { afterEach, describe, expect, it } from 'vitest';
import { LOCALE_CODES, MESSAGES, fmtNum, fmtPct, getLocale, matchLocale, resolveLocale, setLocale, t, tn, upper, type Msg } from '../../src/i18n';
import { en } from '../../src/i18n/locales/en';
import { defaultSettings, sanitizeSettings } from '../../src/ui/settings';

const placeholders = (m: Msg): string[] => {
  const forms = typeof m === 'string' ? [m] : Object.values(m).filter((x): x is string => typeof x === 'string');
  return [...new Set(forms.flatMap((f) => [...f.matchAll(/\{(\w+)\}/g)].map((x) => x[1])))].sort();
};
const forms = (m: Msg): string[] => (typeof m === 'string' ? [m] : Object.values(m).filter((x): x is string => typeof x === 'string'));

/** Values that legitimately stay the same in every language (names, symbols, units, stream captions). */
const SAME_EVERYWHERE = new Set<string>([
  'stunt.kickflip.title', 'stunt.zero60.title', 'ref.zeroToSixtyS', 'site.moon_tranquility.name', 'site.earth_stonehenge.name',
  'site.mars_valles.name', 'site.moon_tranquility.subtitle', 'units.metric', 'quality.ultra', 'aero.auto', 'aero.highDownforce',
  'stunts.stream', 'results.autopilot', 'hud.autopilot', 'hud.aero', 'flash.aero', 'worlds.cardAria', 'key.numpad', 'free.site.kickflip',
  'phase.kicker', 'assist.RAW', 'settings.wind', 'settings.tab.simulation', 'settings.tab.audio', 'pause.title', 'control.pause',
  'results.sim', 'orbit.state', 'sun.state', 'aero.lowDrag', 'fan.highspeed', 'body.mars', 'series.pitch', 'series.downforce',
  'check.pitch165', 'menu.worldsSub', 'geo.N', 'geo.S', 'geo.W', 'geo.E', 'pad.view', 'pad.menu', 'key.ControlLeft',
  // loanwords / same spelling in at least one language (checked by hand)
  'menu.menu', 'control.menu', 'bind.action', 'series.altitude', 'reason.crash', 'hud.collision', 'orbit.dir', 'common.no',
  'hud.manual', 'bind.padAria', 'settings.tab.graphics', 'control.slowMo', 'control.help', 'pad.dpad', 'ref.maxPitchDeg',
  'ref.maxDownforceKg', 'hud.autoland', 'phase.AUTOLAND', 'phase.land', 'phase.stop', 'sun.warpKeys',
  'key.ShiftLeft', 'key.Backspace', 'key.Enter', 'key.CapsLock', 'unit.au', 'settings.compressor', 'hud.compressor', 'hud.menu',
]);

describe('locale files', () => {
  it('ships the 14 languages', () => {
    expect(LOCALE_CODES).toEqual(['en', 'de', 'fr', 'es', 'it', 'pt-BR', 'nl', 'pl', 'ru', 'uk', 'tr', 'ja', 'ko', 'zh-Hans']);
    expect(Object.keys(en).length).toBeGreaterThan(300);
  });
  for (const code of LOCALE_CODES) {
    describe(code, () => {
      const m = MESSAGES[code];
      it('has exactly the keys of en.ts', () => {
        expect(Object.keys(m).sort()).toEqual(Object.keys(en).sort());
      });
      it('has no empty values and the same placeholders as en', () => {
        for (const k of Object.keys(en) as Array<keyof typeof en>) {
          for (const f of forms(m[k])) expect(f.trim(), `${code} ${k}`).not.toBe('');
          expect(placeholders(m[k]), `${code} ${k}`).toEqual(placeholders(en[k]));
        }
      });
      it('plural messages cover every CLDR category of the language', () => {
        const cats = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
        for (const k of Object.keys(en) as Array<keyof typeof en>) {
          const v = m[k];
          if (typeof en[k] === 'string') { expect(typeof v, `${code} ${k}`).toBe('string'); continue; }
          expect(typeof v, `${code} ${k}`).toBe('object');
          const p = v as unknown as Record<string, string | undefined>;
          for (const c of cats) expect(p[c], `${code} ${k} ${c}`).toBeTruthy();
        }
      });
      if (code !== 'en' && code !== 'de') {
        it('no forgotten translations (text that differs between en and de is not left in English)', () => {
          const missed: string[] = [];
          for (const k of Object.keys(en) as Array<keyof typeof en>) {
            if (SAME_EVERYWHERE.has(k)) continue;
            const e = JSON.stringify(en[k]), d = JSON.stringify(MESSAGES.de[k]);
            if (e !== d && JSON.stringify(m[k]) === e) missed.push(k);
          }
          expect(missed).toEqual([]);
        });
      }
    });
  }
});

describe('runtime', () => {
  afterEach(() => setLocale('en'));
  it('Node has no document: defaults to English regardless of the machine locale', () => {
    expect(resolveLocale('auto')).toBe('en');
    expect(resolveLocale('ja')).toBe('ja');
  });
  it('best match of browser preferences', () => {
    expect(matchLocale(['de-AT', 'en'])).toBe('de');
    expect(matchLocale(['pt-PT'])).toBe('pt-BR');
    expect(matchLocale(['zh-TW'])).toBe('zh-Hans');
    expect(matchLocale(['zh-Hans-CN'])).toBe('zh-Hans');
    expect(matchLocale(['ar', 'he', 'uk-UA'])).toBe('uk');
    expect(matchLocale(['ar'])).toBe('en');
    expect(matchLocale([])).toBe('en');
    expect(matchLocale(['nb', 'fr_CA'])).toBe('fr');
  });
  it('interpolation, plurals and fallback', () => {
    expect(t('stunts.best', { value: '0.84 s' })).toBe('Best 0.84 s');
    expect(tn('unit.days', 1, { n: '1' })).toBe('1 day');
    expect(tn('unit.days', 557.7, { n: '557.70' })).toBe('557.70 days');
    setLocale('ru');
    expect(getLocale()).toBe('ru');
    expect(tn('unit.days', 2)).toMatch(/^2 /);
    expect(tn('unit.days', 5)).not.toBe(tn('unit.days', 2));
  });
  it('numbers follow the locale', () => {
    expect(fmtNum(1234.5, 1)).toBe('1,234.5');
    setLocale('de');
    expect(fmtNum(1234.5, 1)).toBe('1.234,5');
    expect(fmtPct(0.42)).toBe('42 %');
    setLocale('fr');
    expect(fmtNum(0.5, 2)).toBe('0,50');
    expect(fmtNum(NaN)).toBe('–');
  });
  it('Turkish upper case keeps the dotted İ', () => {
    expect(upper('pitch', 'tr')).toBe('PİTCH');
    expect(upper('pitch', 'en')).toBe('PITCH');
  });
  it('language setting is persisted and validated', () => {
    expect(defaultSettings().language).toBe('auto');
    expect(sanitizeSettings({ language: 'ko' }).language).toBe('ko');
    expect(sanitizeSettings({ language: 'xx' }).language).toBe('auto');
  });
});
