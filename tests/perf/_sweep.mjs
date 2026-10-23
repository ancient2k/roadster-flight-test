// Visual sweep for ground-level defects (development aid): a grid of camera points over a world, each looking in
// four directions from `eye` metres above the terrain, HUD and car hidden; contact sheets of 4x3 frames.
//   node tests/perf/_sweep.mjs <url> <site> <out prefix> <x0,z0,x1,z1> <step m> [eye=2.5]
import { chromium } from '@playwright/test';
const [url, site, out, rect, step, eye = '2.5'] = process.argv.slice(2);
const [x0, z0, x1, z1] = rect.split(',').map(Number), st = Number(step);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${url}?lang=en&nomenu&q=high`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
await page.evaluate((s) => window.__rft.startWorld(s), site);
await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
await page.evaluate(() => {
  const st = document.createElement('style'); st.textContent = '.rft-hud{display:none!important}'; document.head.append(st);
  const app = window.__rft.app, rd = app.renderer; rd.setCameraMode('orbit');
  // park the car far away, out of every frame
  const b = app.sim.body; b.setTranslation({ x: 0, y: 500, z: 0 }, true); b.setLinvel({ x: 0, y: 0, z: 0 }, true);
  app.sim.body.setGravityScale?.(0, true);
  window.__pose = { x: 0, y: 0, z: 0, yaw: 0 };
  rd.rig.update = function () {
    const p = window.__pose, cm = rd.rig.camera;
    cm.position.set(p.x, p.y, p.z); cm.up.set(0, 1, 0);
    cm.lookAt(p.x + Math.sin(p.yaw) * 20, p.y - 1.2, p.z + Math.cos(p.yaw) * 20); cm.updateMatrixWorld();
  };
});
const frames = [];
for (let z = z0; z <= z1; z += st) for (let x = x0; x <= x1; x += st) for (let k = 0; k < 4; k++) frames.push([x, z, k * Math.PI / 2]);
console.log(frames.length, 'frames');
let sheet = 0;
const { default: sharp } = await import('sharp');
for (let i = 0; i < frames.length; i += 12) {
  const tiles = [];
  for (const [x, z, yaw] of frames.slice(i, i + 12)) {
    await page.evaluate(([x, z, yaw, e]) => {
      const h = window.__rft.app.renderer.worldHandle.heightAt?.(x, z) ?? window.__rft.app.renderer.worldHandle.surfaceAt(x, z);
      window.__pose = { x, y: h + e, z, yaw };
    }, [x, z, yaw, Number(eye)]);
    await page.waitForTimeout(700);
    const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
    const label = Buffer.from(`<svg width="640" height="22"><rect width="640" height="22" fill="black" opacity=".6"/><text x="6" y="16" font-size="14" fill="white" font-family="Menlo">${x},${z} yaw ${Math.round(yaw * 57.3)}</text></svg>`);
    tiles.push(await sharp(buf).composite([{ input: label, top: 0, left: 0 }]).toBuffer());
  }
  const comp = tiles.map((t, j) => ({ input: t, left: (j % 4) * 640, top: Math.floor(j / 4) * 360 }));
  await sharp({ create: { width: 2560, height: 1080, channels: 3, background: '#000' } }).composite(comp).jpeg({ quality: 70 }).toFile(`${out}-${String(sheet++).padStart(2, '0')}.jpg`);
}
console.log(errs.join('\n') || 'ok', sheet, 'sheets');
await browser.close();
