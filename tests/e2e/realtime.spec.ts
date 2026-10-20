import { expect, test, type Page } from '@playwright/test';

// Real-time acceptance through the actual menu (no fast-forward hook): what a player experiences.

const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

const STUNT_TITLES: Record<string, RegExp> = {
  ramp_hang: /Kopfüber-Rampe/, ramp_launch: /Rampen-Absprung/, kickflip: /Kickflip/, zero60: /0–60 mph/, ground_flip: /Bodenstart-Flip/,
};
for (const [stunt, title] of Object.entries(STUNT_TITLES)) {
  test(`menu → Stunts nachfliegen → ${stunt} runs in real time to the results screen`, async ({ page }) => {
    test.setTimeout(300_000);
    const errors = errorsOf(page);
    await page.goto('/?q=low&lang=de'); // German UI: the texts below are the German locale
    await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 90_000 });
    await page.getByRole('button', { name: /Stunts nachfliegen/ }).click();
    await page.getByRole('button', { name: title }).first().click();
    const t0 = Date.now();
    await page.waitForFunction(() => (window as any).__rft.app.menu.current === 'results', null, { timeout: 240_000 });
    const wall = (Date.now() - t0) / 1000;
    const r = await page.evaluate(() => ({ status: (window as any).__rft.app.session.outcome.status, simT: (window as any).__rft.app.sim.getState().t }));
    expect(r.status).toBe('success');
    // real time: the simulation clock and the wall clock agree within a factor of 2.5 (slow GPUs drop frames)
    expect(wall).toBeGreaterThan(r.simT * 0.6);
    expect(wall).toBeLessThan(r.simT * 2.5 + 10);
    await expect(page.getByText(/STUNT GESCHAFFT|Stunt geschafft/i)).toBeVisible();
    await page.screenshot({ path: `test-results/rt-${stunt}-results.png` });
    expect(errors).toEqual([]);
  });
}

test('free play: every assist level lifts off and the car stays intact', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = errorsOf(page);
  await page.goto('/?q=low&lang=de'); // German UI: the texts below are the German locale
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 90_000 });
  await page.getByRole('button', { name: /Freies Testen/ }).click();
  await page.getByRole('button', { name: /Losfliegen/ }).click();
  await page.waitForTimeout(2500); // settling after the spawn
  const levels: string[] = [];
  for (let k = 0; k < 3; k++) {
    const st = await page.evaluate(() => ({ assist: (window as any).__rft.app.manual?.assist }));
    levels.push(st.assist);
    await page.keyboard.down('Space'); await page.waitForTimeout(900); await page.keyboard.up('Space');
    await page.waitForTimeout(400);
    const alt = await page.evaluate(() => (window as any).__rft.app.session.telemetry().altitudeM);
    expect(alt, `lift in ${st.assist}`).toBeGreaterThan(0.8);
    await page.waitForTimeout(6000); // let ASSIST land; STABILIZED/RAW come down by gravity
    await page.evaluate(() => (window as any).__rft.app.restart());
    await page.waitForTimeout(2200);
    await page.keyboard.down('KeyN'); await page.waitForTimeout(100); await page.keyboard.up('KeyN'); // next assist level (held > 1 frame like a human)
    await page.waitForTimeout(200);
  }
  expect(new Set(levels).size).toBe(3);
  expect(errors).toEqual([]);
});
