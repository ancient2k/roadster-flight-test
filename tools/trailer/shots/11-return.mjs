// Back in 3D after "Test drive": the camera starts straight above the course (as the editor showed it), dives down to
// the car on the start line, the car pulls away, lifts off and flies low along the first sections of Starbase
// Sprint (boost pad, loop, curve, jump), the camera chasing it.
import fs from 'node:fs';

const level = JSON.parse(fs.readFileSync('src/editor/samples/starbase-sprint.json', 'utf8'));
const AREA = { minX: -1040, minZ: -450, tileM: 20 };
/** Tile centre of a part (its first tile; good enough for a flight line). */
const at = (p) => [AREA.minX + (p.i + 0.5) * AREA.tileM, AREA.minZ + (p.j + 0.5) * AREA.tileM];

export default async function (page, { flyPath, infiniteAir, controls, camera, settle, record }, name) {
  await page.evaluate((l) => window.__rft.playLevel(l), level);
  await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
  await page.evaluate(() => window.__rft.captureBegin());
  await settle(page, 1);
  await infiniteAir(page);
  // flight line: the start (x −910, z 124, heading −z), then the first course pieces at 9–16 m (over the loop)
  const P = level.parts.slice(0, 14).map(at);
  const heights = [0, 0.5, 2.5, 6, 15, 14, 10, 9, 9, 9, 9, 10, 10, 9];
  const keys = [{ t: 0, pos: [-910, 0.45, 124], heading: 180 }, { t: 0.9, pos: [-910, 0.45, 121], heading: 180 }];
  let t = 1.6;
  for (let k = 1; k < P.length; k++) {
    const [x, z] = P[k], [px, pz] = P[k - 1];
    const heading = (Math.atan2(x - px, z - pz) * 180) / Math.PI;
    keys.push({ t, pos: [x, heights[k], z], heading: Number.isFinite(heading) ? heading : 180 });
    t += 0.62;
  }
  // unwrap the headings (no 359° → 0° spins)
  for (let k = 1; k < keys.length; k++) { while (keys[k].heading - keys[k - 1].heading > 180) keys[k].heading -= 360; while (keys[k].heading - keys[k - 1].heading < -180) keys[k].heading += 360; }
  await flyPath(page, keys);
  await controls(page, [{ t: 0.6, drive: { throttle: 1 } }, { t: 1.4, drive: { throttle: 1 }, thrust: { lift: 0.8, boost: 1 } }]);
  // centre of the course (editor framing), seen from straight above with north up; then down to the start line, and a
  // crane beside the loop that watches the car come over it and turn east past the camera
  await camera(page, [
    { t: 0, pos: [-755, 520, 30], look: [-755, 0, 30], fov: 50 },
    { t: 1.3, pos: [-890, 40, 160], look: 'car', fov: 50 },
    { t: 2.4, pos: [-892, 5, 95], look: 'car+[0,1,0]', fov: 52 },
    { t: 4.6, pos: [-880, 8, -10], look: 'car+[0,1,0]', fov: 50 },
    { t: 7.5, pos: [-872, 10, -40], look: 'car+[0,1,0]', fov: 46 },
  ]);
  return record(page, name, 7.5);
}
