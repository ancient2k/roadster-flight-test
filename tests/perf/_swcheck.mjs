// Service-worker cost on world switches (development aid): Giza on the first visit, then again after a reload,
// when the worker serves the assets from its cache.   node tests/perf/_swcheck.mjs <url> [extra query]
import { chromium } from '@playwright/test';
const [url, q = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const sw = (s) => page.evaluate(async (s) => {
  performance.clearResourceTimings();
  const t0 = performance.now(); await window.__rft.startWorld(s); const l = performance.now() - t0;
  const res = performance.getEntriesByType('resource').filter((e) => e.startTime >= 0).map((e) => [e.name.split('/').slice(-2).join('/'), Math.round(e.duration), Math.round(e.startTime - t0), e.workerStart > 0]);
  res.sort((a, b) => b[1] - a[1]);
  return { l: (l / 1000).toFixed(2), ctl: !!navigator.serviceWorker?.controller, top: res.slice(0, 5) };
}, s);
for (let pass = 0; pass < 3; pass++) {
  await page.goto(`${url}?q=high&nomenu${q}`);
  await page.waitForFunction(() => window.__rft?.ready === true, null, { timeout: 90000 });
  await page.waitForTimeout(pass === 0 ? 6000 : 1500); // first visit: let the warm copy finish
  const r = await sw('earth_giza');
  console.log(`pass ${pass} sw=${r.ctl} giza ${r.l}s`, JSON.stringify(r.top));
}
await browser.close();
