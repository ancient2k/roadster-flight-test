// Pure input mapping: RawInput snapshot + bindings + dt -> PlayerInput.
// No DOM access, deterministic, unit tested (tests/ui/input.test.ts).
import { neutralDrive } from '../shared/types';
import { PAD } from './bindings';
import type { ActionEdges, ActionId, Bindings, ControlId, InputDevice, MenuNav, PadBinding, PlayerInput, RawInput } from './types';

export interface MapperOptions {
  stickDeadzone: number;     // radial, 0..0.6
  triggerDeadzone: number;   // 0..0.5
  invertPitch: boolean;
  mouseAttitude: boolean;    // right mouse button + move = pitch/yaw
  mouseSensitivity: number;
}

export const DEFAULT_MAPPER_OPTIONS: MapperOptions = {
  stickDeadzone: 0.15, triggerDeadzone: 0.05, invertPitch: false, mouseAttitude: false, mouseSensitivity: 1,
};

const ACTION_IDS: ActionId[] = [
  'fanModeCycle', 'aeroModeCycle', 'refillToggle', 'assistCycle', 'cameraCycle',
  'pause', 'reset', 'slowMo', 'photoMode', 'menu', 'help', 'reverseToggle',
];

/** Keyboard ramp times (s): digital keys are shaped into smooth analog demands. */
export const KB_RAMP = {
  steerRise: 0.16, steerReturn: 0.07,
  pedalRise: 0.10, pedalFall: 0.05,
  thrustRise: 0.05, thrustFall: 0.04,
  attitudeRise: 0.12, attitudeFall: 0.06,
};

/** Menu auto-repeat for held directions (s). */
export const NAV_REPEAT = { delay: 0.42, rate: 0.11 };

const TRIGGER_BUTTONS = new Set<number>([PAD.LT, PAD.RT]);

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp11 = (x: number): number => (x < -1 ? -1 : x > 1 ? 1 : x);

/** Radial deadzone with rescale: output magnitude 0 at the deadzone edge, 1 at full deflection. */
export function radialDeadzone(x: number, y: number, dz: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m <= dz || m === 0) return [0, 0];
  const s = clamp01((Math.min(1, m) - dz) / (1 - dz)) / m;
  return [x * s, y * s];
}

/** Scalar deadzone with rescale (triggers). */
export function linearDeadzone(v: number, dz: number): number {
  return v <= dz ? 0 : clamp01((v - dz) / (1 - dz));
}

/** Move `cur` toward `target` with separate rise/fall times (full-scale time constants, linear slew). */
export function slew(cur: number, target: number, dt: number, rise: number, fall: number): number {
  const towardZero = Math.abs(target) < Math.abs(cur) || (cur !== 0 && Math.sign(target) !== Math.sign(cur));
  const t = towardZero ? fall : rise;
  const step = t <= 0 ? Infinity : dt / t;
  const d = target - cur;
  return Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
}

function emptyEdges(): ActionEdges {
  return {
    fanModeCycle: false, aeroModeCycle: false, refillToggle: false, assistCycle: false, cameraCycle: false,
    pause: false, reset: false, slowMo: false, photoMode: false, menu: false, help: false, reverseToggle: false,
  };
}
function emptyNav(): MenuNav { return { up: false, down: false, left: false, right: false, confirm: false, back: false, tabPrev: false, tabNext: false }; }

export class InputMapper {
  private prevDown = new Map<ControlId, boolean>();
  private kb = { steer: 0, throttle: 0, brake: 0, lift: 0, boost: 0, pitch: 0, roll: 0, yaw: 0 };
  private mouseStick = { pitch: 0, yaw: 0 };
  private reverse = false;
  private lastDevice: InputDevice = 'keyboard';
  private prevKeys = new Set<string>();
  private prevPadActive = false;
  private nav = { dir: '' as '' | 'up' | 'down' | 'left' | 'right', held: 0, nextRepeat: 0, prevButtons: [] as boolean[] };

  constructor(public bindings: Bindings, public opts: MapperOptions = { ...DEFAULT_MAPPER_OPTIONS }) {}

  private latched = new Set<ControlId>();

  setReverse(on: boolean): void { this.reverse = on; }

  /**
   * Call on context switches (menu <-> game) with the current raw state: everything held right now
   * counts as "already pressed" (no fresh edge, e.g. the Esc that just closed the pause menu) and
   * is ignored as analog input until released (e.g. gamepad A = lift after confirming "Fortsetzen").
   */
  prime(raw: RawInput): void {
    this.resetState();
    for (const id of Object.keys(this.bindings) as ControlId[]) {
      const v = this.control(id, raw);
      if (Math.max(v.key, v.pad) > 0.5) { this.latched.add(id); this.prevDown.set(id, true); }
    }
    if (raw.pad) this.nav.prevButtons = raw.pad.buttons.map((v) => v > 0.5);
    for (const k of raw.keys) this.prevKeys.add(k);
  }

