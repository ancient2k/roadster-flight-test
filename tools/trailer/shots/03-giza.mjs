// Giza: the Roadster drives up the south face of Khafre's pyramid (53°) on its suction fans – something only this car
// can do. Real physics all the way (fans in grip, wheels on the sand, the talus and the face), so the car and its
// shadow sit on the stone. The camera follows from the south-west, the sun side: the low western sun grazes the south
// face (≈ 24°), and from the east the long shadow a metre beside the car looks as if it floated.
// The face starts at z ≈ −72.5 on x = 80 (the pyramid's centre is at (80, −179)).
export default async function (page, { world, infiniteAir, placeCar, controls, camera, settle, record }, name) {
  await world(page, 'earth_giza');
  await infiniteAir(page);
  await page.evaluate(() => { const m = window.__rft.app.manual; if (m) m.fanMode = 'grip'; });
  await placeCar(page, { x: 80, z: -54, headingDeg: 180, speed: 9 });
  await controls(page, [{ t: 0, drive: { throttle: 0.55 } }, { t: 1.6, drive: { throttle: 0.75 } }]);
  await settle(page, 0.3);
  await camera(page, [
    { t: 0, pos: 'car+[-16,1.2,12]', look: 'car+[0,1,0]', fov: 40 },
    { t: 2.0, pos: 'car+[-14,1.0,12]', look: 'car+[0,2,0]', fov: 36 },
    { t: 4.6, pos: 'car+[-12,0,12]', look: 'car+[0,2,-1]', fov: 30 },
  ]);
  return record(page, name, 4.2);
}
