// Fixed-step capture of the title demo / auto stunts for flicker and ghosting measurements.
//
//   node tests/render/flickerGhost.mjs --url http://127.0.0.1:4391/ --seq kickflip --q high \
//        [--webgl] [--frames 900] [--out dir] [--ref] [--video] [--headed] [--w 1920 --h 1080]
//   --seq title | <stunt id> | world:<site id> (world: free drive with the throttle held, chase camera)
//
// The game loop is stopped and advanced by exactly 1/60 s per frame (4 physics steps, the director's
// cut timers run normally); Math.random is seeded, dynamic resolution is held at 1. Every frame is
// copied from the game canvas into a 192×108 luma grid (blocks of 10×10 px at 1080p: grain and TRAA
// jitter average out) plus, with --video, a 640×360 JPEG. Per frame the trace records the broadcast
// shot, cuts, exposure, the light slots of the FloodRig, the smoke lights and the car's screen box.
//
// --ref additionally runs the sequence a second time as reference without temporal accumulation
// (TRAA history re-seeded from the current frame before every frame, motion blur off, same
// exposure per frame): |A − ref| inside the car box is the ghosting trail.
// Metrics (frameMetrics.ts) go to <out>/metrics.json; a heat map of flicker sources to heat.png.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { cutResidual, dropout, meanAbsDiff, meanLuma, popFrames, pumping, reversalEnergy, reversalHeat, stats, unionBox } from './frameMetrics.ts';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const url = opt('url', 'http://127.0.0.1:4391/');
const seq = opt('seq', 'title');
const q = opt('q', 'high');
const webgl = !!opt('webgl', false);
const W = Number(opt('w', 1920)), H = Number(opt('h', 1080));
const maxFrames = Number(opt('frames', 900));
const out = opt('out', `fg-${seq}-${q}-${webgl ? 'webgl2' : 'webgpu'}`);
const wantRef = !!opt('ref', false);
// reference variant: both (default), mb (motion blur off only), traa (history re-seeded only)
const refMode = opt('refmode', 'both');
// --freeze N: from frame N on the simulation stands still and only rendering goes on (TRAA jitter,
// exposure, grain keep running) – every remaining change of the image is render flicker
const freezeAt = Number(opt('freeze', -1));
// --noprobe: car reflection probe frozen (diagnostic for flicker on the car)
const noProbe = !!opt('noprobe', false);
const video = !!opt('video', false);
const GW = 192, GH = 108;
if (!opt('analyse', null)) mkdirSync(out, { recursive: true });



