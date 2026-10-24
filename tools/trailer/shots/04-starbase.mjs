// Starbase: the Roadster drifts across the build field, the camera rises and turns toward the launch tower ~950 m
// east just as Starship lifts off (one continuous move). An almost empty level arms the launch clock.
const LEVEL = { v: 1, name: 'Trailer', site: 'earth_bocachica', parts: [{ type: 'start', i: 2, j: 2, rot: 1 }], deco: [] };
export const LIFTOFF_S = 8;

export default async function (page, { flyPath, infiniteAir, controls, camera, settle, record }, name) {
  await page.evaluate((l) => window.__rft.playLevel(l), LEVEL);
  await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
  await page.evaluate(() => window.__rft.captureBegin());
  await settle(page, 1);
  await page.evaluate((s) => { window.__rft.app.levelRun.launchIn = s; }, LIFTOFF_S + 0.3);
  await infiniteAir(page);
  // S-drift (the nose runs ahead of the direction of travel), then it stops facing the tower
  await flyPath(page, [
    { t: 0, pos: [-430, 0.45, 10], heading: 55 },
    { t: 2, pos: [-392, 0.45, 42], heading: 105 },
    { t: 4, pos: [-345, 0.45, 58], heading: 125 },
    { t: 6, pos: [-290, 0.45, 55], heading: 92 },
    { t: 7.5, pos: [-266, 0.45, 51], heading: 74 },
    { t: 8.5, pos: [-262, 0.45, 50.5], heading: 72 },
    { t: 16, pos: [-262, 0.45, 50.5], heading: 72 },
  ]);
  await controls(page, [{ t: 0, drive: { throttle: 1, steer: 0.6 } }, { t: 4, drive: { throttle: 1, steer: -0.3 } }, { t: 7, drive: { throttle: 0.6 } }]);
  await camera(page, [
    { t: 0, pos: 'car+[-7,1.1,-7]', look: 'car+[0,0.5,0]', fov: 44 },
    { t: 3, pos: 'car+[-9,1.3,-3]', look: 'car+[0,0.5,0]', fov: 44 },
    { t: 6, pos: 'car+[-14,3,-2]', look: 'car+[30,4,10]', fov: 38 },
    { t: 9, pos: [-286, 2.6, 43], look: [656, 60, 344], fov: 18 },
    { t: 12, pos: [-286, 2.8, 43], look: 'booster+[0,10,0]', fov: 20 },
    { t: 16, pos: [-286, 3, 43], look: 'booster', fov: 26 },
  ]);
  return record(page, name, 16);
}
