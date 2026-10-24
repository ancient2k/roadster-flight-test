// Cuts the trailer from the rendered shots (trailer-out/*.mp4 with game sound), the DOS boot, the editor, the end card
// and the own sound stems. The epic music is optional: trailer-out/music.wav (or .mp3), laid from the first frame and
// faded out under the Sun shots; without it the cut has game sound only in those parts.
//   node tools/trailer/assemble.mjs              → trailer-out/trailer.mp4
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './lib.mjs';

/** Edit list: source, in point, length (s), and what happens to it. */
const EDIT = [
  { src: '01-liftoff', in: 0.0, len: 4.0, fadeIn: 0.6 },
  { src: '02-stonehenge', in: 0.8, len: 2.6 },
  { src: '03-giza', in: 0.5, len: 2.6 },
  { src: '04-starbase', in: 0.5, len: 14.5 },
  { src: '05-ascent', in: 1.0, len: 6.5 },
  { src: '06-moon', in: 0.8, len: 3.2 },
  { src: '07-mars', in: 0.8, len: 3.2 },
  { src: '08-sun', in: 0.0, len: 4.0 },
  { src: '09-roadster1', in: 0.0, len: 5.5, fadeOut: 2.2 },
  { black: 0.8 },
  { src: 'dos', in: 0.0, len: 4.2, silent: true, stem: 'dos-sfx' },
  { src: '10-editor', in: 0.0, len: 11.6, silent: true, stem: ['chiptune', 'editor-sfx'] },
  { src: '11-return', in: 0.0, len: 7.5, pixelIn: 0.7 },
  { src: '12-finale', in: 0.0, len: 14.0, card: { at: 2.5, fade: 1.2 }, fadeOut: 1.5 },
];
const W = 1920, H = 1080, FPS = 60;

const inputs = [], vf = [], af = [], segs = [];
let t = 0, musicEnd = 0;
const stems = [];
for (const [k, e] of EDIT.entries()) {
  if (e.black) {
    vf.push(`color=c=black:s=${W}x${H}:r=${FPS}:d=${e.black},format=yuv420p[v${k}]`);
    af.push(`anullsrc=r=48000:cl=stereo,atrim=0:${e.black}[a${k}]`);
    segs.push(k); t += e.black; continue;
  }
  const file = path.join(OUT, `${e.src}.mp4`);
  if (!fs.existsSync(file)) throw new Error(`missing ${file} (render it with tools/trailer/run.mjs or cards.mjs)`);
  const i = inputs.push(file) - 1;
  let v = `[${i}:v]trim=start=${e.in}:duration=${e.len},setpts=PTS-STARTPTS,fps=${FPS},scale=${W}:${H},format=yuv420p`;
  if (e.fadeIn) v += `,fade=t=in:st=0:d=${e.fadeIn}`;
  if (e.fadeOut) v += `,fade=t=out:st=${e.len - e.fadeOut}:d=${e.fadeOut}`;
  // editor → 3D: the picture starts as big pixels and sharpens (nearest-neighbour down- and upscale per frame)
  if (e.pixelIn) v += `,scale=w='trunc(max(24\\,${W}*pow(min(1\\,t/${e.pixelIn})\\,3))/2)*2':h=-2:eval=frame:flags=neighbor,scale=${W}:${H}:flags=neighbor`;
  if (e.card) {
    const c = inputs.push(path.join(OUT, 'endcard.png')) - 1;
    vf.push(`[${c}:v]format=rgba,loop=loop=-1:size=1:start=0,trim=duration=${e.len},setpts=PTS-STARTPTS,fade=t=in:st=${e.card.at}:d=${e.card.fade}:alpha=1[card${k}]`);
    vf.push(`${v}[base${k}]`);
    vf.push(`[base${k}][card${k}]overlay=0:0:shortest=1,format=yuv420p[v${k}]`);
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
  segs.push(k); t += e.len;
}
const total = t;
const concat = `${segs.map((k) => `[v${k}][a${k}]`).join('')}concat=n=${segs.length}:v=1:a=1[vout][game]`;
// stems at their places; the music (if any) from 0 to the end of the Sun part, with a fade-out
const mix = ['[game]volume=1.0[g]'];
const labels = ['[g]'];
for (const [j, s] of stems.entries()) {
  const i = inputs.push(s.file) - 1;
  mix.push(`[${i}:a]aresample=48000,adelay=${Math.round(s.at * 1000)}|${Math.round(s.at * 1000)},apad,atrim=0:${total}[s${j}]`);
  labels.push(`[s${j}]`);
}
const music = ['music.wav', 'music.mp3'].map((f) => path.join(OUT, f)).find((f) => fs.existsSync(f));
if (music) {
  const i = inputs.push(music) - 1;
  mix.push(`[${i}:a]aresample=48000,atrim=0:${musicEnd},afade=t=out:st=${musicEnd - 2.5}:d=2.5,apad,atrim=0:${total},volume=0.8[m]`);
  labels.push('[m]');
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
