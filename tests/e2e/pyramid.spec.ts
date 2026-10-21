import { expect, test, type Page } from '@playwright/test';

// Giza: the pyramids are drivable. From the sand in front of Khufu's north face, fans in grip, throttle (W,
// kept below ≈ 9 m/s like a careful driver, ≈ 4 m/s near the top) over the talus into the 52° face up to the summit platform
// (≈ 131 m), brake once level on the platform and stand there. Same flow as tools/probe-pyramid.mjs.

const errorsOf = (page: Page) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
};

test('Giza: drive up Khufu from the sand to the summit platform and park', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = errorsOf(page);
  await page.goto('/?q=low&nomenu');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 90_000 });
  await page.evaluate(() => (window as any).__rft.startWorld('earth_giza'));
  const col = await page.evaluate(() => {
    const a = (window as any).__rft.app;
    const top = a.sim.castRay({ x: 401.65, y: 400, z: -519.29 }, { x: 0, y: -1, z: 0 }, 1000);
    return { summitY: top ? 400 - top.dist : null, kind: top?.info?.kind ?? null };
  });
  expect(col.kind).toBe('landmark');
  expect(col.summitY).toBeGreaterThan(129);   // platform (Khufu today 138.5 m incl. the survey mast)
  expect(col.summitY).toBeLessThan(133);
  await page.evaluate(() => {
    const a = (window as any).__rft.app;
    const x = 401.65, z = -519.29 - 155;
    const g = a.renderer.world.heightAt(x, z);
    a.startSession({ kind: 'manual', spawn: { pos: { x, y: g + 0.8, z }, quat: { x: 0, y: 0, z: 0, w: 1 }, speedMs: 0 }, siteId: 'earth_giza' }, false, 'ASSIST');
  });
  await page.mouse.click(800, 450);
  await page.waitForFunction(() => !!(window as any).__rft.app.manual, null, { timeout: 10_000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { (window as any).__rft.app.manual.fanMode = 'grip'; });
  await page.waitForTimeout(1600);
  // The driver runs inside the page on every animation frame (≈ 60 Hz) and presses real keys (W/S/A/D), like a
  // player with a feel for the throttle; the test only watches. +X = left, heading 0 = +Z.
  await page.evaluate(() => {
    const w = window as any, a = w.__rft.app;
    const down = new Set<string>();
    const key = (code: string, on: boolean) => {
      if (down.has(code) === on) return;
      if (on) down.add(code); else down.delete(code);
      window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, key: code }));
    };
    const d = w.__drv = { maxY: -Infinity, onFace: false, parkedS: 0, crashed: false, trace: [] as string[], stop: false, t0: performance.now() };
    let lastT = performance.now(), lastLog = 0;
    const tick = () => {
      if (d.stop) { for (const c of [...down]) key(c, false); return; }
      const now = performance.now(), dt = (now - lastT) / 1000; lastT = now;
      const st = a.sim.getState();
      const q = st.quat, pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.x - q.y * q.z)))) * -180 / Math.PI;
      const y = st.pos.y, v = st.speedMs;
      d.maxY = Math.max(d.maxY, y); d.crashed ||= st.crashed;
      if (y > 40 && st.fans.forceN / 9.81 > 1000) d.onFace = true;
      // keep to the middle of the face (the car crabs slowly on the 52° slope)
      const vxWant = -0.3 * (st.pos.x - 401.65);
      key('KeyA', st.linVel.x < vxWant - 0.15); key('KeyD', st.linVel.x > vxWant + 0.15);
      if (y > 129 && (d.parkedS > 0 || Math.abs(pitch) < 8)) { key('KeyW', false); key('KeyS', true); d.parkedS += dt; }
      // ≈ 9 m/s on the face, 6.5 m/s near the top, over the rounded summit edge (R 12 m: the ≈ 12 m platform is
      // almost all crown) until nearly level, then the brakes above
      else key('KeyW', !((y > 128 && pitch < 8) || v > (y > 115 ? 6.5 : 9)));
      if (now - lastLog > 500) { lastLog = now; d.trace.push(`t=${st.t.toFixed(1)} x=${st.pos.x.toFixed(1)} z=${st.pos.z.toFixed(1)} y=${y.toFixed(1)} v=${v.toFixed(1)} p=${pitch.toFixed(0)} w=${st.wheels.filter((x: any) => x.contact).length} fan=${(st.fans.forceN / 9.81).toFixed(0)} keys=${[...down].join('')}`); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.waitForFunction(() => { const d = (window as any).__drv; return d.crashed || d.parkedS > 5; }, null, { timeout: 150_000 }).catch(() => {});
  const drv = await page.evaluate(() => { const d = (window as any).__drv; d.stop = true; return { maxY: d.maxY, onFace: d.onFace, crashed: d.crashed, parkedS: d.parkedS, trace: d.trace as string[] }; });
  await page.waitForTimeout(300);
  const trace = drv.trace.filter((l) => / y=(1[0-3]\d|-?\d\.)/.test(l)).slice(-40);
  const maxY = drv.maxY, onFace = drv.onFace;
  expect(drv.crashed, trace.join('\n')).toBe(false);
  const end = await page.evaluate(() => {
    const st = (window as any).__rft.app.sim.getState();
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (st.quat.w * st.quat.x - st.quat.y * st.quat.z)))) * -180 / Math.PI;
    return { y: st.pos.y, v: st.speedMs, crashed: st.crashed, wheels: st.wheels.filter((w: any) => w.contact).length, pitch };
  });
  expect(onFace, trace.join('\n')).toBe(true); // climbed the face with the fans sealing on the stone
  expect(maxY).toBeGreaterThan(129);
  expect(end.y, trace.join('\n')).toBeGreaterThan(128); // parked on the summit …
  expect(Math.abs(end.pitch), trace.join('\n')).toBeLessThan(8); // … level on the platform
  expect(end.v).toBeLessThan(0.5);
  expect(end.wheels).toBeGreaterThanOrEqual(3);
  expect(end.crashed).toBe(false);
  expect(errors).toEqual([]);
});

