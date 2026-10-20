import { expect, test, type Page } from '@playwright/test';

// movable, breakable landmarks. Tranquility: drive into the Eagle descent stage → it moves, the parts'
// graphics follow the physics, no console errors. Sun scene: ram Roadster 1 → the orbit panel shows the new orbit.

const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

async function boot(page: Page, site: string): Promise<void> {
  await page.goto('/?q=low&nomenu&lang=en');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 120_000 });
  await page.evaluate((s) => (window as any).__rft.startWorld(s), site);
}

test('Tranquility: ramming the LM descent stage moves it', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = errorsOf(page);
  await boot(page, 'moon_tranquility');
  const start = await page.evaluate(() => {
    const a = (window as any).__rft.app, p = a.sim.props;
    const c = p.partPose(0, 0).pos;
    const x = c.x, z = c.z + 22;   // 22 m south of the LM, facing north (−Z)
    const g = a.renderer.worldHandle.heightAt(x, z);
    a.startSession({ kind: 'manual', spawn: { pos: { x, y: g + 0.05, z }, quat: { x: 0, y: 1, z: 0, w: 0 }, speedMs: 6 }, siteId: 'moon_tranquility' }, false, 'ASSIST');
    return { c, parts: p.objects[0].parts.length, id: p.objects[0].placement.def.id };
  });
  expect(start.id).toBe('lm');
  expect(start.parts).toBe(6);
  await page.mouse.click(800, 450);
  await page.waitForFunction((c) => {
    const p = (window as any).__rft.app.sim.props.partPose(0, 0).pos;
    return Math.hypot(p.x - c.x, p.z - c.z) > 0.3;
  }, start.c, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const end = await page.evaluate(() => {
    const a = (window as any).__rft.app, p = a.sim.props;
    const b = p.partPose(0, 0);
    // the main body's graphics group follows the physics pose
    const g = a.renderer.worldHandle.group.getObjectByName('lm:body');
    const e = g.matrix.elements;
    return { pos: b.pos, gfx: { x: e[12], y: e[13], z: e[14] }, intact: p.intactJoints, crashed: a.sim.getState().crashed };
  });
  expect(Math.hypot(end.pos.x - start.c.x, end.pos.z - start.c.z)).toBeGreaterThan(0.3);
  expect(Math.hypot(end.gfx.x - end.pos.x, end.gfx.y - end.pos.y, end.gfx.z - end.pos.z)).toBeLessThan(0.05);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Sun scene: ramming Roadster 1 changes its orbit in the panel', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = errorsOf(page);
  await boot(page, 'space_sun');
  await expect(page.locator('.rft-orbitpanel')).toContainText('Undisturbed');
  await page.evaluate(() => {
    const a = (window as any).__rft.app, p = a.sim.props.partPose(0, 0).pos;
    // 12 m behind Roadster 1 (−Z), aimed at it, 7 m/s; the spawn point is the ground point under the CoG
    a.startSession({ kind: 'manual', spawn: { pos: { x: p.x, y: p.y - 0.45, z: p.z - 12 }, quat: { x: 0, y: 0, z: 0, w: 1 }, speedMs: 7 }, siteId: 'space_sun' }, false, 'ASSIST');
  });
  await page.mouse.click(800, 450);
  await page.waitForFunction(() => !!(window as any).__rft.app.orbitPanel?.result, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const res = (window as any).__rft.app.orbitPanel.result;
    return { dv: res.dvMag, dq: res.after.q - res.before.q, dP: res.after.periodS - res.before.periodS };
  });
  expect(r.dv).toBeGreaterThan(1);       // a 1.9 t car at 7 m/s into a 1.25 t Roadster
  expect(r.dv).toBeLessThan(15);
  expect(Math.abs(r.dP)).toBeGreaterThan(600);   // s: a few m/s change the period by hours, not seconds
  const panel = page.locator('.rft-orbitpanel');
  await expect(panel).toContainText('Rammed');
  await expect(panel.locator('[data-k="per"]')).toContainText(' h)');
  await expect(panel.locator('[data-k="peri"]')).toContainText('km)');
  expect(errors, errors.join('\n')).toEqual([]);
});