async function run(label, ref, lockExposure) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.addInitScript(() => {
    // seeded Math.random (mulberry32) so particles/emitters repeat between runs
    let s = 1;
    window.__seed = (v) => { s = v >>> 0; };
    Math.random = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  });
  const qs = `?q=${q}${webgl ? '&webgl' : ''}${seq === 'title' ? '' : '&nomenu'}`;
  const world = seq.startsWith('world:') ? seq.slice(6) : null;
  await page.goto(url + qs);
  await page.waitForFunction(() => window.__rft?.ready === true, null, { timeout: 600_000 });
  await page.waitForTimeout(1500);
  // worlds: switch the site first (loads the world renderer), then drive with the throttle held
  if (world) { await page.evaluate((id) => window.__rft.startWorld(id), world); await page.waitForTimeout(3000); }
  const backend = await page.evaluate(([seqId, GW, GH, noProbe]) => {
    const app = window.__rft.app, r = app.renderer;
    app.loop.stop();
    r.fixedRes = true;
    r.dynRes.reset();
    r.applyPixelRatio();
    // full-size copy, box-averaged into the GW×GH grid below (a scaled drawImage samples only a few
    // source pixels per cell and would alias thin lights in the measurement itself)
    const cv0 = r.renderer.domElement;
    const c2 = document.createElement('canvas'); c2.width = cv0.width; c2.height = cv0.height;
    const v2 = document.createElement('canvas'); v2.width = 640; v2.height = 360;
    const vctx = v2.getContext('2d'); vctx.imageSmoothingQuality = 'high';
    let cuts = 0;
    const onCut = r.rig.onCut;
    r.rig.onCut = () => { cuts++; onCut?.(); };
    window.__cap = { c2, ctx: c2.getContext('2d', { willReadFrequently: true }), v2, vctx, cuts: () => cuts };
    // state left over from the attract demo that ran in real time until now
    const rig = r.rig;
    rig.director.heldS = 0; rig.director.current = null; rig.lastCar = null; rig.air = 0;
    rig.camera.fov = 50; rig.camera.updateProjectionMatrix();
    window.__seed(12345);
    if (seqId === 'title') app.startSession({ kind: 'auto', stunt: 'kickflip' }, true);
    else if (seqId.startsWith('world:')) { app.menu.hide(); app.restart?.(); }
    else { app.menu.hide(); app.startStunt(seqId); }
    r.exposureTarget = r.exposure; r.lumFrame = 0; r.probeFrames = 0;
    if (noProbe) r.disable = { ...r.disable, probe: true };
    return r.getStats().backend;
  }, [seq, GW, GH, noProbe]);
  if (backend !== (webgl ? 'webgl2' : 'webgpu')) throw new Error(`backend is ${backend}, expected ${webgl ? 'webgl2' : 'webgpu'}`);
  if (world) await page.keyboard.down('KeyW');
  const frames = [], trace = [];
  const jpgDir = join(out, `${label}-jpg`);
  if (video) { rmSync(jpgDir, { recursive: true, force: true }); mkdirSync(jpgDir); }
  let doneAt = -1;
  for (let i = 0; i < maxFrames; i++) {
    const res = await page.evaluate(([ref, lock, wantJpg, GW, GH, frozen]) => {
      const app = window.__rft.app, r = app.renderer, cap = window.__cap;
      if (ref && ref !== 'mb') r.post.resetHistory();
      if (ref && ref !== 'traa') r.post.motionAmount.value = 0;
      if (lock !== null) r.exposureLock = lock;
      const cuts0 = cap.cuts();
      if (frozen) r.render(); else app.loop.advance(1 / 60);
      const cv = r.renderer.domElement;
      const FW = cap.c2.width, FH = cap.c2.height;
      cap.ctx.drawImage(cv, 0, 0, FW, FH);
      const px = cap.ctx.getImageData(0, 0, FW, FH).data;
      const acc = new Float32Array(GW * GH), cnt = new Float32Array(GW * GH);
      for (let y = 0; y < FH; y++) {
        const gy = Math.min(GH - 1, Math.floor(y * GH / FH)) * GW;
        for (let x = 0; x < FW; x++) {
          const o = (y * FW + x) * 4, g = gy + Math.min(GW - 1, Math.floor(x * GW / FW));
          acc[g] += 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]; cnt[g]++;
        }
      }
      const luma = new Uint8Array(GW * GH);
      for (let k = 0; k < luma.length; k++) luma[k] = Math.round(acc[k] / cnt[k]);
      let s = ''; for (let k = 0; k < luma.length; k++) s += String.fromCharCode(luma[k]);
      let jpg = null;
      if (wantJpg) { cap.vctx.drawImage(cv, 0, 0, 640, 360); jpg = cap.v2.toDataURL('image/jpeg', 0.85); }
      // car screen box (3 m cube around the body centre)
      const cam = r.camera, st = r.lastState;
      let box = null;
      if (st) {
        const P = cam.projectionMatrix.elements, V = cam.matrixWorldInverse.elements;
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, ok = true;
        for (const dx of [-2.6, 2.6]) for (const dy of [-1.2, 1.6]) for (const dz of [-2.6, 2.6]) {
          const x = st.pos.x + dx, y = st.pos.y + dy, z = st.pos.z + dz;
          const vx = V[0] * x + V[4] * y + V[8] * z + V[12], vy = V[1] * x + V[5] * y + V[9] * z + V[13], vz = V[2] * x + V[6] * y + V[10] * z + V[14];
          const cx = P[0] * vx + P[4] * vy + P[8] * vz + P[12], cy = P[1] * vx + P[5] * vy + P[9] * vz + P[13], cw = P[3] * vx + P[7] * vy + P[11] * vz + P[15];
          if (cw <= 0.1) { ok = false; continue; }
          const sx = (cx / cw * 0.5 + 0.5) * GW, sy = (0.5 - cy / cw * 0.5) * GH;
          x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
        }
        if (ok && x1 > 0 && y1 > 0 && x0 < GW && y0 < GH) box = { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
      }
      const fl = r.floods;
      const slots = fl ? fl.slots.map((l) => l.intensity > 0 ? `${l.position.x.toFixed(0)},${l.position.z.toFixed(0)}${l.castShadow ? 's' : ''}` : '-').join('|') : '';
      const tel = app.session.telemetry();
      return {
        luma: s, jpg, box,
        tr: {
          t: tel.t, phase: tel.phase, outcome: app.session.outcome.status, shot: r.rig.currentShot?.id ?? r.rig.mode,
          cut: cap.cuts() > cuts0, exposure: r.exposure, tme: r.renderer.toneMappingExposure, site: fl?.site ?? null, slots,
          res: r.getStats().resolutionScale, car: st ? [st.pos.x, st.pos.y, st.pos.z] : null, cam: [cam.position.x, cam.position.y, cam.position.z, cam.fov].map((v) => +v.toFixed(4)),
        },
      };
    }, [ref, lockExposure ? lockExposure[i] ?? null : null, video, GW, GH, freezeAt >= 0 && i >= freezeAt]);
    const data = Uint8Array.from(res.luma, (ch) => ch.charCodeAt(0));
    frames.push({ w: GW, h: GH, data });
    trace.push({ ...res.tr, box: res.box });
    if (res.jpg) writeFileSync(join(jpgDir, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(res.jpg.split(',')[1], 'base64'));
    if (doneAt < 0 && res.tr.outcome !== 'running' && seq !== 'title') doneAt = i;
    if (doneAt >= 0 && i - doneAt > 90) break;   // 1.5 s after the stunt ended
    if (i % 120 === 0) process.stdout.write(`  ${label} frame ${i} t=${res.tr.t.toFixed(2)} ${res.tr.phase} shot=${res.tr.shot}\n`);
  }
  await page.close();
  if (video) {
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '60', '-i', join(jpgDir, 'f%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', join(out, `${label}.mp4`)]);
    } catch (e) { console.warn('ffmpeg failed', e.message); }
  }
  writeFileSync(join(out, `${label}-luma.bin`), Buffer.concat(frames.map((f) => Buffer.from(f.data))));
  return { frames, trace };
}

