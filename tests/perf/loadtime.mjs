// Ortswechsel-Ladezeit: headed Chromium, alle 10 Orte nacheinander inkl. McGregor-Rückkehr.
// Misst je Ort: Promise von startWorld (Klick → Session läuft), danach die Zeit bis zum ersten
// ruckelfreien Fenster (12 aufeinanderfolgende Frames < 34 ms) und p95/max der ersten 3 s.
// Usage: node tests/perf/loadtime.mjs <url> [quality=high] [webgl=0] [rounds=1] [fresh=0 (each site on a freshly booted page)]
// SITES=a,b,… picks the sites; Chrome runs without occluded-window throttling (other headed browsers on a shared
// machine would otherwise throttle rAF and the GPU process; the player's window is in front) – NOTHROTTLE=0 keeps it.
import { chromium } from '@playwright/test';

const [url = 'http://127.0.0.1:4180/', quality = 'high', webgl = '0', rounds = '1', fresh = '0'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', ...(process.env.NOTHROTTLE === '0' ? [] : ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'])] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 240)); });
page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
const boot = async () => {
  await page.goto(`${url}?q=${quality}&nomenu${webgl === '1' ? '&webgl' : ''}`);
  await page.waitForFunction(() => window.__rft?.ready === true, null, { timeout: 120000 });
  await page.waitForTimeout(2000);
};
await boot();
const ids = process.env.SITES ? process.env.SITES.split(',') : ['earth_stonehenge', 'earth_giza', 'moon_tranquility', 'moon_hadley', 'moon_shackleton', 'mars_jezero', 'mars_gale', 'mars_valles', 'space_sun', 'earth_mcgregor'];
const rows = [];
for (let r = 0; r < Number(rounds); r++) for (const id of ids) {
  if (fresh === '1' && (r > 0 || id !== ids[0])) await boot(); // every site from a freshly booted page
  if (fresh === '1' && id === 'earth_mcgregor') await page.evaluate(() => window.__rft.startWorld('earth_giza'));
  const e0 = errs.length;
  const res = await page.evaluate(async (s) => {
    const t0 = performance.now();
    await window.__rft.startWorld(s);
    const loadMs = performance.now() - t0;
    const dts = []; let last = performance.now(), smoothAt = -1, run = 0;
    await new Promise((res) => {
      const f = (t) => {
        const dt = t - last; last = t; dts.push(dt);
        run = dt < 34 ? run + 1 : 0;
        if (run >= 12 && smoothAt < 0) smoothAt = t - t0;
        if (t - t0 < loadMs + 3000 || smoothAt < 0 && t - t0 < loadMs + 15000) requestAnimationFrame(f); else res();
      };
      requestAnimationFrame(f);
    });
    const first = dts.slice(1, 200).sort((a, b) => a - b);
    const a = window.__rft.app;
    return { heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6), loadMs, smoothMs: smoothAt, p95: first[Math.floor(first.length * 0.95)], max: first[first.length - 1], T: a.lastWorldTimings, site: a.siteId, backend: a.renderer.getStats().backend };
  }, id);
  res.errors = errs.slice(e0);
  rows.push({ id, ...res });
  console.log(`${id.padEnd(18)} load ${(res.loadMs / 1000).toFixed(2)} s  glatt ${(res.smoothMs / 1000).toFixed(2)} s  p95 ${res.p95.toFixed(1)}  max ${res.max.toFixed(0)}  ${res.backend}  heap ${res.heapMB} MB  ${JSON.stringify(res.T)}  err ${res.errors.length}`);
}
console.log('ERRORS', errs.length, errs.slice(0, 5).join(' | '));
console.log('JSON', JSON.stringify(rows));
await browser.close();
