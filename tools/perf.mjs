// Frame-time acceptance: measures rAF frame intervals (p50/p95/p99, fps) per scene in a headed browser.
// Usage: node tools/perf.mjs <url> [quality=high] [seconds=12] [width=1920] [height=1080]
// Scenes: McGregor title demo (kickflip, broadcast), every available world, Sun scene.
import { chromium } from '@playwright/test';

const [url = 'http://127.0.0.1:4180/', quality = 'high', secs = '12', W = '1920', H = '1080'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: Number(W), height: Number(H) } });
await page.goto(`${url}?q=${quality}`);
await page.waitForFunction(() => window.__rft?.ready === true, null, { timeout: 120000 });

async function measure(label) {
  await page.waitForTimeout(3000); // warm-up (shader compile, exposure)
  const r = await page.evaluate(async (ms) => {
    const dts = []; let last = performance.now();
    await new Promise((res) => {
      const end = last + ms;
      const f = (t) => { dts.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else res(); };
      requestAnimationFrame(f);
    });
    dts.sort((a, b) => a - b);
    const q = (p) => dts[Math.min(dts.length - 1, Math.floor(p * dts.length))];
    const st = window.__rft.app.renderer.getStats();
    return { frames: dts.length, fps: dts.length / (ms / 1000), p50: q(0.5), p95: q(0.95), p99: q(0.99), backend: st.backend, res: `${st.width}x${st.height}@${st.resolutionScale}` };
  }, Number(secs) * 1000);
  console.log(`${label.padEnd(18)} fps ${r.fps.toFixed(1).padStart(6)}  p50 ${r.p50.toFixed(1)} ms  p95 ${r.p95.toFixed(1)} ms  p99 ${r.p99.toFixed(1)} ms  ${r.backend} ${r.res}`);
  return r;
}

const results = {};
await page.evaluate(() => window.__rft.app.menu.hide());
results.mcgregor = await measure('mcgregor-kickflip');
const ids = ['earth_stonehenge', 'earth_giza', 'moon_tranquility', 'moon_hadley', 'moon_shackleton', 'mars_jezero', 'mars_gale', 'mars_valles', 'space_sun'];
for (const id of ids) {
  await page.evaluate((s) => window.__rft.startWorld(s), id);
  results[id] = await measure(id);
}
console.log(JSON.stringify({ quality, viewport: `${W}x${H}`, results }));
await browser.close();
