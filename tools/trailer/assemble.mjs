// Cuts the trailer from the rendered shots (trailer-out/*.mp4 with game sound), the DOS boot, the editor, the end card
// and the own sound stems. The score is optional: trailer-out/music.wav (or .mp3), laid from the first frame to the fade
// over Roadster 1 and again from the test drive to the end; without it the cut has game sound only in those parts.
//   node tools/trailer/assemble.mjs              → trailer-out/trailer.mp4
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './lib.mjs';

/** Edit list: source, in point, length (s), and what happens to it (xfade: cross-fade of that length into the next). */
const EDIT = [
  { src: '01-liftoff', in: 0.0, len: 4.0, fadeIn: 0.6 },
  { src: '02-stonehenge', in: 0.3, len: 3.2 },
  { src: '03-giza', in: 0.2, len: 3.8 },
  { src: '04-starbase', in: 0.5, len: 20.0 },
  { src: '06-moon', in: 0.5, len: 4.0 },
  { src: '07-mars', in: 0.2, len: 3.2 },
  { src: '08-sun', in: 0.0, len: 4.0 },
  { src: '09-roadster1', in: 0.0, len: 5.5, fadeOut: 2.2 },
  { black: 0.8 },
  { src: 'dos', in: 0.0, len: 4.2, silent: true, stem: 'dos-sfx' },
  { src: '10-editor', in: 0.0, len: 11.6, silent: true, stem: ['chiptune', 'editor-sfx'] },
  // the test drive: down to the start line and through the loop, a hard cut to the run-up to the jump, and at the top
  // of the jump a cross-fade into the empty closing picture; then the Roadster runs in from the left and slides to a stop
  // as the booster comes down
  { src: '11-return', in: 0.0, len: 10.4, pixelIn: 0.7 },
  { src: '11-return', in: 14.2, len: 4.6, xfade: 1.0 },
  { src: '12-finale', in: 0.0, len: 17.0, card: { at: 6.2, fade: 1.2 }, fadeOut: 1.5 },
];
/** Game sound under the music (the score carries the trailer; jets and engine only underneath). */
const GAME_VOLUME = 0.3;
/** Where the score starts (s into the file; Aphelion by Scott Buckley: 5:00, the swell peaks around 5:40) and its level. */
const MUSIC_IN = Number(process.env.MUSIC_IN ?? 300);
const MUSIC_VOLUME = 0.8;
const W = 1920, H = 1080, FPS = 60;

