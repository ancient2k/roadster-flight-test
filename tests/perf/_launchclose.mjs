// Close-up screenshots of the Starship launch (plumes, cloud, catches) for look development.
//   node tests/perf/_launchclose.mjs <url> <out prefix> [quality] [webgl]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const [url, out, q = 'high', webgl] = process.argv.slice(2);
const level = JSON.parse(fs.readFileSync('src/editor/samples/starbase-sprint.json', 'utf8'));
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); }); page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${url}?lang=de&nomenu&q=${q}${webgl ? '&webgl' : ''}`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
await page.evaluate((l) => window.__rft.playLevel(l), level);
await page.waitForTimeout(1500);
await page.evaluate(() => { window.__rft.app.levelRun.launchIn = 40; document.querySelector('.rft-hud')?.style.setProperty('display', 'none'); });
// camera relative to a stage: offset (m) from its position, looking at it (+ lookY)
const cam = (p) => page.evaluate((p) => {
  const r = window.__rft.app.renderer, a = window.__rft.app;
  r.setCameraMode('orbit');
  const c = r.rig.camera;
  r.rig.update = function () {
    const v = a.launch?.visuals;
    const t = p.look === 'booster' ? v.boosterPos : p.look === 'ship' ? v.shipPos : { x: p.look[0], y: p.look[1], z: p.look[2] };
    const o = p.rel ? { x: t.x + p.at[0], y: t.y + p.at[1], z: t.z + p.at[2] } : { x: p.at[0], y: p.at[1], z: p.at[2] };
    c.position.set(o.x, o.y, o.z); c.up.set(0, 1, 0); c.lookAt(t.x, t.y + (p.dy ?? 0), t.z); c.fov = p.fov ?? 50; c.updateProjectionMatrix(); c.updateMatrixWorld();
  };
}, p);
const shot = async (name) => { await page.screenshot({ path: `${out}-${name}.jpg`, type: 'jpeg', quality: 82 }); console.log('shot', name, await page.evaluate(() => window.__rft.launchWarp(0))); };
const at = (met) => page.evaluate((m) => window.__rft.launchWarp(0, m), met);
const wait = (s) => page.waitForTimeout(s * 1000);
const only = (process.env.SHOTS ?? 'abcdefg').split('');
if (only.includes('a')) { await at(-4); await cam({ at: [520, 3, 620], look: [656, 50, 344.5], fov: 45 }); await wait(10); await shot('a-liftoff-low'); await wait(5); await shot('b-t11'); }
if (only.includes('c')) { await at(20); await cam({ at: [-250, -60, 250], look: 'booster', rel: true, dy: 20, fov: 50 }); await wait(2); await shot('c-ascent-near'); }
if (only.includes('d')) { await at(45); await cam({ at: [-900, -300, 500], look: 'booster', rel: true, fov: 40 }); await wait(2); await shot('d-ascent-45'); }
if (only.includes('e')) { await at(200); await cam({ at: [-1500, -200, 900], look: 'booster', rel: true, fov: 40 }); await wait(2); await shot('e-boostback'); }
if (only.includes('f')) { await at(5850); await cam({ at: [-300, -80, 300], look: 'ship', rel: true, fov: 45 }); await wait(2); await shot('f-bellyflop-near'); }
if (only.includes('g')) { await at(5908); await cam({ at: [140, 20, 520], look: [296, 60, 274], fov: 45 }); await wait(3); await shot('g-ship-landing'); await wait(16); await shot('h-ship-caught'); }
console.log(errs.slice(0, 10).join('\n') || 'no errors');
await browser.close();
