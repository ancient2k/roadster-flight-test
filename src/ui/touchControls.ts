// On-screen controls for phones and tablets. Writes InputManager.touch (per ControlId), so every
// action of src/input/bindings.ts is reachable without a keyboard and rebinding is unaffected.
// Layout (landscape): drive stick bottom left, attitude stick + lift/down/boost/roll bottom right,
// menu/camera/reset top right with a tray for the remaining actions. Shown only on touch devices
// and only while driving (InputManager context 'game'); menus are plain DOM buttons (tap = click).
import type { InputManager } from '../input/InputManager';
import { ATTITUDE_STICK, DRIVE_STICK, type StickMap } from '../input/touch';
import type { ControlId } from '../input/types';
import { onLocaleChange, t, type MsgKey } from '../i18n';
import './touch.css';

/** Edge actions are held at least this long so a quick tap spans a rendered frame. */
const MIN_PRESS_MS = 90;

interface ButtonSpec { id: ControlId; label: MsgKey | null; glyph?: string; cls?: string }

const RIGHT_BUTTONS: ButtonSpec[] = [
  { id: 'boost', label: 'touch.boost', cls: 'boost' },
  { id: 'lift', label: 'touch.lift', cls: 'lift' },
  { id: 'liftDown', label: 'touch.down', cls: 'down' },
  { id: 'rollLeft', label: null, glyph: '⟲', cls: 'rollL' },
  { id: 'rollRight', label: null, glyph: '⟳', cls: 'rollR' },
];
const LEFT_BUTTONS: ButtonSpec[] = [
  { id: 'handbrake', label: 'touch.handbrake', cls: 'hb' },
];
const TOP_BUTTONS: ButtonSpec[] = [
  { id: 'cameraCycle', label: 'touch.camera' },
  { id: 'reset', label: null, glyph: '↺' },
  { id: 'menu', label: null, glyph: '☰' },
];
const TRAY_BUTTONS: ButtonSpec[] = [
  { id: 'assistCycle', label: 'hud.assist' },
  { id: 'fanModeCycle', label: 'hud.fans' },
  { id: 'aeroModeCycle', label: 'hud.aero' },
  { id: 'refillToggle', label: 'touch.refill' },
  { id: 'reverseToggle', label: 'touch.reverse' },
  { id: 'launchMode', label: 'touch.launch' },
  { id: 'slowMo', label: 'touch.slowMo' },
  { id: 'photoMode', label: 'touch.photo' },
  { id: 'pause', label: null, glyph: '❚❚' },
  { id: 'help', label: null, glyph: '?' },
];

/** Every control the overlay drives (the E2E/unit tests check this covers CONTROL_IDS). */
export const TOUCH_CONTROL_IDS: readonly ControlId[] = [
  ...Object.values(DRIVE_STICK), ...Object.values(ATTITUDE_STICK),
  ...[...RIGHT_BUTTONS, ...LEFT_BUTTONS, ...TOP_BUTTONS, ...TRAY_BUTTONS].map((b) => b.id),
] as ControlId[];

/** Touch-first device (coarse pointer or touch points). Desktop touch screens with a mouse also qualify. */
export function hasTouch(): boolean {
  try {
    return (navigator.maxTouchPoints ?? 0) > 0 || matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  } catch { return false; }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); e.className = cls; parent?.appendChild(e); return e;
};

export class TouchControls {
  readonly root: HTMLDivElement;
  private tray!: HTMLDivElement;
  private rotate!: HTMLDivElement;
  private rotateDismissed = false;
  private raf = 0;
  private labelled: Array<[HTMLElement, ButtonSpec]> = [];
  private disposers: Array<() => void> = [];

  constructor(private host: HTMLElement, private input: InputManager, opts: { force?: boolean } = {}) {
    this.root = el('div', 'rft-touch');
    this.root.setAttribute('data-touch-ui', '');
    this.root.hidden = true;
    if (opts.force || hasTouch()) document.documentElement.classList.add('rft-has-touch');
    this.build();
    host.appendChild(this.root);
    const tick = () => { this.sync(); this.raf = requestAnimationFrame(tick); };
    this.raf = requestAnimationFrame(tick);
    const vis = () => { if (document.hidden) this.input.touch.clear(); };
    document.addEventListener('visibilitychange', vis);
    this.disposers.push(() => document.removeEventListener('visibilitychange', vis));
    this.disposers.push(onLocaleChange(() => this.relabel()));
  }

  /** Re-read the translated labels (language change). */
  relabel(): void {
    for (const [b, s] of this.labelled) {
      b.textContent = s.label ? t(s.label) : (s.glyph ?? '');
      b.setAttribute('aria-label', t(`control.${s.id}` as MsgKey));
    }
    this.root.querySelector('.rft-touch-more')?.setAttribute('aria-label', t('touch.more'));
    this.root.querySelector('.rft-touch-stick.drive .rft-touch-hint')!.textContent = t('touch.drive');
    this.root.querySelector('.rft-touch-stick.att .rft-touch-hint')!.textContent = t('touch.attitude');
    this.rotate.querySelector('p')!.textContent = t('mobile.rotate');
    this.rotate.querySelector('button')!.textContent = t('mobile.rotateContinue');
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.root.remove();
    this.input.touch.clear();
  }

