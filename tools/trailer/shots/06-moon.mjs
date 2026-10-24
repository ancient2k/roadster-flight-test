// Tranquility Base, on the wheels: the Roadster really drives (physics, low gravity) across the regolith past the
// Apollo 11 descent stage (942, 0) – long floaty bounces over the small craters, the wheels throwing regolith in
// ballistic arcs. Low camera tracking from the sun side.
export default async function (page, { world, placeCar, controls, camera, settle, record }, name) {
  await world(page, 'moon_tranquility');
  await page.evaluate(() => { window.__rft.app.session.infiniteAir = true; });
  await placeCar(page, { x: 960, z: 70, headingDeg: 190, speed: 12 });
  await controls(page, [{ t: 0, drive: { throttle: 0.9, steer: 0.05 } }]);
  await settle(page, 0.6);
  await camera(page, [
    { t: 0, pos: 'car+[9,0.8,-6]', look: 'car+[0,0.5,-3]', fov: 42 },
    { t: 5, pos: 'car+[10,1.2,-2]', look: 'car+[0,0.5,-3]', fov: 42 },
  ]);
  return record(page, name, 5);
}
