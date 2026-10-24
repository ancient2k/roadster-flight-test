// Drive into the sea at speed (development aid): logs pose, speed, ground height and GNC phase.
//   node tests/perf/_waterprobe.mjs <url> <x,z,yawDeg> <seconds> [keys=w,ShiftLeft] [out]
import { chromium } from '@playwright/test';
const [url, pose, secs, keys = 'w,ShiftLeft', out = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${url}?lang=en&nomenu&q=low`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
await page.evaluate(() => window.__rft.startWorld('earth_bocachica'));
await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
console.log('terrain', await page.evaluate(() => { const t = window.__rft.app.sim.terrainH; return t && { size: t.size, extentM: t.extentM }; }));
await page.evaluate(([x, z, yd]) => {
  const sim = window.__rft.app.sim, b = sim.body, yaw = yd * Math.PI / 180;
  const h = window.__rft.app.renderer.worldHandle.surfaceAt?.(x, z) ?? 0;
  b.setTranslation({ x, y: h + 1, z }, true);
  b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
}, pose.split(',').map(Number));
await page.waitForTimeout(1500);
await page.mouse.click(480, 270);
const ks = keys.split(',').filter(Boolean);
for (const k of ks) await page.keyboard.down(k);
for (let i = 0; i < Number(secs) * 2; i++) {
  await page.waitForTimeout(500);
  console.log(await page.evaluate(() => {
    const app = window.__rft.app, s = app.sim.getState(), tel = app.sim.telemetry(), p = s.pos;
    const gs = app.renderer.worldHandle.surfaceAt?.(p.x, p.z);
    return `t ${s.t.toFixed(1)} pos ${p.x.toFixed(0)},${p.y.toFixed(1)},${p.z.toFixed(0)} v ${s.speedMs.toFixed(1)} vy ${(s.linVel?.y ?? 0).toFixed(1)} hag ${s.heightAboveGroundM.toFixed(1)} surf ${gs?.toFixed?.(2)} air ${tel.airMassKg.toFixed(0)} phase ${tel.phase} wheels ${s.wheels.filter((w) => w.contact).length}`;
  }));
  if (i === Number(secs) - 1) for (const k of ks) await page.keyboard.up(k);
}
if (out) await page.screenshot({ path: out });
console.log(errs.join('\n') || 'ok');
await browser.close();