  /** Clear filters/edges, e.g. after a pause or focus loss so nothing "sticks". */
  resetState(): void {
    this.prevDown.clear();
    this.latched.clear();
    for (const k of Object.keys(this.kb) as (keyof typeof this.kb)[]) this.kb[k] = 0;
    this.mouseStick.pitch = this.mouseStick.yaw = 0;
    this.nav.dir = ''; this.nav.prevButtons = [];
  }

  /** Pad contribution 0..1 of a single binding. */
  padValue(p: PadBinding, raw: RawInput): number {
    const pad = raw.pad;
    if (!pad) return 0;
    if (p.type === 'button') {
      const v = pad.buttons[p.index] ?? 0;
      return TRIGGER_BUTTONS.has(p.index) ? linearDeadzone(v, this.opts.triggerDeadzone) : (v > 0.5 ? 1 : v > 0.1 ? v : 0);
    }
    // Axis: radial deadzone over the stick pair (0/1 left, 2/3 right); other axes scalar.
    const pairBase = p.index < 4 ? p.index - (p.index % 2) : -1;
    let v: number;
    if (pairBase >= 0) {
      const [x, y] = radialDeadzone(pad.axes[pairBase] ?? 0, pad.axes[pairBase + 1] ?? 0, this.opts.stickDeadzone);
      v = p.index === pairBase ? x : y;
    } else {
      const a = pad.axes[p.index] ?? 0;
      v = Math.abs(a) <= this.opts.stickDeadzone ? 0 : Math.sign(a) * clamp01((Math.abs(a) - this.opts.stickDeadzone) / (1 - this.opts.stickDeadzone));
    }
    return clamp01(v * p.dir);
  }

  /** Raw values of a control split by source (latched controls read 0 until released). */
  control(id: ControlId, raw: RawInput): { key: number; pad: number } {
    const b = this.bindings[id];
    let key = 0, pad = 0;
    for (const k of b.keys) if (raw.keys.has(k)) { key = 1; break; }
    for (const p of b.pad) pad = Math.max(pad, this.padValue(p, raw));
    if (this.latched.has(id)) {
      if (Math.max(key, pad) > 0.2) return { key: 0, pad: 0 };
      this.latched.delete(id);
    }
    return { key, pad };
  }

