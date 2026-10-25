// Giza: the Roadster drives up the south face of Khafre's pyramid (53°) on its suction fans – something only this car
// can do. The camera follows from the south-east, low, so the 53° face stands against the horizon.
// The face starts at z ≈ −72.5 on x = 80 (the pyramid's centre is at (80, −179)).
export default async function (page, { world, flyPath, infiniteAir, controls, camera, settle, record }, name) {
  await world(page, 'earth_giza');
  await infiniteAir(page);
  // on the ground all the way: pitch and height follow the sand, the foot of the face and the 53° face itself
  await flyPath(page, [
    { t: 0, pos: [80, 0, -40], heading: 180 },
    { t: 1.6, pos: [80, 0, -64], heading: 180 },
    { t: 2.4, pos: [80, 0, -74], heading: 180 },
    { t: 4.6, pos: [80, 0, -92], heading: 180 },
  ], { conform: true });
  await controls(page, [{ t: 0, drive: { throttle: 1 } }]);
  await camera(page, [
    { t: 0, pos: 'car+[16,1.2,12]', look: 'car+[0,1,0]', fov: 40 },
    { t: 2.0, pos: 'car+[14,1.0,12]', look: 'car+[0,2,0]', fov: 36 },
    { t: 4.6, pos: 'car+[12,0,12]', look: 'car+[0,2,-1]', fov: 30 },
  ]);
  await settle(page, 0.3);
  return record(page, name, 4.2);
}
