// Frame capture for the trailer (docs/TRAILER.md): the game runs on a fixed clock (window.__rft.captureFrame), one
// screenshot per frame, ffmpeg turns the frames into a clip. Shots are small scripts on top of these helpers.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const OUT = path.resolve('trailer-out');

/** Opens the game headless with WebGPU at the capture size. */
export async function open({ url = process.env.TRAILER_URL ?? 'http://127.0.0.1:4173/', width = 1920, height = 1080, scale = 1, quality = 'ultra', lang = process.env.TRAILER_LANG ?? 'en' } = {}) {
  const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal'] });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${url}?lang=${lang}&nomenu&q=${quality}`);
  await page.waitForFunction(() => window.__rft?.ready, null, { timeout: 180000 });
  await hideUi(page);
  return { browser, page, errors };
}

/** Everything on top of the canvas goes: HUD, touch controls, notes, menus, panels. */
export async function hideUi(page) {
  await page.addStyleTag({ content: '#app > :not(canvas):not(.rfte){display:none!important} .rft-hud,.rft-touch,.rft-update,.rft-menu{display:none!important}' });
}

/** Loads a world (site id) and waits for the switch; capture mode is applied to the new renderer. */
export async function world(page, id) {
  await page.evaluate((s) => window.__rft.startWorld(s), id);
  await page.waitForFunction(() => !window.__rft.app.switching, null, { timeout: 180000 });
  await page.evaluate(() => window.__rft.captureBegin());
}

/** Car pose: x, z (ground height looked up), heading in degrees (0 = +z, 90 = +x), height above ground, speed along
 *  the heading and climb rate (m/s). */
