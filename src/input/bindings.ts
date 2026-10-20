// Default control layout, localised labels and persistence of user rebinding.
import type { KeyValueStorage } from '../ui/settings';
import { getLocale, t, type MsgKey } from '../i18n';
import { CONTROL_IDS, type Binding, type Bindings, type ControlId, type PadBinding } from './types';

const b = (index: number): PadBinding => ({ type: 'button', index });
const ax = (index: number, dir: 1 | -1): PadBinding => ({ type: 'axis', index, dir });

/** Standard Gamepad mapping indices (https://w3c.github.io/gamepad/#remapping). */
export const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16,
  LX: 0, LY: 1, RX: 2, RY: 3,
} as const;

export function defaultBindings(): Bindings {
  return {
    throttle: { keys: ['KeyW', 'ArrowUp'], pad: [b(PAD.RT)] },
    brake: { keys: ['KeyS', 'ArrowDown'], pad: [b(PAD.LT)] },
    steerLeft: { keys: ['KeyA', 'ArrowLeft'], pad: [ax(PAD.LX, -1)] },
    steerRight: { keys: ['KeyD', 'ArrowRight'], pad: [ax(PAD.LX, 1)] },
    handbrake: { keys: ['KeyX'], pad: [b(PAD.B)] },
    launchMode: { keys: ['KeyB'], pad: [b(PAD.LS)] },
    lift: { keys: ['Space'], pad: [b(PAD.A)] },
    liftDown: { keys: ['ControlLeft'], pad: [] },
    boost: { keys: ['ShiftLeft', 'ShiftRight'], pad: [b(PAD.X)] },
    pitchUp: { keys: ['KeyK', 'Numpad5'], pad: [ax(PAD.RY, 1)] },   // stick back = nose up (flight convention)
    pitchDown: { keys: ['KeyI', 'Numpad8'], pad: [ax(PAD.RY, -1)] },
    rollLeft: { keys: ['KeyQ'], pad: [b(PAD.LB)] },
    rollRight: { keys: ['KeyE'], pad: [b(PAD.RB)] },
    yawLeft: { keys: ['KeyJ', 'Numpad4'], pad: [ax(PAD.RX, -1)] },
    yawRight: { keys: ['KeyL', 'Numpad6'], pad: [ax(PAD.RX, 1)] },
    fanModeCycle: { keys: ['KeyF'], pad: [b(PAD.UP)] },
    aeroModeCycle: { keys: ['KeyV'], pad: [b(PAD.DOWN)] },
    refillToggle: { keys: ['KeyR'], pad: [b(PAD.RIGHT)] },
    assistCycle: { keys: ['KeyN'], pad: [b(PAD.LEFT)] },
    cameraCycle: { keys: ['KeyC'], pad: [b(PAD.Y)] },
    pause: { keys: ['KeyP'], pad: [b(PAD.START)] },
    reset: { keys: ['Backspace'], pad: [b(PAD.BACK)] },
    slowMo: { keys: ['KeyT'], pad: [b(PAD.RS)] },
    photoMode: { keys: ['F2'], pad: [] },
    menu: { keys: ['Escape'], pad: [] },
    help: { keys: ['F1', 'KeyH'], pad: [] },
    reverseToggle: { keys: ['KeyG'], pad: [] },
  };
}

export type ControlGroup = 'drive' | 'thrusters' | 'systems' | 'game';
/** label is translated on read (control.<id>); group is an id (controls.group.<id> for display). */
export interface ControlMeta { readonly label: string; group: ControlGroup }

const GROUP: Record<ControlId, ControlGroup> = {
  throttle: 'drive',
  brake: 'drive',
  steerLeft: 'drive',
  steerRight: 'drive',
  handbrake: 'drive',
  launchMode: 'drive',
  reverseToggle: 'drive',
  lift: 'thrusters',
  liftDown: 'thrusters',
  boost: 'thrusters',
  pitchUp: 'thrusters',
  pitchDown: 'thrusters',
  rollLeft: 'thrusters',
  rollRight: 'thrusters',
  yawLeft: 'thrusters',
  yawRight: 'thrusters',
  fanModeCycle: 'systems',
  aeroModeCycle: 'systems',
  refillToggle: 'systems',
  assistCycle: 'systems',
  cameraCycle: 'game',
  pause: 'game',
  reset: 'game',
  slowMo: 'game',
  photoMode: 'game',
  menu: 'game',
  help: 'game',
};

export const CONTROL_META: Record<ControlId, ControlMeta> = Object.fromEntries(
  (Object.keys(GROUP) as ControlId[]).map((id) => [id, { group: GROUP[id], get label() { return t(`control.${id}`); } }]),
) as Record<ControlId, ControlMeta>;

export const groupLabel = (g: ControlGroup): string => t(`controls.group.${g}`);

export const BINDINGS_KEY = 'rft.bindings.v1';

const MAX_PAD_INDEX = 32;
function validPad(p: unknown): p is PadBinding {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  const idxOk = typeof o.index === 'number' && Number.isInteger(o.index) && o.index >= 0 && o.index < MAX_PAD_INDEX;
  if (o.type === 'button') return idxOk;
  if (o.type === 'axis') return idxOk && (o.dir === 1 || o.dir === -1);
  return false;
}

/** Merge persisted bindings over the defaults; anything malformed falls back to the default for that control. */
export function sanitizeBindings(raw: unknown): Bindings {
  const def = defaultBindings();
  if (typeof raw !== 'object' || raw === null) return def;
  const src = raw as Record<string, unknown>;
  for (const id of CONTROL_IDS) {
    const v = src[id] as Partial<Binding> | undefined;
    if (!v || typeof v !== 'object') continue;
    const keys = Array.isArray(v.keys) ? v.keys.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length < 40).slice(0, 4) : def[id].keys;
    const pad = Array.isArray(v.pad) ? v.pad.filter(validPad).slice(0, 4) : def[id].pad;
    def[id] = { keys, pad };
  }
  return def;
}

