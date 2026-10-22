// Screenshots of a track-editor level in Boca Chica (development aid).
//   node tests/perf/_levelshot.mjs <url> <level.json> <out prefix> [x,y,z,lx,ly,lz ...]   (x/z in tiles of the build area, y in m)
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const [url, file, out, ...poses] = process.argv.slice(2);
const level = JSON.parse(fs.readFileSync(file, 'utf8'));
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); }); page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${url}?lang=de&nomenu`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
const t0 = Date.now();
await page.evaluate((l) => window.__rft.playLevel(l), level);
console.log('level ready', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}-start.jpg`, type: 'jpeg', quality: 80 });
let k = 0;
for (const p of poses) {
  const [x, y, z, lx, ly, lz] = p.split(',').map(Number);
  await page.evaluate(([x, y, z, lx, ly, lz]) => {
    const r = window.__rft.app.renderer, a = r.worldHandle.buildArea, T = a.tileM;
    r.setCameraMode('orbit');
    const c = r.rig.camera;
    r.rig.update = function () { c.position.set(a.minX + x * T, a.y + y, a.minZ + z * T); c.up.set(0, 1, 0); c.lookAt(a.minX + lx * T, a.y + ly, a.minZ + lz * T); c.updateMatrixWorld(); };
  }, [x, y, z, lx, ly, lz]);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}-${++k}.jpg`, type: 'jpeg', quality: 80 });
}
console.log(errs.slice(0, 10).join('\n') || 'no errors');
await browser.close();
