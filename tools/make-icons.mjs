// App icons for the web app manifest and iOS (public/icons/). Own motif: the HUD gauge arc with a red
// thrust chevron rising through it, white on black; no third-party logos. Run: node tools/make-icons.mjs
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = 'public/icons';
mkdirSync(OUT, { recursive: true });

/** Motif on a 512 grid; `k` scales it around the centre (maskable icons keep it inside the 80 % safe zone). */
function svg({ k = 1, round = true } = {}) {
  // 245° gauge arc like the HUD rings (src/ui/hud/gaugeMath.ts), open at the bottom
  const cx = 256, cy = 262, r = 168, a0 = (90 + 57.5) * Math.PI / 180, sweep = 245 * Math.PI / 180;
  const pt = (a) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  const arc = (from, to) => `M ${pt(from)} A ${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${pt(to)}`;
  const fillTo = a0 + sweep * 0.68;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" ${round ? 'rx="112"' : ''} fill="#000"/>
  <g transform="translate(256 256) scale(${k}) translate(-256 -256)" fill="none" stroke-linecap="round">
    <path d="${arc(a0, a0 + sweep)}" stroke="#3c3c3c" stroke-width="22"/>
    <path d="${arc(a0, fillTo)}" stroke="#fff" stroke-width="22"/>
    <path d="M 186 318 L 256 206 L 326 318" stroke="#e8261c" stroke-width="34" stroke-linejoin="round"/>
    <path d="M 214 372 L 256 306 L 298 372" stroke="#e8261c" stroke-width="24" stroke-linejoin="round" opacity=".6"/>
  </g>
</svg>`;
}

const png = (s, size, file) => sharp(Buffer.from(s)).resize(size, size).png({ compressionLevel: 9 }).toFile(`${OUT}/${file}`);

writeFileSync(`${OUT}/icon.svg`, svg());
await png(svg(), 192, 'icon-192.png');
await png(svg(), 512, 'icon-512.png');
// maskable: full-bleed background, motif within the inner 80 % circle
await png(svg({ k: 0.95, round: false }), 512, 'icon-maskable-512.png');
// iOS draws its own rounded corners and ignores transparency
await png(svg({ k: 0.9, round: false }), 180, 'apple-touch-icon.png');
console.log('icons written to', OUT);
