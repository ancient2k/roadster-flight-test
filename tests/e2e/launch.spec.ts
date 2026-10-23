// Starship launch at Boca Chica (docs/EDITOR.md): a short countdown on the Starbase Sprint sample, the liftoff with the
// ticker and the flight display, the pressure wave pushing a car parked near the mount, both catches through the
// launch clock hook, and a restart putting the stack back on the mount. No console errors.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('Starship launch: countdown, liftoff, pressure wave, catches, restart', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/?lang=en&nomenu');
  await page.waitForFunction(() => (window as any).__rft?.ready, null, { timeout: 120_000 });
  const level = JSON.parse(readFileSync('src/editor/samples/starbase-sprint.json', 'utf8'));
  await page.evaluate((l) => (window as any).__rft.playLevel(l), level);
  await page.waitForFunction(() => { const a = (window as any).__rft.app; return a.siteId === 'earth_bocachica' && !a.switching && a.levelRun; }, null, { timeout: 120_000 });

  // arm an 8 s countdown (as the launch clearance piece does) and park the car 150 m south of mount A
  await page.evaluate(() => {
    const a = (window as any).__rft.app;
    a.levelRun.launchIn = 8;
    const gy = a.renderer.worldHandle.heightAt(656, 494.5);
    a.sim.body.setTranslation({ x: 656, y: gy + 0.9, z: 494.5 }, true);
    a.sim.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  });
  await expect(page.locator('.rftl-count')).toHaveText(/T−0:0\d/);
  await expect(page.locator('.rftl-zone')).toBeVisible();          // inside the exclusion ring
  const pad = await page.evaluate(() => (window as any).__rft.app.launch.visuals.padA);

  // liftoff: ticker, mission clock, flight display; the stack climbs, the pressure wave pushes the car away
  await expect(page.locator('.rftl-tick')).toContainText('Liftoff!', { timeout: 20_000 });
  await expect(page.locator('.rftl-clock')).toHaveText(/T\+00:00:0\d/);
  await expect(page.locator('.rftl-fd')).toBeVisible();
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => {
    const a = (window as any).__rft.app, p = a.sim.body.translation();
    return { z: p.z, booster: a.launch.visuals.boosterPos.y, solid: a.launch.visuals.stackSolid };
  });
  expect(after.z).toBeGreaterThan(494.5 + 2);                      // pushed south, away from the mount
  expect(after.booster).toBeGreaterThan(pad.y + 30);
  expect(after.solid).toBe(false);
  await page.screenshot({ path: 'test-results/e2e-launch-liftoff.png' });

  // booster: alert, landing burn and catch
  await page.evaluate(() => (window as any).__rft.launchWarp(0, 386));
  await expect(page.locator('.rftl-alert')).toContainText('SUPER HEAVY', { timeout: 10_000 });
  await page.evaluate(() => (window as any).__rft.launchWarp(0, 416));
  await expect(page.locator('.rftl-tick')).toContainText('SUPER HEAVY caught by the tower arms!', { timeout: 10_000 });
  expect(await page.evaluate(() => (window as any).__rft.app.launch.visuals.stackSolid)).toBe(true);
  // ship: after the orbit (time lapse), caught at tower B
  await page.evaluate(() => (window as any).__rft.launchWarp(0, 2000));
  await expect(page.locator('.rftl-warp')).toContainText('×');
  await page.evaluate(() => (window as any).__rft.launchWarp(0, 5923));
  await expect(page.locator('.rftl-tick')).toContainText('STARSHIP caught by the tower arms!', { timeout: 10_000 });
  const ship = await page.evaluate(() => { const v = (window as any).__rft.app.launch.visuals; return { s: v.shipPos, b: v.catchB }; });
  expect(Math.hypot(ship.s.x - ship.b.x, ship.s.z - ship.b.z)).toBeLessThan(1);
  await page.screenshot({ path: 'test-results/e2e-launch-ship-caught.png' });

  // restart: one launch per run, the stack is back on the mount
  await page.evaluate(() => (window as any).__rft.app.restart());
  await expect(page.locator('.rftl')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const w = (window as any).__rft.app.renderer.worldHandle.group;
    return w.getObjectByName('SuperHeavy').parent.name + '/' + w.getObjectByName('Starship').parent.name;
  })).toBe('Stack/Stack');
  expect(errors).toEqual([]);
});
