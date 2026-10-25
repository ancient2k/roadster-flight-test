// Stonehenge at sunrise, on the ground: the Roadster drifts in an arc over the grass around the east side of the
// circle (the nose leading the line by 30°, tyres throwing up turf), a low camera outside the ring, the low sun behind
// it on the car.
export default async function (page, { world, flyPath, infiniteAir, controls, camera, settle, record }, name) {
  await world(page, 'earth_stonehenge');
  await infiniteAir(page);
  // arc of radius 26 m around the circle (origin), from south-east to north-east
  const keys = [60, 30, 0, -30, -60].map((phi, k) => {
    const a = (phi * Math.PI) / 180, vel = (Math.atan2(Math.sin(a), -Math.cos(a)) * 180) / Math.PI;
    return { t: k * 1.1, pos: [26 * Math.cos(a), 0.45, 26 * Math.sin(a)], heading: vel + 30 };
  });
  for (let k = 1; k < keys.length; k++) while (keys[k].heading - keys[k - 1].heading < -180) keys[k].heading += 360;
  await flyPath(page, keys, { conform: true });
  await controls(page, [{ t: 0, drive: { throttle: 1, steer: -0.7 } }]);
  await camera(page, [
    { t: 0, pos: [42, 0.9, 7], look: 'car+[0,0.6,0]', fov: 27 },
    { t: 4.4, pos: [42, 1.0, -1], look: 'car+[0,0.6,0]', fov: 27 },
  ]);
  await settle(page, 0.3);
  return record(page, name, 4);
}
