import { describe, expect, it } from 'vitest';
import { InputMapper, NAV_REPEAT, radialDeadzone, linearDeadzone, slew } from '../../src/input/mapping';
import { assignKey, assignPad, defaultBindings, keyLabel, loadBindings, padLabel, sanitizeBindings, saveBindings, BINDINGS_KEY, CONTROL_META, PAD } from '../../src/input/bindings';
import { CONTROL_IDS, type RawInput } from '../../src/input/types';
import type { KeyValueStorage } from '../../src/ui/settings';
import { setLocale } from '../../src/i18n';

const raw = (keys: string[] = [], pad: RawInput['pad'] = null): RawInput => ({ keys: new Set(keys), mouse: { dx: 0, dy: 0, rightHeld: false }, pad });
const padState = (buttons: Record<number, number> = {}, axes: number[] = [0, 0, 0, 0]): NonNullable<RawInput['pad']> => {
  const b = new Array(17).fill(0); for (const [i, v] of Object.entries(buttons)) b[+i] = v; return { buttons: b, axes };
};
const run = (m: InputMapper, r: RawInput, seconds: number, dt = 1 / 60) => { let out = m.map(r, dt); for (let t = dt; t < seconds; t += dt) out = m.map(r, dt); return out; };

describe('deadzones & filters', () => {
  it('radial deadzone rescales to full range and keeps direction', () => {
    expect(radialDeadzone(0.1, 0.05, 0.15)).toEqual([0, 0]);
    const [x, y] = radialDeadzone(1, 0, 0.15);
    expect(x).toBeCloseTo(1, 9); expect(y).toBe(0);
    const [a, b] = radialDeadzone(0.6, 0.6, 0.15); // beyond unit circle -> clamped to 1
    expect(Math.hypot(a, b)).toBeCloseTo(0.8485 > 1 ? 1 : (0.8485 - 0.15) / 0.85, 3);
    expect(a).toBeCloseTo(b, 9);
  });
  it('linear trigger deadzone', () => {
    expect(linearDeadzone(0.04, 0.05)).toBe(0);
    expect(linearDeadzone(1, 0.05)).toBe(1);
    expect(linearDeadzone(0.525, 0.05)).toBeCloseTo(0.5, 9);
  });
  it('slew rises and returns with different times', () => {
    let v = 0; for (let i = 0; i < 6; i++) v = slew(v, 1, 1 / 60, 0.2, 0.05);
    expect(v).toBeCloseTo(0.5, 6);
    for (let i = 0; i < 3; i++) v = slew(v, 0, 1 / 60, 0.2, 0.05);
    expect(v).toBe(0);
  });
});

