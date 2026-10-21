import { expect, test, type Page } from '@playwright/test';

// Vehicle damage "Realistic": a frontal crash into the Semi obstacle dents the nose (sim crush → vertex
// displacement in the render model), the HUD shows the damage view, the run goes on; restart repairs the car.

const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

test('crash with damage on: dented nose, HUD damage view, repaired on restart', async ({ page }, info) => {
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
  await page.evaluate(() => (window as any).__rft.app.menu.hide());

  // 11 m/s (40 km/h) head-on into the Semi (box face at x = −48.3), car heading +X
  await page.evaluate(() => {
    const a = (window as any).__rft.app;
    const s = Math.SQRT1_2;
    a.startSession({ kind: 'manual', spawn: { pos: { x: -62, y: 0, z: -17 }, quat: { x: 0, y: s, z: 0, w: s }, speedMs: 11 } }, false, 'ASSIST');
  });
  await page.mouse.click(800, 450);
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
    const a = (window as any).__rft.app, d = a.sim.getState().damage;
    return { rev: d.rev, dents: d.dents.length, disp: a.renderer.car.damage.maxDisplacement() };
  });
  expect(repaired).toEqual({ rev: 0, dents: 0, disp: 0 });

  // 16 m/s (58 km/h): total loss ends the free run and opens the results screen with the damage block
  await page.evaluate(() => {
    const a = (window as any).__rft.app, s = Math.SQRT1_2;
    a.renderer.setCameraMode('chase');
    a.startSession({ kind: 'manual', spawn: { pos: { x: -62, y: 0, z: -17 }, quat: { x: 0, y: s, z: 0, w: s }, speedMs: 16 } }, false, 'ASSIST');
  });
  const results = page.locator('.rft-results');
  await expect(results).toBeVisible({ timeout: 60_000 });
  const block = results.locator('.rft-damage');
  await expect(block).toHaveAttribute('data-level', 'total');
  await expect(block).toContainText('Total loss');
  await expect(block).toContainText('Front');
  await expect(results.locator('.rft-result-reason').first()).toContainText('Total loss');
  expect(await page.evaluate(() => (window as any).__rft.app.session.outcome)).toMatchObject({ status: 'failed', reason: 'totalLoss' });
  await page.screenshot({ path: info.outputPath('damage-results.png') });
  expect(errors, errors.join('\n')).toEqual([]);
});
