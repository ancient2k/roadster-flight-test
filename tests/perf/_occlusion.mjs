// How often the venue (ramp, truss, drapes, towers …) hides the car from the active camera during a stunt.
// Every 0.1 s, rays from the camera to 9 points of the car's box (centre + corners) are tested against the track
// and environment models; a sample counts as hidden when more than half of the rays are blocked.
//
//   node tests/perf/_occlusion.mjs <url> <stunt> [broadcast|chase] [screenshot dir]
import { chromium } from '@playwright/test';

const [url, stunt, mode = 'broadcast', shots] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${url}?lang=en&nomenu&stunt=${stunt}`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180_000 });
if (mode === 'chase') await page.evaluate(() => window.__rft.app.renderer.setCameraMode('chase'));
const rows = [];
let shotN = 0, lastHidden = false;
for (let i = 0; i < 400; i++) {
  const r = await page.evaluate(() => {
    const app = window.__rft.app, R = app.renderer, cam = R.rig.camera, ray = R.rig.ray;
    const occluders = [R.track?.group, R.env?.group].filter(Boolean);
    const root = R.car.root;
    root.updateMatrixWorld(true);
    // car box in its own frame (≈ 4.35 × 1.3 × 1.94 m), 9 points
    const pts = [[0, 0.6, 0]];
    for (const x of [-0.85, 0.85]) for (const y of [0.15, 1.1]) for (const z of [-2, 2]) pts.push([x, y, z]);
    const P = cam.position.clone();
    let blocked = 0;
    for (const p of pts) {
      const w = root.localToWorld(P.clone().set(p[0], p[1], p[2]));
      const d = w.clone().sub(P), len = d.length();
      ray.set(P, d.divideScalar(len)); ray.far = len - 0.05;
      const hits = ray.intersectObjects(occluders, true).filter((h) => h.object.visible && h.object.material && !h.object.material.transparent);
      if (hits.length) blocked++;
    }
    const st = app.session.outcome.status, t = app.session.telemetry();
    return { t: t.t, phase: t.phase, shot: R.rig.currentShot?.id ?? R.rig.mode, blocked, done: st !== 'running' };
  });
  rows.push(r);
  const hidden = r.blocked > 4;
  if (shots && hidden && !lastHidden && shotN < 6) await page.screenshot({ path: `${shots}/occl-${stunt}-${mode}-${++shotN}.png` });
  lastHidden = hidden;
  if (r.done) break;
  await page.waitForTimeout(100);
}
const hidden = rows.filter((r) => r.blocked > 4);
const by = {};
for (const r of rows) { const k = `${r.shot}`; by[k] ??= { n: 0, hidden: 0 }; by[k].n++; if (r.blocked > 4) by[k].hidden++; }
console.log(JSON.stringify({ stunt, mode, samples: rows.length, hiddenPct: +(100 * hidden.length / rows.length).toFixed(1), byShot: by,
  hiddenAt: hidden.map((r) => `${r.t.toFixed(1)}s ${r.phase} ${r.shot} ${r.blocked}/9`).filter((_, i) => i % 3 === 0).slice(0, 25) }, null, 1));
await browser.close();
