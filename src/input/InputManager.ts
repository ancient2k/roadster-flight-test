// DOM side of input: keyboard, mouse and gamepad collection, rebinding capture, persistence.
// The actual mapping logic lives in mapping.ts (pure, unit tested).
import { browserStorage, type KeyValueStorage } from '../ui/settings';
import { assignKey, assignPad, defaultBindings, keyLabel, loadBindings, padLabel, saveBindings } from './bindings';
import { DEFAULT_MAPPER_OPTIONS, InputMapper, type MapperOptions } from './mapping';
import { TouchState } from './touch';
import type { Bindings, ControlId, PadBinding, PlayerInput, RawInput } from './types';

export type InputContext = 'game' | 'menu';

/** Keys whose browser default (scrolling, back navigation, help) must not fire while driving. */
const GAME_SWALLOW = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Tab', 'F1', 'F2', 'ShiftLeft', 'ControlLeft']);

function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['checkbox', 'radio', 'range', 'button', 'submit'].includes(type);
  }
  return false;
}

export class InputManager {
  readonly mapper: InputMapper;
  /** Written by the on-screen touch controls (src/ui/touchControls.ts). */
  readonly touch = new TouchState();
  private keys = new Set<string>();
  private mouse = { dx: 0, dy: 0, rightHeld: false };
  private context: InputContext = 'menu';
  private storage: KeyValueStorage | null;
  private layoutMap: ReadonlyMap<string, string> | null = null;
  private capture: ((code: string | null) => void) | null = null;
  private listeners = new Set<() => void>();
  private disposers: Array<() => void> = [];
  private padIndex = -1;