// Player driving (R14 report "stuck on the edge"): real keys only, like someone on the keyboard. Starts turned
// 15° away from the summit with the fans still OFF, aims at the summit with A/D, drives onto the talus until the HUD calls
// for the fans (or 25 s), presses F, climbs with an uneven foot (W pressed below 3 m/s, released above 6 m/s,
// random lifts), STOPS on the summit edge with the nose still up, pulls away again and parks level.
test('Giza: player-style drive up Khufu – fans forgotten, uneven throttle, stop on the edge, park', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = errorsOf(page);
  await page.goto('/?q=low&nomenu');
  await page.waitForFunction(() => (window as any).__rft?.ready === true, null, { timeout: 90_000 });
  await page.evaluate(() => (window as any).__rft.startWorld('earth_giza'));
  await page.evaluate(() => {
    const a = (window as any).__rft.app;
    const x = 401.65, z = -519.29 - 155;
    const g = a.renderer.world.heightAt(x, z);
    const h = -15 * Math.PI / 180; // turned away from the summit: the player has to aim
    a.startSession({ kind: 'manual', spawn: { pos: { x, y: g + 0.8, z }, quat: { x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, speedMs: 0 }, siteId: 'earth_giza' }, false, 'ASSIST');
  });
  await page.mouse.click(800, 450);
  await page.waitForFunction(() => !!(window as any).__rft.app.manual, null, { timeout: 10_000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const w = window as any, a = w.__rft.app;
    const down = new Set<string>();
    const key = (code: string, on: boolean) => {
      if (down.has(code) === on) return;
      if (on) down.add(code); else down.delete(code);
      window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, key: code }));
    };
    const flashes: string[] = [];
    const fl = document.querySelector('.rft-flash');
    if (fl) new MutationObserver(() => flashes.push(fl.textContent ?? '')).observe(fl, { childList: true, characterData: true, subtree: true });
    const d = w.__drv2 = { phase: 'nofan', hint: false, maxY: -Infinity, crashed: false, parkedS: 0, stoppedOnEdge: false, trace: [] as string[], stop: false, flashes };
    let lastT = performance.now(), lastLog = 0, lastReact = 0, lift = 0, t0 = performance.now(), fPressedAt = 0, seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const tick = () => {
      if (d.stop) { for (const c of [...down]) key(c, false); return; }
      const now = performance.now(), dt = (now - lastT) / 1000; lastT = now;
      const st = a.sim.getState();
      const q = st.quat, pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.x - q.y * q.z)))) * -180 / Math.PI;
      const y = st.pos.y, v = st.speedMs;
      d.maxY = Math.max(d.maxY, y); d.crashed ||= st.crashed;
      d.hint ||= flashes.some((f) => /STEEP/.test(f));
      if (fPressedAt && now - fPressedAt > 120) { key('KeyF', false); fPressedAt = 0; }
      if (d.phase === 'parked') { key('KeyW', false); key('KeyS', true); d.parkedS += dt; }
      if (now - lastReact > 100) { // reaction: ten decisions a second
        lastReact = now;
        if (lift > 0) lift -= 0.1; else if (rnd() < 0.04) lift = 0.2 + 0.3 * rnd();
        // aim at the summit (+X = left = A)
        if (d.phase !== 'parked') {
          const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
          const e = Math.atan2(401.65 - st.pos.x, -519.29 - st.pos.z) - Math.atan2(fx, fz);
          const ew = Math.atan2(Math.sin(e), Math.cos(e));
          key('KeyA', ew > 0.06 && y < 128); key('KeyD', ew < -0.06 && y < 128);
        }
        if (d.phase === 'nofan') {
          key('KeyW', v < 5);
          if (d.hint || now - t0 > 25_000) { key('KeyF', true); fPressedAt = now; d.phase = 'climb'; }
        } else if (d.phase === 'climb') {
          const vHi = y > 115 ? 4 : 6;
          key('KeyS', false);
          key('KeyW', lift <= 0 && (down.has('KeyW') ? v < vHi : v < 3));
          if (y > 125 && pitch < 30) d.phase = 'edge';
        } else if (d.phase === 'edge') {
          // stop on the summit edge, nose still up
          key('KeyW', false); key('KeyS', true);
          if (v < 0.2) { d.stoppedOnEdge = true; key('KeyS', false); d.phase = 'pull'; }
        } else if (d.phase === 'pull') {
          key('KeyW', v < 2.5);
          if (y > 129 && Math.abs(pitch) < 6) d.phase = 'parked';
        }
      }
      if (now - lastLog > 500) { lastLog = now; d.trace.push(`${d.phase} t=${st.t.toFixed(1)} x=${st.pos.x.toFixed(1)} z=${st.pos.z.toFixed(1)} y=${y.toFixed(1)} v=${v.toFixed(1)} p=${pitch.toFixed(0)} w=${st.wheels.filter((x: any) => x.contact).length} fan=${(st.fans.forceN / 9.81).toFixed(0)} body=${st.bodyContact} keys=${[...down].join('')}`); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.waitForFunction(() => { const d = (window as any).__drv2; return d.crashed || d.parkedS > 5; }, null, { timeout: 220_000 }).catch(() => {});
  const drv = await page.evaluate(() => { const d = (window as any).__drv2; d.stop = true; return { phase: d.phase, hint: d.hint, maxY: d.maxY, crashed: d.crashed, parkedS: d.parkedS, stoppedOnEdge: d.stoppedOnEdge, flashes: d.flashes as string[], trace: d.trace as string[] }; });
  await page.waitForTimeout(300);
  const trace = [`flashes: ${drv.flashes.join(' | ')}`, ...drv.trace.slice(0, 12), '…', ...drv.trace.slice(-40)].join('\n');
  expect(drv.hint, trace).toBe(true);               // the HUD asked for the fans on the steep stone
  expect(drv.crashed, trace).toBe(false);
  expect(drv.stoppedOnEdge, trace).toBe(true);       // it stopped on the edge …
  expect(drv.phase, trace).toBe('parked');           // … pulled away and parked
  const end = await page.evaluate(() => {
    const st = (window as any).__rft.app.sim.getState();
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (st.quat.w * st.quat.x - st.quat.y * st.quat.z)))) * -180 / Math.PI;
    return { y: st.pos.y, v: st.speedMs, wheels: st.wheels.filter((w: any) => w.contact).length, pitch, crashed: st.crashed };
  });
  expect(end.y, trace).toBeGreaterThan(128);
  expect(Math.abs(end.pitch), trace).toBeLessThan(8);
  expect(end.v).toBeLessThan(0.5);
  expect(end.wheels).toBeGreaterThanOrEqual(3);
  expect(end.crashed).toBe(false);
  expect(errors).toEqual([]);
});
