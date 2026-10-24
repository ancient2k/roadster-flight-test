// Sun dive, late phase (0.05 AU, glowing hot): the car as a silhouette against the solar disc, long lens from
// behind, slowly closing in.
export default async function (page, { world, settle, camera, record }, name) {
  await world(page, 'space_sun');
  await page.evaluate(() => {
    const p = window.__rft.app.sunPanel; p.start();
    const AU = 1.495978707e11; Object.assign(p.dive.state, { r: 0.05 * AU, v: 180000, tempK: 1400, t: 5.5e6 }); p.dive.warp = 4e4;
  });
  await settle(page, 1);
  await camera(page, [
    { t: 0, pos: 'car+[1.5,-1,-42]', look: 'car+[0,0.4,0]', fov: 12 },
    { t: 5, pos: 'car+[1,-0.6,-36]', look: 'car+[0,0.4,0]', fov: 12 },
  ]);
  await settle(page, 0.6); // eye adaptation to the new view
  return record(page, name, 5);
}
