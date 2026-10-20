// Usage: node tests/perf/_attrleak.mjs <url> [site=earth_stonehenge]
// Diagnostics: GPU attribute buffers created during a visit that survive leaving it.
import { chromium } from '@playwright/test';
const [url, site = 'earth_stonehenge'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(url + '?q=high&nomenu');
await page.waitForFunction(() => window.__rft?.ready === true, null, { timeout: 120000 });
await page.evaluate(() => window.__rft.startWorld('space_sun'));
await page.evaluate(() => {
  const be = window.__rft.app.worldRenderer.renderer.backend;
  const live = window.__live = new Map();
  for (const fn of ['createAttribute', 'createIndexAttribute', 'createStorageAttribute', 'createIndirectStorageAttribute']) {
    const orig = be[fn]?.bind(be); if (!orig) continue;
    be[fn] = (a, ...r) => { const arr = a.array ?? a.data?.array; live.set(a, { fn, bytes: arr?.byteLength ?? 0, n: a.count, item: a.itemSize, inter: !!a.isInterleavedBuffer || !!a.data, inst: !!(a.isInstancedBufferAttribute || a.isInstancedInterleavedBuffer), name: a.name || '' }); return orig(a, ...r); };
  }
  const d = be.destroyAttribute.bind(be);
  be.destroyAttribute = (a) => { live.delete(a); return d(a); };
});
await page.evaluate((s) => window.__rft.startWorld(s), site);
await page.waitForTimeout(2000);
await page.evaluate(() => window.__rft.startWorld('space_sun'));
const rows = await page.evaluate(() => [...window.__live.values()].filter((v) => v.bytes > 0).sort((a, b) => b.bytes - a.bytes));
const sum = rows.reduce((s, r) => s + r.bytes, 0);
console.log('survivors', rows.length, (sum / 1e6).toFixed(2), 'MB');
for (const r of rows.slice(0, 25)) console.log(JSON.stringify(r));
await browser.close();
