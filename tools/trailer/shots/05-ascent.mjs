// Starship climbing away: close to the pad, the camera looks up along the stack as it clears the tower and follows
// it into the sky (launch clock from MET −2 s, the car stays out of the picture).
const LEVEL = { v: 1, name: 'Trailer', site: 'earth_bocachica', parts: [{ type: 'start', i: 2, j: 2, rot: 1 }], deco: [] };

export default async function (page, { camera, settle, record }, name) {
  await page.evaluate((l) => window.__rft.playLevel(l), LEVEL);
  await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
  await page.evaluate(() => window.__rft.captureBegin());
  await settle(page, 1);
  await page.evaluate(() => { window.__rft.app.levelRun.launchIn = 30; });
  await settle(page, 0.2);
  await page.evaluate(() => window.__rft.launchWarp(0, -2));
  await camera(page, [
    { t: 0, pos: [560, 3, 470], look: [656, 40, 344.5], fov: 42 },
    { t: 4, pos: [556, 3.5, 466], look: 'booster', fov: 40 },
    { t: 9, pos: [550, 4, 460], look: 'booster', fov: 30 },
  ]);
  return record(page, name, 9);
}
