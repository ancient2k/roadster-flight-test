import { describe, expect, it } from 'vitest';
import { GYRO_DEFAULTS, GyroMapper, axisFromTilt, mergeAttitude, tiltAngles, type TiltSample } from '../../src/input/gyro';
import { InputMapper } from '../../src/input/mapping';
import { defaultBindings } from '../../src/input/bindings';

const S = (beta: number, gamma: number, screenAngle = 0): TiltSample => ({ beta, gamma, screenAngle });
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(eps);

describe('tilt angles in screen coordinates', () => {
  it('flat phone reads zero', () => {
    const a = tiltAngles(S(0, 0));
    near(a.pitchDeg, 0); near(a.rollDeg, 0);
  });
  it('portrait: beta = top edge up (pitch), gamma = right edge down (roll)', () => {
    near(tiltAngles(S(10, 0)).pitchDeg, 10);
    near(tiltAngles(S(0, 10)).rollDeg, 10);
    near(tiltAngles(S(0, 10)).pitchDeg, 0);
  });
  it('landscape 90 (device top to the left): screen top = device right edge', () => {
    // screen right side down = device bottom down = beta up
    near(tiltAngles(S(10, 0, 90)).rollDeg, 10);
    near(tiltAngles(S(10, 0, 90)).pitchDeg, 0);
    // screen top edge up = device right edge up = gamma negative
    near(tiltAngles(S(0, -10, 90)).pitchDeg, 10);
  });
  it('landscape 270 is the mirror image of 90', () => {
    near(tiltAngles(S(10, 0, 270)).rollDeg, -10);
    near(tiltAngles(S(0, 10, 270)).pitchDeg, 10);
  });
  it('upside-down portrait (180) flips both axes', () => {
    near(tiltAngles(S(10, 0, 180)).pitchDeg, -10);
    near(tiltAngles(S(0, 10, 180)).rollDeg, -10);
  });
  it('roll is independent of how far the phone is leaned back (landscape, held at 40°)', () => {
    const a = tiltAngles(S(15, -40, 90));
    near(a.rollDeg, 15, 1e-9);
    near(a.pitchDeg, 40, 1e-9);
  });
});

describe('dead zone and sensitivity', () => {
  const t = GYRO_DEFAULTS;
  it('reads zero inside the dead zone and rises continuously from its edge', () => {
    expect(axisFromTilt(2.9, t)).toBe(0);
    expect(axisFromTilt(-3, t)).toBe(0);
    expect(axisFromTilt(3.01, t)).toBeGreaterThan(0);
    expect(axisFromTilt(3.01, t)).toBeLessThan(0.01);
  });
  it('full deflection at dead zone + full tilt, clamped beyond, symmetric', () => {
    near(axisFromTilt(t.deadzoneDeg + t.fullTiltDeg, t), 1);
    expect(axisFromTilt(80, t)).toBe(1);
    expect(axisFromTilt(-80, t)).toBe(-1);
    near(axisFromTilt(-15, t), -axisFromTilt(15, t));
  });
  it('sensitivity scales the gain', () => {
    const lo = axisFromTilt(10, { ...t, sensitivity: 1 }), hi = axisFromTilt(10, { ...t, sensitivity: 2 });
    near(hi, 2 * lo);
  });
});

describe('GyroMapper calibration and smoothing', () => {
  it('the first sample becomes the zero pose', () => {
    const m = new GyroMapper({ smoothingS: 0 });
    expect(m.step(S(0, -40, 90), 0.016)).toEqual({ pitch: 0, roll: 0 });
    expect(m.calibrated).toBe(true);
  });
  it('tilting back from the zero pose = nose up, right edge down = roll right (landscape)', () => {
    const m = new GyroMapper({ smoothingS: 0 });
    m.calibrate(S(0, -40, 90));
    const back = m.step(S(0, -55, 90), 0.016); // 15° further back
    near(back.pitch, (15 - 3) / 25, 1e-9); near(back.roll, 0, 1e-9);
    const fwd = m.step(S(0, -25, 90), 0.016);
    expect(fwd.pitch).toBeLessThan(0);
    const right = m.step(S(15, -40, 90), 0.016);
    near(right.roll, (15 - 3) / 25, 1e-9); near(right.pitch, 0, 1e-9);
  });
  it('recalibrating takes the current pose as the new zero', () => {
    const m = new GyroMapper({ smoothingS: 0 });
    m.calibrate(S(20, 0));
    expect(m.step(S(40, 10), 0.016).pitch).toBeGreaterThan(0.5);
    m.calibrate(S(40, 10));
    expect(m.step(S(40, 10), 0.016)).toEqual({ pitch: 0, roll: 0 });
    m.reset();
    expect(m.calibrated).toBe(false);
  });
  it('wraps across ±180° (phone leaned far back past vertical)', () => {
    const m = new GyroMapper({ smoothingS: 0 });
    m.calibrate(S(175, 0));          // pitch zero ~ +175°
    const r = m.step(S(-175, 0), 0.016); // 10° further: reads +10°, not -350°
    near(r.pitch, (10 - 3) / 25, 1e-9);
  });
  it('low-pass: about 63 % after one time constant, converges, eases back without samples', () => {
    const tau = 0.1;
    const m = new GyroMapper({ smoothingS: tau });
    m.calibrate(S(0, 0));
    const full = new GyroMapper({ smoothingS: 0 }); full.calibrate(S(0, 0));
    const target = full.target(S(20, 0)).pitch;
    let out = 0;
    for (let i = 0; i < 10; i++) out = m.step(S(20, 0), tau / 10).pitch;
    near(out, target * (1 - Math.exp(-1)), 1e-9);
    for (let i = 0; i < 200; i++) out = m.step(S(20, 0), 0.016).pitch;
    near(out, target, 1e-6);
    for (let i = 0; i < 200; i++) out = m.step(null, 0.016).pitch;
    expect(out).toBe(0);
  });
});

describe('merging with the touch attitude', () => {
  it('passes the touch values through while the tilt reads zero', () => {
    const touch = { pitchDown: 0.4, throttle: 1 };
    expect(mergeAttitude(touch, { pitch: 0, roll: 0 })).toBe(touch);
  });
  it('adds signed per axis and clamps; steering and throttle stay untouched', () => {
    const m = mergeAttitude({ pitchDown: 0.5, rollRight: 1, throttle: 0.7, steerLeft: 0.3, yawRight: 0.2 }, { pitch: 0.3, roll: 0.6 });
    near(m.pitchDown!, 0.2); expect(m.pitchUp).toBe(0);
    expect(m.rollRight).toBe(1); expect(m.rollLeft).toBe(0);
    expect(m.throttle).toBe(0.7); expect(m.steerLeft).toBe(0.3); expect(m.yawRight).toBe(0.2);
  });
  it('reaches the thrust demand through the mapper (touch channel)', () => {
    const mapper = new InputMapper(defaultBindings());
    const out = mapper.map({ keys: new Set(), mouse: { dx: 0, dy: 0, rightHeld: false }, pad: null, touch: mergeAttitude({}, { pitch: 0.6, roll: -0.8 }) }, 0.016);
    expect(out.thrust.pitch).toBeGreaterThan(0.3);
    expect(out.thrust.roll).toBeLessThan(-0.5);
    expect(out.drive.steer).toBe(0);
    expect(out.drive.throttle).toBe(0);
  });
});
