// Screenshots of the Starship launch in Boca Chica (development aid): drives the Starbase Sprint sample, arms the launch
// and steps through the flight with the launch clock hook (window.__rft.launchWarp), each shot from a fixed camera.
//   node tests/perf/_launchshot.mjs <url> <out prefix> [quality] [webgl]
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
// arm the launch 40 s out (as a launch clearance piece would)
await page.evaluate(() => { window.__rft.app.levelRun.launchIn = 40; });
await page.waitForTimeout(500);
// camera: from (x, y, z) looking at a world point or a stage; null = the chase camera
const cam = (p) => page.evaluate((p) => {
  const r = window.__rft.app.renderer, a = window.__rft.app;
  if (!p) { r.setCameraMode('chase'); delete r.rig.update; return; }
  r.setCameraMode('orbit');
  const c = r.rig.camera;
  r.rig.update = function () {
    const v = a.launch?.visuals;
    const t = p.look === 'booster' ? v.boosterPos : p.look === 'ship' ? v.shipPos : { x: p.look[0], y: p.look[1], z: p.look[2] };
    c.position.set(p.at[0], p.at[1], p.at[2]); c.up.set(0, 1, 0); c.lookAt(t.x, t.y, t.z); c.fov = p.fov ?? 50; c.updateProjectionMatrix(); c.updateMatrixWorld();
  };
}, p);
const VIEW = [650, 5, 880], PAD = [656, 70, 344.5], TB = [296, 50, 274];
const shot = async (name) => { await page.screenshot({ path: `${out}-${name}.jpg`, type: 'jpeg', quality: 82 }); console.log('shot', name, await page.evaluate(() => window.__rft.launchWarp(0))); };
const at = (met) => page.evaluate((m) => window.__rft.launchWarp(0, m), met);
const wait = (s) => page.waitForTimeout(s * 1000);

await at(-14); await cam(null); await wait(1.5); await shot('a-countdown-chase');
await cam({ at: VIEW, look: PAD, fov: 45 }); await wait(9); await shot('b-deluge');            // ≈ T-3
await wait(4); await shot('c-liftoff');                                                       // ≈ T+1
await wait(6); await shot('d-t7');
await cam({ at: [380, 4, 120], look: 'booster', fov: 40 }); await wait(8); await shot('e-t15');
await cam({ at: VIEW, look: 'booster', fov: 30 }); await wait(30); await shot('f-t45');
await at(150); await wait(1); await cam({ at: VIEW, look: 'booster', fov: 8 }); await wait(16); await shot('g-staging');
await at(300); await cam(null); await wait(1); await shot('h-boostback-chase');
await at(396); await cam({ at: [430, 8, 520], look: 'booster', fov: 40 }); await wait(2); await shot('i-landing-burn');
await wait(9); await shot('j-catch-close');
await cam({ at: [520, 30, 420], look: [656, 70, 344.5], fov: 40 }); await wait(10); await shot('k-caught');
await at(2500); await cam(null); await wait(1.5); await shot('l-orbit-hud');
await at(5800); await cam({ at: [150, 6, 380], look: 'ship', fov: 30 }); await wait(2); await shot('m-bellyflop');
await at(5903); await cam({ at: [170, 10, 420], look: 'ship', fov: 40 }); await wait(4); await shot('n-flip');
await wait(18); await cam({ at: [200, 25, 360], look: TB, fov: 40 }); await wait(3); await shot('o-ship-caught');
console.log(errs.slice(0, 10).join('\n') || 'no errors');
await browser.close();
