// Usage: node tests/perf/_mem.mjs <url> [rounds=3]  (SITES=a,b,… to choose the tour)
// Diagnostics: GPU resource counts of the world renderer after repeated site switches (leak check).
import { chromium } from '@playwright/test';
const [url, rounds = '3'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto(url + '?q=high&nomenu');
await page.waitForFunction(() => window.__rft?.ready === true, null, { timeout: 120000 });
for (let r = 0; r < Number(rounds); r++) for (const s of (process.env.SITES ?? 'mars_jezero,earth_giza,space_sun,earth_mcgregor,moon_hadley').split(',')) {
  await page.evaluate((s) => window.__rft.startWorld(s), s);
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => { const w = window.__rft.app.worldRenderer?.renderer; if (!w) return null; const i = w.info.memory; return { attrMB: +((i.attributesSize + i.indexAttributesSize) / 1e6).toFixed(2), totalMB: Math.round(i.total / 1e6), geo: i.geometries, attr: i.attributes, tex: i.textures, texMB: Math.round(i.texturesSize / 1e6), prog: i.programs, rt: i.renderTargets, ubo: i.uniformBuffers, pipes: w._pipelines.caches.size }; });
  console.log(r, s.padEnd(16), JSON.stringify(m));
}
console.log('ERRORS', errs.length, errs.slice(0, 3).join(' | '));
await browser.close();
