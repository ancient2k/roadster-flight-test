// Diagnostics: camera on the largest boulder near the spawn (works with InstancedMesh and cell meshes)
// to compare boulder shading and cast shadows between builds. Usage: node tests/perf/_rockshot.mjs <url> <site> <out.png> [webgl]
import { chromium } from '@playwright/test';
const [url, site, out, webgl, side] = process.argv.slice(2);
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto(url + `?q=high&nomenu${webgl ? '&webgl' : ''}`);
await page.waitForFunction(() => window.__rft?.ready === true, null, { timeout: 120000 });
await page.evaluate((s) => window.__rft.startWorld(s), site);
await page.waitForTimeout(2500);
const info = await page.evaluate((SIDE) => {
  const a = window.__rft.app, gr = a.renderer, car = a.sim.getState().pos;
  let best = null;
  gr.scene.traverse((o) => {
    if (o.name !== 'RockCell') return;
    let arr, n;
    if (o.isInstancedMesh) { arr = o.instanceMatrix.array; n = o.count; }
    else { arr = o.geometry.getAttribute('cellM0').data.array; n = o.geometry.instanceCount; }
    for (let i = 0; i < n; i++) {
      const k = i * 16, x = arr[k + 12], y = arr[k + 13], z = arr[k + 14];
      const sc = Math.hypot(arr[k], arr[k + 1], arr[k + 2]);
      const d = Math.hypot(x - car.x, z - car.z);
      if (d < 250 && sc > 0.6 && (!best || sc / (1 + d / 60) > best.w)) best = { x, y, z, sc, d, w: sc / (1 + d / 60) };
    }
  });
  if (!best) return null;
  const sd = gr.worldHandle.sunDirection, h = Math.hypot(sd.x, sd.z) || 1;
  const cam = gr.camera;
  const r = Math.max(1, best.sc);
  const ka = SIDE ? 1.5 : 5, kb = SIDE ? 6 : 2;
  const px = best.x + (sd.x / h) * ka * r + (-sd.z / h) * kb * r, pz = best.z + (sd.z / h) * ka * r + (sd.x / h) * kb * r;
  const py = Math.max(gr.worldHandle.heightAt(px, pz) + 1.5, best.y + 1.6 * r);
  gr.rig.update = () => { cam.position.set(px, py, pz); cam.up.set(0, 1, 0); cam.lookAt(best.x, best.y, best.z); gr.rig.focusDistance = cam.position.distanceTo(new cam.position.constructor(best.x, best.y, best.z)); };
  return best;
}, !!side);
await page.waitForTimeout(2500);
await page.screenshot({ path: out });
console.log(site, JSON.stringify(info), 'errors', errs.length, errs.slice(0, 2).join(' | '));
await browser.close();