  // ------------------------------------------------------------------ build
  private build(): void {
    const left = el('div', 'rft-touch-zone left', this.root);
    const right = el('div', 'rft-touch-zone right', this.root);
    this.stick(left, 'drive', DRIVE_STICK);
    this.stick(right, 'att', ATTITUDE_STICK);
    const lb = el('div', 'rft-touch-btns left', this.root);
    for (const s of LEFT_BUTTONS) this.button(lb, s, 'hold');
    const rb = el('div', 'rft-touch-btns right', this.root);
    for (const s of RIGHT_BUTTONS) this.button(rb, s, 'hold');
    const top = el('div', 'rft-touch-top', this.root);
    const more = el('button', 'rft-touch-btn rft-touch-more', top);
    more.type = 'button'; more.textContent = '⋯';
    more.addEventListener('click', () => { this.tray.hidden = !this.tray.hidden; more.classList.toggle('on', !this.tray.hidden); });
    for (const s of TOP_BUTTONS) this.button(top, s, 'tap');
    this.tray = el('div', 'rft-touch-tray', this.root);
    this.tray.hidden = true;
    for (const s of TRAY_BUTTONS) this.button(this.tray, s, 'tap');

    this.rotate = el('div', 'rft-rotate', this.host);
    this.rotate.setAttribute('data-touch-rotate', '');
    el('div', 'rft-rotate-icon', this.rotate).textContent = '⟳';
    el('p', '', this.rotate);
    const go = el('button', 'rft-touch-btn', this.rotate);
    go.type = 'button';
    go.addEventListener('click', () => { this.rotateDismissed = true; this.sync(); });
    this.disposers.push(() => this.rotate.remove());
    this.relabel();
  }

  private button(parent: HTMLElement, s: ButtonSpec, mode: 'hold' | 'tap'): void {
    const b = el('button', `rft-touch-btn ${s.cls ?? ''}`, parent);
    b.type = 'button';
    b.dataset.control = s.id;
    this.labelled.push([b, s]);
    let downAt = 0, timer = 0;
    const release = () => { b.classList.remove('on'); this.input.touch.set(s.id, 0); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      clearTimeout(timer);
      downAt = performance.now();
      b.classList.add('on');
      this.input.touch.set(s.id, 1);
    });
    const up = () => {
      if (!b.classList.contains('on')) return;
      const wait = mode === 'tap' ? Math.max(0, MIN_PRESS_MS - (performance.now() - downAt)) : 0;
      clearTimeout(timer);
      if (wait > 0) timer = window.setTimeout(release, wait); else release();
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Floating stick: the base appears under the finger, deflection is relative to the touch-down point. */
  private stick(zone: HTMLElement, cls: string, map: StickMap): void {
    const wrap = el('div', `rft-touch-stick ${cls}`, zone);
    const base = el('div', 'rft-touch-base', wrap);
    const knob = el('div', 'rft-touch-knob', base);
    el('div', 'rft-touch-hint', wrap);
    let id = -1, ox = 0, oy = 0;
    const radius = () => Math.max(36, base.offsetWidth / 2 || 56);
    const place = (x: number, y: number) => {
      const r = zone.getBoundingClientRect();
      base.style.left = `${x - r.left}px`; base.style.top = `${y - r.top}px`;
    };
    const move = (x: number, y: number) => {
      const R = radius();
      let dx = (x - ox) / R, dy = (y - oy) / R;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      knob.style.transform = `translate(${dx * R}px, ${dy * R}px)`;
      this.input.touch.setStick(map, { x: dx, y: dy });
    };
    const end = () => {
      id = -1;
      wrap.classList.remove('on');
      base.style.left = base.style.top = '';
      knob.style.transform = '';
      this.input.touch.setStick(map, { x: 0, y: 0 });
    };
    zone.addEventListener('pointerdown', (e) => {
      if (id !== -1 || e.target !== zone && !wrap.contains(e.target as Node)) return;
      e.preventDefault();
      id = e.pointerId;
      try { zone.setPointerCapture(id); } catch { /* synthetic pointer */ }
      ox = e.clientX; oy = e.clientY;
      wrap.classList.add('on');
      place(ox, oy);
      move(ox, oy);
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === id) { e.preventDefault(); move(e.clientX, e.clientY); } });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) zone.addEventListener(ev, (e) => { if (e.pointerId === id) end(); });
  }

  // ------------------------------------------------------------------ state
  private sync(): void {
    const touchUi = document.documentElement.classList.contains('rft-has-touch');
    const game = this.input.getContext() === 'game';
    const show = touchUi && game;
    if (this.root.hidden === show) {
      this.root.hidden = !show;
      if (!show) { this.tray.hidden = true; this.root.querySelector('.rft-touch-more')?.classList.remove('on'); }
    }
    const portrait = window.innerHeight > window.innerWidth;
    this.rotate.hidden = !(touchUi && portrait && !this.rotateDismissed);
  }
}
