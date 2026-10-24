// The twist: the retro track editor. The track name is typed, then Starbase Sprint is built piece by piece in the
// order of the course (faster and faster), a mouse pointer places each piece; at the end it moves to "Test drive"
// and clicks. Writes trailer-out/10-editor.events.json (times of key presses and clicks, for the sound).
import fs from 'node:fs';
import path from 'node:path';

const POINTER = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="36" viewBox="0 0 12 18" shape-rendering="crispEdges">
<path d="M0 0h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1H7v1h1v1h1v2H8v1H7v-1H6v-2H5v-1H4v1H3v1H2v1H1v1H0z" fill="#000"/>
<path d="M1 2h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1h1v1H6v1h1v1h1v2H7v-2H6v-1H5v-1H4v1H3v1H2v1H1z" fill="#fff"/></svg>`;

/** Larger retro pixels: 1280 × 720 CSS pixels rendered at 1.5× (1920 × 1080). */
export const viewport = { width: 1280, height: 720, scale: 1.5 };

export default async function (page, h, name) {
  const fps = 60;
  const level = JSON.parse(fs.readFileSync('src/editor/samples/starbase-sprint.json', 'utf8'));
  await page.evaluate(() => window.__rft.openEditor());
  await page.waitForFunction(() => !!window.__rft.app.editor);
  await page.evaluate(({ level, svg }) => {
    const ed = window.__rft.app.editor;
    ed.closeDialogs();
    ed.setLevel({ ...level, parts: [], deco: [] }, null);
    ed.nameInput.value = '';
    // zoom onto the course (bounding box of its tiles + a margin)
    const is = level.parts.map((q) => q.i), js = level.parts.map((q) => q.j);
    const i0 = Math.min(...is) - 3, i1 = Math.max(...is) + 5, j0 = Math.min(...js) - 3, j1 = Math.max(...js) + 5;
    const W = ed.main.clientWidth, H = ed.main.clientHeight, sc = Math.floor(Math.min(W / (i1 - i0), H / (j1 - j0)));
    ed.view = { scale: sc, ox: Math.round(W / 2 - ((i0 + i1) / 2) * sc), oz: Math.round(H / 2 - ((j0 + j1) / 2) * sc) };
    ed.draw();
    const p = document.createElement('div');
    p.id = 'trailer-pointer';
    p.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none;image-rendering:pixelated';
    p.innerHTML = svg;
    document.body.appendChild(p);
  }, { level, svg: POINTER });

  // timeline on the beat of the chiptune (150 BPM, a bar = 1.6 s; tools/trailer/audio.mjs): bar 1 the name is typed
  // in sixteenths, bars 2–3 one piece per beat, bars 4–5 eighths, then sixteenths; the click on "Test drive" falls on
  // the downbeat of bar 8
  const BEAT = 60 / 150, title = level.name.toUpperCase();
  const events = [];
  for (let k = 1; k <= title.length; k++) events.push({ t: 0.2 + (k - 1) * BEAT / 4, kind: 'key', text: title.slice(0, k) });
  let t = 4 * BEAT;
  level.parts.forEach((part, k) => {
    events.push({ t, kind: 'place', k });
    t += k < 8 ? BEAT : k < 24 ? BEAT / 2 : BEAT / 4;
  });
  const moveTo = t + BEAT / 2;
  const clickT = 28 * BEAT;
  events.push({ t: clickT, kind: 'click' });
  const end = clickT + 0.4;
  const moveS = clickT - moveTo;
  // pointer target per frame: the tile centre of the next piece, the name field while typing, the button at the end
  const geo = await page.evaluate(() => {
    const ed = window.__rft.app.editor, r = ed.canvas.getBoundingClientRect(), n = ed.nameInput.getBoundingClientRect();
    const b = [...ed.el.querySelectorAll('.rfte-btn.hot')].find((x) => x.offsetParent);
    const br = b.getBoundingClientRect();
    return { left: r.left, top: r.top, view: ed.view, name: [n.left + 30, n.top + n.height / 2], button: [br.left + br.width / 2, br.top + br.height / 2] };
  });
  const tileXY = (part) => [geo.left + geo.view.ox + (part.i + 0.5) * geo.view.scale, geo.top + geo.view.oz + (part.j + 0.5) * geo.view.scale];
  const places = events.filter((e) => e.kind === 'place');
  const ease = (u) => u * u * (3 - 2 * u);
  const pointerAt = (time) => {
    if (time < places[0].t - 0.35) return geo.name;
    if (time >= moveTo) { const u = ease(Math.min(1, (time - moveTo) / moveS)); const a = tileXY(level.parts.at(-1)); return [a[0] + (geo.button[0] - a[0]) * u, a[1] + (geo.button[1] - a[1]) * u]; }
    // glide from the previous piece to the next one, arriving at its placing time
    let k = places.findIndex((e) => e.t > time);
    if (k < 0) k = places.length - 1;
    const to = tileXY(level.parts[places[k].k]), from = k > 0 ? tileXY(level.parts[places[k - 1].k]) : geo.name;
    const t0 = k > 0 ? places[k - 1].t : places[0].t - 0.35, u = ease(Math.min(1, Math.max(0, (time - t0) / Math.max(0.05, places[k].t - t0))));
    return [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u];
  };

  const dir = path.join(h.OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const n = Math.round(end * fps);
  const scout = process.env.SCOUT === '1';
  let shown = 0, typed = '';
  for (let i = 0; i < n; i++) {
    const time = i / fps;
    const parts = events.filter((e) => e.kind === 'place' && e.t <= time).length;
    const text = events.filter((e) => e.kind === 'key' && e.t <= time).at(-1)?.text ?? '';
    const pressed = time >= events.at(-1).t && time < events.at(-1).t + 0.15;
    const [px, py] = pointerAt(time);
    await page.evaluate(({ parts, text, px, py, pressed, changed, all }) => {
      const ed = window.__rft.app.editor;
      if (changed) { ed.level.parts = all.slice(0, parts); ed.nameInput.value = text; ed.level.name = text; ed.draw(); ed.updateStatus(); }
      const p = document.getElementById('trailer-pointer');
      p.style.transform = `translate(${px}px, ${py}px)`;
      const b = [...ed.el.querySelectorAll('.rfte-btn.hot')].find((x) => x.offsetParent);
      b.style.filter = pressed ? 'brightness(1.6)' : '';
      b.style.transform = pressed ? 'translate(1px,1px)' : '';
    }, { parts, text, px, py, pressed, changed: parts !== shown || text !== typed, all: level.parts });
    shown = parts; typed = text;
    if (scout && i % Math.round(n / 8) !== 0) continue;
    await page.screenshot({ path: path.join(dir, `${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 95 });
  }
  fs.writeFileSync(path.join(h.OUT, `${name}.events.json`), JSON.stringify({ fps, end, events }, null, 1));
  if (scout) {
    const files = fs.readdirSync(dir).sort().map((f) => path.join(dir, f));
    fs.mkdirSync(path.join(h.OUT, 'scout'), { recursive: true });
    const { execFileSync } = await import('node:child_process');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-pattern_type', 'glob', '-i', path.join(dir, '*.jpg'), '-vf', 'scale=640:-1,tile=4x2', '-frames:v', '1', path.join(h.OUT, 'scout', `${name}.jpg`)]);
    return path.join(h.OUT, 'scout', `${name}.jpg`);
  }
  h.encode(name, fps);
  return path.join(h.OUT, `${name}.mp4`);
}
