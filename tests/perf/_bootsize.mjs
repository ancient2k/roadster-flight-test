// Download size and time of the boot and of each world switch against a built dist/ (docs/RENDERING.md, load size).
// "pages" is what GitHub Pages transfers: it gzips .js/.json/.glb/.bin/.hdr/.wasm/.html/.css, images go as they are.
// Files already loaded in an earlier stage (the car on a world switch) are not counted again.
// Also samples the boot bar (width, MB line, phase line) to show how long it stands still.
//
//   npx vite preview --outDir <dist> --port 4401 &
//   node tests/perf/_bootsize.mjs http://127.0.0.1:4401/ <dist> [site ...]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const [url, dist, ...sites] = process.argv.slice(2);
const GZ = /\.(js|mjs|json|glb|bin|hdr|wasm|html|css|svg|txt)$/i;
const gz = new Map();
const pagesBytes = (u) => {
  const p = path.join(dist, decodeURIComponent(new URL(u).pathname));
  const f = fs.existsSync(p) && fs.statSync(p).isFile() ? p : path.join(dist, 'index.html');
  if (!gz.has(f)) { const b = fs.readFileSync(f); gz.set(f, GZ.test(f) ? zlib.gzipSync(b, { level: 6 }).length : b.length); }
  return gz.get(f);
};

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
let reqs = [];
page.on('requestfinished', async (r) => {
  const s = await r.sizes().catch(() => null);
  if (r.url().startsWith(url)) reqs.push({ url: r.url(), raw: s?.responseBodySize ?? 0 });
});
const take = () => { const r = reqs; reqs = []; return r; };
const TOP = process.env.TOP ? +process.env.TOP : 0; // TOP=<n>: also list the n largest files per stage
const loaded = new Set(); // files of earlier stages come from the browser cache
const sum = (rs) => {
  const seen = new Set(), dup = rs.filter((r) => (seen.has(r.url) ? true : (seen.add(r.url), false))).length;
  const uniq = [...new Map(rs.map((r) => [r.url, r])).values()].filter((r) => !loaded.has(r.url));
  uniq.forEach((r) => loaded.add(r.url));
  if (TOP) console.log(uniq.map((r) => [pagesBytes(r.url), new URL(r.url).pathname]).sort((a, b) => b[0] - a[0]).slice(0, TOP).map(([b, p]) => `  ${(b / 1e6).toFixed(2)} MB ${p}`).join('\n'));
  return { files: uniq.length, dupRequests: dup, rawMB: +(uniq.reduce((a, r) => a + r.raw, 0) / 1e6).toFixed(1), pagesMB: +(uniq.reduce((a, r) => a + pagesBytes(r.url), 0) / 1e6).toFixed(1) };
};

const t0 = Date.now();
await page.goto(url + '?lang=en');
const samples = [];
for (;;) {
  const s = await page.evaluate(() => ({
    ready: !!window.__rft?.ready, w: document.querySelector('#boot .bar i')?.style.width ?? '', mb: document.querySelector('#boot .mb')?.textContent ?? '',
    ph: document.querySelector('#boot .ph')?.textContent ?? '', step: window.__rftBoot?.phase ?? '',
  })).catch(() => null);
  if (s) samples.push({ t: (Date.now() - t0) / 1000, ...s });
  if (s?.ready) break;
  if (Date.now() - t0 > 240_000) throw new Error('boot timeout');
  await page.waitForTimeout(250);
}
const bootS = (Date.now() - t0) / 1000;
await page.waitForTimeout(1500);
// longest stretch in which neither the bar width nor the MB line changed
let still = 0, from = samples[0];
for (const s of samples) { if (s.w !== from.w || s.mb !== from.mb) from = s; still = Math.max(still, s.t - from.t); }
const out = { boot: { s: +bootS.toFixed(1), longestStillS: +still.toFixed(1), ...sum(take()) }, worlds: {} };
console.log('bar:', samples.filter((_, i) => i % 4 === 0).map((s) => `${s.t.toFixed(0)}s ${s.w} ${s.mb} [${s.step}]`).join(' | '));
for (const site of sites) {
  const t1 = Date.now();
  await page.evaluate((s) => window.__rft.startWorld(s), site);
  await page.waitForTimeout(1500);
  out.worlds[site] = { s: +((Date.now() - t1) / 1000 - 1.5).toFixed(1), ...sum(take()) };
}
console.log(JSON.stringify(out, null, 1));
await browser.close();
