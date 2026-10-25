// Closing picture: the cross-fade from the jump runs over the empty field; then the Roadster comes in from the left,
// brakes, swings round in a drift and stops in the right foreground, its nose toward the tower – just as Super Heavy,
// coming down, reaches the height of the tower arms (left third), which then catch it. The end card goes above the car (composited later).
import fs from 'node:fs';

const level = JSON.parse(fs.readFileSync('src/editor/samples/starbase-sprint.json', 'utf8'));
/** Mission time at the start of the shot: the booster is at the height of the arms when the car stops (≈ 5.4 s). */
export const MET0 = Number(process.env.MET0 ?? 399.5);
/** Camera and its view direction on the ground; car keys are given as (ahead, right) of the camera in metres. */
const CAM = [330, 660], FWD = [0.818, -0.575], RIGHT = [0.575, 0.818];
const at = (f, r) => [CAM[0] + f * FWD[0] + r * RIGHT[0], 0.45, CAM[1] + f * FWD[1] + r * RIGHT[1]];

export default async function (page, { flyPath, controls, camera, settle, record }, name) {
  await page.evaluate((l) => window.__rft.playLevel(l), level);
  await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
  await page.evaluate(() => window.__rft.captureBegin());
  await settle(page, 1);
  await page.evaluate(() => { window.__rft.app.activeRun.launchIn = 30; });
  await settle(page, 0.1);
  await page.evaluate((m) => window.__rft.launchWarp(0, m), MET0);
  // camera low at (330, 660) looking north-east at the tower (656, 344); the car runs in across the picture from the
  // left (out of frame until ≈ 1.6 s, after the cross-fade) and stops 20 m ahead and 8 m to the right
  await flyPath(page, [
    { t: 0, pos: at(27, -45), heading: 32 },
    { t: 1.0, pos: at(26, -29), heading: 32 },
    { t: 1.8, pos: at(25.3, -17), heading: 32 },
    { t: 2.8, pos: at(24, -4), heading: 36 },
    { t: 3.6, pos: at(22, 3.5), heading: 70 },
    { t: 4.4, pos: at(20.8, 6.8), heading: 108 },
    { t: 5.0, pos: at(20.3, 7.8), heading: 123 },
    { t: 5.4, pos: at(20.1, 8), heading: 128 },
    { t: 30, pos: at(20.1, 8), heading: 128 },
  ]);
  await controls(page, [{ t: 0, drive: { throttle: 0.4 } }, { t: 2.8, drive: { brake: 1, handbrake: true, steer: 0.8 } }, { t: 5.4, drive: { handbrake: true } }]);
  await camera(page, [
    { t: 0, pos: [330, 2.6, 660], look: [700, 56, 400], fov: 42 },
    { t: 17, pos: [331, 2.8, 661], look: [700, 60, 400], fov: 40 },
  ]);
  return record(page, name, 17);
}
