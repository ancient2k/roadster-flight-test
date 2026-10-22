// Retro look of the editor (a 1990 DOS game, drawn for this project): a small VGA-like palette, crisp pixel
// lettering (system font rendered at 8–12 px and thresholded, so every script works), and top-view icons of the
// track pieces computed from their real geometry (src/shared/parts.ts).
import { buildPart, partDef, placeTris, type MatKey, type PartType } from '../shared/parts';

export const VGA = {
  black: '#000000', navy: '#0000aa', blue: '#0055ff', cyan: '#00aaaa', ltcyan: '#55ffff',
  grey: '#aaaaaa', dkgrey: '#555555', white: '#ffffff', yellow: '#ffff55', red: '#aa0000', ltred: '#ff5555',
  green: '#00aa00', ltgreen: '#55ff55', brown: '#aa5500', sand: '#c8b47a', field: '#86867c', fieldLine: '#6c6c64',
};

const MAT_COLOUR: Record<MatKey, [number, number, number]> = {
  asphalt: [58, 58, 60], paint: [255, 255, 255], concrete: [200, 198, 188], curb: [216, 48, 48], steel: [90, 96, 112],
  red: [220, 40, 40], glow: [255, 96, 64], pad: [64, 176, 224],
};

/**
 * Text as crisp pixels: rendered at `px` size with the system font into a small canvas, alpha thresholded,
 * then returned as a canvas to be drawn scaled up with image smoothing off.
 */
export function pixelText(text: string, px: number, colour: string, bold = true, spacing = 0): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = `${bold ? '700 ' : ''}${px}px ui-monospace, "Courier New", monospace`;
  g.font = font;
  const chars = [...text];
  const adv = chars.map((ch) => g.measureText(ch).width + spacing);
  const w = Math.ceil(adv.reduce((a, b) => a + b, 0)) + 2, h = Math.ceil(px * 1.3) + 2;
  c.width = w; c.height = h;
  g.font = font;
  g.textBaseline = 'top';
  g.fillStyle = colour;
  let x = 1;
  chars.forEach((ch, k) => { g.fillText(ch, Math.round(x), 1); x += adv[k]; });
  const img = g.getImageData(0, 0, w, h);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] > 110 ? 255 : 0;
  g.putImageData(img, 0, 0);
  return c;
}

/** Big pixel title with a hard drop shadow (entry screen, header). */
export function pixelTitle(text: string, scale: number, colour = VGA.yellow, shadow = VGA.red): HTMLCanvasElement {
  const a = pixelText(text, 11, colour, true, 1.5), s = pixelText(text, 11, shadow, true, 1.5);
  const c = document.createElement('canvas');
  c.width = (a.width + 1) * scale; c.height = (a.height + 1) * scale;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(s, scale, scale, s.width * scale, s.height * scale);
  g.drawImage(a, 0, 0, a.width * scale, a.height * scale);
  c.className = 'rfte-pixel';
  return c;
}

const iconCache = new Map<string, HTMLCanvasElement>();

/**
 * Top view of a piece: its triangles projected onto (x, z), lighter with height, drawn at `pxPerTile` per tile.
 * North (−z) is up, so the editor shows the build area like a map.
 */
export function partIcon(type: PartType, rot: number, pxPerTile = 16): HTMLCanvasElement {
  const key = `${type}|${rot}|${pxPerTile}`;
  const hit = iconCache.get(key);
  if (hit) return hit;
  const def = partDef(type);
  const [w, d] = rot % 2 === 0 ? [def.w, def.d] : [def.d, def.w];
  const c = document.createElement('canvas');
  c.width = w * pxPerTile; c.height = d * pxPerTile;
  const g = c.getContext('2d')!;
  const mesh = buildPart(type);
  const tris: { y: number; col: [number, number, number]; p: number[] }[] = [];
  const add = (mat: MatKey, src: Float32Array, lift: number) => {
    const t = placeTris(src, def, 0, 0, rot, 0);     // metres, footprint at the origin
    for (let k = 0; k < t.length; k += 9) {
      const y = Math.max(t[k + 1], t[k + 4], t[k + 7]) + lift;
      tris.push({ y, col: MAT_COLOUR[mat], p: [t[k], t[k + 2], t[k + 3], t[k + 5], t[k + 6], t[k + 8]] });
    }
  };
  for (const s of mesh.decals) add(s.mat, s.tris, 0);
  for (const s of mesh.solids) add(s.mat, s.tris, 0.01);
  tris.sort((a, b) => a.y - b.y);
  const k = pxPerTile / 20;
  for (const t of tris) {
    const light = Math.min(1.35, 0.8 + t.y / 30);
    g.fillStyle = `rgb(${Math.min(255, t.col[0] * light) | 0},${Math.min(255, t.col[1] * light) | 0},${Math.min(255, t.col[2] * light) | 0})`;
    g.beginPath();
    g.moveTo(t.p[0] * k, t.p[1] * k); g.lineTo(t.p[2] * k, t.p[3] * k); g.lineTo(t.p[4] * k, t.p[5] * k);
    g.closePath(); g.fill();
  }
  // posterise to the palette look: no anti-aliased edges
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] > 100 ? 255 : 0;
  g.putImageData(img, 0, 0);
  iconCache.set(key, c);
  return c;
}

/** Deco symbol (palette and grid): a few pixels in its colour. */
export function decoColour(type: string): string {
  return type === 'cone' ? '#ff7a1a' : type === 'barrel' ? VGA.ltred : type === 'container' ? '#3a6ea5' : type === 'light_mast' ? VGA.yellow : VGA.grey;
}
