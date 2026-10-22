import { expect, test, type Page } from '@playwright/test';

// Vehicle damage "Full": a frontal crash into the Semi obstacle dents the nose (sim crush → vertex displacement in
// the render model) and tears the front bumper off (cut out of the Body mesh, flying as a Rapier body), the HUD
// shows the damage view, the run goes on; restart repairs the car. A harder crash destroys the car: the wreck
// stays, the HUD says "Destroyed – reset" with the reset key, and the reset key repairs it.

const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

test('crash with damage on: dented nose, parts fly, total loss → reset', async ({ page }, info) => {
  test.setTimeout(300_000);
  const errors = errorsOf(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('rft.settings.v1', JSON.stringify({ version: 1, realism: { damage: 'realistic' } })); } catch { /* blocked */ }
  });
  await page.goto('/?q=low&nomenu&lang=en');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 120_000 });

  // the setting is listed (Settings → Simulation) and active
  await page.evaluate(() => (window as any).__rft.app.menu.show('settings'));
  await page.locator('#tab-simulation').click();
  const seg = page.locator('.rft-segs[data-label="Vehicle damage"]');
  await expect(seg).toBeVisible();
  await expect(seg.locator('[data-v="realistic"]')).toHaveAttribute('aria-checked', 'true');
  await expect(seg.locator('[data-v="realistic"]')).toHaveText('Full');
  await expect(seg.locator('[data-v="visual"]')).toHaveText('Visual');
  await page.evaluate(() => (window as any).__rft.app.menu.hide());

  // 11 m/s (40 km/h) head-on into the Semi (box face at x = −48.3), car heading +X
  await page.evaluate(() => {
    const a = (window as any).__rft.app;
    const s = Math.SQRT1_2;
    a.startSession({ kind: 'manual', spawn: { pos: { x: -62, y: 0, z: -17 }, quat: { x: 0, y: s, z: 0, w: s }, speedMs: 11 } }, false, 'ASSIST');
  });
  await page.mouse.click(800, 450);
  // the bumper tears off in the impact: catch it in the air (orbit camera from the side, slow motion)
  await page.waitForFunction(() => ((window as any).__rft.app.sim.getState().damage?.lost.length ?? 0) > 0, null, { timeout: 60_000 });
  await page.evaluate(() => {
    const a = (window as any).__rft.app;
    a.loop.timeScale = 0.1;
    a.renderer.setCameraMode('orbit');
    Object.assign(a.renderer.rig.orbit, { yaw: -1.2, pitch: 0.25, dist: 7 });
  });
  await page.waitForTimeout(700);
  const flying = await page.evaluate(() => {
    const a = (window as any).__rft.app, d = a.sim.getState().damage;
    return { lost: [...d.lost], debrisY: d.debris.map((x: any) => x.pos.y), render: a.renderer.car.damage.debrisInfo() };
  });
  console.log('parts flying', JSON.stringify(flying));
  expect(flying.lost).toContain('Bumper_F');
  expect(flying.render.parts).toContain('Bumper_F');
  expect(flying.render.cutTriangles).toBeGreaterThan(1000);   // real triangles out of the Body mesh
  await page.screenshot({ path: info.outputPath('damage-parts-flying.png') });
  await page.evaluate(() => { (window as any).__rft.app.loop.timeScale = 1; });
  await page.waitForFunction(() => ((window as any).__rft.app.sim.getState().damage?.crushM.front ?? 0) > 0.2, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => {
    const a = (window as any).__rft.app, st = a.sim.getState(), d = st.damage;
    return {
      mode: d.mode, crush: d.crushM.front, dents: d.dents.length, rev: d.rev, total: d.totalLoss, crashed: st.crashed,
      outcome: a.session.outcome.status, disp: a.renderer.car.damage.maxDisplacement(),
    };
  });
  console.log('after crash', after);
  expect(after.mode).toBe('realistic');
  expect(after.crush).toBeGreaterThan(0.25); expect(after.crush).toBeLessThan(0.45);   // Campbell: ≈ 0.35 m at 118 kJ
  expect(after.dents).toBeGreaterThan(0);
  expect(after.total).toBe(false);
  expect(after.crashed).toBe(false);
  expect(after.outcome).toBe('running');
  expect(after.disp).toBeGreaterThan(0.2);   // the render model is visibly dented
  await expect(page.locator('.rft-destroyed')).toBeHidden();

  // three-quarter view onto the crushed nose (orbit camera, world yaw), HUD stays on
  await page.evaluate(() => {
    const a = (window as any).__rft.app;
    a.renderer.setCameraMode('orbit');
    Object.assign(a.renderer.rig.orbit, { yaw: 0.45, pitch: 0.5, dist: 6.5 });
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath('damage-dent.png') });

  // restart = repair
  await page.evaluate(() => (window as any).__rft.app.restart());
  await page.waitForTimeout(800);
  const repaired = await page.evaluate(() => {
    const a = (window as any).__rft.app, d = a.sim.getState().damage, r = a.renderer.car.damage.debrisInfo();
    return { rev: d.rev, dents: d.dents.length, lost: d.lost.length, disp: a.renderer.car.damage.maxDisplacement(), parts: r.parts.length, cut: r.cutTriangles };
  });
  expect(repaired).toEqual({ rev: 0, dents: 0, lost: 0, disp: 0, parts: 0, cut: 0 });

  // 16 m/s (58 km/h): total loss — the wreck stays (no results screen), drive and fans dead, the HUD asks for the reset
  await page.evaluate(() => {
    const a = (window as any).__rft.app, s = Math.SQRT1_2;
    a.renderer.setCameraMode('chase');
    a.startSession({ kind: 'manual', spawn: { pos: { x: -62, y: 0, z: -17 }, quat: { x: 0, y: s, z: 0, w: s }, speedMs: 16 } }, false, 'ASSIST');
  });
  const banner = page.locator('.rft-destroyed');
  await expect(banner).toBeVisible({ timeout: 60_000 });
  await expect(banner).toContainText('DESTROYED');
  await expect(banner).toContainText('Backspace');
  await page.waitForTimeout(2500);
  const wreck = await page.evaluate(() => {
    const a = (window as any).__rft.app, st = a.sim.getState(), d = st.damage;
    return { total: d.totalLoss, integrity: d.integrity, lost: [...d.lost], crashed: st.crashed, outcome: a.session.outcome.status, results: !!document.querySelector('.rft-results') };
  });
  console.log('wreck', JSON.stringify(wreck));
  expect(wreck).toMatchObject({ total: true, crashed: true, outcome: 'running', results: false });
  expect(wreck.lost).toContain('Bumper_F');
  await page.evaluate(() => {
    const a = (window as any).__rft.app;
    a.renderer.setCameraMode('orbit');
    Object.assign(a.renderer.rig.orbit, { yaw: 0.6, pitch: 0.35, dist: 8 });
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: info.outputPath('damage-destroyed.png') });

  // the reset key repairs the car and clears the debris (respawn standing, not into the Semi again)
  await page.evaluate(() => { (window as any).__rft.app.session.mode.spawn.speedMs = 0; });
  await page.keyboard.down('Backspace'); await page.waitForTimeout(150); await page.keyboard.up('Backspace');
  await expect(banner).toBeHidden({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const reset = await page.evaluate(() => {
    const a = (window as any).__rft.app, d = a.sim.getState().damage, r = a.renderer.car.damage.debrisInfo();
    return { total: d.totalLoss, lost: d.lost.length, debris: d.debris.length, parts: r.parts.length, cut: r.cutTriangles, crashed: a.sim.getState().crashed };
  });
  expect(reset).toEqual({ total: false, lost: 0, debris: 0, parts: 0, cut: 0, crashed: false });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('parts tear off at speed and fly as real model parts (debris copies, Body cut-outs)', async ({ page }, info) => {
  test.setTimeout(300_000);
  const errors = errorsOf(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('rft.settings.v1', JSON.stringify({ version: 1, realism: { damage: 'realistic' } })); } catch { /* blocked */ }
  });
  await page.goto('/?q=low&nomenu&lang=en');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 120_000 });
  // 20 m/s; a side-swipe and a rear hit tear off wing, door, rear bumper, diffuser and a wheel
  await page.evaluate(() => {
    const a = (window as any).__rft.app;
    const s = Math.SQRT1_2;   // past the lit obstacle lane, heading +X (the Semi is ≈ 3 s ahead)
    a.startSession({ kind: 'manual', spawn: { pos: { x: -140, y: 0, z: -17 }, quat: { x: 0, y: s, z: 0, w: s }, speedMs: 20 } }, false, 'ASSIST');
  });
  await page.waitForTimeout(1500);
  const lost = await page.evaluate(() => {
    const a = (window as any).__rft.app, dm = a.sim.modules.find((m: any) => m.name === 'damage');
    a.loop.timeScale = 0.12;
    dm.inject(a.sim, { x: 0, y: 0.6, z: -1.5 }, { x: 0, y: -0.7, z: 0.7 }, 30_000);
    dm.inject(a.sim, { x: 0.9, y: 0.3, z: 0.2 }, { x: -1, y: 0, z: 0 }, 14_000);
    dm.inject(a.sim, { x: 0, y: -0.15, z: -2.0 }, { x: 0, y: 0, z: 1 }, 9_000);
    dm.inject(a.sim, { x: -0.98, y: -0.1, z: -1.25 }, { x: 1, y: 0, z: 0 }, 34_000);
    a.renderer.setCameraMode('orbit');
    Object.assign(a.renderer.rig.orbit, { yaw: 2.2, pitch: 0.3, dist: 9 });
    return [...dm.state.lost];
  });
  console.log('torn off', lost);
  for (const p of ['Wing', 'Door_L', 'Bumper_R', 'Diffuser', 'Wheel_RR']) expect(lost).toContain(p);
  await page.waitForTimeout(1600);
  const render = await page.evaluate(() => (window as any).__rft.app.renderer.car.damage.debrisInfo());
  console.log('render debris', JSON.stringify(render));
  for (const p of ['Wing', 'Door_L', 'Bumper_R', 'Diffuser', 'Wheel_RR']) expect(render.parts).toContain(p);
  expect(render.cutTriangles).toBeGreaterThan(1000);
  expect(await page.evaluate(() => (window as any).__rft.app.sim.getState().damage.totalLoss)).toBe(false);
  await page.screenshot({ path: info.outputPath('damage-parts-flying-speed.png') });
  // performance: cost of classifying the Body triangles (first cut) and frame time with debris vs intact
  const perf = await page.evaluate(async () => {
    const a = (window as any).__rft.app, v = a.renderer.car.damage;
    const keep = v.bodyMeshes; v.bodyMeshes = null;
    const t0 = performance.now(); v.bodyParts(); const classifyMs = performance.now() - t0;
    v.bodyMeshes = keep;
    a.loop.timeScale = 1;
    const sample = async () => { const xs: number[] = []; for (let i = 0; i < 90; i++) { await new Promise(requestAnimationFrame); xs.push(a.frameMs); } return xs.reduce((s, x) => s + x, 0) / xs.length; };
    const withDebris = await sample();
    a.restart();
    await new Promise((r) => setTimeout(r, 500));
    const intact = await sample();
    return { classifyMs, withDebris, intact };
  });
  console.log('perf', JSON.stringify(perf));

  // the same in daylight (Giza): car rolling at 15 m/s, a rear-quarter hit and a side-swipe
  await page.evaluate(() => { (window as any).__rft.app.loop.timeScale = 1; });
  await page.evaluate(() => (window as any).__rft.startWorld('earth_giza'));
  await page.waitForTimeout(4000);
  const giza = await page.evaluate(() => {
    const a = (window as any).__rft.app, dm = a.sim.modules.find((m: any) => m.name === 'damage');
    const q = a.sim.body.rotation();
    const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    a.sim.body.setLinvel({ x: fx * 15, y: 0, z: fz * 15 }, true);
    a.loop.timeScale = 0.15;
    dm.inject(a.sim, { x: 0, y: 0.6, z: -1.5 }, { x: 0, y: -0.7, z: 0.7 }, 30_000);
    dm.inject(a.sim, { x: 0.9, y: 0.3, z: 0.2 }, { x: -1, y: 0, z: 0 }, 14_000);
    dm.inject(a.sim, { x: 0, y: -0.15, z: -2.0 }, { x: 0, y: 0, z: 1 }, 9_000);
    dm.inject(a.sim, { x: 0, y: -0.1, z: 2.2 }, { x: 0, y: 0, z: -1 }, 9_000);
    a.renderer.setCameraMode('orbit');
    Object.assign(a.renderer.rig.orbit, { yaw: 2.4, pitch: 0.22, dist: 8.5 });
    return { site: a.siteId, lost: [...dm.state.lost], total: dm.state.totalLoss };
  });
  console.log('giza', JSON.stringify(giza));
  expect(giza.site).toBe('earth_giza');
  expect(giza.lost.length).toBeGreaterThanOrEqual(5);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: info.outputPath('damage-parts-flying-giza.png') });
  expect(errors, errors.join('\n')).toEqual([]);
});