export function loadBindings(storage: KeyValueStorage | null): Bindings {
  if (!storage) return defaultBindings();
  try {
    const t = storage.getItem(BINDINGS_KEY);
    return t ? sanitizeBindings(JSON.parse(t)) : defaultBindings();
  } catch { return defaultBindings(); }
}

export function saveBindings(storage: KeyValueStorage | null, bindings: Bindings): void {
  if (!storage) return;
  try { storage.setItem(BINDINGS_KEY, JSON.stringify(bindings)); } catch { /* ignore */ }
}

/**
 * Assign a key to a control. A key may only drive one control: it is removed from every other
 * control first (returns the ids it was taken from, so the UI can warn).
 */
export function assignKey(bindings: Bindings, id: ControlId, code: string, slot = 0): ControlId[] {
  const stolen: ControlId[] = [];
  for (const other of CONTROL_IDS) {
    if (other === id) continue;
    const i = bindings[other].keys.indexOf(code);
    if (i >= 0) { bindings[other].keys.splice(i, 1); stolen.push(other); }
  }
  const keys = bindings[id].keys.filter((k) => k !== code);
  keys.splice(Math.min(slot, keys.length), slot < keys.length ? 1 : 0, code);
  bindings[id].keys = keys.slice(0, 4);
  return stolen;
}

export const padEq = (a: PadBinding, c: PadBinding): boolean =>
  a.type === c.type && a.index === c.index && (a.type === 'button' || (c.type === 'axis' && a.dir === c.dir));

export function assignPad(bindings: Bindings, id: ControlId, p: PadBinding, slot = 0): ControlId[] {
  const stolen: ControlId[] = [];
  for (const other of CONTROL_IDS) {
    if (other === id) continue;
    const before = bindings[other].pad.length;
    bindings[other].pad = bindings[other].pad.filter((q) => !padEq(q, p));
    if (bindings[other].pad.length !== before) stolen.push(other);
  }
  const pads = bindings[id].pad.filter((q) => !padEq(q, p));
  pads.splice(Math.min(slot, pads.length), slot < pads.length ? 1 : 0, p);
  bindings[id].pad = pads.slice(0, 4);
  return stolen;
}

// ------------------------------------------------------------------ labels
/** Named keys with a translated label (key.<code>). */
const KEY_KEYS: Partial<Record<string, MsgKey>> = {
  Space: 'key.Space', ShiftLeft: 'key.ShiftLeft', ShiftRight: 'key.ShiftRight', ControlLeft: 'key.ControlLeft', ControlRight: 'key.ControlRight',
  AltRight: 'key.AltRight', Backspace: 'key.Backspace', Enter: 'key.Enter', CapsLock: 'key.CapsLock',
};
const KEY_FIXED: Record<string, string> = {
  AltLeft: 'Alt', Escape: 'Esc', Tab: 'Tab', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};
/** Printed punctuation keys without a layout map: German layout when the UI is German, otherwise US. */
const PUNCT_DE: Record<string, string> = {
  Minus: 'ß', Equal: '´', BracketLeft: 'Ü', BracketRight: '+', Semicolon: 'Ö', Quote: 'Ä', Backquote: '^',
  Backslash: '#', Comma: ',', Period: '.', Slash: '-', IntlBackslash: '<',
};
const PUNCT_US: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`',
  Backslash: '\\', Comma: ',', Period: '.', Slash: '/', IntlBackslash: '<',
};

/**
 * Human label for a KeyboardEvent.code. `layoutMap` (navigator.keyboard.getLayoutMap(), Chromium) gives the
 * real printed key for the user's layout (e.g. KeyZ -> "Y" on German keyboards).
 */
export function keyLabel(code: string, layoutMap?: ReadonlyMap<string, string> | null): string {
  const fromLayout = layoutMap?.get(code);
  if (fromLayout && fromLayout.trim()) return fromLayout.toUpperCase();
  const named = KEY_KEYS[code];
  if (named) return t(named);
  if (KEY_FIXED[code]) return KEY_FIXED[code];
  const punct = (getLocale() === 'de' ? PUNCT_DE : PUNCT_US)[code];
  if (punct) return punct;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return t('key.numpad', { n: code.slice(6) });
  return code;
}

const PAD_BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', null, null, 'L3', 'R3', null, null, null, null, 'Home'];
const PAD_BUTTON_KEYS: Partial<Record<number, () => string>> = {
  8: () => t('pad.view'), 9: () => t('pad.menu'),
  12: () => t('pad.dpad', { dir: '↑' }), 13: () => t('pad.dpad', { dir: '↓' }), 14: () => t('pad.dpad', { dir: '←' }), 15: () => t('pad.dpad', { dir: '→' }),
};

export function padLabel(p: PadBinding): string {
  if (p.type === 'button') return PAD_BUTTON_NAMES[p.index] ?? PAD_BUTTON_KEYS[p.index]?.() ?? t('pad.button', { n: p.index });
  const base = p.index === 0 || p.index === 1 ? t('pad.leftStick') : p.index === 2 || p.index === 3 ? t('pad.rightStick') : t('pad.axis', { n: p.index });
  const horiz = p.index % 2 === 0;
  return `${base} ${horiz ? (p.dir > 0 ? '→' : '←') : (p.dir > 0 ? '↓' : '↑')}`;
}