describe('InputMapper keyboard', () => {
  it('WASD drives with smooth ramps', () => {
    const m = new InputMapper(defaultBindings());
    const first = m.map(raw(['KeyW', 'KeyD']), 1 / 60);
    expect(first.drive.throttle).toBeGreaterThan(0);
    expect(first.drive.throttle).toBeLessThan(0.5);
    const later = run(m, raw(['KeyW', 'KeyD']), 0.5);
    expect(later.drive.throttle).toBe(1);
    expect(later.drive.steer).toBe(1);
    const arrows = run(new InputMapper(defaultBindings()), raw(['ArrowUp', 'ArrowLeft']), 0.5);
    expect(arrows.drive.throttle).toBe(1);
    expect(arrows.drive.steer).toBe(-1);
  });
  it('thrust keys map to the documented signs', () => {
    const out = run(new InputMapper(defaultBindings()), raw(['Space', 'ShiftLeft', 'KeyK', 'KeyE', 'KeyL']), 0.5);
    expect(out.thrust).toEqual({ lift: 1, boost: 1, pitch: 1, roll: 1, yaw: 1 });
    const inv = new InputMapper(defaultBindings(), { stickDeadzone: 0.15, triggerDeadzone: 0.05, invertPitch: true, mouseAttitude: false, mouseSensitivity: 1 });
    expect(run(inv, raw(['KeyK']), 0.5).thrust.pitch).toBe(-1);
    expect(run(new InputMapper(defaultBindings()), raw(['KeyQ', 'KeyI', 'KeyJ']), 0.5).thrust).toMatchObject({ pitch: -1, roll: -1, yaw: -1 });
  });
  it('actions are edge-triggered', () => {
    const m = new InputMapper(defaultBindings());
    expect(m.map(raw(['KeyF']), 1 / 60).pressed.fanModeCycle).toBe(true);
    expect(m.map(raw(['KeyF']), 1 / 60).pressed.fanModeCycle).toBe(false);
    expect(m.map(raw([]), 1 / 60).pressed.fanModeCycle).toBe(false);
    expect(m.map(raw(['KeyF']), 1 / 60).pressed.fanModeCycle).toBe(true);
  });
  it('context switch: a key still held (Esc that closed the menu) gives no new edge and no analog input', () => {
    const m = new InputMapper(defaultBindings());
    expect(m.map(raw(['Escape']), 1 / 60).pressed.menu).toBe(true);
    m.prime(raw(['Escape', 'Space']));
    const held = m.map(raw(['Escape', 'Space']), 1 / 60);
    expect(held.pressed.menu).toBe(false);
    expect(held.thrust.lift).toBe(0);
    expect(m.map(raw(['Escape', 'Space']), 0.5).thrust.lift).toBe(0);
    m.map(raw([]), 1 / 60);                       // released
    expect(m.map(raw(['Escape']), 1 / 60).pressed.menu).toBe(true);
    expect(run(m, raw(['Space']), 0.3).thrust.lift).toBe(1);
  });
  it('context switch with gamepad A held (confirm) does not fire lift', () => {
    const m = new InputMapper(defaultBindings());
    const a = padState({ [PAD.A]: 1 });
    m.prime(raw([], a));
    expect(m.map(raw([], a), 1 / 60).thrust.lift).toBe(0);
    expect(m.map(raw([], a), 1 / 60).menuNav.confirm).toBe(false);
    m.map(raw([], padState()), 1 / 60);
    expect(m.map(raw([], a), 1 / 60).thrust.lift).toBe(1);
  });
  it('reverse toggles, launch mode and handbrake are held', () => {
    const m = new InputMapper(defaultBindings());
    expect(m.map(raw(['KeyG']), 1 / 60).drive.reverse).toBe(true);
    expect(m.map(raw([]), 1 / 60).drive.reverse).toBe(true);
    expect(m.map(raw(['KeyG']), 1 / 60).drive.reverse).toBe(false);
    const o = m.map(raw(['KeyB', 'KeyX']), 1 / 60);
    expect(o.drive.launchMode).toBe(true);
    expect(o.drive.handbrake).toBe(true);
  });
  it('huge dt is clamped (tab switch) and NaN-free', () => {
    const o = new InputMapper(defaultBindings()).map(raw(['KeyW']), 10);
    expect(o.drive.throttle).toBe(1);
    expect(Number.isFinite(o.drive.steer)).toBe(true);
  });
});

describe('InputMapper gamepad (standard mapping)', () => {
  it('triggers, sticks, bumpers', () => {
    const m = new InputMapper(defaultBindings());
    const o = m.map(raw([], padState({ [PAD.RT]: 1, [PAD.LT]: 0.03, [PAD.RB]: 1, [PAD.A]: 1 }, [-1, 0, 0, 1])), 1 / 60);
    expect(o.drive.throttle).toBe(1);
    expect(o.drive.brake).toBe(0);         // inside trigger deadzone
    expect(o.drive.steer).toBeCloseTo(-1, 6);
    expect(o.thrust.roll).toBe(1);
    expect(o.thrust.pitch).toBeCloseTo(1, 6); // stick pulled back = nose up
    expect(o.thrust.lift).toBe(1);
    expect(o.lastDevice).toBe('gamepad');
    expect(o.gamepadConnected).toBe(true);
  });
  it('stick noise inside the deadzone produces no output', () => {
    const o = new InputMapper(defaultBindings()).map(raw([], padState({}, [0.1, -0.08, 0.12, 0.05])), 1 / 60);
    expect(o.drive.steer).toBe(0);
    expect(o.thrust.yaw).toBe(0);
    expect(o.thrust.pitch).toBe(0);
  });
  it('stronger source wins when keyboard and pad are mixed', () => {
    const o = run(new InputMapper(defaultBindings()), raw(['KeyA'], padState({}, [0.5, 0, 0, 0])), 0.5);
    expect(o.drive.steer).toBe(-1);
  });
  it('menu navigation with auto-repeat', () => {
    const m = new InputMapper(defaultBindings());
    const down = padState({ [PAD.DOWN]: 1 });
    let count = 0;
    const dt = 1 / 60;
    for (let t = 0; t < 1.0; t += dt) if (m.map(raw([], down), dt).menuNav.down) count++;
    const expected = 1 + Math.floor((1.0 - NAV_REPEAT.delay) / NAV_REPEAT.rate) + 1;
    expect(count).toBeGreaterThanOrEqual(expected - 1);
    expect(count).toBeLessThanOrEqual(expected + 1);
    expect(m.map(raw([], padState({ [PAD.A]: 1 })), dt).menuNav.confirm).toBe(true);
    expect(m.map(raw([], padState({ [PAD.A]: 1 })), dt).menuNav.confirm).toBe(false);
  });
});

