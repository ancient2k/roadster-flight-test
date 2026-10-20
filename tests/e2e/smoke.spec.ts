import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

// E2E acceptance against the production build (vite preview). The game exposes `window.__rft`
// (src/main.ts) for deterministic driving from tests.

const collectErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

const boot = async (page: Page, query = '?q=low') => {
  await page.goto('/' + query);
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 90_000 });
};

test('title menu loads over the live demo without console errors', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await expect(page.locator('canvas').first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).__rft.app.menu.current)).toBe('title');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-results/e2e-title.png' });
  expect(errors).toEqual([]);
});

for (const stunt of ['ramp_hang', 'ramp_launch', 'kickflip', 'zero60', 'ground_flip']) {
  test(`auto stunt ${stunt} succeeds and shows the results screen`, async ({ page }) => {
    const errors = collectErrors(page);
    await boot(page);
    await page.evaluate((s) => (window as any).__rft.startStunt(s), stunt);
    let r: any;
    for (let k = 0; k < 90; k++) {
      r = await page.evaluate(() => (window as any).__rft.fastForward(1));
      if (r.outcome !== 'running') break;
    }
    expect(r.outcome, `reason: ${r.reason}`).toBe('success');
    await page.waitForFunction(() => (window as any).__rft.app.menu.current === 'results', null, { timeout: 60_000 });
    await page.screenshot({ path: `test-results/e2e-results-${stunt}.png` });
    expect(errors).toEqual([]);
  });
}

test('manual free play responds to the keyboard (drive, lift, assist levels)', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await page.evaluate(() => (window as any).__rft.startFreePlay('ground_flip'));
  await page.mouse.click(800, 450);
  const tel = () => page.evaluate(() => { const a = (window as any).__rft.app; return { v: a.sim.getState().speedMs, alt: a.session.telemetry().altitudeM, crashed: a.sim.getState().crashed }; });
  await page.keyboard.down('KeyW'); await page.waitForTimeout(2000); await page.keyboard.up('KeyW');
  expect((await tel()).v).toBeGreaterThan(5);
  await page.keyboard.down('Space'); await page.waitForTimeout(1200); await page.keyboard.up('Space');
  expect((await tel()).alt).toBeGreaterThan(1.5);
  await page.waitForTimeout(6000);
  const end = await tel();
  expect(end.crashed).toBe(false);
  expect(errors).toEqual([]);
});

test('WebGL2 fallback boots and renders without errors', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page, '?q=low&webgl');
  const backend = await page.evaluate(() => (window as any).__rft.app.renderer.getStats().backend);
  expect(String(backend)).toMatch(/webgl/i);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'test-results/e2e-webgl.png' });
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------ Phase 2: worlds
const SITES_E2E = ['earth_stonehenge', 'earth_giza', 'moon_tranquility', 'moon_hadley', 'moon_shackleton', 'mars_jezero', 'mars_gale', 'mars_valles'];
for (const site of SITES_E2E) {
  test(`world ${site} loads, gravity matches, car settles on its wheels`, async ({ page }) => {
    const errors = collectErrors(page);
    await boot(page);
    await page.evaluate((s) => (window as any).__rft.startWorld(s), site);
    await page.waitForTimeout(5000);
    const r = await page.evaluate(() => {
      const a = (window as any).__rft.app; const s = a.sim.getState();
      return { site: a.siteId, g: a.sim.gravity.y, wheels: s.wheels.filter((w: any) => w.contact).length, crashed: s.crashed, speed: s.speedMs };
    });
    expect(r.site).toBe(site);
    const expectedG = site.startsWith('moon') ? -1.62 : site.startsWith('mars') ? -3.721 : -9.80665;
    expect(r.g).toBeCloseTo(expectedG, 2);
    expect(r.wheels).toBeGreaterThanOrEqual(3);
    expect(r.crashed).toBe(false);
    expect(r.speed).toBeLessThan(1.0); // auto-hold on slopes
    await page.screenshot({ path: `test-results/e2e-world-${site}.png` });
    expect(errors).toEqual([]);
  });
}

test('Sun scene: zero gravity, the dive runs until the car vaporises', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await page.evaluate(() => (window as any).__rft.startWorld('space_sun'));
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => (window as any).__rft.app.sim.gravity.y)).toBe(0);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 3; i++) await page.keyboard.press('PageUp'); // warp 1e5 -> 1e7 (clamped)
  await page.waitForFunction(() => (window as any).__rft.app['sunPanel']?.dive?.state.done === true, null, { timeout: 90_000 });
  const ev = await page.evaluate(() => (window as any).__rft.app['sunPanel'].dive.events.map((e: any) => e.id));
  expect(ev).toContain('aluminium');
  expect(ev[ev.length - 1]).toBe('vapor');
  await page.screenshot({ path: 'test-results/e2e-sun.png' });
  expect(errors).toEqual([]);
});

test('WebGL2: switching between worlds works repeatedly without errors', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await boot(page, '?q=low&webgl');
  for (const s of ['moon_tranquility', 'earth_giza', 'space_sun', 'earth_mcgregor', 'mars_jezero']) {
    await page.evaluate((x) => (window as any).__rft.startWorld(x), s);
    await page.waitForTimeout(2500);
    const st = await page.evaluate(() => ({ site: (window as any).__rft.app.siteId, backend: (window as any).__rft.app.renderer.getStats().backend }));
    expect(st.site).toBe(s);
    expect(String(st.backend)).toMatch(/webgl/i);
  }
  expect(errors).toEqual([]);
});
