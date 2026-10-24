// Renders trailer shots (tools/trailer/shots/<name>.mjs, each exporting `default async (page, h) => …`).
//   npm run build && npx vite preview --port 4173   (in another terminal)
//   node tools/trailer/run.mjs 01-liftoff 02-stonehenge     full 1080p60 frames → trailer-out/<name>.mp4
//   SCOUT=1 node tools/trailer/run.mjs 02-stonehenge          8 stills → trailer-out/scout/<name>.jpg
//   W=3840 H=2160 node tools/trailer/run.mjs …                4K
import * as h from './lib.mjs';

const names = process.argv.slice(2);
const scout = process.env.SCOUT === '1';
// one fresh browser per shot (a world loaded twice in a row renders black)
const errors = [];
for (const name of names) {
  const t0 = Date.now();
  const mod = await import(`./shots/${name}.mjs`), shot = mod.default;
  // a shot may ask for its own CSS viewport (the editor: 1280 × 720 at 1.5× = 1920 × 1080 with larger pixels)
  const W = Number(process.env.W ?? (scout ? 1280 : 1920)), H = Number(process.env.H ?? (scout ? 720 : 1080));
  const vp = mod.viewport ? { width: mod.viewport.width, height: mod.viewport.height, scale: (mod.viewport.scale * W) / 1920 } : { width: W, height: H };
  const o = await h.open({ ...vp, quality: process.env.Q ?? 'ultra' });
  await o.page.evaluate(() => window.__rft.captureBegin());
  const out = await shot(o.page, h, name);
  console.log(`${name}: ${out} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  errors.push(...o.errors.map((e) => `${name}: ${e}`));
  await o.browser.close();
}
console.log(errors.slice(0, 10).join('\n') || 'no errors');
