import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

// site switch time (docs/RENDERING.md). Measured as the player sees it: from the switch
// request until the game runs smoothly (12 consecutive frames < 34 ms after the loading screen is gone).
// Budget 8 s in the test run (target on the M1 Pro: < 5 s; the test machine may be shared).

const BUDGET_MS = 8000;

const collectErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

/** Switch site and wait for a smooth picture; returns { loadMs, smoothMs } (smoothMs counts from the request). */
const switchTo = (page: Page, id: string) => page.evaluate(async (s) => {
  const rft = (window as any).__rft;
  const t0 = performance.now();
  await rft.startWorld(s);
  const loadMs = performance.now() - t0;
  let last = performance.now(), run = 0;
  const smoothMs = await new Promise<number>((res) => {
    const f = (t: number) => {
      run = t - last < 34 ? run + 1 : 0;
      last = t;
      if (run >= 12) res(t - t0);
      else if (t - t0 > 30_000) res(Infinity);
      else requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  return { loadMs, smoothMs, site: rft.app.siteId as string, loading: !!document.querySelector('.rft-loading') };
}, id);

test('site switches (first world, world to world, back to McGregor) are smooth within 8 s', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?q=high&nomenu');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 90_000 });
  await page.waitForTimeout(1500);
  for (const id of ['moon_hadley', 'mars_jezero', 'earth_mcgregor', 'mars_jezero']) {
    const r = await switchTo(page, id);
    console.log(`[r6] ${id}: Laden ${(r.loadMs / 1000).toFixed(2)} s, ruckelfrei ${(r.smoothMs / 1000).toFixed(2)} s`);
    expect(r.site).toBe(id);
    expect(r.loading).toBe(false);
    expect(r.smoothMs, `${id}: ${Math.round(r.smoothMs)} ms`).toBeLessThan(BUDGET_MS);
    // the session runs: the car is simulated in the new world
    const st = await page.evaluate(() => { const a = (window as any).__rft.app; return { crashed: a.sim.getState().crashed, t: a.sim.getState().t }; });
    expect(st.crashed).toBe(false);
  }
  await page.screenshot({ path: 'test-results/e2e-r6-jezero.png' });
  expect(errors).toEqual([]);
});

// Regression guard for every site and both backends. Idle machine: 0.2–5.4 s (docs/RENDERING.md);
// under heavy load from other processes (load average ≈ 20) single WebGL2 switches took up to 8.6 s, hence 12 s.
const ALL_SITES_BUDGET_MS = 12_000;
test('every site (all 10, WebGPU and WebGL2) is smooth within 12 s', async ({ page }) => {
  test.setTimeout(420_000);
  const errors = collectErrors(page);
  const sites = ['earth_stonehenge', 'earth_giza', 'moon_tranquility', 'moon_hadley', 'moon_shackleton', 'mars_jezero', 'mars_gale', 'mars_valles', 'space_sun', 'earth_mcgregor'];
  for (const webgl of [false, true]) {
    await page.goto(`/?q=high&nomenu${webgl ? '&webgl' : ''}`);
    await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 90_000 });
    await page.waitForTimeout(1500);
    for (const id of sites) {
      const r = await switchTo(page, id);
      console.log(`[load] ${webgl ? 'webgl2' : 'webgpu'} ${id}: ruckelfrei ${(r.smoothMs / 1000).toFixed(2)} s`);
      expect(r.site).toBe(id);
      expect(await page.evaluate(() => (window as any).__rft.app.renderer.backend)).toBe(webgl ? 'webgl2' : 'webgpu');
      expect(r.smoothMs, `${webgl ? 'webgl2' : 'webgpu'} ${id}: ${Math.round(r.smoothMs)} ms`).toBeLessThan(ALL_SITES_BUDGET_MS);
    }
  }
  expect(errors).toEqual([]);
});

test('ultra: every world is smooth within 12 s', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await page.goto('/?q=ultra&nomenu');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 90_000 });
  await page.waitForTimeout(1500);
  for (const id of ['earth_stonehenge', 'earth_giza', 'moon_tranquility', 'moon_hadley', 'moon_shackleton', 'mars_jezero', 'mars_gale', 'mars_valles', 'space_sun', 'earth_mcgregor']) {
    const r = await switchTo(page, id);
    console.log(`[load] ultra ${id}: ruckelfrei ${(r.smoothMs / 1000).toFixed(2)} s`);
    expect(r.site).toBe(id);
    expect(r.smoothMs, `ultra ${id}: ${Math.round(r.smoothMs)} ms`).toBeLessThan(ALL_SITES_BUDGET_MS);
  }
  expect(errors).toEqual([]);
});

test('cold start: fresh browser context, no cache – page to playable McGregor and on into Giza', async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } }); // empty HTTP cache
  const page = await ctx.newPage();
  const errors = collectErrors(page);
  const t0 = Date.now();
  await page.goto('/?q=high&nomenu');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 90_000 });
  const readyMs = Date.now() - t0;
  const r = await switchTo(page, 'earth_giza');
  console.log(`[load] kalt: bereit ${(readyMs / 1000).toFixed(2)} s, Gizeh ruckelfrei ${(r.smoothMs / 1000).toFixed(2)} s`);
  expect(readyMs).toBeLessThan(20_000);
  expect(r.smoothMs).toBeLessThan(ALL_SITES_BUDGET_MS);
  expect(errors).toEqual([]);
  await ctx.close();
});

