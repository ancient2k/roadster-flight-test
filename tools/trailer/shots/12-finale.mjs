// Closing picture: Super Heavy comes back and is caught by the tower arms (left third), the Roadster hovers in from
// the left toward the tower; the right half stays calm for the end card (composited later).
import fs from 'node:fs';

const level = JSON.parse(fs.readFileSync('src/editor/samples/starbase-sprint.json', 'utf8'));
export const MET0 = 399;

export default async function (page, { flyPath, infiniteAir, controls, camera, settle, record }, name) {
  await page.evaluate((l) => window.__rft.playLevel(l), level);
  await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
  await page.evaluate(() => window.__rft.captureBegin());
  await settle(page, 1);
  await page.evaluate(() => { window.__rft.app.levelRun.launchIn = 30; });
  await settle(page, 0.1);
  await page.evaluate((m) => window.__rft.launchWarp(0, m), MET0);
  await infiniteAir(page);
  await flyPath(page, [
    { t: 0, pos: [372, 16, 610], heading: 45 },
    { t: 6, pos: [400, 20, 590], heading: 48 },
    { t: 14, pos: [412, 21, 582], heading: 50 },
  ]);
  await controls(page, [{ t: 0, thrust: { lift: 0.6, boost: 0.4 } }]);
  await camera(page, [
    { t: 0, pos: [330, 12, 660], look: [700, 95, 400], fov: 40 },
    { t: 14, pos: [342, 13, 652], look: [700, 100, 400], fov: 38 },
  ]);
  await settle(page, 0.3);
  return record(page, name, 14);
}
