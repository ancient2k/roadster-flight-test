// The jets fire, the Roadster lifts off (McGregor free play at night): a fixed camera ahead and to the left, high
// enough to keep the ground and the horizon in the picture, the look follows the car up out of its own dust cloud. The car stands at (20, 0.45, 40), nose to +z.
export default async function (page, { controls, camera, settle, record }, name) {
  await page.evaluate(() => { window.__rft.startFreePlay('ground_flip'); window.__rft.captureBegin(); });
  await settle(page, 2);
  await controls(page, [
    { t: 0 },
    { t: 1.2, thrust: { lift: 0.75 } },
    { t: 2.4, thrust: { lift: 0.35 } },
  ]);
  await camera(page, [
    { t: 0, pos: [4, 3.2, 62], look: 'car+[0,0.8,0]', fov: 24 },
    { t: 1.2, pos: [4.5, 3.2, 61.5], look: 'car+[0,0.8,0]', fov: 24 },
    { t: 4.0, pos: [5.5, 3.6, 60], look: 'car+[0,0.4,0]', fov: 30 },
  ]);
  await settle(page, 0.5);
  return record(page, name, 4);
}