  constructor(private target: HTMLElement | Window = window, opts: Partial<MapperOptions> = {}, storage: KeyValueStorage | null = browserStorage()) {
    this.storage = storage;
    this.mapper = new InputMapper(loadBindings(storage), { ...DEFAULT_MAPPER_OPTIONS, ...opts });
    this.attach();
    const kb = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> } }).keyboard;
    kb?.getLayoutMap?.().then((m) => { this.layoutMap = m; this.emit(); }).catch(() => { /* not available */ });
  }

  // ------------------------------------------------------------------ public API
  setContext(c: InputContext): void {
    if (c !== this.context) { this.context = c; this.touch.clear(); this.mapper.prime({ keys: this.keys, mouse: this.mouse, pad: this.readPad() }); }
  }
  getContext(): InputContext { return this.context; }
  setOptions(o: Partial<MapperOptions>): void { Object.assign(this.mapper.opts, o); }

  poll(dt: number): PlayerInput {
    const raw: RawInput = { keys: this.keys, mouse: this.mouse, pad: this.readPad(), touch: this.touch.values };
    const out = this.mapper.map(raw, dt);
    this.mouse.dx = 0; this.mouse.dy = 0;
    return out;
  }

  getBindings(): Readonly<Bindings> { return this.mapper.bindings; }
  setBindings(b: Bindings): void { this.mapper.bindings = b; saveBindings(this.storage, b); this.emit(); }
  resetBindings(): void { this.setBindings(defaultBindings()); }
  bindKey(id: ControlId, code: string, slot = 0): ControlId[] {
    const b = structuredClone(this.mapper.bindings); const stolen = assignKey(b, id, code, slot); this.setBindings(b); return stolen;
  }
  bindPad(id: ControlId, p: PadBinding, slot = 0): ControlId[] {
    const b = structuredClone(this.mapper.bindings); const stolen = assignPad(b, id, p, slot); this.setBindings(b); return stolen;
  }
  clearBinding(id: ControlId, kind: 'key' | 'pad', slot: number): void {
    const b = structuredClone(this.mapper.bindings);
    if (kind === 'key') b[id].keys.splice(slot, 1); else b[id].pad.splice(slot, 1);
    this.setBindings(b);
  }
  onBindingsChange(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }

  keyLabel(code: string): string { return keyLabel(code, this.layoutMap); }
  padLabel(p: PadBinding): string { return padLabel(p); }
  /** Short label of the first binding for on-screen hints. */
  hint(id: ControlId, device: 'keyboard' | 'gamepad' = 'keyboard'): string {
    const b = this.mapper.bindings[id];
    if (device === 'gamepad' && b.pad[0]) return padLabel(b.pad[0]);
    return b.keys[0] ? this.keyLabel(b.keys[0]) : b.pad[0] ? padLabel(b.pad[0]) : '–';
  }

  /** Wait for the next key press (Escape cancels -> null). */
  captureKey(): Promise<string | null> {
    return new Promise((resolve) => {
      this.capture?.(null);
      this.capture = (code) => { this.capture = null; resolve(code); };
    });
  }

  /** Wait for the next gamepad button or stick deflection (> 0.6 from rest). Resolves null after timeout. */
  capturePad(timeoutMs = 6000): Promise<PadBinding | null> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const base = this.readPad();
      const baseButtons = base ? base.buttons.map((v) => v > 0.5) : [];
      const tick = () => {
        const p = this.readPad();
        if (p) {
          for (let i = 0; i < p.buttons.length; i++) if (p.buttons[i] > 0.5 && !baseButtons[i]) return resolve({ type: 'button', index: i });
          for (let i = 0; i < p.axes.length; i++) {
            const a = p.axes[i];
            if (Math.abs(a) > 0.6) return resolve({ type: 'axis', index: i, dir: a > 0 ? 1 : -1 });
          }
        }
        if (performance.now() - t0 > timeoutMs) return resolve(null);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  /** Short rumble on supporting gamepads (landing hits etc.). */
  rumble(strong: number, weak: number, ms: number): void {
    try {
      const gp = this.padIndex >= 0 ? navigator.getGamepads?.()[this.padIndex] : null;
      const act = (gp as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | null)?.vibrationActuator;
      act?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) })?.catch(() => {});
    } catch { /* ignore */ }
  }

  dispose(): void { for (const d of this.disposers) d(); this.disposers = []; this.listeners.clear(); }

  /**
   * Release everything held (focus loss, tab hidden, page hide): a key whose keyup never arrives would
   * otherwise keep its thruster demand forever (R14: "jets fire uncontrolled").
   */
  releaseAll(): void { this.keys.clear(); this.mouse.rightHeld = false; this.touch.clear(); this.mapper.resetState(); }

  // ------------------------------------------------------------------ internals
  private emit(): void { for (const l of this.listeners) l(); }

  private readPad(): RawInput['pad'] {
    let pads: (Gamepad | null)[] = [];
    try { pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : []; } catch { return null; }
    let gp: Gamepad | null = null;
    // Prefer standard-mapped pads; stick with the one used last.
    if (this.padIndex >= 0 && pads[this.padIndex]?.connected) gp = pads[this.padIndex];
    if (!gp) gp = pads.find((p) => p?.connected && p.mapping === 'standard') ?? pads.find((p) => p?.connected) ?? null;
    this.padIndex = gp ? gp.index : -1;
    if (!gp) return null;
    return { buttons: gp.buttons.map((b) => b.value || (b.pressed ? 1 : 0)), axes: gp.axes };
  }

  private attach(): void {
    const on = <K extends keyof WindowEventMap>(el: HTMLElement | Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on(window, 'keydown', (e) => {
      if (this.capture) {
        e.preventDefault(); e.stopPropagation();
        this.capture(e.code === 'Escape' ? null : e.code);
        return;
      }
      if (isTextTarget(e.target)) return;
      // macOS sends no keyup for keys pressed while Cmd is held (Cmd+K …): never record them as held
      if (e.metaKey && e.code !== 'MetaLeft' && e.code !== 'MetaRight') return;
      this.keys.add(e.code);
      if (this.context === 'game' && (GAME_SWALLOW.has(e.code) || this.isBound(e.code))) e.preventDefault();
    }, { capture: true });
    on(window, 'keyup', (e) => {
      this.keys.delete(e.code);
      // releasing Cmd: keys pressed with it held get no keyup of their own on macOS
      if (e.code === 'MetaLeft' || e.code === 'MetaRight') this.keys.clear();
    });
    on(window, 'blur', () => this.releaseAll());
    // tab switches and app switches on mobile do not always blur the window
    on(window, 'pagehide', () => this.releaseAll());
    if (typeof document !== 'undefined') {
      const onVis = () => { if (document.visibilityState === 'hidden') this.releaseAll(); };
      document.addEventListener('visibilitychange', onVis);
      this.disposers.push(() => document.removeEventListener('visibilitychange', onVis));
    }
    on(this.target, 'pointerdown', (e) => { if (e.button === 2) this.mouse.rightHeld = true; });
    on(window, 'pointerup', (e) => { if (e.button === 2) this.mouse.rightHeld = false; });
    on(window, 'pointermove', (e) => { if (this.mouse.rightHeld) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; } });
    on(this.target, 'contextmenu', (e) => { if (this.context === 'game') e.preventDefault(); });
    on(window, 'gamepaddisconnected', () => { this.padIndex = -1; });
  }

  private isBound(code: string): boolean {
    for (const b of Object.values(this.mapper.bindings)) if (b.keys.includes(code)) return true;
    return false;
  }
}
