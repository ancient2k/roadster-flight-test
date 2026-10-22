// pure render logic (no GPU): camera maths, broadcast director, dynamic resolution,
// eye adaptation, effect parameters and the fake show reel.
import { describe, expect, it } from 'vitest';
import {
  smoothDamp, angleDelta, dampAngle, chaseYaw, chaseOffset, BroadcastDirector, BROADCAST_SHOTS, nearestSite, shotScore,
} from '../../src/render/cameraMath';
import { DynamicResolution, QUALITY_PRESETS, settingsForBackend, targetExposure, adaptExposure, NIGHT_EXPOSURE, BASE_EXPOSURE, REF_SCENE_LUM } from '../../src/render/quality';
import { plumeParams, tireSmokeRate, brakeLightOn } from '../../src/render/fxParams';
import { fakeState, LOOP_S, SEGMENTS } from '../../src/render/fakeState';
import { ROADSTER } from '../../src/shared/roadster';
import { TRACK, sampleRamp } from '../../src/shared/track';
import { DEG, hudPitchDeg, rollDeg, qrot } from '../../src/shared/math';
import type { WheelState } from '../../src/shared/types';

describe('camera maths', () => {
  it('smoothDamp converges without overshoot', () => {
    const s = { value: 0, vel: 0 };
    let maxV = 0;
    for (let i = 0; i < 240; i++) { smoothDamp(s, 10, 0.3, 1 / 60); maxV = Math.max(maxV, s.value); }
    expect(s.value).toBeCloseTo(10, 2);
    expect(maxV).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('angle helpers wrap correctly', () => {
    expect(angleDelta(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(0.2, 9);
    expect(angleDelta(-3, 3)).toBeCloseTo(2 * Math.PI - 6, 9);
    // damping across the ±pi seam takes the short way
    const a = dampAngle(Math.PI - 0.05, -Math.PI + 0.05, 50, 1);
    expect(Math.abs(angleDelta(a, -Math.PI + 0.05))).toBeLessThan(1e-6);
  });

  it('chase yaw follows velocity, falls back to body forward, null when pointing up', () => {
    expect(chaseYaw({ x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: 0 })).toBeCloseTo(90 * DEG, 9);
    expect(chaseYaw({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 })).toBeCloseTo(0, 9);
    expect(chaseYaw({ x: 0, y: 1, z: 0.01 }, { x: 0, y: 5, z: 0 })).toBeNull();
    expect(chaseYaw({ x: 0, y: 0, z: 1 }, { x: 0.3, y: 0, z: -4 })).toBeCloseTo(0, 9);   // reversing: stays behind the car
  });

  it('chase camera sits behind and above the target', () => {
    const p = chaseOffset({ x: 0, y: 1, z: 0 }, 0, 0);
    expect(p.z).toBeLessThan(-6);
    expect(p.y).toBeGreaterThan(2.5);
    const q = chaseOffset({ x: 0, y: 1, z: 0 }, Math.PI / 2, 50);
    expect(q.x).toBeLessThan(-9); // heading +X -> camera at -X, further back at speed
  });
});

describe('broadcast director', () => {
  it('every site has shots and every shot looks into the scene', () => {
    for (const site of ['ramp_hang', 'ramp_launch', 'kickflip', 'zero60', 'ground_flip', 'overview']) {
      expect(BROADCAST_SHOTS.some((s) => s.site === site)).toBe(true);
    }
    for (const s of BROADCAST_SHOTS) expect(s.pos.y).toBeGreaterThan(0.2);
  });

  it('maps positions to stunt sites', () => {
    expect(nearestSite({ x: -45, y: 0, z: -40 })).toBe('kickflip');
    expect(nearestSite({ x: 60, y: 10, z: 62 })).toBe('ramp_hang');
    expect(nearestSite({ x: 0, y: 0, z: -110 })).toBe('zero60');
    expect(nearestSite({ x: 0, y: 0.4, z: -117.7 })).toBe('zero60'); // 0-60 start in front of the gate
    expect(nearestSite({ x: -45, y: 0, z: -95 })).toBe('kickflip');   // kickflip run-up
    expect(nearestSite({ x: 500, y: 0, z: 500 })).toBe('overview');
    expect(nearestSite({ x: -45, y: 0.5, z: 25 })).toBe('kickflip');   // landing/rollout beyond the row
  });
  it('low ramp cameras give up the car once it flies high (stream: broadside for the roll)', () => {
    const low = BROADCAST_SHOTS.find((x) => x.id === 'kick_low')!;
    const side = BROADCAST_SHOTS.find((x) => x.id === 'kick_broadside')!;
    const flying = { x: -45, y: 8, z: -20 };
    expect(shotScore(side, flying)).toBeGreaterThan(shotScore(low, flying));
    const d = new BroadcastDirector();
    let r = d.update({ x: -45, y: 0.5, z: -60 }, 1 / 60);
    for (let i = 0; i < 240; i++) r = d.update(flying, 1 / 60);
    expect(r.shot.id).not.toBe('kick_low');
  });

  it('holds a shot for the minimum time and cuts when the car changes site', () => {
    const d = new BroadcastDirector();
    const kick = { x: -45, y: 1, z: -50 };
    let r = d.update(kick, 1 / 60);
    expect(r.cut).toBe(true);
    expect(r.shot.site).toBe('kickflip');
    let cuts = 0;
    for (let i = 0; i < 60; i++) { r = d.update(kick, 1 / 60); if (r.cut) cuts++; }
    expect(cuts).toBe(0); // within minHold
    // teleport to the wall ramp
    for (let i = 0; i < 200; i++) { r = d.update({ x: 60, y: 5, z: 58 }, 1 / 60); if (r.shot.site === 'ramp_hang') break; }
    expect(r.shot.site).toBe('ramp_hang');
  });

  it('forced shot is honoured', () => {
    const d = new BroadcastDirector();
    d.forced = 'z60_front';
    expect(d.update({ x: -45, y: 0, z: -40 }, 0.016).shot.id).toBe('z60_front');
  });

  // the stream's phase cameras. Paths are the GNC runs (fastForward, 4 Hz samples [t, x, y, z]).
  const run = (d: BroadcastDirector, path: number[][]) => {
    const seq: { t: number; id: string }[] = [];
    let cuts = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const [t0, x0, y0, z0] = path[i], [t1, x1, y1, z1] = path[i + 1];
      const vel = { x: (x1 - x0) / (t1 - t0), y: (y1 - y0) / (t1 - t0), z: (z1 - z0) / (t1 - t0) };
      for (let t = t0; t < t1; t += 1 / 60) {
        const k = (t - t0) / (t1 - t0);
        const r = d.update({ x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, z: z0 + (z1 - z0) * k }, 1 / 60, vel);
        if (r.cut) cuts++;
        if (!seq.length || seq[seq.length - 1].id !== r.shot.id) seq.push({ t, id: r.shot.id });
      }
    }
    return { seq, cuts };
  };
  it('kickflip: tele approach from behind, broadside for the roll, low camera at the landing', () => {
    const kick = [[0, -45, 0.4, -150], [5, -45, 0.4, -82], [6, -45, 0.4, -62], [7.02, -45, 0.4, -42.6], [7.27, -45, 0.6, -37.7],
      [7.52, -45, 1.8, -33], [7.77, -45, 3.8, -28.6], [8.02, -45, 5.6, -24.4], [8.27, -45.2, 7.1, -20.2], [8.52, -45.6, 8.1, -16.2],
      [8.77, -46, 8.4, -12.1], [9.02, -46.3, 7.8, -7.9], [9.27, -46.4, 6.6, -3.6], [9.52, -46.3, 5, 0.5], [9.77, -46.1, 3.3, 4.4],
      [10.02, -46, 1.9, 8.1], [10.27, -45.9, 1.1, 11.7], [10.52, -45.8, 0.9, 15.3], [11.02, -45.7, 0.6, 22.4], [11.52, -45.6, 0.4, 29.6],
      [12.02, -45.5, 0.4, 36.7], [12.52, -45.4, 0.5, 43.5], [13.3, -45.3, 0.5, 48.1]];
    const { seq, cuts } = run(new BroadcastDirector(), kick);
    const at = (t: number) => [...seq].reverse().find((s) => s.t <= t)!.id;
    expect(at(3)).toBe('kick_rear');
    expect(at(8.6)).toBe('kick_broadside');   // roll over the row (stream 963 s)
    expect(at(9.8)).toBe('kick_land');        // cut while still ~3 m up, touchdown in the cloud (964.5 s)
    expect(cuts).toBeLessThanOrEqual(5);
  });
  it('0-60 and finale: three-quarter camera from behind the start towards the gate, locked-off tele for the flip', () => {
    const z60 = [[0, 0, 0.4, -120], [2.45, 0, 0.4, -120], [2.77, 0, 0.4, -118.2], [3.02, 0, 0.4, -114.5], [3.27, 0, 0.4, -108.8],
      [3.52, 0, 0.4, -102.7], [4.28, 0, 0.4, -94.6]];
    const z = run(new BroadcastDirector(), z60).seq;
    expect(z[0].id).toBe('z60_gate');                       // staging and launch towards the gate
    expect([...z].reverse().find((s) => s.t <= 3.07)!.id).toBe('z60_gate');   // stream still 1267 s
    expect(z.length).toBeLessThanOrEqual(2);                 // at most one cut when it passes the camera
    const fin = [[0, 20, 0.4, 40], [1.02, 20, 1.4, 40], [1.52, 19.9, 5.3, 40], [2.27, 18.7, 8.2, 39.9], [3.02, 18.2, 6.1, 39.8], [4.02, 18.1, 1, 39.8], [6.2, 18.1, 0.4, 39.7]];
    const f = run(new BroadcastDirector(), fin);
    expect(f.seq.map((s) => s.id)).toEqual(['fin_front']);
    const ff = BROADCAST_SHOTS.find((s) => s.id === 'fin_front')!;
    expect(shotScore(ff, { x: 18.7, y: 8.2, z: 39.9 })).toBeGreaterThan(0);   // apex stays in the locked frame
  });
  it('ramp landing camera only while the car comes back down off the wall', () => {
    const land = BROADCAST_SHOTS.find((s) => s.id === 'wlaunch_land')!;
    expect(land.site).toBe('ramp_launch');
    expect(shotScore(land, { x: 60, y: 8, z: 51 }, { x: 0, y: -4, z: -2 })).toBeGreaterThan(0.5);         // dropping off the overhang
    expect(shotScore(land, { x: 60, y: 1.0, z: 43 }, { x: 0, y: -1, z: -1.5 })).toBeGreaterThan(0.5);    // touchdown ≈ 17 m out (R15)
    expect(shotScore(land, { x: 60, y: 0.4, z: 55 }, { x: 0, y: 0, z: 7 })).toBeLessThan(0);      // approach
    expect(shotScore(land, { x: 60, y: 19, z: 66 }, { x: 0, y: 0, z: -2 })).toBeLessThan(0);      // high on the wall
  });

  // GNC runs of the two wall-ramp stunts (real-time recordings, 0.5 s samples [t, x, y, z]); ramp entry at
  // t ≈ 9 s / 6.7 s. Both run on the same ramp, so the director needs the stunt to pick the launch set.
  const HANG = [[3,60,0.4,30],[4,60,0.4,33.6],[5,60,0.4,41.9],[6,60,0.4,48.9],[7,60,0.4,54.2],[8,60,0.4,57.7],[8.5,60,0.4,59],[9,60,0.5,60.7],
    [9.5,60,0.9,62.7],[10,60,1.5,64.3],[10.5,60,2.7,66.4],[11,60,4.3,68],[11.5,60,6.1,69.2],[12,60,7.9,69.9],[13,60,10.4,70.4],[15,60,11.1,70.4],
    [16,60,13.2,70.1],[17,60,17.1,68.3],[18,60,20,65],[19,60,21.1,61.9],[20,60,21.5,60.3],[29,60,21.5,60.3],[30,60,21.1,61.9],[31,60,20.5,63.9],
    [32,60,18.9,66.7],[33,60,16.3,68.9],[34,60,13.2,70.1],[35,60,9.9,70.4],[36,60,6.7,69.5],[37,60,3.9,67.7],[38,60,1.8,65.1],[39,60,0.7,62.2],
    [40,60,0.5,60.2],[41,60,0.4,57.2],[41.5,60,0.4,55.8],[44,60,0.4,55.8]];
  const LAUNCH = [[2,60,0.4,30],[3,60,0.4,35.4],[4,60,0.4,42.1],[5,60,0.4,48.7],[6,60,0.4,55.1],[6.5,60,0.4,58.4],[7,60,0.6,61.5],[7.5,60,1.5,64.5],
    [8,60,3.3,67],[8.5,60,5.9,69.1],[9,60,9.4,70.3],[9.5,60,13.6,70],[10,60,17.5,68],[10.5,60,20.3,64.4],[11,60,21.5,60.2],[11.5,60,22.1,56.7],
    [12,60,22.6,54],[12.5,60,22.5,51.9],[13,59.6,19.8,50],[13.5,58.9,14.4,48.1],[14,58,9.2,46.2],[14.5,57.4,5.3,44.8],[15,57.1,2.6,44],
    [15.5,56.9,1.1,43.6],[16,56.8,0.7,43.2],[16.5,56.7,0.5,42.9],[17,56.7,0.5,42.5],[17.5,56.7,0.5,40.3],[18,56.7,0.5,37.8],
    [18.5,56.7,0.5,35.1],[19,56.7,0.5,32.5],[19.5,56.6,0.5,29.8],[20,56.6,0.5,27.1],[20.5,56.5,0.5,24.6],[21,56.5,0.5,23.9],[23,56.5,0.5,23.9]];
  const stuntDirector = (stunt: 'ramp_hang' | 'ramp_launch') => { const d = new BroadcastDirector(); d.stunt = stunt; return d; };
  it('wall ramp hang: the long rear lens only at the foot, the wide shot for the hang (stream 674–710 s)', () => {
    const { seq } = run(stuntDirector('ramp_hang'), HANG);
    const at = (t: number) => [...seq].reverse().find((s) => s.t <= t)!.id;
    for (let t = 12; t <= 36; t += 0.5) expect(at(t), `t = ${t}`).not.toBe('wall_rear');
    for (let t = 19; t <= 30; t += 0.5) expect(at(t), `t = ${t}`).toBe('wall_side');   // hang: the car is under the overhang
    for (const s of seq) expect(s.id.startsWith('wall_'), s.id).toBe(true);
    // no ping-pong: every shot after the first is held at least half the minimum hold
    for (let i = 1; i + 1 < seq.length; i++) expect(seq[i + 1].t - seq[i].t, `${seq[i].id} at ${seq[i].t}`).toBeGreaterThan(1.2);
  });
  it('ramp launch: its own camera set, the drop and the touchdown on the landing camera', () => {
    const { seq } = run(stuntDirector('ramp_launch'), LAUNCH);
    const at = (t: number) => [...seq].reverse().find((s) => s.t <= t)!.id;
    for (const s of seq) expect(s.id.startsWith('wlaunch_'), s.id).toBe(true);
    for (let t = 10; t <= 15; t += 0.5) expect(at(t), `t = ${t}`).not.toBe('wlaunch_rear');
    expect(at(14.5)).toBe('wlaunch_land');   // falling, ≈ 5 m up
    expect(at(16.5)).toBe('wlaunch_land');   // touchdown / rollout
    for (let t = 17; t <= 23; t += 0.5) expect(at(t), `t = ${t}`).toBe('wlaunch_land');   // drives off out of the cloud, stops
    for (let i = 1; i + 1 < seq.length; i++) expect(seq[i + 1].t - seq[i].t, `${seq[i].id} at ${seq[i].t}`).toBeGreaterThan(1.2);
  });

  it('fixed framings score the car negatively when it is out of the view cone', () => {
    const s = BROADCAST_SHOTS.find((x) => x.id === 'wall_side')!;
    expect(shotScore(s, { x: 60, y: 12, z: 66 })).toBeGreaterThan(shotScore(s, { x: -100, y: 0, z: -150 }));
  });
});

describe('quality and dynamic resolution', () => {
  it('presets get monotonically more expensive', () => {
    const order = ['low', 'medium', 'high', 'ultra'] as const;
    for (let i = 1; i < order.length; i++) {
      expect(QUALITY_PRESETS[order[i]].particleBudget).toBeGreaterThanOrEqual(QUALITY_PRESETS[order[i - 1]].particleBudget);
      expect(QUALITY_PRESETS[order[i]].shadowMapSize).toBeGreaterThanOrEqual(QUALITY_PRESETS[order[i - 1]].shadowMapSize);
    }
    expect(QUALITY_PRESETS.high.traa && QUALITY_PRESETS.high.ao && QUALITY_PRESETS.high.ssr).toBe(true);
  });

  it('WebGL2 fallback drops SSR and motion blur', () => {
    const s = settingsForBackend('ultra', 'webgl2');
    expect(s.ssr).toBe(false);
    expect(s.motionBlur).toBe(false);
    expect(QUALITY_PRESETS.ultra.ssr).toBe(true); // preset itself untouched
  });

  it('steps down under load, back up with hysteresis, ignores single spikes', () => {
    const dr = new DynamicResolution([1, 0.85, 0.7], 1000 / 60, 10);
    for (let i = 0; i < 40; i++) dr.update(16);
    expect(dr.scale).toBe(1);
    dr.update(200); // one hitch
    for (let i = 0; i < 5; i++) dr.update(16);
    expect(dr.scale).toBe(1);
    for (let i = 0; i < 200; i++) dr.update(24);
    expect(dr.scale).toBeLessThan(1);
    const low = dr.scale;
    for (let i = 0; i < 400; i++) dr.update(9);
    expect(dr.scale).toBeGreaterThan(low);
  });
});

describe('eye adaptation', () => {
  it('maps darker scenes to higher exposure within limits', () => {
    // within the working range around the calibrated reference luminance (REF_SCENE_LUM)
    expect(targetExposure(REF_SCENE_LUM * 0.9)).toBeGreaterThan(targetExposure(REF_SCENE_LUM * 1.1));
    expect(targetExposure(REF_SCENE_LUM)).toBeCloseTo(BASE_EXPOSURE, 6);
    // adaptation is limited to ±0.3 EV around the calibrated base exposure
    expect(NIGHT_EXPOSURE.max / NIGHT_EXPOSURE.min).toBeCloseTo(2 ** 0.6, 6);
    expect(targetExposure(1e-6)).toBe(NIGHT_EXPOSURE.max);
    expect(targetExposure(100)).toBe(NIGHT_EXPOSURE.min);
  });
  it('adapts faster to brighter scenes', () => {
    const down = adaptExposure(1.5, 0.5, 0.1) - 1.5; // getting brighter -> exposure drops
    const up = adaptExposure(0.5, 1.5, 0.1) - 0.5;
    expect(Math.abs(down)).toBeGreaterThan(Math.abs(up));
    expect(adaptExposure(1, 2, 0)).toBe(1);
  });
});

describe('effect parameters', () => {
  const main = ROADSTER.nozzles[0];
  it('closed nozzle is invisible', () => {
    expect(plumeParams(main, { open: false, thrustN: 0, massFlowKgS: 0, exitPressureRatio: 1 }).intensity).toBe(0);
  });
  it('higher pressure ratio -> longer shock cells, more diamonds', () => {
    const lo = plumeParams(main, { open: true, thrustN: 20500, massFlowKgS: 31, exitPressureRatio: 1.5 });
    const hi = plumeParams(main, { open: true, thrustN: 20500, massFlowKgS: 31, exitPressureRatio: 4 });
    expect(hi.cellSpacing).toBeGreaterThan(lo.cellSpacing);
    expect(hi.diamondStrength).toBeGreaterThan(lo.diamondStrength);
    expect(hi.length).toBeGreaterThanOrEqual(lo.length);
    expect(hi.length).toBeLessThanOrEqual(9);
  });
  it('perfectly expanded jet shows no diamonds', () => {
    expect(plumeParams(main, { open: true, thrustN: 20500, massFlowKgS: 31, exitPressureRatio: 1 }).diamondStrength).toBe(0);
  });
  it('tyre smoke needs slip and contact', () => {
    const w = (o: Partial<WheelState>): WheelState => ({ id: 'RL', contact: true, compression: 0.03, suspensionForceN: 4000, slipRatio: 0, slipAngleRad: 0,
      angularVel: 50, steerRad: 0, normalLoadN: 4500, contactPoint: { x: 0, y: 0, z: 0 }, surfaceNormal: { x: 0, y: 1, z: 0 }, ...o });
    expect(tireSmokeRate(w({}), 20)).toBe(0);
    expect(tireSmokeRate(w({ slipRatio: 0.6, angularVel: 120 }), 10)).toBeGreaterThan(50);
    expect(tireSmokeRate(w({ contact: false, slipRatio: 0.6, angularVel: 120 }), 10)).toBe(0);
  });
  it('brake light heuristic', () => {
    expect(brakeLightOn(-6, true, 20)).toBe(true);
    expect(brakeLightOn(3, true, 20)).toBe(false);
    expect(brakeLightOn(-6, false, 20)).toBe(false);
  });
});

describe('fake show reel (title demo)', () => {
  it('is continuous enough and covers every segment', () => {
    expect(SEGMENTS.map((s) => s.id)).toEqual(['kickflip', 'ramp_hang', 'zero60', 'ground_flip']);
    let prev = fakeState(0);
    let maxJump = 0;
    for (let t = 1 / 60; t < LOOP_S; t += 1 / 60) {
      const s = fakeState(t, prev);
      const same = SEGMENTS.find((g) => t >= g.t0 && t < g.t1) === SEGMENTS.find((g) => prev.t >= g.t0 && prev.t < g.t1);
      if (same) maxJump = Math.max(maxJump, Math.hypot(s.pos.x - prev.pos.x, s.pos.y - prev.pos.y, s.pos.z - prev.pos.z));
      expect(Number.isFinite(s.pos.x + s.pos.y + s.pos.z)).toBe(true);
      expect(s.nozzles.length).toBe(10);
      prev = s;
    }
    expect(maxJump).toBeLessThan(1.5); // < 90 m/s between frames
  });
  it('hangs inverted near the top of the wall ramp (pitch ~170°, ~21 m)', () => {
    const seg = SEGMENTS.find((s) => s.id === 'ramp_hang')!;
    let best = 0, alt = 0;
    for (let t = seg.t0; t < seg.t1; t += 0.05) {
      const s = fakeState(t);
      const p = hudPitchDeg(s.quat);
      if (p > best) { best = p; alt = s.pos.y; }
    }
    expect(best).toBeGreaterThan(160);
    expect(alt).toBeGreaterThan(18);
  });
  it('kickflip completes a full roll and clears the semi', () => {
    const semi = TRACK.obstacles.find((o) => o.model === 'semi')!;
    let rollSum = 0, prevRoll = 0, maxYOverSemi = 0;
    for (let t = 0; t < 13; t += 0.01) {
      const s = fakeState(t);
      const r = rollDeg(s.quat);
      let d = r - prevRoll; if (d > 180) d -= 360; if (d < -180) d += 360;
      rollSum += d; prevRoll = r;
      if (Math.abs(s.pos.z - semi.center.z) < semi.size.x / 2) maxYOverSemi = Math.max(maxYOverSemi, s.pos.y);
      const up = qrot(s.quat, { x: 0, y: 1, z: 0 });
      expect(Number.isFinite(up.y)).toBe(true);
    }
    expect(Math.abs(rollSum)).toBeGreaterThan(340);
    expect(maxYOverSemi).toBeGreaterThan(semi.size.y + 1);
  });
});

describe('ramp geometry source', () => {
  it('wall ramp profile reaches ~21 m and curls past vertical', () => {
    const wall = TRACK.ramps.find((r) => r.kind === 'wallRamp')!;
    const S = sampleRamp(wall, 0.2);
    const top = S[S.length - 1];
    expect(top.y).toBeGreaterThan(19);
    expect(top.thetaRad / DEG).toBeGreaterThan(160);
  });
});
