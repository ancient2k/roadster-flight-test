// Giza: the Roadster drives up the south face of Khafre's pyramid (53°) on its suction fans – something only this car
// can do. The camera follows from the south-east, low, so the 53° face stands against the horizon.
// The face starts at z ≈ −72.5 on x = 80 (the pyramid's centre is at (80, −179)).
export default async function (page, { world, flyPath, infiniteAir, controls, camera, settle, record }, name) {
  await world(page, 'earth_giza');
  await infiniteAir(page);
  await flyPath(page, [
    { t: 0, pos: [80, 0.45, -40], heading: 180 },
    { t: 1.6, pos: [80, 0.45, -66], heading: 180 },
    { t: 2.1, pos: [80, 0.6, -73.5], heading: 180, pitch: 40 },
    { t: 2.6, pos: [80, 0.75, -78], heading: 180, pitch: 53 },
    { t: 4.6, pos: [80, 0.75, -96], heading: 180, pitch: 53 },
  ]);
  await controls(page, [{ t: 0, drive: { throttle: 1 } }]);
  await camera(page, [
    { t: 0, pos: 'car+[16,1.2,12]', look: 'car+[0,1,0]', fov: 40 },
    { t: 2.0, pos: 'car+[20,1.0,16]', look: 'car+[0,2,0]', fov: 40 },
    { t: 4.6, pos: 'car+[26,0,22]', look: 'car+[0,3,-2]', fov: 40 },
  ]);
  await settle(page, 0.3);
  return record(page, name, 4.2);
}
