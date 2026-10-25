// Jezero crater, on the ground: the Roadster drifts in an arc behind Perseverance (−30, 0), throwing up the red
// dust; low camera south of the rover, the rover in the foreground.
export default async function (page, { world, flyPath, infiniteAir, controls, camera, settle, record }, name) {
  await world(page, 'mars_jezero');
  await infiniteAir(page);
  // arc of 15 m around the rover, west → north → east; the nose leads the turn by 30°
  const keys = [200, 235, 270, 305, 340].map((phi, k) => {
    const a = (phi * Math.PI) / 180, vel = (Math.atan2(-Math.sin(a), Math.cos(a)) * 180) / Math.PI;
    return { t: k * 0.9, pos: [-30 + 15 * Math.cos(a), 0.45, -2 + 15 * Math.sin(a)], heading: vel - 30 };
  });
  for (let k = 1; k < keys.length; k++) while (keys[k].heading - keys[k - 1].heading > 180) keys[k].heading -= 360;
  await flyPath(page, keys, { conform: true });
  await controls(page, [{ t: 0, drive: { throttle: 1, steer: 0.7 } }]);
  await camera(page, [
    { t: 0, pos: [-26, 1.5, 10], look: 'car+[0,0.6,0]', fov: 36 },
    { t: 4.4, pos: [-24, 1.6, 10], look: 'car+[0,0.6,0]', fov: 36 },
  ]);
  await settle(page, 0.3);
  return record(page, name, 3.6);
}
