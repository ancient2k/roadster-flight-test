// Drives the car into a spot and back out (development aid for "car gets stuck" reports): places the car facing a
// target, holds W for <fwd> s, then S for <back> s, logs position/speed and takes a screenshot at each phase end.
//   node tests/perf/_stuckprobe.mjs <url> <site> <out prefix> <carX,carZ,targetX,targetZ> [fwd=4] [back=4] [key=w]
import { chromium } from '@playwright/test';
const [url, site, out, pose, fwd = '4', back = '4', key = 'w'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${url}?lang=en&nomenu`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
await page.evaluate((s) => window.__rft.startWorld(s), site);
await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
await page.evaluate(([cx, cz, tx, tz]) => {
  const b = window.__rft.app.sim.body, yaw = Math.atan2(tx - cx, tz - cz);
  b.setTranslation({ x: cx, y: b.translation().y + 2, z: cz }, true);
  b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
}, pose.split(',').map(Number));
const st = () => page.evaluate(() => {
  const b = window.__rft.app.sim.body, p = b.translation(), v = b.linvel(), s = window.__rft.app.sim.getState();
  return `pos ${p.x.toFixed(1)},${p.y.toFixed(2)},${p.z.toFixed(1)}  v ${Math.hypot(v.x, v.z).toFixed(1)} m/s  wheels ${s.wheels.filter((w) => w.contact).length}`;
});
await page.waitForTimeout(2500);
console.log('start ', await st());
await page.mouse.click(640, 360);
const hold = async (k, s, tag) => {
  await page.keyboard.down(k);
  for (let i = 0; i < Number(s) * 2; i++) { await page.waitForTimeout(500); if (i % 2) console.log(tag, await st()); }
  await page.keyboard.up(k);
  await page.screenshot({ path: `${out}-${tag}.jpg`, type: 'jpeg', quality: 80 });
};
await hold(key, fwd, 'fwd ');
await hold(key === 'w' ? 's' : 'w', back, 'back');
console.log(errs.join('\n') || 'ok');
await browser.close();
