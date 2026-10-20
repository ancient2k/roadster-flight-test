// 0-60 gate – nozzle trigger of the smoke curtain and the housing proportions from the stream.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { GATE_JET_T0, updateGateFx } from '../../src/render/world/gateFx';
import { SCENE_TIME } from '../../src/render/world/materials';
import { TRACK, siteFor } from '../../src/shared/track';

describe('0-60 gate smoke curtain trigger', () => {
  const s = siteFor('zero60').spawn.pos;
  const at = (dz: number, x = s.x) => updateGateFx(new THREE.Vector3(x, 0.4, s.z + dz));

  it('stays off on the start, opens once the car has left it, re-arms on a new run', () => {
    SCENE_TIME.value = 10;
    at(0);
    expect(GATE_JET_T0.value).toBeLessThan(-1000);
    at(0.03);                                  // settling creep on the start: still off
    expect(GATE_JET_T0.value).toBeLessThan(-1000);
    SCENE_TIME.value = 12.5;
    at(0.2);                                   // launched
    expect(GATE_JET_T0.value).toBeCloseTo(12.4, 5);
    SCENE_TIME.value = 13.5;
    at(6);                                     // further down the lane: no second trigger
    expect(GATE_JET_T0.value).toBeCloseTo(12.4, 5);
    at(0);                                     // restart puts the car back on the start
    expect(GATE_JET_T0.value).toBeLessThan(-1000);
  });

  it('ignores cars elsewhere on the pad', () => {
    SCENE_TIME.value = 20;
    at(0);
    at(5, s.x + 30);
    expect(GATE_JET_T0.value).toBeLessThan(-1000);
  });
});

describe('0-60 gate housing (stream 1267 s)', () => {
  const gate = TRACK.decor.find((d) => d.kind === 'gate')!;
  it('is a low, wide housing rather than a wall', () => {
    expect(gate.size!.y).toBeLessThanOrEqual(5);           // 6.8 m
    expect(gate.size!.x / gate.size!.y).toBeGreaterThan(3);
  });
  it('front face stays where the car is ~1 m short of it at 0.62 s', () => {
    expect(gate.pos.z).toBeCloseTo(-110.5, 3);
    expect(gate.headingDeg).toBe(180);
  });
});
