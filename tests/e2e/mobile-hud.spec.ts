import { expect, test, type Page } from '@playwright/test';
import { LOCALE_CODES } from '../../src/i18n';

// Mobile HUD layout: screenshots of the driving HUD with the touch overlay, the ⋯ tray and the
// menus in landscape and portrait, in English and the longest translations, plus a geometric
// check that no HUD group overlaps a touch control. Runs under the phone projects of
// playwright.config.ts; screenshots go to $RFT_SHOTS (default test-results/).

const SHOTS = process.env.RFT_SHOTS ?? 'test-results';
/** Languages with the longest HUD / touch labels (plus CJK). */
const LANGS = ['de', 'ru', 'fr', 'ja'];

const ready = (page: Page) => page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 300_000, polling: 1000 });

async function setLang(page: Page, lang: string): Promise<void> {
  await page.evaluate(() => (window as any).__rft.app.menu.show('settings'));
  await page.locator('.rft-tab').nth(1).click();
  await page.locator('select[data-setting="language"]').selectOption(lang);
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(lang);
}

async function drive(page: Page): Promise<void> {
  await page.evaluate(() => { const r = (window as any).__rft; r.app.menu.hide(); r.startFreePlay('ground_flip'); });
  await expect(page.locator('[data-touch-ui]')).toBeVisible();
  await page.waitForTimeout(1500);
}

type Box = { name: string; x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** HUD groups (Hud.layoutBoxes) against the visible touch controls; returns the overlapping pairs. */
async function collisions(page: Page): Promise<string[]> {
  const r = await page.evaluate(() => {
    const hud = (window as any).__rft.app.hud?.layoutBoxes?.() ?? [];
    const box = (name: string, b: DOMRect) => ({ name, x: b.x, y: b.y, w: b.width, h: b.height });
    const visible = (e: HTMLElement) => e.offsetParent !== null && !e.closest('[hidden]');
    const touch = [...document.querySelectorAll<HTMLElement>('.rft-touch-btns .rft-touch-btn, .rft-touch-top, .rft-touch-base')]
      .filter(visible).map((e) => box(e.dataset.control ?? e.className, e.getBoundingClientRect()));
    for (const e of document.querySelectorAll<HTMLElement>('.rft-touch-hint')) {
      if (!visible(e)) continue;
      const r = document.createRange(); r.selectNodeContents(e);
      touch.push(box(`hint ${e.textContent}`, r.getBoundingClientRect()));
    }
    // clipped button labels (all languages)
    for (const e of document.querySelectorAll<HTMLElement>('.rft-touch-btn')) {
      if (visible(e) && e.scrollWidth > e.clientWidth + 1) touch.push({ name: `clipped ${e.dataset.control}: ${e.textContent}`, x: -1e4, y: -1e4, w: 0, h: 0 });
    }
    return { hud, touch, w: innerWidth, h: innerHeight };
  });
  const out: string[] = (r.touch as Box[]).filter((t) => t.name.startsWith('clipped')).map((t) => t.name);
  for (const h of r.hud as Box[]) {
    for (const t of r.touch as Box[]) if (overlap(h, t)) out.push(`${h.name} × ${t.name}`);
    if (h.x < -1 || h.y < -1 || h.x + h.w > r.w + 1 || h.y + h.h > r.h + 1) out.push(`${h.name} off-screen`);
  }
  const tc = (r.touch as Box[]).filter((t) => !t.name.startsWith('clipped'));
  for (let i = 0; i < tc.length; i++) for (let j = i + 1; j < tc.length; j++) {
    if (overlap(tc[i], tc[j])) out.push(`${tc[i].name} × ${tc[j].name}`);
  }
  for (let i = 0; i < r.hud.length; i++) for (let j = i + 1; j < r.hud.length; j++) {
    if (overlap(r.hud[i], r.hud[j])) out.push(`${r.hud[i].name} × ${r.hud[j].name}`);
  }
  return out;
}

test('mobile HUD layout: landscape, portrait, tray, menus, languages', async ({ page }, info) => {
  test.setTimeout(600_000);
  const name = info.project.name || 'default';
  const vp = page.viewportSize()!;
  const land = { width: Math.max(vp.width, vp.height), height: Math.min(vp.width, vp.height) };
  const shot = (what: string) => page.screenshot({ path: `${SHOTS}/hud-${name}-${what}.png` });
  await page.setViewportSize(land);
  // the large iPhone gets a notch / home indicator (emulation has no safe-area insets; see src/ui/touch.css)
  const notch = name.startsWith('iphone');
  const insets = async (portrait: boolean) => {
    if (!notch) return;
    const v = portrait ? { top: 59, right: 0, bottom: 34, left: 0 } : { top: 0, right: 59, bottom: 21, left: 59 };
    await page.evaluate((x) => { for (const [k, px] of Object.entries(x)) document.documentElement.style.setProperty(`--rft-safe-${k}`, `${px}px`); }, v);
  };
  await page.goto('/?touch&q=low');
  await ready(page);
  await insets(false);

  await drive(page);
  await shot('landscape-en');
  const bad: string[] = [];
  bad.push(...(await collisions(page)).map((c) => `landscape en: ${c}`));

  await page.locator('.rft-touch-more').click();
  await expect(page.locator('.rft-touch-tray')).toBeVisible();
  await shot('landscape-tray');
  await page.locator('.rft-touch-more').click();

  await page.locator('.rft-touch-btn[data-control="menu"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__rft.app.menu.current)).toBe('pause');
  await shot('landscape-pause');
  await page.evaluate(() => (window as any).__rft.app.menu.show('settings'));
  await shot('landscape-settings');

  for (const lang of LANGS) {
    await setLang(page, lang);
    await drive(page);
    await shot(`landscape-${lang}`);
    bad.push(...(await collisions(page)).map((c) => `landscape ${lang}: ${c}`));
  }

  // every other language: geometry and clipped labels only (no screenshots)
  for (const lang of LOCALE_CODES.filter((l) => l !== 'en' && !LANGS.includes(l))) {
    await setLang(page, lang);
    await drive(page);
    bad.push(...(await collisions(page)).map((c) => `landscape ${lang}: ${c}`));
  }

  // portrait (the landscape hint dismissed): HUD and touch overlay still usable
  await setLang(page, 'de');
  await page.setViewportSize({ width: land.height, height: land.width });
  await insets(true);
  await drive(page);
  const rotate = page.locator('[data-touch-rotate]');
  if (await rotate.isVisible()) await rotate.getByRole('button').click();
  await page.waitForTimeout(500);
  await shot('portrait-de');
  bad.push(...(await collisions(page)).map((c) => `portrait de: ${c}`));
  await page.evaluate(() => (window as any).__rft.app.menu.show('pause'));
  await shot('portrait-pause');

  console.log(`[${name}] collisions`, JSON.stringify(bad));
  if (process.env.RFT_HUD_BEFORE) return; // baseline screenshots of the old layout only
  expect(bad).toEqual([]);
});
