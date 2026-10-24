// Hitch probe with uneven frame intervals (development aid): drives the loop by hand with jittered frame times and
// measures how far the car's screen position departs from a time-linear path between its neighbours.
//   node tests/perf/_hitch2.mjs <url> <lookYawDeg>
import { chromium } from '@playwright/test';
const [url, yawDeg = '150'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${url}?lang=de&nomenu&q=low`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
await page.evaluate(() => window.__rft.startWorld('earth_bocachica'));
await page.waitForTimeout(4000);
await page.mouse.click(640, 360);
await page.keyboard.down('KeyW');
await page.waitForTimeout(3000);
const r = await page.evaluate(async (yaw) => {
  const a = window.__rft.app, rig = a.renderer.rig, loop = a.loop;
  loop.stop();
  rig.look.yaw = yaw; rig.look.idle = 0;
  for (let i = 0; i < 120; i++) loop.advance(1 / 60); // settle the turned camera
  const out = []; let t = 0, seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 600; i++) {
    const dt = [1 / 120, 1 / 60, 1 / 120, 1 / 90][Math.floor(rnd() * 4)];
    t += dt;
    rig.look.idle = 0;
    loop.advance(dt);
    const p = a.renderer.car.root.position.clone().project(rig.camera);
    out.push([t, p.x * 640, p.y * 360]);
    if (i % 30 === 0) await new Promise((res) => setTimeout(res, 0));
  }
  loop.start();
  return out;
}, Number(yawDeg) * Math.PI / 180);
await page.keyboard.up('KeyW');
const res = [];
for (let i = 1; i < r.length - 1; i++) {
  const [t0, x0, y0] = r[i - 1], [t1, x1, y1] = r[i], [t2, x2, y2] = r[i + 1], k = (t1 - t0) / (t2 - t0);
  res.push(Math.hypot(x1 - (x0 + (x2 - x0) * k), y1 - (y0 + (y2 - y0) * k)));
}
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
console.log(`yaw ${yawDeg}: deviation px p50 ${q(res, 0.5).toFixed(3)} p95 ${q(res, 0.95).toFixed(3)} max ${Math.max(...res).toFixed(3)}`);
await browser.close();
