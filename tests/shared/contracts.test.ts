import { describe, expect, it } from 'vitest';
import { TRACK, profileLength, sampleProfile, rampLocalToWorld } from '../../src/shared/track';
import { ROADSTER } from '../../src/shared/roadster';
import { DEG, hudPitchDeg, qaxisAngle, qrot, rollDeg, v3cross, v3len } from '../../src/shared/math';
import { NOZZLE_COUNT } from '../../src/shared/types';

describe('shared contracts', () => {
  it('wall ramp shaped like the stream: bend R 9.8 to vertical, 4.3 m straight, curl R 8 to 185°; ≈ 5 m wide', () => {
    const wall = TRACK.ramps.find((r) => r.kind === 'wallRamp')!;
    const L = profileLength(wall.profile);
    const end = sampleProfile(wall.profile, L);
    expect(end.thetaRad / DEG).toBeCloseTo(185, 3);
    const sTop90 = 9.8 * Math.PI / 2;
    expect(sampleProfile(wall.profile, sTop90).y).toBeCloseTo(9.8, 3);                 // end of the bend
    expect(sampleProfile(wall.profile, sTop90 + 4.3).y).toBeCloseTo(14.1, 3);          // top of the straight
    expect(sampleProfile(wall.profile, sTop90 + 4.3).thetaRad / DEG).toBeCloseTo(90, 3);
    const s170 = sTop90 + 4.3 + 8 * (80 * DEG);
    expect(sampleProfile(wall.profile, s170).y).toBeCloseTo(14.1 + 8 * Math.sin(80 * DEG), 3);
    // HUD hang altitude at 170° body pitch: surface − 0.45 m CoG offset·|cos| − 0.45 m (HUD zero) ≈ 21.06 m (69.1 ft)
    expect(14.1 + 8 * Math.sin(80 * DEG) - 0.45 * Math.cos(10 * DEG) - 0.45).toBeCloseTo(21.06, 1);
    expect(wall.width).toBeCloseTo(5, 3);
  });
  it('kicker lip ~2.35 m', () => {
    const k = TRACK.ramps.find((r) => r.kind === 'kicker')!;
    const end = sampleProfile(k.profile, profileLength(k.profile));
    expect(end.y).toBeCloseTo(2.37, 1);
  });
  it('body frame is right-handed with +X left', () => {
    const c = v3cross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(c.z).toBe(1);
    const fl = ROADSTER.wheels.find((w) => w.id === 'FL')!;
    expect(fl.pos.x).toBeGreaterThan(0);
  });
  it('10 nozzles with unit directions', () => {
    expect(ROADSTER.nozzles.length).toBe(NOZZLE_COUNT);
    for (const n of ROADSTER.nozzles) expect(v3len(n.dir)).toBeCloseTo(1, 6);
    const yawL = ROADSTER.nozzles.find((n) => n.name === 'YAW_L')!;
    // yaw torque about +Y from left-front nozzle pushing toward -X must turn the nose right (negative about +Y)
    const tq = v3cross(yawL.pos, yawL.dir);
    expect(tq.y).toBeLessThan(0);
  });
  it('HUD pitch convention: nose up positive, past vertical continues to 170', () => {
    const noseUp30 = qaxisAngle({ x: -1, y: 0, z: 0 }, 30 * DEG);
    expect(hudPitchDeg(noseUp30)).toBeCloseTo(30, 4);
    const q170 = qaxisAngle({ x: -1, y: 0, z: 0 }, 170 * DEG);
    expect(hudPitchDeg(q170)).toBeCloseTo(170, 4);
    const rightDown = qaxisAngle({ x: 0, y: 0, z: 1 }, 20 * DEG);
    expect(rollDeg(rightDown)).toBeCloseTo(20, 4);
    expect(qrot(noseUp30, { x: 0, y: 0, z: 1 }).y).toBeGreaterThan(0);
  });
  it('ramp local->world respects heading', () => {
    const w = rampLocalToWorld({ ...TRACK.ramps[0], headingDeg: 90, origin: { x: 0, y: 0, z: 0 } }, { x: 0, y: 0, z: 10 });
    expect(w.x).toBeCloseTo(10, 6);
  });
});
