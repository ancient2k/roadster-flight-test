import { describe, expect, it } from 'vitest';
import { InputMapper } from '../../src/input/mapping';
import { defaultBindings } from '../../src/input/bindings';
import { ATTITUDE_STICK, DRIVE_STICK, TouchState, stickValues } from '../../src/input/touch';
import { CONTROL_IDS, type RawInput } from '../../src/input/types';
import { TOUCH_CONTROL_IDS } from '../../src/ui/touchControls';
import { classifyDevice, defaultQualityFor, MOBILE_CAPS, settingsForBackend, QUALITY_PRESETS } from '../../src/render/quality';

const raw = (touch: TouchState): RawInput => ({ keys: new Set(), mouse: { dx: 0, dy: 0, rightHeld: false }, pad: null, touch: touch.values });

describe('touch sticks', () => {
  it('deadzone around the touch-down point', () => {
    const v = stickValues(DRIVE_STICK, { x: 0.05, y: -0.05 });
    expect(v.throttle).toBe(0); expect(v.steerRight).toBe(0);
  });
  it('drive stick: up = throttle, down = brake, x = steer', () => {
    const v = stickValues(DRIVE_STICK, { x: 1, y: 0 });
    expect(v.steerRight).toBeCloseTo(1, 6); expect(v.steerLeft).toBe(0);
    expect(stickValues(DRIVE_STICK, { x: 0, y: -1 }).throttle).toBeCloseTo(1, 6);
    expect(stickValues(DRIVE_STICK, { x: 0, y: 1 }).brake).toBeCloseTo(1, 6);
  });
  it('attitude stick: pull (down) = nose up like the gamepad', () => {
    expect(stickValues(ATTITUDE_STICK, { x: 0, y: 1 }).pitchUp).toBeCloseTo(1, 6);
    expect(stickValues(ATTITUDE_STICK, { x: -1, y: 0 }).yawLeft).toBeCloseTo(1, 6);
  });
});

describe('touch -> mapper', () => {
  it('analog throttle and steering pass through the pad channel', () => {
    const m = new InputMapper(defaultBindings());
    const ts = new TouchState();
    ts.setStick(DRIVE_STICK, { x: 0.5, y: -1 });
    const out = m.map(raw(ts), 1 / 60);
    expect(out.drive.throttle).toBeGreaterThan(0.6);
    expect(out.drive.steer).toBeGreaterThan(0.1);
    expect(out.drive.steer).toBeLessThan(0.6); // expo like a stick, not a digital key
    ts.clear();
    const off = m.map(raw(ts), 1 / 60);
    expect(off.drive.throttle).toBe(0); expect(off.drive.steer).toBe(0);
  });
  it('buttons give edges and hold values (menu, lift)', () => {
    const m = new InputMapper(defaultBindings());
    const ts = new TouchState();
    ts.set('menu', 1); ts.set('lift', 1);
    const a = m.map(raw(ts), 1 / 60);
    expect(a.pressed.menu).toBe(true); expect(a.thrust.lift).toBe(1);
    const b = m.map(raw(ts), 1 / 60);
    expect(b.pressed.menu).toBe(false);
  });
  it('works with any keyboard rebinding (routing by control id)', () => {
    const bind = defaultBindings();
    bind.boost.keys = []; bind.boost.pad = [];
    const m = new InputMapper(bind);
    const ts = new TouchState(); ts.set('boost', 1);
    expect(m.map(raw(ts), 1 / 60).thrust.boost).toBe(1);
  });
  it('the overlay reaches every bindable control', () => {
    expect(new Set(TOUCH_CONTROL_IDS)).toEqual(new Set(CONTROL_IDS));
  });
});

describe('mobile device profile', () => {
  const base = { maxTouchPoints: 0, coarsePointer: false, canHover: true, minScreen: 1080, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/150' };
  it('classifies phones, tablets and desktops', () => {
    expect(classifyDevice(base)).toBe('desktop');
    expect(classifyDevice({ ...base, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })).toBe('mobile');
    expect(classifyDevice({ ...base, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile' })).toBe('mobile');
    // iPadOS: desktop Safari UA but touch
    expect(classifyDevice({ ...base, maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', minScreen: 820 })).toBe('mobile');
    // touch laptop with a mouse stays desktop
    expect(classifyDevice({ ...base, maxTouchPoints: 10, coarsePointer: false, canHover: true })).toBe('desktop');
  });
  it('mobile defaults to low and caps budgets on every preset', () => {
    expect(defaultQualityFor('mobile')).toBe('low');
    expect(defaultQualityFor('desktop')).toBe('high');
    for (const lvl of ['low', 'medium', 'high', 'ultra'] as const) {
      const s = settingsForBackend(lvl, 'webgpu', 'mobile');
      expect(s.maxPixelRatio).toBeLessThanOrEqual(MOBILE_CAPS.maxPixelRatio);
      expect(s.shadowMapSize).toBeLessThanOrEqual(MOBILE_CAPS.shadowMapSize);
      expect(s.particleBudget).toBeLessThanOrEqual(MOBILE_CAPS.particleBudget);
      expect(s.ssr).toBe(false);
      expect(s.resolutionSteps.at(-1)).toBe(0.5);
    }
    expect(settingsForBackend('ultra', 'webgpu', 'desktop')).toEqual(QUALITY_PRESETS.ultra);
  });
});
