import { describe, expect, it } from 'vitest';
import { SETTINGS_KEY, SettingsStore, damageForSettings, defaultSettings, sanitizeSettings, type KeyValueStorage, type Settings } from '../../src/ui/settings';

class MemStore implements KeyValueStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
class ThrowingStore implements KeyValueStorage {
  getItem(): string | null { throw new Error('SecurityError'); }
  setItem(): void { throw new Error('QuotaExceeded'); }
  removeItem(): void { throw new Error('nope'); }
}

describe('settings persistence', () => {
  it('defaults when empty', () => {
    expect(new SettingsStore(new MemStore()).get()).toEqual(defaultSettings());
  });
  it('round-trips through storage', () => {
    const mem = new MemStore();
    const a = new SettingsStore(mem);
    a.update((d) => { d.units = 'metric'; d.graphics.quality = 'ultra'; d.audio.master = 0.3; });
    const b = new SettingsStore(mem);
    expect(b.get().units).toBe('metric');
    expect(b.get().graphics.quality).toBe('ultra');
    expect(b.get().audio.master).toBe(0.3);
  });
  it('rejects corrupt JSON and bad types/enums, clamps ranges, keeps the rest', () => {
    const mem = new MemStore();
    mem.setItem(SETTINGS_KEY, '{not json');
    expect(new SettingsStore(mem).get()).toEqual(defaultSettings());
    const s = sanitizeSettings({ units: 'furlongs', graphics: { quality: 'potato', motionBlur: false }, audio: { master: 7, crowd: 'loud' }, extra: 1, realism: { wind: true } });
    expect(s.units).toBe('imperial');
    expect(s.graphics.quality).toBe('high');
    expect(s.graphics.motionBlur).toBe(false);
    expect(s.audio.master).toBe(1);
    expect(s.audio.crowd).toBe(defaultSettings().audio.crowd);
    expect(s.realism.wind).toBe(true);
    expect((s as unknown as Record<string, unknown>).extra).toBeUndefined();
    expect(sanitizeSettings(null)).toEqual(defaultSettings());
    expect(sanitizeSettings({ audio: { master: NaN } }).audio.master).toBe(defaultSettings().audio.master);
  });
  it('never throws when storage is blocked; still works in memory', () => {
    const st = new SettingsStore(new ThrowingStore());
    expect(st.get()).toEqual(defaultSettings());
    st.update((d) => { d.units = 'metric'; });
    expect(st.get().units).toBe('metric');
    expect(new SettingsStore(null).get().units).toBe('imperial');
  });
  it('notifies listeners with a change hint', () => {
    const st = new SettingsStore(new MemStore());
    const seen: string[] = [];
    const off = st.onChange((_s, c) => seen.push(c));
    st.update((d) => { d.units = 'metric'; }, 'units');
    off();
    st.update((d) => { d.units = 'imperial'; }, 'units');
    expect(seen).toEqual(['units']);
  });
});

describe('vehicle damage follows the graphics preset unless chosen', () => {
  const withQ = (q: Settings['graphics']['quality'], damage: Settings['realism']['damage']): Settings => {
    const s = defaultSettings(); s.graphics.quality = q; s.realism.damage = damage; return s;
  };
  it('default is auto: Ultra → visual, every other preset → off; never Full', () => {
    expect(defaultSettings().realism.damage).toBe('auto');
    expect(damageForSettings(withQ('ultra', 'auto'))).toBe('visual');
    for (const q of ['low', 'medium', 'high'] as const) expect(damageForSettings(withQ(q, 'auto'))).toBe('off');
  });
  it('an explicit choice wins over the preset', () => {
    expect(damageForSettings(withQ('ultra', 'off'))).toBe('off');
    expect(damageForSettings(withQ('low', 'visual'))).toBe('visual');
    expect(damageForSettings(withQ('medium', 'realistic'))).toBe('realistic');
    expect(damageForSettings(withQ('ultra', 'realistic'))).toBe('realistic');
  });
  it('migration: the stored default "off" of version 1 becomes auto, chosen levels stay, version 2 keeps "off"', () => {
    expect(sanitizeSettings({ version: 1, realism: { damage: 'off' } }).realism.damage).toBe('auto');
    expect(sanitizeSettings({ version: 1, realism: { damage: 'visual' } }).realism.damage).toBe('visual');
    expect(sanitizeSettings({ version: 1, realism: { damage: 'realistic' } }).realism.damage).toBe('realistic');
    expect(sanitizeSettings({ version: 2, realism: { damage: 'off' } }).realism.damage).toBe('off');
    expect(sanitizeSettings({ version: 2, realism: { damage: 'bogus' } }).realism.damage).toBe('auto');
    expect(sanitizeSettings({ version: 1 }).version).toBe(2);
  });
});
