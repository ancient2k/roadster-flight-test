// Screenshots of a site from the spawn and from given camera poses (development aid).
//   node tests/perf/_worldshot.mjs <url> <site> <out prefix> [x,y,z,lx,ly,lz ...]
import { chromium } from '@playwright/test';
const [url, site, out, ...poses] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text().slice(0, 160)); });
await page.goto(`${url}?lang=de&nomenu`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
const t0 = Date.now();
await page.evaluate((s) => window.__rft.startWorld(s), site);
console.log('load', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}-spawn.jpg`, type: 'jpeg', quality: 80 });
let k = 0;
for (const p of poses) {
  const [x, y, z, lx, ly, lz] = p.split(',').map(Number);
  await page.evaluate(([x, y, z, lx, ly, lz]) => { const r = window.__rft.app.renderer; r.setCameraMode('orbit'); const c = r.rig.camera; r.rig.update = function () { c.position.set(x, y, z); c.up.set(0, 1, 0); c.lookAt(lx, ly, lz); c.updateMatrixWorld(); }; }, [x, y, z, lx, ly, lz]);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}-${++k}.jpg`, type: 'jpeg', quality: 80 });
}
console.log(errs.slice(0, 15).join('\n'));
await browser.close();
