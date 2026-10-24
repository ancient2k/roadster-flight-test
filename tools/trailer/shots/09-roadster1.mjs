// Roadster 1 with Starman tumbling in the sunlight (camera on the Sun side, looking back); the camera pulls back and
// away (the cut fades to black).
export default async function (page, { world, settle, camera, record }, name) {
  await world(page, 'space_sun');
  await settle(page, 1);
  await camera(page, [
    { t: 0, pos: [-5.2, 2.0, 38.6], look: [-7, 1.2, 34], fov: 34 },
    { t: 6, pos: [-1, 3.5, 44], look: [-7, 1.2, 34], fov: 34 },
  ]);
  await settle(page, 0.6); // eye adaptation to the new view
  return record(page, name, 6);
}
