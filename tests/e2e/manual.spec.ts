import { expect, test, type Page } from '@playwright/test';

// Manual-mode acceptance beyond the smoke test: long flights to the air reserve, a simulated standard
// gamepad (navigator.getGamepads is replaced by a controllable fake), and a long session with varied input.

const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

/** Installs a fake standard-mapped gamepad, controllable through window.__pad. */
const fakeGamepad = () => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = { id: 'Fake Standard Gamepad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons, vibrationActuator: null };
  (window as any).__pad = {
    set(i: number, v: number) { buttons[i].value = v; buttons[i].pressed = v > 0.5; pad.timestamp = performance.now(); },
    axis(i: number, v: number) { pad.axes[i] = v; pad.timestamp = performance.now(); },
  };
  Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
  window.addEventListener('load', () => window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad })));
};

const startFree = async (page: Page) => {
  await page.goto('/?q=low');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 90_000 });
  await page.evaluate(() => (window as any).__rft.startFreePlay('ground_flip'));
  await page.mouse.click(800, 450);
  await page.waitForTimeout(2500); // settle on the wheels
};

const tel = (page: Page) => page.evaluate(() => {
  const a = (window as any).__rft.app; const s = a.sim.getState(); const t = a.session.telemetry();
  return { alt: t.altitudeM, air: t.airMassKg, phase: t.phase as string, crashed: s.crashed, speed: s.speedMs, wheels: s.wheels.filter((w: any) => w.contact).length, device: a.playerInput?.lastDevice };
});

test('ASSIST: holding lift until the air runs low triggers the reserve and lands safely', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = errorsOf(page);
  await startFree(page);
  await page.keyboard.down('Space');
  const phases = new Set<string>();
  let maxAlt = 0;
  for (let i = 0; i < 60; i++) { // up to 30 s of continuous lift demand
    await page.waitForTimeout(500);
    const t = await tel(page);
    if (t.phase) phases.add(t.phase);
    maxAlt = Math.max(maxAlt, t.alt);
    if (phases.has('AUTO-LANDUNG') && t.wheels >= 3) break;
  }
  await page.keyboard.up('Space');
  await page.waitForTimeout(6000);
  const end = await tel(page);
  expect(maxAlt).toBeGreaterThan(3);
  expect([...phases].some((p) => p === 'LUFT KNAPP' || p === 'AUTO-LANDUNG')).toBe(true);
  expect(end.crashed).toBe(false);
  expect(end.wheels).toBeGreaterThanOrEqual(3);
  expect(end.alt).toBeLessThan(0.3);
  expect(end.air).toBeGreaterThan(0); // the reserve was kept
  expect(errors).toEqual([]);
});

test('gamepad (standard mapping): throttle trigger drives, A button lifts, device is reported', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(fakeGamepad);
  const errors = errorsOf(page);
  await startFree(page);
  await page.evaluate(() => (window as any).__pad.set(7, 1)); // RT = throttle
  await page.waitForTimeout(2500);
  await page.evaluate(() => (window as any).__pad.set(7, 0));
  const drove = await tel(page);
  expect(drove.speed).toBeGreaterThan(5);
  expect(drove.device).toBe('gamepad');
  await page.evaluate(() => (window as any).__pad.set(0, 1)); // A = lift
  await page.waitForTimeout(1200);
  await page.evaluate(() => (window as any).__pad.set(0, 0));
  const lifted = await tel(page);
  expect(lifted.alt).toBeGreaterThan(1.5);
  await page.waitForTimeout(6000);
  expect((await tel(page)).crashed).toBe(false);
  expect(errors).toEqual([]);
});

test('long session: 90 s of varied driving and flying input without errors or NaN', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = errorsOf(page);
  await startFree(page);
  const keys = ['KeyW', 'KeyA', 'KeyD', 'Space', 'KeyQ', 'KeyE', 'ShiftLeft', 'KeyS', 'KeyJ', 'KeyL', 'KeyI', 'KeyK'];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 90; i++) {
    const k = keys[Math.floor(rnd() * keys.length)];
    await page.keyboard.down(k);
    await page.waitForTimeout(300 + rnd() * 700);
    await page.keyboard.up(k);
    if (i % 15 === 14) {
      const t = await tel(page);
      expect(Number.isFinite(t.alt) && Number.isFinite(t.speed) && Number.isFinite(t.air)).toBe(true);
      if (t.crashed) await page.evaluate(() => (window as any).__rft.app.restart());
    }
  }
  const fps = await page.evaluate(() => (window as any).__rft.app.renderer.getStats().fps);
  expect(fps).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});
