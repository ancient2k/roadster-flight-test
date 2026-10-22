// Editor texts: every language has every key, the same placeholders, no empty values.
import { describe, expect, it } from 'vitest';
import { LOCALE_CODES } from '../../src/i18n';
import { EDITOR_MESSAGES, et } from '../../src/editor/i18n';

const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('editor texts', () => {
  const en = EDITOR_MESSAGES.en;
  for (const code of LOCALE_CODES) {
    it(`${code}: complete`, () => {
      const m = EDITOR_MESSAGES[code];
      expect(Object.keys(m).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en) as (keyof typeof en)[]) {
        expect(m[k].trim(), `${code} ${k}`).not.toBe('');
        expect(ph(m[k]), `${code} ${k}`).toEqual(ph(en[k]));
      }
    });
  }
  it('fills placeholders', () => {
    expect(et('special.launch', { s: 60 })).toContain('60');
  });
});
