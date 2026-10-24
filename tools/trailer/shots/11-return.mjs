// Back in 3D after "Test drive": the camera starts straight above the course (as the editor showed it), dives down to
// the car on the start line, and the car really drives Starbase Sprint – the course driver gives throttle, brake and
// steering as a player would: away from the line, over the boost pad and through the loop, seen from the side.
import fs from 'node:fs';

const level = JSON.parse(fs.readFileSync('src/editor/samples/starbase-sprint.json', 'utf8'));

export default async function (page, { courseDrive, controls, camera, settle, record }, name) {
  await page.evaluate((l) => window.__rft.playLevel(l), level);
  await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
  await page.evaluate(() => window.__rft.captureBegin());
  await controls(page, [{ t: 0 }]);
  await settle(page, 1);
  // the loop: tile (6, 23–24) = x −920…−900, z 10…50, 20 m high; the car comes from the start (−910, 124) heading −z
  await camera(page, [
    { t: 0, pos: [-755, 520, 30], look: [-755, 0, 30], fov: 50 },
    { t: 0.9, pos: [-820, 260, 110], look: [-905, 0, 118], fov: 50 },
    { t: 1.8, pos: [-880, 40, 160], look: 'car+[0,1,0]', fov: 50 },
    { t: 2.6, pos: 'rel+[3,2.2,11]', look: 'car+[0,1,0]', fov: 55 },
    { t: 3.6, pos: 'rel+[5,2.5,10]', look: 'car+[0,1,0]', fov: 55 },
    { t: 4.6, pos: [-884, 3, 48], look: 'car+[0,1,0]', fov: 58 },
    { t: 6.2, pos: [-880, 8, 30], look: 'car+[0,1,0]', fov: 58 },
    { t: 8.5, pos: [-886, 6, 4], look: 'car+[0,1,0]', fov: 55 },
  ]);
  await courseDrive(page, { delayS: 0.9 });
  return record(page, name, 8.5);
}
