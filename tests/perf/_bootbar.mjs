// Boot bar under a throttled connection: samples width / MB / phase line every 0.5 s and saves a few screenshots.
//   node tests/perf/_bootbar.mjs <url> <out dir> [Mbit/s]
import { chromium } from '@playwright/test';
const [url, out, mbit = '20'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: (+mbit * 1e6) / 8, uploadThroughput: 1e6 });
const t0 = Date.now();
await page.goto(url + '?lang=de');
const rows = []; let shots = 0;
for (;;) {
  const s = await page.evaluate(() => ({ ready: !!window.__rft?.ready, w: document.querySelector('#boot .bar i')?.style.width, mb: document.querySelector('#boot .mb')?.textContent, ph: document.querySelector('#boot .ph')?.textContent, step: window.__rftBoot?.phase })).catch(() => null);
  const t = (Date.now() - t0) / 1000;
  if (s) rows.push(`${t.toFixed(1).padStart(5)}s  ${String(s.w).padEnd(6)} ${String(s.mb).padEnd(8)} ${String(s.step ?? '').padEnd(10)} ${s.ph}`);
  if (s?.ready) break;
  if ([2, 6, 12].some((x) => t > x && shots < [2, 6, 12].indexOf(x) + 1)) await page.screenshot({ path: `${out}/bootbar-${++shots}.png` });
  if (t > 300) break;
  await page.waitForTimeout(500);
}
console.log(rows.join('\n'));
await browser.close();