describe('bindings', () => {
  it('every control has a default and no key drives two controls', () => {
    const b = defaultBindings();
    const seen = new Map<string, string>();
    for (const id of CONTROL_IDS) {
      expect(b[id]).toBeDefined();
      for (const k of b[id].keys) { expect(seen.has(k), `${k} used by ${seen.get(k)} and ${id}`).toBe(false); seen.set(k, id); }
    }
  });
  it('rebinding steals the key from the previous owner', () => {
    const b = defaultBindings();
    const stolen = assignKey(b, 'lift', 'KeyW');
    expect(stolen).toEqual(['throttle']);
    expect(b.lift.keys[0]).toBe('KeyW');
    expect(b.throttle.keys).toEqual(['ArrowUp']);
    const m = new InputMapper(b);
    expect(run(m, raw(['KeyW']), 0.3).thrust.lift).toBe(1);
    expect(run(m, raw(['KeyW']), 0.3).drive.throttle).toBe(0);
    const s2 = assignPad(b, 'boost', { type: 'button', index: PAD.A });
    expect(s2).toEqual(['lift']);
  });
  it('persists and sanitizes', () => {
    const mem = new Map<string, string>();
    const st: KeyValueStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
    const b = defaultBindings(); assignKey(b, 'help', 'KeyU');
    saveBindings(st, b);
    expect(loadBindings(st).help.keys).toContain('KeyU');
    mem.set(BINDINGS_KEY, JSON.stringify({ lift: { keys: [42, 'KeyZ'], pad: [{ type: 'axis', index: 1, dir: 3 }, { type: 'button', index: 2 }] }, bogus: 1 }));
    const l = loadBindings(st);
    expect(l.lift.keys).toEqual(['KeyZ']);
    expect(l.lift.pad).toEqual([{ type: 'button', index: 2 }]);
    mem.set(BINDINGS_KEY, '[[[');
    expect(loadBindings(st)).toEqual(defaultBindings());
    expect(sanitizeBindings(undefined)).toEqual(defaultBindings());
    const throwing: KeyValueStorage = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => {} };
    expect(loadBindings(throwing)).toEqual(defaultBindings());
    expect(() => saveBindings(throwing, b)).not.toThrow();
  });
  it('labels (English source, layout-aware)', () => {
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('KeyZ', new Map([['KeyZ', 'y']]))).toBe('Y');
    expect(keyLabel('KeyQ')).toBe('Q');
    expect(keyLabel('Minus')).toBe('-');
    expect(keyLabel('Numpad5')).toBe('Num 5');
    expect(padLabel({ type: 'button', index: PAD.RT })).toBe('RT');
    expect(padLabel({ type: 'button', index: PAD.UP })).toBe('D-pad ↑');
    expect(padLabel({ type: 'axis', index: PAD.RY, dir: 1 })).toBe('Right stick ↓');
    expect(CONTROL_META.lift.label).toBe('Lift thrusters (hover)');
    expect(CONTROL_META.lift.group).toBe('thrusters');
  });
  it('labels follow the UI language (German keyboard punctuation only in German)', () => {
    setLocale('de');
    try {
      expect(keyLabel('Space')).toBe('Leertaste');
      expect(keyLabel('Minus')).toBe('ß');
      expect(padLabel({ type: 'axis', index: PAD.RY, dir: 1 })).toBe('Rechter Stick ↓');
      expect(padLabel({ type: 'button', index: PAD.UP })).toBe('Steuerkreuz ↑');
      expect(CONTROL_META.lift.label).toBe('Hubdüsen (Schweben)');
    } finally { setLocale('en'); }
  });
});
