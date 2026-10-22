// Share link: deflate + base64url in the URL fragment, round trip and size.
import { describe, expect, it } from 'vitest';
import { decodeLevel, encodeLevel, trackCodeFromHash } from '../../src/editor/share';
import { validateLevel } from '../../src/shared/level';
import sprint from '../../src/editor/samples/starbase-sprint.json';

describe('share link', () => {
  it('round-trips a level and stays short', async () => {
    const L = validateLevel(sprint, { nx: 48, nz: 36 }).level;
    const code = await encodeLevel(L);
    expect(code).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(code.length).toBeLessThan(1500);
    const back = await decodeLevel(code, { nx: 48, nz: 36 });
    expect(back.level.parts).toEqual(L.parts);
    expect(back.level.deco).toEqual(L.deco);
    expect(trackCodeFromHash(`#track=${code}`)).toBe(code);
    await expect(decodeLevel('nonsense', { nx: 48, nz: 36 })).rejects.toThrow();
  });
});
