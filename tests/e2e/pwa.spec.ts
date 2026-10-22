import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Installable app: manifest + service worker (tools/pwa/), boot MB counter with cached files, offline
// start after one visit. Chromium only (installability via the DevTools protocol).

const SHOTS = process.env.RFT_SHOTS ?? 'test-results';
const ready = (page: Page) => page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 300_000, polling: 500 });
/** Last MB figure the boot screen showed (index.html removes the element when the game is ready). */
const lastMb = (page: Page) => page.evaluate(() => parseFloat((window as any).__mbLast ?? '0'));
const cacheCount = (page: Page, name: string) => page.evaluate(async (n) => (await (await caches.open(n)).keys()).length, name);

test('installable, boots from the cache, starts offline after one visit', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'installability check needs Chromium');
  test.setTimeout(600_000);
  await page.addInitScript(() => {
    const t = setInterval(() => {
      const mb = document.querySelector('#boot .mb')?.textContent;
      if (mb) (window as any).__mbLast = mb;
      if ((window as any).__rft?.ready) clearInterval(t);
    }, 50);
  });

  // first visit: network only; the worker registers after the start and takes the page over
  await page.goto('./?q=low'); // relative: the suite also runs with a sub-folder baseURL
  await ready(page);
  const mbNet = await lastMb(page);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 120_000 });
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector<HTMLLinkElement>('link[rel=manifest]')!.href)).json());
  expect(manifest.start_url).toBe('./');
  expect(manifest.scope).toBe('./');
  // Playwright contexts are incognito (Chrome never offers install there): ask a real profile
  const profile = mkdtempSync(join(tmpdir(), 'rft-pwa-'));
  const real = await chromium.launchPersistentContext(profile, { channel: 'chromium', args: ['--enable-unsafe-webgpu'] });
  try {
    const p2 = real.pages()[0] ?? await real.newPage();
    await p2.goto(page.url());
    await p2.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 300_000, polling: 1000 });
    const inst = await (await real.newCDPSession(p2)).send('Page.getInstallabilityErrors');
    const app = await (await real.newCDPSession(p2)).send('Page.getAppManifest');
    console.log('[pwa] installability', JSON.stringify(inst.installabilityErrors), 'manifest errors', JSON.stringify(app.errors));
    expect(inst.installabilityErrors).toEqual([]);
    expect(app.errors).toEqual([]);
  } finally { await real.close(); rmSync(profile, { recursive: true, force: true }); }

  // the boot assets of the first visit are copied into the asset cache ("warm")
  let n = -1;
  await expect.poll(async () => { const m = await cacheCount(page, 'rft-assets'); const stable = m === n && m > 5; n = m; return stable; },
    { timeout: 120_000, intervals: [2000] }).toBe(true);
  console.log(`[pwa] cached assets after first visit: ${n}`);

  // second visit: everything from the worker; the MB counter still moves
  await page.reload();
  await ready(page);
  const mbCache = await lastMb(page);
  console.log(`[pwa] boot MB network ${mbNet}, from cache ${mbCache}`);
  expect(mbNet).toBeGreaterThan(5);
  expect(mbCache).toBeGreaterThan(5);

  // a visited world is cached too
  await page.evaluate(() => (window as any).__rft.startWorld('moon_tranquility'));
  await page.waitForTimeout(4000);

  // offline: the game, the start scene and the visited world still load
  const failed: string[] = [];
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('console', (m) => { if (m.type() === 'error') failed.push(`console: ${m.text()}`); });
  await context.setOffline(true);
  await page.reload();
  await ready(page).catch((e) => { throw new Error(`offline start failed: ${failed.slice(0, 10).join(' | ')}\n${e}`); });
  await page.evaluate(() => (window as any).__rft.startWorld('moon_tranquility'));
  await page.waitForTimeout(4000);
  expect(await page.evaluate(() => (window as any).__rft.app.siteId)).toBe('moon_tranquility');
  await page.screenshot({ path: `${SHOTS}/pwa-offline-moon.png` });
  await context.setOffline(false);
});
