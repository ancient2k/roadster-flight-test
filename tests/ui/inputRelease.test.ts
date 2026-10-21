// R14: focus loss / hidden tab / Cmd shortcuts must not leave a thruster key "held" (no keyup arrives).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InputManager as IM } from '../../src/input/InputManager';

const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
let InputManager: typeof IM;
let win: EventTarget, doc: EventTarget & { visibilityState: string };

beforeAll(async () => {
  for (const k of ['window', 'document', 'HTMLElement']) saved[k] = g[k];
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  g.window = win; g.document = doc; g.HTMLElement = class {};
  ({ InputManager } = await import('../../src/input/InputManager'));
});
afterAll(() => { for (const k of Object.keys(saved)) g[k] = saved[k]; });

const key = (type: 'keydown' | 'keyup', code: string, metaKey = false) =>
  win.dispatchEvent(Object.assign(new Event(type), { code, metaKey }));
const make = () => { const m = new InputManager(win as unknown as Window, {}, null); m.setContext('game'); return m; };
/** a few frames so the keyboard slew reaches full demand */
const hold = (m: IM) => { let o = m.poll(1 / 60); for (let i = 0; i < 20; i++) o = m.poll(1 / 60); return o; };

describe('InputManager releases everything when the key-up can get lost', () => {
  it('window blur: lift and pitch drop to 0 on the next frame', () => {
    const m = make();
    key('keydown', 'Space'); key('keydown', 'KeyK');
    const held = hold(m);
    expect(held.thrust.lift).toBe(1); expect(held.thrust.pitch).toBe(1);
    win.dispatchEvent(new Event('blur'));
    const after = m.poll(1 / 60);
    expect(after.thrust.lift).toBe(0); expect(after.thrust.pitch).toBe(0);
    m.dispose();
  });

  it('tab hidden (visibilitychange) and pagehide release as well', () => {
    const m = make();
    key('keydown', 'ShiftLeft');
    expect(hold(m).thrust.boost).toBe(1);
    doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); doc.visibilityState = 'visible';
    expect(m.poll(1 / 60).thrust.boost).toBe(0);
    key('keydown', 'KeyQ');
    expect(hold(m).thrust.roll).toBe(-1);
    win.dispatchEvent(new Event('pagehide'));
    expect(m.poll(1 / 60).thrust.roll).toBe(0);
    m.dispose();
  });

  it('macOS: a key pressed with Cmd held (no keyup follows) is never recorded; releasing Cmd clears all', () => {
    const m = make();
    key('keydown', 'MetaLeft', true);
    key('keydown', 'KeyK', true);          // Cmd+K: the browser swallows its keyup
    expect(hold(m).thrust.pitch).toBe(0);
    key('keydown', 'KeyJ');                // pressed before Cmd …
    key('keyup', 'MetaLeft');              // … Cmd released: everything held is dropped
    expect(m.poll(1 / 60).thrust.yaw).toBe(0);
    m.dispose();
  });
});
