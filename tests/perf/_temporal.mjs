// Temporal stability (development aid for flicker reports): a fixed camera, <n> frames <ms> apart, and the mean
// absolute change between consecutive frames over the whole image and a region – lower = steadier picture.
//   node tests/perf/_temporal.mjs <url> <site> <out prefix> <camX,camY,camZ> <lookX,lookY,lookZ> [region=x,y,w,h] [n=12] [ms=100] [carX,carZ]
import { chromium } from '@playwright/test';
import sharp from 'sharp';
const [url, site, out, camS, lookS, regionS = '0,360,1280,360', n = '12', ms = '100', carS = ''] = process.argv.slice(2);
const cam = camS.split(',').map(Number), look = lookS.split(',').map(Number), region = regionS.split(',').map(Number);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${url}?lang=en&nomenu`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
await page.evaluate((s) => window.__rft.startWorld(s), site);
await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
await page.evaluate(([cam, look, car]) => {
  const st = document.createElement('style'); st.textContent = '.rft-hud{display:none!important}'; document.head.append(st);
  const app = window.__rft.app, rd = app.renderer; rd.setCameraMode('orbit');
  if (car.length === 2) { const b = app.sim.body; const h = rd.worldHandle.surfaceAt(car[0], car[1]); b.setTranslation({ x: car[0], y: h + 0.8, z: car[1] }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true); }
  rd.rig.update = function () { const cm = rd.rig.camera; cm.position.set(cam[0], cam[1], cam[2]); cm.up.set(0, 1, 0); cm.lookAt(look[0], look[1], look[2]); cm.updateMatrixWorld(); };
}, [cam, look, carS ? carS.split(',').map(Number) : []]);
await page.waitForTimeout(3000);
const bufs = [];
for (let i = 0; i < Number(n); i++) { bufs.push(await page.screenshot()); await page.waitForTimeout(Number(ms)); }
await browser.close();
const raw = await Promise.all(bufs.map((b) => sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
const W = raw[0].info.width, [rx, ry, rw, rh] = region;
let all = 0, reg = 0, na = 0, nr = 0;
for (let k = 1; k < raw.length; k++) {
  const a = raw[k - 1].data, b = raw[k].data;
  for (let i = 0; i < a.length; i += 3) {
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    all += d; na++;
    const p = i / 3, x = p % W, y = Math.floor(p / W);
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) { reg += d; nr++; }
  }
}
await sharp(bufs[0]).toFile(`${out}-0.png`);
console.log(`mean |Δ| per frame: image ${(all / na).toFixed(2)}, region ${(reg / nr).toFixed(2)} (0..255)`);
