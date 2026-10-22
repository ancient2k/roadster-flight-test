// Editor walk-through with screenshots (development aid): entry screen, sample track, placing pieces, test drive.
//   node tests/perf/_editorshot.mjs <url> <out prefix>
import { chromium } from '@playwright/test';
const [url, out] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = []; page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); }); page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${url}?lang=de`);
await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}-0-title.jpg`, type: 'jpeg', quality: 80 });
await page.getByText('Strecken-Editor').click();
await page.waitForSelector('.rfte-entry');
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}-1-entry.jpg`, type: 'jpeg', quality: 80 });
// open the sample "Starbase Sprint"
await page.locator('.rfte-entry li', { hasText: 'Starbase Sprint' }).getByRole('button').click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}-2-sample.jpg`, type: 'jpeg', quality: 80 });
// place a few pieces by clicking: stunt group, loop, then click on the grid
await page.getByRole('button', { name: 'Stunts' }).click();
await page.locator('.rfte-item', { hasText: 'Looping' }).click();
const box = await page.locator('.rfte-main canvas').boundingBox();
await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}-3-ghost.jpg`, type: 'jpeg', quality: 80 });
await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.5);
await page.keyboard.press('r');
await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.45);
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}-4-placed.jpg`, type: 'jpeg', quality: 80 });
// test drive
const t0 = Date.now();
await page.getByRole('button', { name: 'Testfahrt' }).click();
await page.waitForFunction(() => !document.querySelector('.rfte') || getComputedStyle(document.querySelector('.rfte')).display === 'none', null, { timeout: 120000 });
await page.waitForFunction(() => window.__rft.app.siteId === 'earth_bocachica' && !window.__rft.app.switching, null, { timeout: 120000 });
await page.waitForTimeout(3000);
console.log('test drive ready after', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.screenshot({ path: `${out}-5-drive.jpg`, type: 'jpeg', quality: 80 });
await page.keyboard.down('KeyW'); await page.waitForTimeout(3500); await page.keyboard.up('KeyW');
await page.screenshot({ path: `${out}-6-driving.jpg`, type: 'jpeg', quality: 80 });
await page.keyboard.down('Escape'); await page.waitForTimeout(150); await page.keyboard.up('Escape');
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}-7-back.jpg`, type: 'jpeg', quality: 80 });
console.log(errs.slice(0, 10).join('\n') || 'no errors');
await browser.close();
