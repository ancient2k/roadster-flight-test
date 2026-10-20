import { expect, test, type Page } from '@playwright/test';

// driving on loose soil throws dust and leaves tyre tracks; the jets scour the ground. Tranquility:
// drive a few seconds → track segments and dust grains exist, no console errors.

const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

test('Tranquility: driving leaves tyre tracks and throws regolith dust', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = errorsOf(page);
  await page.goto('/?q=low&nomenu');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 120_000 });
  await page.evaluate(() => (window as any).__rft.startWorld('moon_tranquility'));
  const before = await page.evaluate(() => {
    const a = (window as any).__rft.app, w = a.renderer.worldHandle;
    // 40 m off the spawn (clear of the LM), heading +Z, rolling at 8 m/s
    const x = w.spawn.x + 40, z = w.spawn.z + 40, g = w.heightAt(x, z);
    a.startSession({ kind: 'manual', spawn: { pos: { x, y: g + 0.05, z }, quat: { x: 0, y: 0, z: 0, w: 1 }, speedMs: 8 }, siteId: 'moon_tranquility' }, false, 'ASSIST');
    return a.renderer.groundFx();
  });
  expect(before.marks).not.toBeNull();
  await page.mouse.click(800, 450);
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => (window as any).__rft.app.renderer.groundFx().marks.segments > 40, null, { timeout: 60_000 });
  await page.waitForTimeout(1000);
  await page.keyboard.up('KeyW');
  const fx = await page.evaluate(() => (window as any).__rft.app.renderer.groundFx());
  expect(fx.marks.segments).toBeGreaterThan(40);
  expect(fx.marks.segments).toBeLessThanOrEqual(3000);       // q=low ring capacity
  expect(fx.dust.wheelGrains).toBeGreaterThan(100);
  expect(fx.dust.wheelVeil).toBe(0);                          // no gas on the Moon: grains only
  // the lift jets scour the regolith (directional multiplicative decal) and throw ejecta
  const scours0 = fx.marks.scours;
  await page.keyboard.down('Space');
  await page.waitForTimeout(1500);
  await page.keyboard.up('Space');
  const fx2 = await page.evaluate(() => (window as any).__rft.app.renderer.groundFx());
  expect(fx2.marks.scours).toBeGreaterThan(scours0);
  expect(fx2.dust.jetGrains).toBeGreaterThan(fx.dust.jetGrains);
  expect(errors, errors.join('\n')).toEqual([]);
});
