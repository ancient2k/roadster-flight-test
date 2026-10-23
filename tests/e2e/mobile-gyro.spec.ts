import { expect, test, type Page } from '@playwright/test';

// Tilt steering (src/input/gyro.ts, gyroSensor.ts): sensor events are simulated with dispatchEvent
// (a page-side timer repeats the current pose like a real sensor at ~30 Hz). Runs under the phone
// projects of playwright.config.ts, e.g. `npx playwright test tests/e2e/mobile-gyro.spec.ts --project=pixel7`.

const SHOTS = process.env.RFT_SHOTS ?? 'test-results';
/** How far the player leans the phone back in the zero pose (deg). */
const HOLD = 35;

/** Fake sensor: window.__tilt = { pitch, roll } in screen terms, turned into beta/gamma for the current screen angle. */
async function installSensor(page: Page, opts: { permission?: 'granted' | 'denied'; silent?: boolean } = {}): Promise<void> {
  await page.addInitScript(({ hold, permission, silent }) => {
    const w = window as any;
    w.__tilt = { pitch: 0, roll: 0 };
    w.__permissionAsked = 0;
    if (permission) (window as any).DeviceOrientationEvent.requestPermission = () => { w.__permissionAsked++; return Promise.resolve(permission); };
    if (silent) return;
    setInterval(() => {
      const a = ((screen.orientation?.angle ?? 0) % 360 + 360) % 360;
      const p = hold + w.__tilt.pitch, r = w.__tilt.roll;
      // portrait: beta = top edge up, gamma = right edge down; landscape 90: screen top = device right edge
      const [beta, gamma] = a === 90 ? [r, -p] : a === 270 ? [-r, p] : a === 180 ? [-p, -r] : [p, r];
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta, gamma, absolute: false }));
    }, 33);
  }, { hold: HOLD, permission: opts.permission, silent: !!opts.silent });
}

async function boot(page: Page): Promise<void> {
  const vp = page.viewportSize()!;
  await page.setViewportSize({ width: Math.max(vp.width, vp.height), height: Math.min(vp.width, vp.height) });
  await page.goto('/?lang=en&touch');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 300_000, polling: 1000 });
  await page.evaluate(() => { const r = (window as any).__rft; r.app.menu.hide(); r.startFreePlay('ground_flip'); r.app.manual.assist = 'RAW'; });
  await expect(page.locator('[data-touch-ui]')).toBeVisible();
  await page.waitForTimeout(1000);
}

const tilt = (page: Page, pitch: number, roll: number) => page.evaluate(([p, r]) => { (window as any).__tilt = { pitch: p, roll: r }; }, [pitch, roll]);
const axes = (page: Page) => page.evaluate(() => {
  const app = (window as any).__rft.app;
  // commanded valve duties (lift corners 4..7) of the last simulation step
  const duty: Float32Array | undefined = app.session.lastOutput?.thrust?.duty;
  const corners = duty ? [duty[4], duty[5], duty[6], duty[7]] : [0, 0, 0, 0];
  return {
    pitch: app.manual.axes.pitch as number, roll: app.manual.axes.roll as number,
    front: corners[0] + corners[1], rear: corners[2] + corners[3], left: corners[0] + corners[2], right: corners[1] + corners[3],
    gyro: app.settings.get().controls.gyro as boolean,
  };
});

