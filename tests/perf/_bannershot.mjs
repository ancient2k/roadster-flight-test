// Hero shots for the README banner (development aid): the car placed on the ground facing a target, HUD hidden,
// chase camera or a fixed camera given relative to the car (metres along the car's forward/right axis and up).
//   node tests/perf/_bannershot.mjs <url> <site> <out.png> <carX,carZ,targetX,targetZ> [fwd,right,up,lookFwd,lookUp] [WxH]
//   HIDE=<css selector> overrides what is hidden (default: the HUD).
import { chromium } from '@playwright/test';
const [url, site, out, pose, cam = '', size = '1600x900'] = process.argv.slice(2);
const [w, h] = size.split('x').map(Number);
const hide = process.env.HIDE ?? '.rft-hud';
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${url}?lang=en&nomenu&q=ultra`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
await page.evaluate((s) => window.__rft.startWorld(s), site);
await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
await page.evaluate(([[cx, cz, tx, tz], c, sel]) => {
  const app = window.__rft.app, b = app.sim.body;
  const yaw = Math.atan2(tx - cx, tz - cz);
  b.setTranslation({ x: cx, y: 3, z: cz }, true);
  b.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  if (sel) for (const el of document.querySelectorAll(sel)) el.style.display = 'none';
  if (c.length === 5) {
    const [f, r, u, lf, lu] = c, fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -fz, rz = fx;
    const rd = app.renderer; rd.setCameraMode('orbit');
    const cm = rd.rig.camera;
    rd.rig.update = function () {
      const p = b.translation();
      cm.position.set(p.x + f * fx + r * rx, p.y + u, p.z + f * fz + r * rz); cm.up.set(0, 1, 0);
      cm.lookAt(p.x + lf * fx, p.y + lu, p.z + lf * fz); cm.updateMatrixWorld();
    };
  }
}, [pose.split(',').map(Number), cam ? cam.split(',').map(Number) : [], hide]);
await page.waitForTimeout(6000);
await page.screenshot({ path: out });
console.log(errs.join('\n') || 'ok');
await browser.close();
