// Every shipped UI language boots without console errors and shows its own texts (title menu,
// settings, HUD). Screenshots land in test-results/i18n-<lang>-*.png for a visual layout check.
import { expect, test } from '@playwright/test';
import { LOCALE_CODES, t } from '../../src/i18n';

// 14 cold boots of ≈ 25–30 s each (q=low, fresh page) plus the settings check
test.describe.configure({ timeout: 600_000 });

test('all 14 languages load via ?lang= without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  for (const lang of LOCALE_CODES) {
    const e0 = errors.length;
    await page.goto(`/?q=low&lang=${lang}`);
    await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 120_000 });
    expect(await page.evaluate(() => document.documentElement.lang), lang).toBe(lang);
    // title menu in that language
    await expect(page.locator('.rft-mainbtn-label').first(), lang).toHaveText(t('menu.stunts', undefined, lang));
    await page.screenshot({ path: `test-results/i18n-${lang}-title.png` });
    // settings → display (language picker shows the forced language's own name list)
    await page.evaluate(() => (window as any).__rft.app.menu.show('settings'));
    await page.locator('.rft-tab').nth(1).click();
    await expect(page.locator('.rft-header h2'), lang).toHaveText(t('settings.title', undefined, lang));
    await expect(page.locator('select[data-setting="language"] option')).toHaveCount(LOCALE_CODES.length + 1);
    await page.screenshot({ path: `test-results/i18n-${lang}-settings.png` });
    // HUD in free play
    await page.evaluate(() => { const r = (window as any).__rft; r.app.menu.hide(); r.startFreePlay('ground_flip'); });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `test-results/i18n-${lang}-hud.png` });
    expect(errors.slice(e0), lang).toEqual([]);
  }
});

test('language switch in the settings applies immediately and persists', async ({ page }) => {
  await page.goto('/?q=low');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/?q=low');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 120_000 });
  await page.evaluate(() => (window as any).__rft.app.menu.show('settings'));
  await page.locator('.rft-tab').nth(1).click();
  await page.locator('select[data-setting="language"]').selectOption('fr');
  await expect(page.locator('.rft-header h2')).toHaveText('Paramètres');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('fr');
  await page.reload();
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 120_000 });
  await expect(page.locator('.rft-mainbtn-label').first()).toHaveText('Rejouer les cascades');
  await page.evaluate(() => localStorage.clear());
});
