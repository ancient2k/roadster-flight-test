// Track editor: title menu -> editor, sample track, placing and erasing a piece, test drive in
// Boca Chica with the time trial running, Esc back to the editor.
import { expect, test } from '@playwright/test';

test('track editor: build, share, test drive and back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/?lang=en');
  await page.waitForFunction(() => (window as any).__rft?.ready, null, { timeout: 120_000 });
  await page.getByText('Track editor', { exact: true }).click();
  await expect(page.locator('.rfte-entry')).toBeVisible();
  await page.locator('.rfte-entry li', { hasText: 'Starbase Sprint' }).getByRole('button').click();
  await expect(page.locator('.rfte-entry')).toHaveCount(0);
  const parts0 = await page.evaluate(() => (window as any).__rft.app.editor.current.parts.length);
  expect(parts0).toBeGreaterThan(30);

  // place a ring in an empty corner, then erase it again with a right click
  await page.getByRole('button', { name: 'Stunts' }).click();
  await page.locator('.rfte-item', { hasText: 'Fly-through ring' }).click();
  const box = (await page.locator('.rfte-main canvas').boundingBox())!;
  const at = { x: box.x + box.width * 0.85, y: box.y + box.height * 0.2 };
  await page.mouse.click(at.x, at.y);
  expect(await page.evaluate(() => (window as any).__rft.app.editor.current.parts.length)).toBe(parts0 + 1);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  expect(await page.evaluate(() => (window as any).__rft.app.editor.current.parts.length)).toBe(parts0);

  // test drive: Boca Chica, car behind the start line, the clock starts with the first metre
  await page.getByRole('button', { name: 'Test drive' }).click();
  await page.waitForFunction(() => { const a = (window as any).__rft.app; return a.siteId === 'earth_bocachica' && !a.switching && a.levelRun; }, null, { timeout: 120_000 });
  await expect(page.locator('.rfth-row')).toBeVisible();
  await page.keyboard.down('KeyW'); await page.waitForTimeout(2500); await page.keyboard.up('KeyW');
  const run = await page.evaluate(() => { const r = (window as any).__rft.app.levelRun; return { state: r.state, t: r.t, progress: r.progress }; });
  expect(run.state).toBe('running');
  expect(run.t).toBeGreaterThan(1);
  await page.screenshot({ path: 'test-results/e2e-editor-drive.png' });

  // Esc: back to the editor with the same track
  await page.keyboard.down('Escape'); await page.waitForTimeout(150); await page.keyboard.up('Escape');
  await expect(page.locator('.rfte')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__rft.app.editor.current.parts.length)).toBe(parts0);
  expect(errors).toEqual([]);
});
