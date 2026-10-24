// The jets fire, the Roadster lifts off (McGregor free play at night): a fixed low camera ahead and to the left,
// the look follows the car up out of its own dust cloud. The car stands at (20, 0.45, 40), nose to +z.
export default async function (page, { controls, camera, settle, record }, name) {
  await page.evaluate(() => { window.__rft.startFreePlay('ground_flip'); window.__rft.captureBegin(); });
  await settle(page, 2);
  await controls(page, [
    { t: 0 },
    { t: 1.2, thrust: { lift: 0.75 } },
    { t: 2.4, thrust: { lift: 0.35 } },
  ]);
  await camera(page, [
    { t: 0, pos: [7, 1.2, 56], look: 'car+[0,0.6,0]', fov: 22 },
    { t: 1.2, pos: [7.5, 1.2, 55.5], look: 'car+[0,0.6,0]', fov: 22 },
    { t: 4.0, pos: [8.5, 1.6, 54], look: 'car+[0,0.3,0]', fov: 30 },
  ]);
  await settle(page, 0.5);
  return record(page, name, 4);
}
