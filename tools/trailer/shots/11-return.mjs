// Back in 3D after "Test drive": the camera starts straight above the course (as the editor showed it), dives down to
// the car on the start line, and the car really drives Starbase Sprint – the course driver gives throttle, brake and
// steering as a player would: away from the line, over the boost pad and through the loop (seen from the side),
// round the wide curve and over the jump (seen from below against the sky).
import fs from 'node:fs';

const level = JSON.parse(fs.readFileSync('src/editor/samples/starbase-sprint.json', 'utf8'));

export default async function (page, { courseDrive, controls, camera, settle, record }, name) {
  await page.evaluate((l) => window.__rft.playLevel(l), level);
  await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
  await page.evaluate(() => window.__rft.captureBegin());
  await controls(page, [{ t: 0 }]);
  await settle(page, 1);
  // the loop: tile (6, 23–24) = x −920…−900, z 10…50, 20 m high; the car comes from the start (−910, 124) heading −z
  // timing of the real drive (from the record start): away at 0.9 s, loop 5.8–9.5 s, wide curve 13–14.5 s, jump ≈ 18 s
  // (kicker x −820…−800 on z −60 heading east, landing from x −780)
  await camera(page, [
    { t: 0, pos: [-755, 520, 30], look: [-755, 0, 30], fov: 50 },
    { t: 0.9, pos: [-820, 260, 110], look: [-905, 0, 118], fov: 50 },
    { t: 1.8, pos: [-880, 40, 160], look: 'car+[0,1,0]', fov: 50 },
    { t: 2.6, pos: 'rel+[3,2.2,11]', look: 'car+[0,1,0]', fov: 55 },
    { t: 4.0, pos: 'rel+[5,2.5,10]', look: 'car+[0,1,0]', fov: 55 },
    { t: 5.2, pos: [-882, 3, 50], look: 'car+[0,1,0]', fov: 58 },
    { t: 7.5, pos: [-874, 9, 30], look: 'car+[0,1,0]', fov: 58 },
    { t: 9.6, pos: [-880, 5, 8], look: 'car+[0,1,0]', fov: 55 },
    { t: 11.0, pos: 'rel+[-3,2.5,11]', look: 'car+[0,1,0]', fov: 55 },
    // (cut in the edit) out of the wide curve, low ahead of the kicker, then the jump against the sky
    { t: 14.2, pos: 'rel+[4,1.6,9]', look: 'car+[0,0.8,0]', fov: 50 },
    { t: 16.3, pos: 'rel+[6,1.4,8]', look: 'car+[0,1,0]', fov: 52 },
    { t: 17.6, pos: [-806, 1.4, -44], look: 'car+[0,1,0]', fov: 52 },
    { t: 19.5, pos: [-792, 1.4, -44], look: 'car+[0,1,0]', fov: 52 },
  ]);
  await courseDrive(page, { delayS: 0.9 });
  return record(page, name, 19.5);
}
