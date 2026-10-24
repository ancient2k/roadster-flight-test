// Jezero crater: the Roadster hovers past Perseverance (−30, 0) in the afternoon light, the jets raise the red dust;
// low camera south of the rover with the rover in the foreground.
export default async function (page, { world, flyPath, infiniteAir, controls, camera, settle, record }, name) {
  await world(page, 'mars_jezero');
  await infiniteAir(page);
  await flyPath(page, [
    { t: 0, pos: [-75, 3, -22], heading: 95 },
    { t: 3, pos: [-40, 3.5, -16], heading: 100, roll: 4 },
    { t: 6, pos: [-5, 4, -14], heading: 98 },
  ]);
  await controls(page, [{ t: 0, thrust: { lift: 0.6, boost: 0.6 } }]);
  await camera(page, [
    { t: 0, pos: [-34, 1.0, 9], look: 'car', fov: 40 },
    { t: 5, pos: [-31, 1.2, 9], look: 'car', fov: 40 },
  ]);
  await settle(page, 0.3);
  return record(page, name, 5);
}
