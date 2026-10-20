// Diagnostics: GPU pipeline/shader-module/node-build counts and times per site switch (world renderer).
// Usage: node tests/perf/_gpu.mjs <url> <site> [<site> …]
import { chromium } from '@playwright/test';
const [url, ...seq] = process.argv.slice(2);
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(url + '?q=high&nomenu');
await page.waitForFunction(() => window.__rft?.ready === true, null, { timeout: 120000 });
const hook = () => page.evaluate(() => {
  const r = window.__rft.app.worldRenderer?.renderer; if (!r || r.__hooked) return; r.__hooked = true;
  const d = r.backend.device; const S = window.__gpuStats = { sm: 0, smMs: 0, rpA: 0, rpAMs: 0, rp: 0, rpMs: 0, maxA: 0, nb: 0, nbMs: 0 };
  const csm = d.createShaderModule.bind(d); d.createShaderModule = (x) => { const t = performance.now(); const m = csm(x); S.sm++; S.smMs += performance.now() - t; return m; };
  const crpa = d.createRenderPipelineAsync.bind(d); d.createRenderPipelineAsync = (x) => { const t = performance.now(); S.rpA++; return crpa(x).then((p) => { const ms = performance.now() - t; S.rpAMs += ms; S.maxA = Math.max(S.maxA, ms); return p; }); };
  const crp = d.createRenderPipeline.bind(d); d.createRenderPipeline = (x) => { const t = performance.now(); const p = crp(x); S.rp++; S.rpMs += performance.now() - t; return p; };
  const nodes = r._nodes; const gfr = nodes.getForRender.bind(nodes);
  nodes.getForRender = (ro, ...a) => { const had = ro._nodeBuilderState; const t = performance.now(); const x = gfr(ro, ...a); if (!had) { S.nb++; S.nbMs += performance.now() - t; } return x; };
});
for (const s of seq) {
  await hook();
  await page.evaluate(() => { if (window.__gpuStats) for (const k in window.__gpuStats) window.__gpuStats[k] = 0; });
  const t0 = Date.now();
  await page.evaluate((s) => window.__rft.startWorld(s), s);
  const st = await page.evaluate(() => JSON.stringify(window.__gpuStats ?? {}, (k, v) => typeof v === 'number' ? Math.round(v) : v));
  const T = await page.evaluate(() => window.__rft.app.lastWorldTimings);
  console.log(s.padEnd(18), Date.now() - t0, 'compile', T['r.s.compile'], 'prewarm', T['r.prewarm'], st);
}
await browser.close();