export async function placeCar(page, { x, z, headingDeg = 0, lift = 0.6, speed = 0, climb = 0 }) {
  await page.evaluate(({ x, z, headingDeg, lift, speed, climb }) => {
    const a = window.__rft.app, b = a.sim.body, h = a.renderer.worldHandle?.surfaceAt?.(x, z) ?? 0;
    const r = (headingDeg * Math.PI) / 360;
    b.setTranslation({ x, y: h + lift, z }, true);
    b.setRotation({ x: 0, y: Math.sin(r), z: 0, w: Math.cos(r) }, true);
    const hd = (headingDeg * Math.PI) / 180;
    b.setLinvel({ x: Math.sin(hd) * speed, y: climb, z: Math.cos(hd) * speed }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }, { x, z, headingDeg, lift, speed, climb });
}

/**
 * Scripted controls: keys = [{ t, drive?: Partial<DriveInput>, thrust?: Partial<ThrustInput> }], held from t (s,
 * shot time) until the next key. Replaces what the devices deliver; edges (menu, camera …) stay off.
 */
export async function controls(page, keys) {
  await page.evaluate((keys) => {
    const app = window.__rft.app, inp = app.input;
    inp.__poll ??= inp.poll.bind(inp);
    const t0 = app.sim.getState().t;
    inp.poll = (dt) => {
      const p = inp.__poll(dt), t = app.sim.getState().t - t0;
      for (const k of Object.keys(p.pressed)) p.pressed[k] = false;
      let cur = null;
      for (const k of keys) if (k.t <= t) cur = k;
      p.drive = { throttle: 0, brake: 0, steer: 0, handbrake: false, reverse: false, launchMode: false, accelLimitG: null, ...(cur?.drive ?? {}) };
      p.thrust = { lift: 0, boost: 0, pitch: 0, roll: 0, yaw: 0, ...(cur?.thrust ?? {}) };
      return p;
    };
  }, keys);
}

/**
 * Camera path: keys = [{ t, pos: [x,y,z] | 'car+[dx,dy,dz]', look: [x,y,z] | 'car' | 'booster+[…]' …, fov }], Catmull–Rom
 * through the positions (fixed positions: y above the ground), look points absolute, smoothstep-eased fov. Positions relative to the car follow it (in world axes).
 */
export async function camera(page, keys) {
  await page.evaluate((keys) => {
    const app = window.__rft.app, rig = app.renderer.rig, cam = rig.camera;
    const t0 = app.sim.getState().t;
    // 'car', 'booster', 'ship' (Starship launch stages), each optionally '+[dx,dy,dz]' in world axes; 'rel+[right,
    // up, back]' in the car's heading frame (yaw only)
    const ground = (x, z) => { const g = app.renderer.worldHandle?.surfaceAt?.(x, z) ?? 0; return Number.isFinite(g) ? g : 0; };
    const resolve = (v, car, agl = false) => {
      if (Array.isArray(v)) return agl ? [v[0], v[1] + ground(v[0], v[2]), v[2]] : v;
      const rel = /^rel\+\[([^\]]+)\]$/.exec(v);
      if (rel) {
        const [r, u, b] = rel[1].split(',').map(Number), q = app.sim.getState().quat;
        // forward = q · (0, 0, 1) projected on the ground plane
        let fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
        const n = Math.hypot(fx, fz) || 1; fx /= n; fz /= n;
        return [car.x - fx * b - fz * r, car.y + u, car.z - fz * b + fx * r];
      }
      const m = /^(car|booster|ship)(?:\+\[([^\]]+)\])?$/.exec(v);
      const d = m?.[2] ? m[2].split(',').map(Number) : [0, 0, 0];
      const vis = app.launch?.visuals;
      const o = m?.[1] === 'booster' ? vis?.boosterPos : m?.[1] === 'ship' ? vis?.shipPos : car;
      return [(o ?? car).x + d[0], (o ?? car).y + d[1], (o ?? car).z + d[2]];
    };
    const cr = (p0, p1, p2, p3, u) => p1.map((_, i) => 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * u + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * u * u + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * u * u * u));
    const sample = (field, t, car) => {
      const n = keys.length;
      let i = 0;
      while (i < n - 2 && keys[i + 1].t <= t) i++;
      const a = keys[i], b = keys[Math.min(i + 1, n - 1)];
      const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
      const P = (j) => resolve(keys[Math.min(Math.max(j, 0), n - 1)][field], car, field === 'pos');
      return cr(P(i - 1), P(i), P(i + 1), P(i + 2), u);
    };
    // the view direction is interpolated as a unit vector (look points far away would make the spline overshoot)
    const dirAt = (k, car) => {
      const p = resolve(k.pos, car, true), l = resolve(k.look, car);
      const d = [l[0] - p[0], l[1] - p[1], l[2] - p[2]], n = Math.hypot(...d) || 1;
      return d.map((v) => v / n);
    };
    const seg = (t) => {
      let i = 0;
      while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
      const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
      return { i, a, b, u: b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0 };
    };
    rig.__update ??= rig.update.bind(rig);
    rig.update = (state, dt) => {
      rig.__update(state, dt);
      const t = app.sim.getState().t - t0, car = state.pos;
      const p = sample('pos', t, car);
      const { i, a, b, u } = seg(t), n = keys.length, K = (j) => keys[Math.min(Math.max(j, 0), n - 1)];
      const d = cr(dirAt(K(i - 1), car), dirAt(K(i), car), dirAt(K(i + 1), car), dirAt(K(i + 2), car), u);
      const s = u * u * (3 - 2 * u);
      // looking (almost) straight down: north (−z) at the top of the picture, as on a map
      const dn = Math.hypot(...d), vert = Math.abs(d[1] / dn);
      if (vert > 0.999) cam.up.set(0, 0, -1); else cam.up.set(0, 1, 0);
      // never below the ground (a spline between keys high up and close to the car can dip under it)
      p[1] = Math.max(p[1], ground(p[0], p[2]) + 0.8);
      cam.position.set(p[0], p[1], p[2]); cam.lookAt(p[0] + d[0] * 100, p[1] + d[1] * 100, p[2] + d[2] * 100);
      cam.fov = (a.fov ?? 50) + ((b.fov ?? a.fov ?? 50) - (a.fov ?? 50)) * s;
      cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    };
  }, keys);
}

