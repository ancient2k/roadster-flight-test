// Giza in the late-afternoon light: low over the sand toward the three pyramids, the jets throw up the sand; a
// tracking camera behind and beside the car, the pyramids ahead (Khafre at (80, -179), the sun low in the west).
export default async function (page, { world, flyPath, infiniteAir, controls, camera, settle, record }, name) {
  await world(page, 'earth_giza');
  await infiniteAir(page);
  await flyPath(page, [
    { t: 0, pos: [-560, 3.5, 470], heading: 130 },
    { t: 3, pos: [-468, 3.2, 393], heading: 131, roll: -3 },
    { t: 6, pos: [-376, 3.5, 316], heading: 133 },
  ]);
  await controls(page, [{ t: 0, thrust: { lift: 0.5, boost: 0.7 } }]);
  await camera(page, [
    { t: 0, pos: 'car+[-12,2.2,4]', look: 'car+[22,2,-14]', fov: 40 },
    { t: 4, pos: 'car+[-11,1.8,2]', look: 'car+[22,3,-14]', fov: 40 },
  ]);
  await settle(page, 0.3);
  return record(page, name, 4);
}
