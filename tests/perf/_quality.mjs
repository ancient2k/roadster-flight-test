// Diagnostics: quality changes inside a world (rock cells rebuilt on shared geometries), then switches.
import { chromium } from '@playwright/test';
const [url] = process.argv.slice(2);
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); }); page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(url + '?q=high&nomenu');
await page.waitForFunction(() => window.__rft?.ready === true, null, { timeout: 120000 });
await page.evaluate(() => window.__rft.startWorld('mars_jezero'));
const rocks = () => page.evaluate(() => window.__rft.app.renderer.worldHandle.stats().rocks);
for (const q of ['ultra', 'high', 'low', 'high']) {
  await page.evaluate((q) => { const a = window.__rft.app; a.settings.update((d) => { d.graphics.quality = q; }, 'graphics.quality'); a.applySettings?.(a.settings.get()); a.renderer.setQuality(q); }, q);
  await page.waitForTimeout(2500);
  console.log(q, 'rocks', await rocks(), 'fps', await page.evaluate(() => window.__rft.app.renderer.getStats().fps.toFixed(0)));
}
await page.evaluate(() => window.__rft.startWorld('earth_mcgregor'));
await page.waitForTimeout(1500);
await page.evaluate(() => window.__rft.startWorld('moon_hadley'));
await page.waitForTimeout(2500);
console.log('track q', await page.evaluate(() => window.__rft.app.trackRenderer.getStats().quality), 'world q', await page.evaluate(() => window.__rft.app.renderer.getStats().quality));
await page.screenshot({ path: process.argv[3] ?? 'q.png' });
console.log('ERRORS', errs.length, errs.slice(0, 4).join(' | '));
await browser.close();