/** Back to the game's own camera (chase etc.). */
export async function gameCamera(page, mode = 'chase') {
  await page.evaluate((m) => { const r = window.__rft.app.renderer; if (r.rig.__update) { r.rig.update = r.rig.__update; delete r.rig.__update; } r.setCameraMode(m); }, mode);
}

/** Runs the scene for `seconds` without saving frames (settling, warm-up of TRAA and exposure). */
export async function settle(page, seconds, fps = 60) {
  await page.evaluate(async ({ n, dt }) => {
    for (let i = 0; i < n; i++) { window.__rft.captureFrame(dt); if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0)); }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, { n: Math.round(seconds * fps), dt: 1 / fps });
}

/**
 * Records `seconds` of the scene into trailer-out/<name>/ as JPEG frames and encodes trailer-out/<name>.mp4.
 * `each(page, i, t)` runs before frame i (camera cuts, launch clock …).
 */
export async function record(page, name, seconds, { fps = 60, each, cutFirst = true, scout = process.env.SCOUT === '1', audio = !scout } = {}) {
  const dir = path.join(OUT, scout ? 'scout' : name);
  if (!scout) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (cutFirst) await page.evaluate(() => window.__rft.captureCut());
  const n = Math.round(seconds * fps), t0 = Date.now();
  if (audio) await audioBegin(page, n, fps);
  // scout: 8 stills spread over the shot, tiled into trailer-out/scout/<name>.jpg (fast framing checks)
  const stills = scout ? new Set(Array.from({ length: 8 }, (_, k) => Math.min(n - 1, Math.round((k * (n - 1)) / 7)))) : null;
  for (let i = 0; i < n; i++) {
    if (each) await each(page, i, i / fps);
    if (process.env.TRACE && i % 30 === 0) console.log(`  ${name} t=${(i / fps).toFixed(1)}`, await page.evaluate(() => { const s = window.__rft.app.sim.getState(); const a = window.__rft.app; return `x=${s.pos.x.toFixed(0)} y=${s.pos.y.toFixed(1)} z=${s.pos.z.toFixed(0)} v=${s.speedMs.toFixed(0)} thr=${a.manual?.drive?.throttle} brk=${a.manual?.drive?.brake} menu=${a.menu.isOpen()} ed=${a.editor?.visible} paused=${a.loop.paused}`; }));
    const keep = !stills || stills.has(i);
    // one frame per task, then wait for the browser to present it (several renders in one task show only one);
    // with sound: the offline audio render is held at this frame's time while the frame updates the voices
    await page.evaluate(async ({ dt, keep, i }) => {
      const A = window.__trailerAudio;
      if (A) await A.reach(i);
      window.__rft.captureFrame(dt);
      if (A) A.release(i);
      if (keep) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, { dt: 1 / fps, keep, i });
    if (!keep) continue;
    const file = scout ? path.join(dir, `${name}-${String(i).padStart(5, '0')}.jpg`) : path.join(dir, `${String(i).padStart(5, '0')}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: scout ? 80 : 95 });
    if (!scout && i % 60 === 59) process.stdout.write(`  ${name}: ${i + 1}/${n} frames, ${((Date.now() - t0) / (i + 1)).toFixed(0)} ms/frame\n`);
  }
  if (audio) await audioEnd(page, path.join(OUT, `${name}.wav`));
  if (scout) {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${name}-`)).sort().map((f) => path.join(dir, f));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...files.flatMap((f) => ['-i', f]), '-filter_complex',
      `${files.map((_, k) => `[${k}]scale=640:-1[s${k}]`).join(';')};${files.map((_, k) => `[s${k}]`).join('')}xstack=inputs=${files.length}:layout=${files.map((_, k) => `${(k % 4) ? Array.from({ length: k % 4 }, () => 'w0').join('+') : '0'}_${k >= 4 ? 'h0' : '0'}`).join('|')}`,
      path.join(dir, `${name}.jpg`)]);
    for (const f of files) fs.rmSync(f);
    return path.join(dir, `${name}.jpg`);
  }
  encode(name, fps, audio ? path.join(OUT, `${name}.wav`) : null);
  return path.join(OUT, `${name}.mp4`);
}

