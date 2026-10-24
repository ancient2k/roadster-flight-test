// Closing picture: Super Heavy comes back and is caught by the tower arms (left third); the Roadster stands in the
// right foreground, diagonally below where the end card goes, its nose toward the tower – watching the catch.
import fs from 'node:fs';

const level = JSON.parse(fs.readFileSync('src/editor/samples/starbase-sprint.json', 'utf8'));
export const MET0 = 399;

export default async function (page, { placeCar, controls, camera, settle, record }, name) {
  await page.evaluate((l) => window.__rft.playLevel(l), level);
  await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
  await page.evaluate(() => window.__rft.captureBegin());
  await settle(page, 1);
  await page.evaluate(() => { window.__rft.app.activeRun.launchIn = 30; });
  await settle(page, 0.1);
  await page.evaluate((m) => window.__rft.launchWarp(0, m), MET0);
  // camera low at (330, 660) looking north-east at the tower (656, 344); the car 20 m ahead and 8 m to the right
  await placeCar(page, { x: 351, z: 655, headingDeg: 128 });
  await controls(page, [{ t: 0, drive: { handbrake: true } }]);
  await settle(page, 1);
  await camera(page, [
    { t: 0, pos: [330, 2.6, 660], look: [700, 56, 400], fov: 42 },
    { t: 14, pos: [331, 2.8, 661], look: [700, 60, 400], fov: 40 },
  ]);
  await settle(page, 0.5);
  return record(page, name, 14);
}
