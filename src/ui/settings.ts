// Typed user settings with versioned, defensive persistence. DOM-free: storage is injected
// (window.localStorage in the app, an in-memory map in tests). Every access is try/catch'd
// because storage can be missing, full or blocked (private mode, sandboxed iframes).
import type { AssistLevel } from '../shared/types';
import type { Units } from './units';
import { LOCALE_CODES, type LanguageSetting } from '../i18n';
import { DAMAGE_MODES, type DamageMode } from '../shared/damage';
import { HANDLING_MODES, type HandlingMode } from '../shared/handling';

export type GraphicsQuality = 'low' | 'medium' | 'high' | 'ultra';
export type RefillRate = 'realistic' | 'game';

export interface Settings {
  version: 1;
  graphics: { quality: GraphicsQuality; dynamicResolution: boolean; motionBlur: boolean };
  units: Units;
  /** UI language; 'auto' follows navigator.languages (?lang= overrides both). */
  language: LanguageSetting;
  audio: { master: number; effects: number; crowd: number; muted: boolean };
  refillRate: RefillRate;
  realism: {
    infiniteAir: boolean;     // tank never empties (gameplay)
    sensorNoise: boolean;     // GNC sees noisy state estimate
    valveDelays: boolean;     // model valve opening/closing delay + min on-time
    wind: boolean;            // gusts over the pad
    /** Vehicle damage: 'off' = a hard body impact is a collision (previous behaviour), 'realistic' = damage model. */
    damage: DamageMode;
    /** Driving physics in free play: 'fun' (default) adds game helpers on crashes, 'realistic' is the plain model. */
    handling: HandlingMode;
  };
  assistDefault: AssistLevel;
  controls: {
    invertPitch: boolean; mouseAttitude: boolean; mouseSensitivity: number; stickDeadzone: number; triggerDeadzone: number;
    /** Tilt steering with the motion sensor (phones): pitch/roll of the attitude stick. Off by default. */
    gyro: boolean; gyroSensitivity: number;
  };
  hud: { visible: boolean; scale: number; showExtras: boolean };
}

export const SETTINGS_KEY = 'rft.settings.v1';

export function defaultSettings(): Settings {
  return {
    version: 1,
    graphics: { quality: 'high', dynamicResolution: true, motionBlur: true },
    units: 'imperial',
    language: 'auto',
    audio: { master: 0.8, effects: 1, crowd: 0.7, muted: false },
    refillRate: 'game',
    realism: { infiniteAir: false, sensorNoise: false, valveDelays: true, wind: false, damage: 'off', handling: 'fun' },
    assistDefault: 'ASSIST',
    controls: { invertPitch: false, mouseAttitude: false, mouseSensitivity: 1, stickDeadzone: 0.15, triggerDeadzone: 0.05, gyro: false, gyroSensitivity: 1 },
    hud: { visible: true, scale: 1, showExtras: true },
  };
}

export interface KeyValueStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** localStorage if reachable, otherwise null (never throws). */
export function browserStorage(): KeyValueStorage | null {
  try {
    const s = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    if (!s) return null;
    const probe = '__rft_probe__';
    s.setItem(probe, '1'); s.removeItem(probe);
    return s;
  } catch { return null; }
}

type Plain = Record<string, unknown>;
const isObj = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Deep-merge `src` over `base`, accepting only keys that exist in `base` with the same primitive
 * type (and, for strings, one of `allowed` when an enum list is registered). Unknown/invalid input is dropped.
 */
function mergeTyped(base: Plain, src: unknown, path: string, enums: Record<string, readonly string[]>): Plain {
  const out: Plain = {};
  for (const k of Object.keys(base)) {
    const b = base[k];
    const v = isObj(src) ? src[k] : undefined;
    const p = path ? `${path}.${k}` : k;
    if (isObj(b)) { out[k] = mergeTyped(b, v, p, enums); continue; }
    if (typeof v === typeof b && v !== undefined) {
      if (typeof v === 'number' && !Number.isFinite(v)) { out[k] = b; continue; }
      if (typeof v === 'string' && enums[p] && !enums[p].includes(v)) { out[k] = b; continue; }
      out[k] = v;
    } else out[k] = b;
  }
  return out;
}

const ENUMS: Record<string, readonly string[]> = {
  'graphics.quality': ['low', 'medium', 'high', 'ultra'],
  units: ['imperial', 'metric'],
  language: ['auto', ...LOCALE_CODES],
  refillRate: ['realistic', 'game'],
  assistDefault: ['ASSIST', 'STABILIZED', 'RAW'],
  'realism.damage': DAMAGE_MODES,
  'realism.handling': HANDLING_MODES,
};

const RANGES: Array<[string[], number, number]> = [
  [['audio', 'master'], 0, 1], [['audio', 'effects'], 0, 1], [['audio', 'crowd'], 0, 1],
  [['controls', 'mouseSensitivity'], 0.1, 5], [['controls', 'stickDeadzone'], 0, 0.6],
  [['controls', 'triggerDeadzone'], 0, 0.5], [['controls', 'gyroSensitivity'], 0.3, 3], [['hud', 'scale'], 0.5, 2],
];

/** Validate arbitrary (parsed) data into a complete Settings object. */
export function sanitizeSettings(raw: unknown): Settings {
  const s = mergeTyped(defaultSettings() as unknown as Plain, raw, '', ENUMS) as unknown as Settings;
  s.version = 1;
  for (const [[a, b], lo, hi] of RANGES) {
    const o = (s as unknown as Record<string, Record<string, number>>)[a];
    o[b] = Math.min(hi, Math.max(lo, o[b]));
  }
  return s;
}

type Listener = (s: Readonly<Settings>, changed: string) => void;

export class SettingsStore {
  private data: Settings;
  private listeners = new Set<Listener>();

  constructor(private storage: KeyValueStorage | null = browserStorage(), private key = SETTINGS_KEY) {
    this.data = this.load();
  }

  get(): Readonly<Settings> { return this.data; }

  /** Apply a mutation, sanitize, persist, notify. `changed` is a dotted path hint for listeners. */
  update(mutate: (draft: Settings) => void, changed = '*'): Readonly<Settings> {
    const draft = structuredClone(this.data);
    mutate(draft);
    this.data = sanitizeSettings(draft);
    this.save();
    for (const l of this.listeners) l(this.data, changed);
    return this.data;
  }

  reset(): void { this.update((d) => Object.assign(d, defaultSettings()), '*'); }

  onChange(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }

  private load(): Settings {
    if (!this.storage) return defaultSettings();
    try {
      const txt = this.storage.getItem(this.key);
      return txt ? sanitizeSettings(JSON.parse(txt)) : defaultSettings();
    } catch { return defaultSettings(); }
  }

  private save(): void {
    if (!this.storage) return;
    try { this.storage.setItem(this.key, JSON.stringify(this.data)); } catch { /* quota / blocked: keep in memory */ }
  }
}