function analyse(frames, trace) {
  const cuts = new Set(trace.map((t, i) => (t.cut ? i : -1)).filter((i) => i >= 0));
  const skip = new Set([...cuts, 0, 1]);
  const rev = [], revCar = [], revBg = [];
  for (let t = 1; t + 1 < frames.length; t++) {
    if (skip.has(t) || skip.has(t + 1)) continue;
    rev.push(reversalEnergy(frames[t - 1], frames[t], frames[t + 1]));
    // inside the car box (paint reflections, jets) and outside it (venue lights, sky, clouds)
    const b = trace[t].box;
    if (!b) continue;
    const m = new Uint8Array(GW * GH);
    for (let y = Math.max(0, b.y0); y < Math.min(GH, b.y1); y++) for (let x = Math.max(0, b.x0); x < Math.min(GW, b.x1); x++) m[y * GW + x] = 1;
    const inv = m.map((v) => 1 - v);
    if ((b.x1 - b.x0) * (b.y1 - b.y0) < GW * GH * 0.5) revCar.push(reversalEnergy(frames[t - 1], frames[t], frames[t + 1], m));
    revBg.push(reversalEnergy(frames[t - 1], frames[t], frames[t + 1], inv));
  }
  const luma = frames.map(meanLuma);
  const meanL = luma.reduce((a, b) => a + b, 0) / Math.max(1, luma.length);
  const pops = popFrames(frames, skip).map((p) => ({ ...p, ...pick(trace[p.t]), prev: pick(trace[p.t - 1]) }));
  const cutRes = [...cuts].filter((c) => c > 2).map((c) => ({ t: c, shot: trace[c].shot, residual: cutResidual(frames, c) }));
  // discrete state flips
  const flips = { slots: 0, site: 0, res: 0 };
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].slots !== trace[i - 1].slots) flips.slots++;
    if (trace[i].site !== trace[i - 1].site) flips.site++;
    if (trace[i].res !== trace[i - 1].res) flips.res++;
  }
  const expo = trace.map((t) => t.tme);
  return {
    frames: frames.length, cuts: cuts.size,
    flicker: stats(rev), flickerRel: stats(rev).mean / Math.max(1, meanL), dropout: dropout(frames, skip), flickerCar: stats(revCar), flickerBg: stats(revBg), pumpingLuma: pumping(luma), exposurePumping: pumping(expo.map((e) => Math.log2(e) * 100)) / 100,
    pops: pops.slice(0, 40), popCount: pops.length, cutResidual: { ...stats(cutRes.map((c) => c.residual)), list: cutRes }, flips,
  };
}
const pick = (t) => (t ? { shot: t.shot, cut: t.cut, slots: t.slots, tme: +t.tme.toFixed(3), site: t.site, phase: t.phase } : null);

