// Frames of an auto-mode stunt for README images (development aid): HUD hidden, a screenshot every <step> ms.
//   node tests/perf/_stuntshot.mjs <url> <stunt> <out prefix> [camera=broadcast] [frames=40] [step=250] [WxH]
//   camera may also be "follow:back,side,up": metres behind/right of/above the car along its ground track.
import { chromium } from '@playwright/test';
const [url, stunt, out, cam = 'broadcast', n = '40', step = '250', size = '1600x900'] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${url}?lang=en&nomenu&q=ultra`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
await page.evaluate((s) => window.__rft.app.startStunt(s), stunt);
await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
await page.evaluate((c) => {
  const st = document.createElement('style');
  st.textContent = '.rft-hud,[class*="hud"],[class*="toast"],[class*="ticker"]{display:none!important}';
  document.head.append(st);
  const rd = window.__rft.app.renderer;
  if (!c.startsWith('follow:')) { rd.setCameraMode(c); return; }
  const [bk, sd, up] = c.slice(7).split(',').map(Number), b = window.__rft.app.sim.body, cm = rd.rig.camera;
  let fx = 0, fz = 1;
  rd.setCameraMode('orbit');
  rd.rig.update = function () {
    const p = b.translation(), v = b.linvel(), sp = Math.hypot(v.x, v.z);
    if (sp > 3) { fx = v.x / sp; fz = v.z / sp; }
    cm.position.set(p.x - bk * fx - sd * fz, p.y + up, p.z - bk * fz + sd * fx); cm.up.set(0, 1, 0);
    cm.lookAt(p.x, p.y, p.z); cm.updateMatrixWorld();
  };
}, cam);
for (let i = 0; i < Number(n); i++) {
  await page.waitForTimeout(Number(step));
  const t = await page.evaluate(() => { const p = window.__rft.app.sim.body.translation(); return `${p.y.toFixed(1)}`; });
  await page.screenshot({ path: `${out}-${String(i).padStart(2, '0')}.jpg`, type: 'jpeg', quality: 90 });
  console.log(i, 'y', t);
}
console.log(errs.join('\n') || 'ok');
await browser.close();
