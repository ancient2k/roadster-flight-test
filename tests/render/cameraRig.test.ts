// Chase camera (R15 user finding: "the ramp keeps hiding the car", "turn the camera with the mouse").
import { describe, expect, it } from 'vitest';
import { CameraRig, LOOK_RECENTER_S } from '../../src/render/camera/cameraRig';
import { fakeState, SEGMENTS } from '../../src/render/fakeState';
import { qrot } from '../../src/shared/math';
import type { VehicleState } from '../../src/shared/types';

const dt = 1 / 60;
const rel = (rig: CameraRig, s: VehicleState) => {
  const p = rig.camera.position;
  return { x: p.x - s.pos.x, y: p.y - s.pos.y, z: p.z - s.pos.z };
};

describe('chase camera on the wall ramp', () => {
  it('stays on the open side (over the roof) while the car climbs, hangs and comes down', () => {
    const seg = SEGMENTS.find((x) => x.id === 'ramp_hang')!;
    const rig = new CameraRig(16 / 9);
    let checked = 0;
    for (let t = seg.t0; t < seg.t1; t += dt) {
      const s = fakeState(t);
      rig.update(s, dt);
      const up = qrot(s.quat, { x: 0, y: 1, z: 0 });
      // settled on a steep part of the wall (the blend needs ≈ 1 s)
      if (s.groundContact && up.y < 0.2 && fakeState(t - 1).groundContact && qrot(fakeState(t - 1).quat, { x: 0, y: 1, z: 0 }).y < 0.25) {
        const d = rel(rig, s);
        expect(d.x * up.x + d.y * up.y + d.z * up.z, `t=${t.toFixed(2)}`).toBeGreaterThan(1.5);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});

describe('chase camera mouse look', () => {
  const driving = () => { for (let t = 1; t < 4; t += 0.05) { const s = fakeState(t); if (s.groundContact && s.speedMs > 5) return t; } throw new Error('no driving state'); };

  it('a drag turns the camera around the car, and it swings back behind the car once idle', () => {
    const t0 = driving();
    const base = new CameraRig(16 / 9), turned = new CameraRig(16 / 9);
    for (let k = 0; k < 30; k++) { base.update(fakeState(t0 + k * dt), dt); turned.update(fakeState(t0 + k * dt), dt); }
    const L = (turned as unknown as { look: { yaw: number; idle: number } }).look;
    L.yaw = Math.PI / 2; L.idle = 0;
    const s = fakeState(t0 + 30 * dt);
    base.update(s, dt); turned.update(s, dt);
    const a = rel(base, s), b = rel(turned, s);
    const angle = Math.acos((a.x * b.x + a.z * b.z) / Math.hypot(a.x, a.z) / Math.hypot(b.x, b.z));
    expect(angle).toBeGreaterThan(1.2);
    // no drag for a while (car keeps driving): back behind the car
    for (let k = 1; k < Math.round((LOOK_RECENTER_S + 4) / dt); k++) turned.update(fakeState(t0 + 30 * dt), dt);
    expect(Math.abs(L.yaw)).toBeLessThan(0.05);
  });
});
