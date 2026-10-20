// headed in-game measurement per site against a build snapshot: load time (cold = incl. first shader
// compile, warm = second visit in the same tab), fps after settling (median of samples), console errors,
// screenshot from the chase camera.
//   node tools/worlds/world_probe.mjs http://127.0.0.1:4195/ <outDir> [webgl] [site …]
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const [url = 'http://127.0.0.1:4195/', outDir = '.', ...rest] = process.argv.slice(2);
const webgl = rest[0] === 'webgl';
const sites = (webgl ? rest.slice(1) : rest).length ? (webgl ? rest.slice(1) : rest) : [
  'earth_stonehenge', 'earth_giza', 'moon_tranquility', 'moon_hadley', 'moon_shackleton', 'mars_jezero', 'mars_gale', 'mars_valles', 'space_sun'];
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 240)); });
page.on('pageerror', (e) => errs.push('pageerror ' + String(e).slice(0, 300)));
await page.goto(url + '?q=high&nomenu' + (webgl ? '&webgl' : ''));
await page.waitForFunction(() => window.__rft?.ready === true, null, { timeout: 120000 });
const rows = [];
let lastT = null;
const load = async (s) => { const t0 = Date.now(); await page.evaluate((x) => window.__rft.startWorld(x), s); lastT = await page.evaluate((x) => ({ ...window.__rft.app.lastWorldTimings, loadWorld: Math.round(performance.getEntriesByName(`r5:loadWorld:${x}`).at(-1)?.duration ?? -1) }), s); return Date.now() - t0; };
for (const s of sites) {
  const e0 = errs.length;
  const cold = await load(s);
  await page.waitForTimeout(2500);
  // warm: leave and come back (shaders/pipelines cached, assets in the HTTP cache)
  await load(s === 'earth_giza' ? 'earth_stonehenge' : 'earth_giza');
  await page.waitForTimeout(1500);
  const warm = await load(s);
  const warmT = lastT;
  await page.waitForTimeout(9000);
  const fps = [];
  for (let i = 0; i < 8; i++) { fps.push(await page.evaluate(() => window.__rft.app.renderer.getStats().fps)); await page.waitForTimeout(500); }
  fps.sort((a, b) => a - b);
  const st = await page.evaluate(() => { const a = window.__rft.app; const r = a.renderer; return { backend: r.backend ?? r.getStats().backend, site: a.siteId }; });
  await page.screenshot({ path: `${outDir}/${s}${webgl ? '_webgl' : ''}.png` });
  const row = { site: s, backend: st.backend, coldMs: cold, warmMs: warm, warmPhases: warmT, fpsMedian: Math.round(fps[4]), fpsMin: Math.round(fps[0]), errors: errs.slice(e0) };
  rows.push(row);
  console.log(JSON.stringify(row));
}
fs.writeFileSync(`${outDir}/probe${webgl ? '_webgl' : ''}.json`, JSON.stringify(rows, null, 1));
await browser.close();
