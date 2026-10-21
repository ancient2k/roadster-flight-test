import { expect, test, type Page } from '@playwright/test';

// R14 "Raumsteuerung": the Sun scene (zero g, vacuum) flown with the keyboard like a player.
// STABILIZED stops a rotation after the key is released and then stays quiet, RAW fires nothing without
// a key, ASSIST yaw does not push the car along its roof, focus loss releases a held key.
// Waits are in SIMULATION time (the machine is often loaded; the loop may run slower than real time).

const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

const simT = (page: Page) => page.evaluate(() => (window as any).__rft.app.sim.getState().t as number);
async function waitSim(page: Page, seconds: number): Promise<void> {
  const t0 = await simT(page);
  await page.waitForFunction((t) => (window as any).__rft.app.sim.getState().t >= t, t0 + seconds, { timeout: 120_000, polling: 50 });
}
/** Holds a key for `seconds` of simulation time. */
async function tap(page: Page, key: string, seconds: number): Promise<void> {
  await page.keyboard.down(key); await waitSim(page, seconds); await page.keyboard.up(key);
}
/** N (assist cycle) until the level is reached; held for a few frames like a player (a 0-ms press falls between two polls). */
async function cycleTo(page: Page, level: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (await page.evaluate((l) => (window as any).__rft.app.manual.assist === l, level)) return;
    await tap(page, 'KeyN', 0.15);
    await waitSim(page, 0.1);
  }
  expect(await page.evaluate(() => (window as any).__rft.app.manual.assist)).toBe(level);
}
const state = (page: Page) => page.evaluate(() => {
  const a = (window as any).__rft.app, s = a.sim.getState(), q = s.quat, w = s.angVel;
  // body rate = q⁻¹ · ω · q, roof (body +Y) in world
  const rot = (v: any, c: any) => {
    const ux = c.x, uy = c.y, uz = c.z, uw = c.w;
    const tx = 2 * (uy * v.z - uz * v.y), ty = 2 * (uz * v.x - ux * v.z), tz = 2 * (ux * v.y - uy * v.x);
    return { x: v.x + uw * tx + (uy * tz - uz * ty), y: v.y + uw * ty + (uz * tx - ux * tz), z: v.z + uw * tz + (ux * ty - uy * tx) };
  };
  const wb = rot(w, { x: -q.x, y: -q.y, z: -q.z, w: q.w });
  const up = rot({ x: 0, y: 1, z: 0 }, q);
  const v = s.linVel;
  return { t: s.t, wb, rate: Math.hypot(wb.x, wb.y, wb.z), vUp: v.x * up.x + v.y * up.y + v.z * up.z, g: Math.hypot(a.sim.gravity.x, a.sim.gravity.y, a.sim.gravity.z), assist: a.manual?.assist as string, lift: a.manual?.axes.lift as number };
});
/** Fraction of 50 ms samples over `seconds` of sim time in which any valve was open. */
async function firing(page: Page, seconds: number): Promise<number> {
  const t1 = (await simT(page)) + seconds;
  let n = 0, on = 0;
  while ((await simT(page)) < t1) {
    if (await page.evaluate(() => (window as any).__rft.app.sim.propulsion.dutyActual.some((d: number) => d > 0))) on++;
    n++;
    await page.waitForTimeout(50);
  }
  return n ? on / n : 0;
}

test('Raumsteuerung: STABILIZED / RAW / ASSIST in zero g with the keyboard, blur releases keys', async ({ page }) => {
  test.setTimeout(420_000);
  const errors = errorsOf(page);
  await page.goto('/?q=low&nomenu&lang=en');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 120_000 });
  await page.evaluate(() => (window as any).__rft.startWorld('space_sun'));
  await page.waitForFunction(() => { const a = (window as any).__rft.app; return a.siteId === 'space_sun' && !!a.manual; }, null, { timeout: 180_000 });
  await page.mouse.click(800, 450);   // focus the game
  // spawn settle (no wheels in space: ends after 5 s or with the first input)
  await waitSim(page, 5.5);
  expect((await state(page)).g).toBeLessThan(0.05);

  // ---- STABILIZED: N cycles ASSIST -> STABILIZED -> RAW
  await cycleTo(page, 'STABILIZED');
  await tap(page, 'KeyK', 0.4);                      // pitch up
  await waitSim(page, 2.5);
  const st = await state(page);
  expect(Math.abs(st.wb.x)).toBeLessThan(0.2);       // rotation stopped (before R14 it kept ≈ 0.9 rad/s)
  expect(st.rate).toBeLessThan(0.3);
  expect(await firing(page, 2.5)).toBeLessThan(0.05); // and the jets are quiet

  // ---- RAW: nothing fires without a key
  await cycleTo(page, 'RAW');
  await waitSim(page, 0.3);
  expect(await firing(page, 2)).toBe(0);

  // ---- ASSIST: a yaw tap turns the car with the yaw jets only
  await cycleTo(page, 'ASSIST');
  await waitSim(page, 2);
  const before = await state(page);
  await tap(page, 'KeyJ', 0.5);
  await waitSim(page, 4);
  const after = await state(page);
  expect(Math.abs(after.vUp - before.vUp)).toBeLessThan(0.8);   // before R14: ≈ +4.6 m/s along the roof
  expect(after.rate).toBeLessThan(0.45);

  // ---- focus loss while a key is held: the demand is released
  await page.keyboard.down('Space');
  await waitSim(page, 0.3);
  expect((await state(page)).lift).toBeGreaterThan(0.5);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await waitSim(page, 0.2);
  expect((await state(page)).lift).toBe(0);
  await page.keyboard.up('Space');

  expect(errors).toEqual([]);
});