test('tilt steering drives the attitude nozzles', async ({ page }, info) => {
  await installSensor(page);
  await boot(page);
  const angle = await page.evaluate(() => screen.orientation?.angle ?? 0);
  console.log(`[${info.project.name}] screen angle ${angle}`);

  const sw = page.locator('.rft-touch-gyro');
  await expect(sw).toBeVisible();
  await expect(sw).toHaveAttribute('aria-checked', 'false'); // off by default
  expect((await axes(page)).gyro).toBe(false);
  await expect(page.locator('.rft-touch-recenter')).toBeHidden();

  // leaning the phone while it is off does nothing
  await tilt(page, 20, 0);
  await page.waitForTimeout(400);
  expect(Math.abs((await axes(page)).pitch)).toBeLessThan(0.01);

  // switch on: the current pose (leaned 20° further) becomes the zero
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.rft-touch-recenter')).toBeVisible();
  expect((await axes(page)).gyro).toBe(true);
  await page.waitForTimeout(400);
  const zero = await axes(page);
  expect(Math.abs(zero.pitch)).toBeLessThan(0.02);
  expect(Math.abs(zero.roll)).toBeLessThan(0.02);

  // tilt back 15° from there = nose up, forward = nose down; nozzles open
  await tilt(page, 35, 0);
  await expect.poll(async () => (await axes(page)).pitch).toBeGreaterThan(0.2);
  const up = await axes(page);
  expect(Math.abs(up.roll)).toBeLessThan(0.05);
  // nose up: the front lift nozzles open more than the rear ones
  await expect.poll(async () => { const a = await axes(page); return a.front - a.rear; }).toBeGreaterThan(0.1);
  await page.screenshot({ path: `${SHOTS}/mobile-gyro-${info.project.name}-pitch.png` });
  await tilt(page, 5, 0);
  await expect.poll(async () => (await axes(page)).pitch).toBeLessThan(-0.2);

  // right edge down = roll right, left = roll left
  await tilt(page, 20, 15);
  await expect.poll(async () => (await axes(page)).roll).toBeGreaterThan(0.2);
  expect(Math.abs((await axes(page)).pitch)).toBeLessThan(0.05);
  // roll right (right side down): the left nozzles push
  await expect.poll(async () => { const a = await axes(page); return a.left - a.right; }).toBeGreaterThan(0.1);
  await tilt(page, 20, -15);
  await expect.poll(async () => (await axes(page)).roll).toBeLessThan(-0.2);

  // dead zone: 2° reads zero
  await tilt(page, 22, 2);
  await page.waitForTimeout(500);
  const dz = await axes(page);
  expect(Math.abs(dz.pitch)).toBeLessThan(0.01);
  expect(Math.abs(dz.roll)).toBeLessThan(0.01);

  // recenter: the leaned pose becomes the new zero
  await tilt(page, 40, 0);
  await expect.poll(async () => (await axes(page)).pitch).toBeGreaterThan(0.2);
  await page.locator('.rft-touch-recenter').click();
  await expect.poll(async () => Math.abs((await axes(page)).pitch)).toBeLessThan(0.02);

  // restart recenters too
  await tilt(page, 55, 0);
  await expect.poll(async () => (await axes(page)).pitch).toBeGreaterThan(0.2);
  await page.evaluate(() => { const app = (window as any).__rft.app; app.restart(); app.manual.assist = 'RAW'; });
  await expect.poll(async () => Math.abs((await axes(page)).pitch)).toBeLessThan(0.02);

  // Settings -> Controls shows the option as on, with sensitivity and recenter
  await page.locator('.rft-touch-btn[data-control="menu"]').click();
  await page.evaluate(() => (window as any).__rft.app.menu.show('settings'));
  await page.locator('#tab-steuerung').click();
  const row = page.locator('[data-gyro]');
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-gyro-recenter]')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mobile-gyro-${info.project.name}-settings.png` });
  // switch off there
  await row.getByRole('switch').click();
  await expect.poll(async () => (await axes(page)).gyro).toBe(false);
  await page.evaluate(() => { const r = (window as any).__rft; r.app.menu.hide(); });
  await tilt(page, 0, 20);
  await page.waitForTimeout(500);
  const off = await axes(page);
  expect(Math.abs(off.roll)).toBeLessThan(0.01);
  await expect(sw).toHaveAttribute('aria-checked', 'false');
});

test('denied permission or a missing sensor leaves tilt steering off with a hint', async ({ page }) => {
  await installSensor(page, { permission: 'denied' });
  await boot(page);
  const sw = page.locator('.rft-touch-gyro');
  await sw.click();
  await expect.poll(() => page.evaluate(() => (window as any).__permissionAsked)).toBe(1);
  await page.waitForTimeout(300);
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  expect((await axes(page)).gyro).toBe(false);

  // the settings toggle shows why
  await page.evaluate(() => (window as any).__rft.app.menu.show('settings'));
  await page.locator('#tab-steuerung').click();
  const row = page.locator('[data-gyro]');
  await row.getByRole('switch').click();
  await expect(row).toContainText('denied');
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
});

test('no sensor events: the option stays off', async ({ page }) => {
  await installSensor(page, { silent: true });
  await boot(page);
  const sw = page.locator('.rft-touch-gyro');
  await sw.click();
  await page.waitForTimeout(2200);
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  expect((await axes(page)).gyro).toBe(false);
  await page.evaluate(() => (window as any).__rft.app.menu.show('settings'));
  await page.locator('#tab-steuerung').click();
  const row = page.locator('[data-gyro]');
  await row.getByRole('switch').click();
  await expect(row).toContainText('No motion sensor', { timeout: 5000 });
});
