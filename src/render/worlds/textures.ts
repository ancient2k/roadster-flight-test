// Texture loading for the world terrain: macro albedo/splat (grid-aligned, flipY off so row 0 = north),
// and tiling detail layers (diff/nor/arm) with their mean albedo. Missing files resolve to null.
import * as THREE from 'three/webgpu';
import type { DetailLayer } from './terrain';

const loader = new THREE.TextureLoader();

async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok && !(r.headers.get('content-type') ?? '').includes('text/html');
  } catch { return false; }
}

export async function loadTex(url: string | null, opts: { srgb: boolean; flipY?: boolean; repeat?: boolean; anisotropy?: number }): Promise<THREE.Texture | null> {
  if (!url || !(await exists(url))) return null;
  try {
    const t = await loader.loadAsync(url);
    t.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.flipY = opts.flipY ?? true;
    t.wrapS = t.wrapT = opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.anisotropy = opts.anisotropy ?? 8;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  } catch (e) {
    console.warn('[worlds] Textur nicht ladbar:', url, e);
    return null;
  }
}

/** Mean linear colour of an image texture (16×16 downsample). */
export function meanLinear(t: THREE.Texture): [number, number, number] {
  const img = t.image as CanvasImageSource & { width: number; height: number };
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    const lin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += lin(d[i]); gg += lin(d[i + 1]); b += lin(d[i + 2]); }
    const n = d.length / 4;
    return [Math.max(1e-3, r / n), Math.max(1e-3, gg / n), Math.max(1e-3, b / n)];
  } catch { return [0.25, 0.25, 0.25]; }
}

/**
 * Detail layer by name. Looks for the world pipeline's files in the site directory (detail_<name>_diff.jpg / _nor.jpg /
 * _arm.jpg), then in an optional fallback directory with Poly Haven naming (<folder>/<folder>_diff_2k.jpg …).
 */
export async function loadDetailLayer(
  dir: string, name: string, scaleM: number, fallback?: { base: string; folder: string } | null, anisotropy = 8, sharedDir?: string,
): Promise<DetailLayer | null> {
  const tries: [string, string, string][] = [];
  if (sharedDir) {
    // _shared/detail/<name>_{diff,nor,arm}.jpg, tile size in detail.json
    try {
      const r = await fetch(`${sharedDir}/detail.json`);
      if (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html')) {
        const j = await r.json() as Record<string, { tileM?: number }>;
        if (j[name]?.tileM) scaleM = j[name].tileM!;
      }
    } catch { /* keep default scale */ }
    tries.push([`${sharedDir}/${name}_diff.jpg`, `${sharedDir}/${name}_nor.jpg`, `${sharedDir}/${name}_arm.jpg`]);
  }
  tries.push([`${dir}/detail_${name}_diff.jpg`, `${dir}/detail_${name}_nor.jpg`, `${dir}/detail_${name}_arm.jpg`]);
  if (fallback) {
    const f = `${fallback.base}/${fallback.folder}/${fallback.folder}`;
    tries.push([`${f}_diff_2k.jpg`, `${f}_nor_gl_2k.jpg`, `${f}_arm_2k.jpg`]);
    tries.push([`${f}_diff_1k.jpg`, `${f}_nor_gl_1k.jpg`, `${f}_arm_1k.jpg`]);
  }
  for (const [d, n, a] of tries) {
    const diff = await loadTex(d, { srgb: true, repeat: true, anisotropy });
    if (!diff) continue;
    const [nor, arm] = await Promise.all([
      loadTex(n, { srgb: false, repeat: true, anisotropy }), loadTex(a, { srgb: false, repeat: true, anisotropy }),
    ]);
    return { diff, nor, arm, mean: meanLinear(diff), scaleM };
  }
  return null;
}

/** Which Poly Haven set stands in for a detail name until ships detail_*.jpg. */
export const DETAIL_FALLBACK: Record<string, string> = {
  sand: 'aerial_sand', limestone: 'rock_face_03', regolith: 'ground_grey', moon_rock: 'gray_rocks',
  mars_soil: 'red_sand', mars_rock: 'dry_riverbed_rock', grass: 'rock_ground', chalk: 'rock_ground', rock: 'dark_rock',
};