  map(raw: RawInput, dt: number): PlayerInput {
    dt = Math.max(0, Math.min(dt, 0.1));
    const c = (id: ControlId) => this.control(id, raw);
    const r = KB_RAMP;

    // ---------------------------------------------------------------- device tracking
    for (const k of raw.keys) if (!this.prevKeys.has(k)) { this.lastDevice = 'keyboard'; break; }
    this.prevKeys = new Set(raw.keys);
    const padActive = !!raw.pad && (raw.pad.buttons.some((v) => v > 0.5) || raw.pad.axes.some((v) => Math.abs(v) > 0.5));
    if (padActive && !this.prevPadActive) this.lastDevice = 'gamepad';
    this.prevPadActive = padActive;

    // ---------------------------------------------------------------- drive
    const thr = c('throttle'), brk = c('brake'), sl = c('steerLeft'), sr = c('steerRight');
    this.kb.throttle = slew(this.kb.throttle, thr.key, dt, r.pedalRise, r.pedalFall);
    this.kb.brake = slew(this.kb.brake, brk.key, dt, r.pedalRise, r.pedalFall);
    this.kb.steer = slew(this.kb.steer, sr.key - sl.key, dt, r.steerRise, r.steerReturn);
    const padSteer = sr.pad - sl.pad;
    const drive = neutralDrive();
    drive.throttle = Math.max(this.kb.throttle, thr.pad);
    drive.brake = Math.max(this.kb.brake, brk.pad);
    drive.steer = clamp11(Math.abs(padSteer) > Math.abs(this.kb.steer) ? Math.sign(padSteer) * Math.abs(padSteer) ** 1.3 : this.kb.steer);
    const hb = c('handbrake'); drive.handbrake = Math.max(hb.key, hb.pad) > 0.5;
    const lm = c('launchMode'); drive.launchMode = Math.max(lm.key, lm.pad) > 0.5;

    // ---------------------------------------------------------------- thrust
    const lu = c('lift'), ld = c('liftDown'), bo = c('boost');
    this.kb.lift = slew(this.kb.lift, lu.key - ld.key, dt, r.thrustRise, r.thrustFall);
    this.kb.boost = slew(this.kb.boost, bo.key, dt, r.thrustRise, r.thrustFall);
    const pu = c('pitchUp'), pd = c('pitchDown'), rl = c('rollLeft'), rr = c('rollRight'), yl = c('yawLeft'), yr = c('yawRight');
    this.kb.pitch = slew(this.kb.pitch, pu.key - pd.key, dt, r.attitudeRise, r.attitudeFall);
    this.kb.roll = slew(this.kb.roll, rr.key - rl.key, dt, r.attitudeRise, r.attitudeFall);
    this.kb.yaw = slew(this.kb.yaw, yr.key - yl.key, dt, r.attitudeRise, r.attitudeFall);

    // Mouse attitude: decaying virtual stick fed by mouse deltas while the right button is held.
    const decay = Math.exp(-dt / 0.12);
    if (this.opts.mouseAttitude && raw.mouse.rightHeld) {
      const k = 0.006 * this.opts.mouseSensitivity;
      this.mouseStick.pitch = clamp11(this.mouseStick.pitch * decay - raw.mouse.dy * k);
      this.mouseStick.yaw = clamp11(this.mouseStick.yaw * decay + raw.mouse.dx * k);
    } else {
      this.mouseStick.pitch *= decay; this.mouseStick.yaw *= decay;
      if (Math.abs(this.mouseStick.pitch) < 1e-3) this.mouseStick.pitch = 0;
      if (Math.abs(this.mouseStick.yaw) < 1e-3) this.mouseStick.yaw = 0;
    }

    const pick = (kbv: number, padv: number, mouse = 0) => {
      const pc = Math.sign(padv) * Math.abs(padv) ** 1.5; // expo for fine attitude control
      let best = kbv;
      if (Math.abs(pc) > Math.abs(best)) best = pc;
      if (Math.abs(mouse) > Math.abs(best)) best = mouse;
      return clamp11(best);
    };
    let pitch = pick(this.kb.pitch, pu.pad - pd.pad, this.mouseStick.pitch);
    if (this.opts.invertPitch) pitch = -pitch;
    const thrust = {
      lift: clamp11(Math.abs(lu.pad - ld.pad) > Math.abs(this.kb.lift) ? lu.pad - ld.pad : this.kb.lift),
      boost: clamp01(Math.max(this.kb.boost, bo.pad)),
      pitch,
      roll: pick(this.kb.roll, rr.pad - rl.pad),
      yaw: pick(this.kb.yaw, yr.pad - yl.pad, this.mouseStick.yaw),
    };

    // ---------------------------------------------------------------- edges
    const pressed = emptyEdges();
    for (const id of ACTION_IDS) {
      const wasLatched = this.latched.has(id);
      const v = c(id);
      const down = Math.max(v.key, v.pad) > 0.5;
      pressed[id] = down && !this.prevDown.get(id);
      this.prevDown.set(id, down || (wasLatched && this.latched.has(id)));
    }
    if (pressed.reverseToggle) this.reverse = !this.reverse;
    drive.reverse = this.reverse;

    return {
      drive, thrust, pressed,
      menuNav: this.mapNav(raw, dt),
      lastDevice: this.lastDevice,
      gamepadConnected: !!raw.pad,
    };
  }

  /** Gamepad menu navigation with auto-repeat on held directions. */
  private mapNav(raw: RawInput, dt: number): MenuNav {
    const nav = emptyNav();
    const pad = raw.pad;
    if (!pad) { this.nav.dir = ''; this.nav.prevButtons = []; return nav; }
    const btn = (i: number) => (pad.buttons[i] ?? 0) > 0.5;
    const lx = pad.axes[0] ?? 0, ly = pad.axes[1] ?? 0;
    let dir: typeof this.nav.dir = '';
    if (btn(PAD.UP) || ly < -0.6) dir = 'up';
    else if (btn(PAD.DOWN) || ly > 0.6) dir = 'down';
    else if (btn(PAD.LEFT) || lx < -0.6) dir = 'left';
    else if (btn(PAD.RIGHT) || lx > 0.6) dir = 'right';

    if (dir && dir !== this.nav.dir) {
      nav[dir] = true; this.nav.held = 0; this.nav.nextRepeat = NAV_REPEAT.delay;
    } else if (dir) {
      this.nav.held += dt;
      if (this.nav.held >= this.nav.nextRepeat) { nav[dir] = true; this.nav.nextRepeat += NAV_REPEAT.rate; }
    }
    this.nav.dir = dir;

    const edge = (i: number) => btn(i) && !this.nav.prevButtons[i];
    nav.confirm = edge(PAD.A);
    nav.back = edge(PAD.B);
    nav.tabPrev = edge(PAD.LB);
    nav.tabNext = edge(PAD.RB);
    this.nav.prevButtons = pad.buttons.map((v) => v > 0.5);
    return nav;
  }
}
