// Closing picture: the Roadster comes in from ahead on the left, brakes, swings round in a drift and stops in the
// right foreground, its nose toward the tower – just as Super Heavy, coming down, reaches the height of the tower
// arms (left third), which then catch it. The end card goes above the car (composited later).
import fs from 'node:fs';

const level = JSON.parse(fs.readFileSync('src/editor/samples/starbase-sprint.json', 'utf8'));
/** Mission time at the start of the shot: the booster is at the height of the arms when the car stops (≈ 4 s). */
export const MET0 = Number(process.env.MET0 ?? 399);

export default async function (page, { flyPath, controls, camera, settle, record }, name) {
  await page.evaluate((l) => window.__rft.playLevel(l), level);
  await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
  await page.evaluate(() => window.__rft.captureBegin());
  await settle(page, 1);
  await page.evaluate(() => { window.__rft.app.activeRun.launchIn = 30; });
  await settle(page, 0.1);
  await page.evaluate((m) => window.__rft.launchWarp(0, m), MET0);
  // camera low at (330, 660) looking north-east at the tower (656, 344); the car stops 20 m ahead and 8 m to the right
  await flyPath(page, [
    { t: 0, pos: [344, 0.45, 619], heading: 11 },
    { t: 1.4, pos: [347.5, 0.45, 637], heading: 15 },
    { t: 2.4, pos: [350, 0.45, 648], heading: 50 },
    { t: 3.1, pos: [351, 0.45, 653], heading: 100 },
    { t: 3.6, pos: [351.2, 0.45, 654.6], heading: 122 },
    { t: 4.0, pos: [351, 0.45, 655], heading: 128 },
    { t: 30, pos: [351, 0.45, 655], heading: 128 },
  ]);
  await controls(page, [{ t: 0, drive: { throttle: 0.3 } }, { t: 1.8, drive: { brake: 1, handbrake: true, steer: 0.8 } }, { t: 4.0, drive: { handbrake: true } }]);
  await camera(page, [
    { t: 0, pos: [330, 2.6, 660], look: [700, 56, 400], fov: 42 },
    { t: 16, pos: [331, 2.8, 661], look: [700, 60, 400], fov: 40 },
  ]);
  return record(page, name, 16);
}
