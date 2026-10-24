// Paved areas painted onto loose ground (the level editor's flat roads and pads lie as decals on the sand of the
// build field, without a collider of their own): a point-in-triangle lookup on the XZ plane, binned on a grid.
// The physics uses it for the tyre profile (asphalt instead of sand), the renderer to keep tracks and dust off it.

export type PavedTest = (x: number, z: number) => boolean;

/** tris: world-space triangles (x, y, z × 3 per triangle); cellM: grid cell size (m). */
export function pavedLookup(tris: Float32Array, cellM = 4): PavedTest | null {
  const n = Math.floor(tris.length / 9);
  if (n === 0) return null;
  const cells = new Map<number, number[]>();
  const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const x0 = Math.min(tris[o], tris[o + 3], tris[o + 6]), x1 = Math.max(tris[o], tris[o + 3], tris[o + 6]);
    const z0 = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]), z1 = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
    for (let i = Math.floor(x0 / cellM); i <= Math.floor(x1 / cellM); i++) {
      for (let j = Math.floor(z0 / cellM); j <= Math.floor(z1 / cellM); j++) {
        const k = key(i, j);
        let a = cells.get(k);
        if (!a) cells.set(k, a = []);
        a.push(o);
      }
    }
  }
  return (x, z) => {
    const a = cells.get(key(Math.floor(x / cellM), Math.floor(z / cellM)));
    if (!a) return false;
    for (const o of a) if (inTri(x, z, tris[o], tris[o + 2], tris[o + 3], tris[o + 5], tris[o + 6], tris[o + 8])) return true;
    return false;
  };
}

function inTri(px: number, pz: number, ax: number, az: number, bx: number, bz: number, cx: number, cz: number): boolean {
  const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
  const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
  const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