function writeHeat(frames, trace, file) {
  const cuts = new Set(trace.map((t, i) => (t.cut ? i : -1)).filter((i) => i >= 0));
  const heat = reversalHeat(frames, new Set([...cuts, 0, 1]));
  const pgm = Buffer.alloc(GW * GH);
  for (let i = 0; i < heat.length; i++) pgm[i] = Math.min(255, Math.round(heat[i] * 25)); // 10 luma reversal ≙ white
  const raw = file + '.gray';
  writeFileSync(raw, pgm);
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${GW}x${GH}`, '-i', raw, '-vf', 'scale=960:540:flags=neighbor,format=gray,lutrgb=r=val:g=val:b=val', file]);
    rmSync(raw);
  } catch { /* keep the raw file */ }
}

function ghost(A, B) {
  const n = Math.min(A.frames.length, B.frames.length);
  const car = [], trail = [], whole = [];
  for (let i = 0; i < n; i++) {
    whole.push(meanAbsDiff(A.frames[i], B.frames[i]));
    const now = A.trace[i].box, old = A.trace[Math.max(0, i - 6)].box;
    const b = unionBox([now, old], 3);
    if (b && (b.x1 - b.x0) * (b.y1 - b.y0) < GW * GH * 0.6) car.push(meanAbsDiff(A.frames[i], B.frames[i], b));
    // the trail: where the car was 6 frames ago but is not now
    if (old && now && !A.trace.slice(Math.max(0, i - 6), i + 1).some((t) => t.cut)) {
      const tb = { x0: old.x0, y0: old.y0, x1: old.x1, y1: old.y1 };
      if (now.x0 > old.x0) tb.x1 = Math.min(tb.x1, now.x0); else tb.x0 = Math.max(tb.x0, now.x1);
      if (tb.x1 - tb.x0 >= 2 && tb.y1 > tb.y0) trail.push(meanAbsDiff(A.frames[i], B.frames[i], tb));
    }
  }
  return { whole: stats(whole), carBox: stats(car), trail: stats(trail), refFlicker: analyse(B.frames, B.trace).flicker };
}

function summary(metrics) {
  const a = metrics.A;
  return JSON.stringify({ seq: metrics.seq, q: metrics.q, backend: metrics.backend, frames: a.frames, cuts: a.cuts, flicker: +a.flicker.mean.toFixed(3), dropout: +(a.dropout * 100).toFixed(3), flickerCar: +a.flickerCar.mean.toFixed(3), flickerBg: +a.flickerBg.mean.toFixed(3), pumping: +a.pumpingLuma.toFixed(3), popCount: a.popCount, cutResidual: +a.cutResidual.p50.toFixed(2), flips: a.flips, ghost: metrics.ghost && { car: +metrics.ghost.carBox.mean.toFixed(2), trail: +metrics.ghost.trail.mean.toFixed(2), whole: +metrics.ghost.whole.mean.toFixed(2) } });
}

const loadLuma = (file) => { const b = readFileSync(file); const fr = []; for (let o = 0; o + GW * GH <= b.length; o += GW * GH) fr.push({ w: GW, h: GH, data: new Uint8Array(b.subarray(o, o + GW * GH)) }); return fr; };

const offline = opt('analyse', null);
if (offline) {
  // re-evaluate a capture directory (A-luma.bin, trace.json[, ref-luma.bin])
  const prev = existsSync(join(offline, 'metrics.json')) ? JSON.parse(readFileSync(join(offline, 'metrics.json'), 'utf8')) : { seq: offline };
  const A = { frames: loadLuma(join(offline, 'A-luma.bin')), trace: JSON.parse(readFileSync(join(offline, 'trace.json'), 'utf8')) };
  const metrics = { ...prev, A: analyse(A.frames, A.trace) };
  if (existsSync(join(offline, 'ref-luma.bin'))) metrics.ghost = ghost(A, { frames: loadLuma(join(offline, 'ref-luma.bin')), trace: A.trace });
  writeFileSync(join(offline, 'metrics.json'), JSON.stringify(metrics, null, 1));
  console.log(summary(metrics));
  process.exit(0);
}

const browser = await chromium.launch({
  headless: !opt('headed', false),
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const A = await run('A', false, null);
const metrics = { seq, q, backend: webgl ? 'webgl2' : 'webgpu', size: `${W}x${H}`, load: (await import('node:os')).loadavg(), A: analyse(A.frames, A.trace) };
writeHeat(A.frames, A.trace, join(out, 'heat.png'));
writeFileSync(join(out, 'trace.json'), JSON.stringify(A.trace));
if (wantRef) {
  const B = await run('ref', refMode, A.trace.map((t) => t.tme));
  writeFileSync(join(out, 'trace-ref.json'), JSON.stringify(B.trace));
  metrics.ghost = ghost(A, B);
  // the reference must show the same frames: camera and car positions of both runs
  let dc = 0, dp = 0;
  for (let i = 0; i < Math.min(A.trace.length, B.trace.length); i++) {
    const a = A.trace[i], b = B.trace[i];
    dc = Math.max(dc, Math.hypot(a.cam[0] - b.cam[0], a.cam[1] - b.cam[1], a.cam[2] - b.cam[2]) + Math.abs(a.cam[3] - b.cam[3]));
    if (a.car && b.car) dp = Math.max(dp, Math.hypot(a.car[0] - b.car[0], a.car[1] - b.car[1], a.car[2] - b.car[2]));
  }
  metrics.ghost.divergence = { camera: dc, car: dp };
  metrics.ghost.refMode = refMode;
}
writeFileSync(join(out, 'metrics.json'), JSON.stringify(metrics, null, 1));
console.log(summary(metrics));
await browser.close();