const inputs = [], vf = [], af = [], segs = [];
let t = 0, musicEnd = 0, musicBack = 0;
const stems = [];
for (const [k, e] of EDIT.entries()) {
  if (e.black) {
    vf.push(`color=c=black:s=${W}x${H}:r=${FPS}:d=${e.black},settb=1/${FPS},format=yuv420p[v${k}]`);
    af.push(`anullsrc=r=48000:cl=stereo,atrim=0:${e.black}[a${k}]`);
    segs.push(k); t += e.black; continue;
  }
  const file = path.join(OUT, `${e.src}.mp4`);
  if (!fs.existsSync(file)) throw new Error(`missing ${file} (render it with tools/trailer/run.mjs or cards.mjs)`);
  const i = inputs.push(file) - 1;
  let v = `[${i}:v]trim=start=${e.in}:duration=${e.len},setpts=PTS-STARTPTS,fps=${FPS},settb=1/${FPS},scale=${W}:${H},format=yuv420p`;
  if (e.fadeIn) v += `,fade=t=in:st=0:d=${e.fadeIn}`;
  if (e.fadeOut) v += `,fade=t=out:st=${e.len - e.fadeOut}:d=${e.fadeOut}`;
  // editor → 3D: the picture starts as big pixels and sharpens (nearest-neighbour down- and upscale per frame)
  if (e.pixelIn) v += `,scale=w='trunc(max(24\\,${W}*pow(min(1\\,t/${e.pixelIn})\\,3))/2)*2':h=-2:eval=frame:flags=neighbor,scale=${W}:${H}:flags=neighbor`;
  if (e.card) {
    const c = inputs.push(path.join(OUT, 'endcard.png')) - 1;
    vf.push(`[${c}:v]format=rgba,loop=loop=-1:size=1:start=0,trim=duration=${e.len},setpts=PTS-STARTPTS,fade=t=in:st=${e.card.at}:d=${e.card.fade}:alpha=1[card${k}]`);
    vf.push(`${v}[base${k}]`);
    vf.push(`[base${k}][card${k}]overlay=0:0:shortest=1,settb=1/${FPS},format=yuv420p[v${k}]`);
  } else vf.push(`${v}[v${k}]`);
  if (e.silent) af.push(`anullsrc=r=48000:cl=stereo,atrim=0:${e.len}[a${k}]`);
  else {
    let a = `[${i}:a]atrim=start=${e.in}:duration=${e.len},asetpts=PTS-STARTPTS,aresample=48000,apad,atrim=0:${e.len}`;
    if (e.fadeIn) a += `,afade=t=in:st=0:d=${e.fadeIn}`;
    if (e.fadeOut) a += `,afade=t=out:st=${e.len - e.fadeOut}:d=${e.fadeOut}`;
    af.push(`${a}[a${k}]`);
  }
  for (const s of [e.stem ?? []].flat()) stems.push({ file: path.join(OUT, `${s}.wav`), at: t });
  if (e.src === '09-roadster1') musicEnd = t + e.len;
  if (e.src === '11-return' && !musicBack) musicBack = t;
  segs.push(k); t += e.len - (e.xfade ?? 0);
}
const total = t;
// join the segments one after another: a cut, or a cross-fade where the previous segment asks for one
const join = [];
let cv = `[v${segs[0]}]`, ca = `[a${segs[0]}]`, len = EDIT[segs[0]].len ?? EDIT[segs[0]].black;
for (let n = 1; n < segs.length; n++) {
  const k = segs[n], prev = EDIT[segs[n - 1]], e = EDIT[k], l = e.len ?? e.black, nv = `[j${n}v]`, na = `[j${n}a]`;
  if (prev.xfade) {
    // xfade needs both inputs on the same timebase (concat hands its output on in microseconds)
    join.push(`${cv}settb=1/${FPS}[j${n}x]`);
    join.push(`[j${n}x][v${k}]xfade=transition=fade:duration=${prev.xfade}:offset=${(len - prev.xfade).toFixed(3)}${nv}`);
    join.push(`${ca}[a${k}]acrossfade=d=${prev.xfade}${na}`);
    len += l - prev.xfade;
  } else {
    join.push(`${cv}${ca}[v${k}][a${k}]concat=n=2:v=1:a=1${nv}${na}`);
    len += l;
  }
  cv = nv; ca = na;
}
join.push(`${cv}null[vout]`, `${ca}anull[game]`);
const concat = join.join(';\n');
// stems at their places, then the score (if any) in its two parts
const mix = [`[game]volume=${GAME_VOLUME}[g]`];
const labels = ['[g]'];
for (const [j, s] of stems.entries()) {
  const i = inputs.push(s.file) - 1;
  mix.push(`[${i}:a]aresample=48000,adelay=${Math.round(s.at * 1000)}|${Math.round(s.at * 1000)},apad,atrim=0:${total}[s${j}]`);
  labels.push(`[s${j}]`);
}
const music = ['music.wav', 'music.mp3'].map((f) => path.join(OUT, f)).find((f) => fs.existsSync(f));
if (music) {
  // part one from MUSIC_IN to the fade-out over Roadster 1; after the editor the score picks up where it stopped and
  // its decay carries the test drive and the closing picture
  const a = inputs.push(music) - 1, b = inputs.push(music) - 1, back = MUSIC_IN + musicEnd, tail = total - musicBack;
  mix.push(`[${a}:a]aresample=48000,atrim=start=${MUSIC_IN}:duration=${musicEnd},asetpts=PTS-STARTPTS,afade=t=out:st=${musicEnd - 2.5}:d=2.5,apad,atrim=0:${total},volume=${MUSIC_VOLUME}[m]`);
  mix.push(`[${b}:a]aresample=48000,atrim=start=${back}:duration=${tail},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.2,afade=t=out:st=${tail - 2}:d=2[mb]`);
  mix.push(`anullsrc=r=48000:cl=stereo,atrim=0:${musicBack}[mpre]`, `[mpre][mb]concat=n=2:v=0:a=1,apad,atrim=0:${total},volume=${MUSIC_VOLUME}[m2]`);
  labels.push('[m]', '[m2]');
}
mix.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0,alimiter=limit=0.95[aout]`);

const graph = [...vf, ...af, concat, ...mix].join(';\n');
fs.writeFileSync(path.join(OUT, 'assemble.filter'), graph);
const out = path.join(OUT, 'trailer.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs.flatMap((f) => ['-i', f]),
  '-/filter_complex', path.join(OUT, 'assemble.filter'), '-map', '[vout]', '-map', '[aout]',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', out], { stdio: 'inherit' });
console.log(`trailer: ${out} (${total.toFixed(1)} s${music ? ', with music' : ', no music yet'})`);
