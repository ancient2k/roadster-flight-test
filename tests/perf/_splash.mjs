// Water spray capture (development aid): puts the car <h> m above the Boca Chica sea at <x,z> with <v> m/s eastwards,
// then saves <n> frames every <ms> ms with the car's submersion and speed in the log.
//   node tests/perf/_splash.mjs <url> <out prefix> <x,z> <h> <v> [n=10] [ms=150] [keys=w]
import { chromium } from '@playwright/test';
const [url, out, xz, h, v, n = '10', ms = '150', keys = 'w'] = process.argv.slice(2);
const [x, z] = xz.split(',').map(Number);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${url}?lang=en&nomenu`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
await page.evaluate(() => window.__rft.startWorld('earth_bocachica'));
await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
await page.evaluate(() => { const st = document.createElement('style'); st.textContent = '.rft-hud{display:none!important}'; document.head.append(st); });
const place = (vx) => page.evaluate(([x, z, h, vx]) => {
  const b = window.__rft.app.sim.body;
  b.setTranslation({ x: x - 40, y: -0.377 + Number(h), z }, true);
  b.setRotation({ x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }, true);
  b.setLinvel({ x: vx, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
}, [x, z, h, vx]);
// park in the air for the chase camera to settle, then release
for (let i = 0; i < 20; i++) { await place(0); await page.waitForTimeout(100); }
await page.mouse.click(640, 360);
for (const k of keys.split(',').filter(Boolean)) await page.keyboard.down(k);
await page.evaluate(([x, z, h, v]) => { const b = window.__rft.app.sim.body; b.setTranslation({ x, y: -0.377 + Number(h), z }, true); b.setLinvel({ x: Number(v), y: 0, z: 0 }, true); }, [x, z, h, v]);
for (let i = 0; i < Number(n); i++) {
  await page.waitForTimeout(Number(ms));
  const info = await page.evaluate(() => { const a = window.__rft.app, s = a.sim.getState(); const gy = a.renderer.worldHandle.surfaceAt(s.pos.x, s.pos.z); return `x ${s.pos.x.toFixed(1)} y ${s.pos.y.toFixed(2)} v ${s.speedMs.toFixed(1)} vy ${s.linVel.y.toFixed(2)} sub ${a.sim.submersion.toFixed(2)} bed ${gy.toFixed(2)} wheels ${s.wheels.filter((w) => w.contact).length} pitch ${a.sim.telemetry().pitchDeg.toFixed(0)} air ${a.sim.telemetry().airMassKg.toFixed(0)} ph ${a.sim.telemetry().phase}`; });
  console.log(i, info);
  await page.screenshot({ path: `${out}-${String(i).padStart(2, '0')}.png` });
}
console.log(JSON.stringify(await page.evaluate(() => {
  const ps = window.__rft.app.renderer.particles, t = ps.uTime.value, A = ps.A.array, B = ps.B.array, C = ps.C.array, D = ps.D.array, out = {};
  for (let i = 0; i < ps.capacity; i++) { const age = t - A[i * 4 + 3]; if (age < 0 || age > B[i * 4 + 3]) continue; const k = D[i * 4 + 1]; out[k] ??= { n: 0, y: 0, size1: 0 }; out[k].n++; out[k].y += A[i * 4 + 1]; out[k].size1 = Math.max(out[k].size1, C[i * 4 + 1]); }
  for (const k in out) out[k].y = +(out[k].y / out[k].n).toFixed(2);
  return out;
})));
if (process.env.NOPARTICLES) {
  await page.evaluate(() => { window.__rft.app.renderer.particles.sprite.visible = false; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}-noparticles.png` });
}
await browser.close();
