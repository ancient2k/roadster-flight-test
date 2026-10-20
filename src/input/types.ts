// Player input contract produced by InputManager.poll(dt) once per rendered frame.
import type { DriveInput } from '../shared/types';

/** Manual thrust demand (interpreted by GNC according to the assist level). */
export interface ThrustInput {
  lift: number;   // -1..1  (+ = up / away from the ground; - = push down, only meaningful in RAW/inverted)
  boost: number;  // 0..1   rear main nozzles
  pitch: number;  // -1..1  (+ = nose up)
  roll: number;   // -1..1  (+ = right side down)
  yaw: number;    // -1..1  (+ = nose right)
}

/** Edge-triggered actions: true only in the frame the control went down. */
export interface ActionEdges {
  fanModeCycle: boolean;   // off -> grip -> highspeed -> off
  aeroModeCycle: boolean;  // auto -> highDownforce -> lowDrag -> auto
  refillToggle: boolean;   // onboard compressor on/off
  assistCycle: boolean;    // ASSIST -> STABILIZED -> RAW -> ASSIST
  cameraCycle: boolean;
  pause: boolean;
  reset: boolean;
  slowMo: boolean;         // toggle time scale
  photoMode: boolean;
  menu: boolean;
  help: boolean;
  reverseToggle: boolean;
}
export type ActionId = keyof ActionEdges;

/** Menu navigation edges (gamepad; keyboard menus are handled natively by the DOM). Includes auto-repeat. */
export interface MenuNav { up: boolean; down: boolean; left: boolean; right: boolean; confirm: boolean; back: boolean; tabPrev: boolean; tabNext: boolean }

export type InputDevice = 'keyboard' | 'gamepad';

export interface PlayerInput {
  drive: DriveInput;
  thrust: ThrustInput;
  pressed: ActionEdges;
  menuNav: MenuNav;
  /** Device that produced the most recent meaningful input (for on-screen glyphs). */
  lastDevice: InputDevice;
  gamepadConnected: boolean;
}

/** Every bindable control. Analog axes are bound as two half-axes. */
export const CONTROL_IDS = [
  'throttle', 'brake', 'steerLeft', 'steerRight', 'handbrake', 'launchMode',
  'lift', 'liftDown', 'boost', 'pitchUp', 'pitchDown', 'rollLeft', 'rollRight', 'yawLeft', 'yawRight',
  'fanModeCycle', 'aeroModeCycle', 'refillToggle', 'assistCycle', 'cameraCycle',
  'pause', 'reset', 'slowMo', 'photoMode', 'menu', 'help', 'reverseToggle',
] as const;
export type ControlId = (typeof CONTROL_IDS)[number];

export type PadBinding =
  | { type: 'button'; index: number }
  | { type: 'axis'; index: number; dir: 1 | -1 };

export interface Binding { keys: string[]; pad: PadBinding[] }
export type Bindings = Record<ControlId, Binding>;

/** Raw device snapshot handed to the (pure) mapper. */
export interface RawInput {
  keys: ReadonlySet<string>;        // KeyboardEvent.code values currently held
  mouse: { dx: number; dy: number; rightHeld: boolean };
  pad: { buttons: readonly number[]; axes: readonly number[] } | null;
}