/**
 * Game sound for a recorded shot: the AudioEngine is moved onto an OfflineAudioContext that renders in lockstep with
 * the frames (suspended at every frame time; the frame's update schedules the voices, then the render goes on).
 */
async function audioBegin(page, n, fps) {
  await page.evaluate(({ n, fps }) => {
    const app = window.__rft.app, sr = 48000;
    const ctx = new OfflineAudioContext(2, Math.ceil((n / fps) * sr) + 1024, sr);
    app.audio.attachContext(ctx);
    app.audio.setVolume({ master: 0.9, effects: 1, crowd: 0.7, muted: false });
    app.audio.reset?.();
    const reached = new Map(), waiting = new Map();
    for (let i = 1; i < n; i++) {
      ctx.suspend(i / fps).then(() => { const w = waiting.get(i); if (w) { waiting.delete(i); w(); } else reached.set(i, true); });
    }
    const A = window.__trailerAudio = {
      ctx, done: null,
      reach: (i) => (i === 0 ? Promise.resolve() : reached.has(i) ? (reached.delete(i), Promise.resolve()) : new Promise((r) => waiting.set(i, r))),
      release: (i) => { if (i === 0) A.done = ctx.startRendering(); else ctx.resume(); },
    };
  }, { n, fps });
}

async function audioEnd(page, file) {
  const b64 = await page.evaluate(async () => {
    const A = window.__trailerAudio; delete window.__trailerAudio;
    const buf = await A.done;
    const L = buf.getChannelData(0), R = buf.getChannelData(1), pcm = new Int16Array(L.length * 2);
    for (let i = 0; i < L.length; i++) { pcm[2 * i] = Math.max(-1, Math.min(1, L[i])) * 32767; pcm[2 * i + 1] = Math.max(-1, Math.min(1, R[i])) * 32767; }
    let s = ''; const u8 = new Uint8Array(pcm.buffer);
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return { data: btoa(s), sr: buf.sampleRate };
  });
  writeWav(file, Buffer.from(b64.data, 'base64'), b64.sr, 2);
}

/** 16-bit PCM WAV. */
export function writeWav(file, pcm, sampleRate, channels) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

export function encode(name, fps = 60, wav = null) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(OUT, name, '%05d.jpg'),
    ...(wav ? ['-i', wav, '-c:a', 'aac', '-b:a', '256k', '-shortest'] : []),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', path.join(OUT, `${name}.mp4`)]);
}

/**
 * Flight path for the car, independent of the flight controller: before every physics step the body is put on a
 * Catmull–Rom path through keys = [{ t, pos: [x, y, z], heading?, pitch?, roll? }] (degrees; y above ground when
 * `agl`), with the matching velocity, so wheels, jets and dust react as in a real flight. null clears it.
 */
