// headless copy of tools/shot-phase.mjs (lead) for before/after comparisons.
// Headed: run a stunt to a given GNC phase (+ extra seconds), pause, and screenshot the live render.
import { chromium } from '@playwright/test';
const [url = 'http://127.0.0.1:5173/', stunt = 'kickflip', phase = 'roll', extra = '0.3', out = 'shot.png', cam = 'broadcast'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(url + '?q=high&nomenu');
await page.waitForFunction(() => window.__rft?.ready === true, null, { timeout: 90000 });
await page.waitForTimeout(3000);
await page.evaluate(([s, c]) => { window.__rft.startStunt(s); window.__rft.app.renderer.setCameraMode(c); }, [stunt, cam]);
for (let k = 0; k < 2400; k++) {
  const ph = await page.evaluate(() => { window.__rft.fastForward(1 / 60); return window.__rft.app.session.telemetry().phase; });
  if (ph === phase) break;
}
await page.evaluate((x) => window.__rft.fastForward(Number(x)), extra);
await page.evaluate(() => { window.__rft.app.loop.paused = true; });
await page.waitForTimeout(2500);
await page.screenshot({ path: out });
await browser.close();
