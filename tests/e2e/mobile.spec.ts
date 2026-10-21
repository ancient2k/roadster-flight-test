import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

// Mobile boot + touch drive. Runs under a phone profile (Chromium mobile emulation or WebKit
// iPhone, see docs/MOBILE.md); under the desktop config it forces the touch UI with ?touch.
// Screenshots go to $RFT_SHOTS (default test-results/).

const SHOTS = process.env.RFT_SHOTS ?? 'test-results';

const collectErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

const tel = (page: Page) => page.evaluate(() => {
  const a = (window as any).__rft.app;
  return { v: a.sim.getState().speedMs, alt: a.session.telemetry().altitudeM, crashed: a.sim.getState().crashed };
});

/** Press and hold inside an element (mouse -> pointer events, like a finger), optionally dragging by (dx, dy). */
async function hold(page: Page, selector: string, ms: number, dx = 0, dy = 0): Promise<void> {
  const box = (await page.locator(selector).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (dx || dy) await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test('mobile boot + touch drive', async ({ page }, info) => {
  const errors = collectErrors(page);
  const name = info.project.name || 'default';
  const vp = page.viewportSize()!;
  const portrait = { width: Math.min(vp.width, vp.height), height: Math.max(vp.width, vp.height) };
  await page.setViewportSize(portrait);
  await page.goto('/?lang=en&touch');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 300_000, polling: 1000 });

  // phones start on "low" without a stored choice
  const boot = await page.evaluate(() => ({ profile: (window as any).__rft.profile, q: (window as any).__rft.app.renderer.getStats().quality, backend: (window as any).__rft.app.renderer.getStats().backend }));
  if (info.project.use.isMobile) { expect(boot.profile).toBe('mobile'); expect(boot.q).toBe('low'); }
  console.log(`[${name}] boot`, JSON.stringify(boot));

  // portrait: landscape hint over the title menu, dismissable
  const rotate = page.locator('[data-touch-rotate]');
  await expect(rotate).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mobile-${name}-portrait-hint.png` });
  await rotate.getByRole('button').click();
  await expect(rotate).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/mobile-${name}-portrait-title.png` });

  // landscape: title menu fits, tap "Free test" opens the free-play screen
  await page.setViewportSize({ width: portrait.height, height: portrait.width });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/mobile-${name}-landscape-title.png` });
  const free = page.locator('.rft-mainbtn').nth(1);
  await expect(free).toBeInViewport();
  await free.click();
  await expect.poll(() => page.evaluate(() => (window as any).__rft.app.menu.current)).toBe('free');

  // driving: touch UI visible, no menu
  await page.evaluate(() => (window as any).__rft.startFreePlay('ground_flip'));
  const ui = page.locator('[data-touch-ui]');
  await expect(ui).toBeVisible();
  await page.waitForTimeout(1500);
  const v0 = (await tel(page)).v;
  await hold(page, '.rft-touch-zone.left', 2500, 0, -90); // drive stick pushed up = throttle
  const v1 = (await tel(page)).v;
  console.log(`[${name}] speed ${v0.toFixed(2)} -> ${v1.toFixed(2)} m/s`);
  expect(v1).toBeGreaterThan(v0 + 3);
  await page.screenshot({ path: `${SHOTS}/mobile-${name}-landscape-drive.png` });

  // lift thrusters
  await hold(page, '.rft-touch-btn[data-control="lift"]', 1500);
  const alt = (await tel(page)).alt;
  console.log(`[${name}] altitude after lift ${alt.toFixed(2)} m`);
  expect(alt).toBeGreaterThan(1);

  // tray + menu button -> pause menu, resume by tap
  await page.locator('.rft-touch-more').click();
  await expect(page.locator('.rft-touch-tray')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mobile-${name}-landscape-tray.png` });
  await page.locator('.rft-touch-btn[data-control="menu"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__rft.app.menu.current)).toBe('pause');
  await expect(ui).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/mobile-${name}-landscape-pause.png` });
  await page.getByRole('button', { name: /resume/i }).first().click();
  await expect(ui).toBeVisible();

  expect(errors).toEqual([]);
});

// ------------------------------------------------------------------ boot failure paths
// three's WebGPURenderer itself falls back to WebGL 2 when device creation fails; the one-time
// ?webgl reload in src/main.ts only covers failures after that point (not triggered here).
test('a broken WebGPU device still boots on WebGL 2', async ({ page }) => {
  await page.addInitScript(() => {
    const A = (window as any).GPUAdapter;
    if (A && !location.search.includes('webgl')) A.prototype.requestDevice = () => Promise.reject(new Error('test: no device'));
  });
  await page.goto('/?lang=en');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 300_000, polling: 1000 });
  const r = await page.evaluate(() => ({ search: location.search, backend: (window as any).__rft.app.renderer.getStats().backend, flag: sessionStorage.getItem('rft.bootRetry') }));
  console.log('[retry]', JSON.stringify(r));
  expect(String(r.backend)).toMatch(/webgl/i);
  expect(r.flag).toBeNull();
});

test('a final start failure shows a message instead of loading forever', async ({ page }) => {
  await page.addInitScript(() => { HTMLCanvasElement.prototype.getContext = () => null; });
  await page.goto('/?lang=en&webgl');
  const msg = page.locator('#boot .msg[role=alert]');
  await expect(msg).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#boot')).toHaveClass(/failed/);
  await expect(msg.getByRole('button', { name: 'Reload' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mobile-boot-failed.png` });
  await page.waitForTimeout(3000);
  expect(new URL(page.url()).searchParams.get('webgl')).not.toBeNull(); // no reload loop
});

test('a stalled start offers simple graphics; keep waiting dismisses it', async ({ page }) => {
  await page.addInitScript(() => {
    if ((navigator as any).gpu) (navigator as any).gpu.requestAdapter = () => new Promise(() => {});
    else HTMLCanvasElement.prototype.getContext = function () { return new Promise(() => {}) as any; } as any;
  });
  await page.goto('/?lang=en&bootslow=6');
  const msg = page.locator('#boot .msg[role=alert]');
  await expect(msg).toBeVisible({ timeout: 120_000 });
  await expect(msg).toContainText('unusually long');
  await page.screenshot({ path: `${SHOTS}/mobile-boot-slow.png` });
  await msg.getByRole('button', { name: 'Keep waiting' }).click();
  await page.waitForTimeout(2500);
  await expect(msg).toHaveCount(0);
  await expect(page.locator('#boot .ph')).toContainText('Preparing graphics');
});