export async function flyPath(page, keys, { agl = true, conform = false } = {}) {
  await page.evaluate(({ keys, agl, conform }) => {
    const app = window.__rft.app, sess = app.session;
    sess.__step ??= sess.step.bind(sess);
    if (!keys) { sess.step = sess.__step; delete sess.__step; return; }
    // RAW: the jets do what the controls say (ASSIST would brake against the scripted motion)
    if (app.manual) app.manual.assist = 'RAW';
    const ground = (x, z) => { const g = agl ? (app.renderer.worldHandle?.surfaceAt?.(x, z) ?? 0) : 0; return Number.isFinite(g) ? g : 0; };
    const t0 = app.sim.getState().t, n = keys.length;
    const cr = (p0, p1, p2, p3, u) => 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
    const at = (t) => {
      let i = 0;
      while (i < n - 2 && keys[i + 1].t <= t) i++;
      const a = keys[i], b = keys[Math.min(i + 1, n - 1)];
      const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
      const K = (j) => keys[Math.min(Math.max(j, 0), n - 1)];
      const f = (g) => cr(g(K(i - 1)), g(K(i)), g(K(i + 1)), g(K(i + 2)), u);
      const x = f((k) => k.pos[0]), z = f((k) => k.pos[2]);
      return { x, y: f((k) => k.pos[1]) + ground(x, z), z, h: f((k) => k.heading ?? 0), p: f((k) => k.pitch ?? 0), r: f((k) => k.roll ?? 0) };
    };
    const D = Math.PI / 180;
    // conform: the car sits on the ground – pitch and height from the ground under the front and rear axle
    // (keys then only give x, z and heading; the given y and pitch are ignored)
    const FRONT = 1.4, REAR = 1.25, RIDE = 0.45;
    const onGround = (a) => {
      const h = a.h * Math.PI / 180, fx = Math.sin(h), fz = Math.cos(h);
      const g = (x, z) => { const v = app.renderer.worldHandle?.surfaceAt?.(x, z) ?? 0; return Number.isFinite(v) ? v : 0; };
      const hf = g(a.x + fx * FRONT, a.z + fz * FRONT), hr = g(a.x - fx * REAR, a.z - fz * REAR);
      const p = Math.atan2(hf - hr, FRONT + REAR);
      return { ...a, y: (hf * REAR + hr * FRONT) / (FRONT + REAR) + RIDE / Math.cos(p), p: p * 180 / Math.PI };
    };
    sess.step = () => {
      const t = app.sim.getState().t - t0, dt = app.sim.dt, b2 = app.sim.body;
      const a = conform ? onGround(at(t)) : at(t), b = conform ? onGround(at(t + dt)) : at(t + dt);
      // heading about y, then pitch (nose up = about −x local), then roll (right side down = about +z local)
      const cy = Math.cos(a.h * D / 2), sy = Math.sin(a.h * D / 2), cp = Math.cos(-a.p * D / 2), sp = Math.sin(-a.p * D / 2), cr2 = Math.cos(a.r * D / 2), sr = Math.sin(a.r * D / 2);
      const q1 = { w: cy * cp, x: cy * sp, y: sy * cp, z: -sy * sp };                         // yaw · pitch
      const q = { w: q1.w * cr2 - q1.z * sr, x: q1.x * cr2 + q1.y * sr, y: q1.y * cr2 - q1.x * sr, z: q1.z * cr2 + q1.w * sr }; // · roll
      b2.setTranslation({ x: a.x, y: a.y, z: a.z }, true);
      b2.setRotation(q, true);
      b2.setLinvel({ x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt }, true);
      b2.setAngvel({ x: 0, y: (b.h - a.h) * D / dt, z: 0 }, true);
      sess.__step();
    };
  }, { keys, agl, conform });
}

/** Endless air for the shot (no autoland, no empty tank). */
export async function infiniteAir(page) {
  await page.evaluate(() => { window.__rft.app.session.infiniteAir = true; });
}

/** The course driver (src/sim/gnc/courseDriver.ts) drives the level being played: real driving, as a player would
 *  (after delayS on the brake). */
export async function courseDrive(page, { delayS = 0 } = {}) {
  await page.evaluate((delayS) => {
    const app = window.__rft.app, inp = app.input, drv = window.__rft.courseDriver(), t0 = app.sim.getState().t;
    if (!drv) throw new Error('no level is being driven');
    inp.__poll ??= inp.poll.bind(inp);
    inp.poll = (dt) => {
      const p = inp.__poll(dt);
      for (const k of Object.keys(p.pressed)) p.pressed[k] = false;
      const st = app.sim.getState(), d = drv.update(st);
      p.drive = st.t - t0 < delayS ? { ...d, throttle: 0, brake: 1, steer: 0 } : d;
      p.thrust = { lift: 0, boost: 0, pitch: 0, roll: 0, yaw: 0 };
      return p;
    };
  }, delayS);
}
