// Roads painted onto loose ground (level editor): the tyres see asphalt there, the sand elsewhere.
import { describe, expect, it } from 'vitest';
import { pavedLookup } from '../../../src/shared/paved';
import { surfaceAtPoint } from '../../../src/sim/vehicle/surfaces';

// a 10 m wide road from x = 0 to 100 along z = −5..5 (two triangles)
const road = new Float32Array([0, 0, -5, 100, 0, -5, 100, 0, 5, 0, 0, -5, 100, 0, 5, 0, 0, 5]);

describe('paved roads on loose ground', () => {
  it('point lookup', () => {
    const p = pavedLookup(road)!;
    expect(p(50, 0)).toBe(true);
    expect(p(1, 4.9)).toBe(true);
    expect(p(50, 6)).toBe(false);
    expect(p(-1, 0)).toBe(false);
    expect(pavedLookup(new Float32Array(0))).toBeNull();
  });
  it('the tyre surface is asphalt on the road, the site sand beside it; ramps stay concrete', () => {
    const sim = { surface: 'sand' as const, hardGround: [], paved: pavedLookup(road) };
    expect(surfaceAtPoint('ground', sim, 50, 0)).toBe('asphalt');
    expect(surfaceAtPoint('ground', sim, 50, 8)).toBe('sand');
    expect(surfaceAtPoint('landmark', sim, 50, 0)).toBe('concrete');
    expect(surfaceAtPoint('ground', { ...sim, paved: null }, 50, 0)).toBe('sand');
  });
});
