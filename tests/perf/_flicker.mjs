// Temporal-stability capture (development aid for flicker reports): drives with W from the spawn (or a pose) and
// grabs <n> consecutive frames after <warm> s; writes them as numbered JPEGs for frame-to-frame comparison.
//   node tests/perf/_flicker.mjs <url> <site> <out prefix> [n=16] [warm=4] [query=] [pose=x,z,yawDeg] [js=]  (js: evaluated in the page before driving, e.g. renderer.disable tweaks)
import { chromium } from '@playwright/test';
const [url, site, out, n = '16', warm = '4', query = '', pose = '', js = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${url}?lang=en&nomenu${query ? '&' + query : ''}`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
await page.evaluate((s) => window.__rft.startWorld(s), site);
await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
if (pose) await page.evaluate(([x, z, yd]) => {
  const b = window.__rft.app.sim.body, yaw = yd * Math.PI / 180, h = window.__rft.app.renderer.worldHandle.surfaceAt?.(x, z) ?? b.translation().y;
  b.setTranslation({ x, y: h + 1.5, z }, true);
  b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
}, pose.split(',').map(Number));
await page.evaluate(() => { const st = document.createElement('style'); st.textContent = '.rft-hud{display:none!important}'; document.head.append(st); });
if (js) await page.evaluate(js);
await page.waitForTimeout(2500);
await page.mouse.click(640, 360);
await page.keyboard.down('w');
await page.waitForTimeout(Number(warm) * 1000);
// consecutive presented frames via the CDP screencast (screenshots skip frames)
const fs = await import('node:fs');
const cdp = await page.context().newCDPSession(page);
let k = 0;
await new Promise((done) => {
  cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    await cdp.send('Page.screencastFrameAck', { sessionId });
    if (k < Number(n)) fs.writeFileSync(`${out}-${String(k++).padStart(2, '0')}.png`, Buffer.from(data, 'base64'));
    if (k === Number(n)) { k++; done(); }
  });
  cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
});
await cdp.send('Page.stopScreencast');
await page.keyboard.up('w');
console.log(JSON.stringify(await page.evaluate(() => window.__rft.app.renderer.stats)), errs.join('\n') || 'ok');
await browser.close();
