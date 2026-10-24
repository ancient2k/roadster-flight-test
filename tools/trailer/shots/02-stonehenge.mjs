// Stonehenge at sunrise: the Roadster races across the grass toward the circle and hops over the stones; low camera
// on the far (north-east) side, the sun behind it lights the car's front. The circle is at the origin.
export default async function (page, { world, flyPath, infiniteAir, controls, camera, settle, record }, name) {
  await world(page, 'earth_stonehenge');
  await infiniteAir(page);
  // from the south across the circle at 10 m, low over the lintels, the camera off to the east pans with it
  await flyPath(page, [
    { t: 0, pos: [-14, 9, 60], heading: 172 },
    { t: 2, pos: [-8, 10, 22], heading: 170, roll: 4 },
    { t: 4, pos: [0, 10.5, -16], heading: 168, roll: 4 },
    { t: 6, pos: [10, 12, -54], heading: 165 },
  ]);
  await controls(page, [{ t: 0, thrust: { lift: 0.5, boost: 0.6 } }]);
  await camera(page, [
    { t: 0, pos: [46, 1.4, 6], look: 'car', fov: 26 },
    { t: 4, pos: [46, 1.6, -4], look: 'car', fov: 26 },
  ]);
  return record(page, name, 4);
}
