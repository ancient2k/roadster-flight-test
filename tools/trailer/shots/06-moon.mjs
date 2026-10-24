// Tranquility Base: the Roadster hovers past the Apollo 11 descent stage (942, 0) in the low morning sun, the jets
// blow the regolith away; low camera on the sun side, the black sky above.
export default async function (page, { world, flyPath, infiniteAir, controls, camera, settle, record }, name) {
  await world(page, 'moon_tranquility');
  await infiniteAir(page);
  await flyPath(page, [
    { t: 0, pos: [930, 2.5, 42], heading: 180 },
    { t: 3, pos: [931, 3, 14], heading: 184, roll: -4 },
    { t: 6, pos: [934, 3.5, -16], heading: 186 },
  ]);
  await controls(page, [{ t: 0, thrust: { lift: 0.5, boost: 0.3 } }]);
  await camera(page, [
    { t: 0, pos: [958, 1.3, 14], look: 'car', fov: 36 },
    { t: 5, pos: [958, 1.5, 8], look: 'car', fov: 36 },
  ]);
  await settle(page, 0.3);
  return record(page, name, 5);
}
