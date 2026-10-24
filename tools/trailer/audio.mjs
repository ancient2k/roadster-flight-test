// Own sounds for the trailer, synthesised sample by sample (no samples, no licences): the 8-bit tune under the editor
// (150 BPM, 8 bars, the last downbeat = the click on "Test drive"), the DOS boot (PC speaker beep, hard disk, keys)
// and the editor clicks. Timings come from trailer-out/dos.events.json and 10-editor.events.json.
//   node tools/trailer/audio.mjs        → trailer-out/chiptune.wav, dos-sfx.wav, editor-sfx.wav
import fs from 'node:fs';
import path from 'node:path';
import { OUT, writeWav } from './lib.mjs';

const SR = 48000;
const BPM = 150, BEAT = 60 / BPM, BAR = 4 * BEAT, S16 = BEAT / 4;

// ---------------------------------------------------------------- tiny synth
const buf = (sec) => new Float32Array(Math.ceil(sec * SR));
const hz = (note) => {
  const m = /^([A-G])(#|b)?(\d)$/.exec(note);
  const base = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 440 * 2 ** ((base + (Number(m[3]) - 4) * 12) / 12);
};
/** Adds a voice: kind pulse (duty), tri, noise; ADSR-ish: attack, decay to sustain, release at the end. */
function voice(out, t0, dur, { kind = 'pulse', f = 440, duty = 0.5, vol = 0.2, a = 0.002, d = 0.06, s = 0.6, r = 0.03, slide = 0, vib = 0 }) {
  const i0 = Math.floor(t0 * SR), n = Math.floor((dur + r) * SR);
  let ph = 0, lfsr = 0x7fff, hold = 0, noise = 0;
  for (let k = 0; k < n && i0 + k < out.length; k++) {
    const t = k / SR;
    const env = t < a ? t / a : t < a + d ? 1 - (1 - s) * ((t - a) / d) : t < dur ? s : s * Math.max(0, 1 - (t - dur) / r);
    const fr = f * (1 + slide * t) * (1 + vib * Math.sin(2 * Math.PI * 6 * t));
    ph = (ph + fr / SR) % 1;
    let v;
    if (kind === 'pulse') v = ph < duty ? 1 : -1;
    else if (kind === 'tri') v = 4 * Math.abs(ph - 0.5) - 1;
    else {                                   // NES-style LFSR noise, clocked at f
      hold += fr / SR;
      while (hold >= 1) { hold -= 1; const bit = (lfsr ^ (lfsr >> 1)) & 1; lfsr = (lfsr >> 1) | (bit << 14); noise = lfsr & 1 ? 1 : -1; }
      v = noise;
    }
    out[i0 + k] += v * env * vol;
  }
}
const kick = (o, t, vol = 0.5) => voice(o, t, 0.09, { kind: 'pulse', f: 150, duty: 0.5, vol, d: 0.08, s: 0, r: 0.02, slide: -6 });
const snare = (o, t, vol = 0.28) => voice(o, t, 0.12, { kind: 'noise', f: 9000, vol, d: 0.1, s: 0, r: 0.03 });
const hat = (o, t, vol = 0.09) => voice(o, t, 0.03, { kind: 'noise', f: 30000, vol, d: 0.03, s: 0, r: 0.01 });
const save = (name, ...chans) => {
  const L = chans[0], R = chans[1] ?? chans[0];
  const pcm = Buffer.alloc(L.length * 4);
  for (let i = 0; i < L.length; i++) {
    pcm.writeInt16LE(Math.round(Math.tanh(L[i]) * 32000), 4 * i);
    pcm.writeInt16LE(Math.round(Math.tanh(R[i]) * 32000), 4 * i + 2);
  }
  writeWav(path.join(OUT, name), pcm, SR, 2);
  console.log(name, (L.length / SR).toFixed(2), 's');
};

// ---------------------------------------------------------------- chiptune (8 bars + the ring-out of the final hit)
{
  const L = buf(8 * BAR + 1.2), R = buf(8 * BAR + 1.2);
  const both = (fn) => { fn(L); fn(R); };
  const chords = [['A2', 'A3', 'C4', 'E4'], ['A2', 'A3', 'C4', 'E4'], ['F2', 'F3', 'A3', 'C4'], ['G2', 'G3', 'B3', 'D4'],
    ['A2', 'A3', 'C4', 'E4'], ['F2', 'F3', 'A3', 'C4'], ['E2', 'E3', 'G#3', 'B3'], ['A2', 'A3', 'C#4', 'E4']];
  const lead = [
    null,
    'A4 C5 E5 A5 G5 E5 C5 E5', 'F4 A4 C5 F5 E5 C5 A4 C5', 'G4 B4 D5 G5 F5 D5 B4 D5', 'A4 C5 E5 A5 B5 C6 B5 A5',
  ];
  for (let bar = 0; bar < 7; bar++) {
    const t0 = bar * BAR, [root, , c1, c2] = chords[bar];
    // bass: root eighths with octave jumps (from bar 1 on), triangle
    for (let e = 0; e < 8; e++) {
      const f = hz(root) * (e % 2 ? 2 : 1);
      both((o) => voice(o, t0 + e * BEAT / 2, BEAT / 2 * 0.8, { kind: 'tri', f, vol: bar === 0 ? 0.22 : 0.3, d: 0.05, s: 0.8 }));
    }
    // drums
    for (let b = 0; b < 4; b++) {
      const tb = t0 + b * BEAT;
      if (bar >= 1) { if (b % 2 === 0) both((o) => kick(o, tb)); else both((o) => snare(o, tb)); }
      hat(L, tb + BEAT / 2, 0.07); hat(R, tb, 0.06);
      if (bar >= 3) { hat(L, tb + BEAT / 4, 0.04); hat(R, tb + 3 * BEAT / 4, 0.04); }
    }
    // lead (bars 1–4), arpeggio (bar 5), snare roll + climb (bar 6)
    if (lead[bar]) lead[bar].split(' ').forEach((n, e) => {
      voice(L, t0 + e * BEAT / 2, BEAT / 2 * 0.85, { f: hz(n), duty: 0.25, vol: 0.13, d: 0.08, s: 0.55, vib: 0.004 });
      voice(R, t0 + e * BEAT / 2 + 0.012, BEAT / 2 * 0.85, { f: hz(n) * 2, duty: 0.125, vol: 0.04, d: 0.08, s: 0.4 });
    });
    if (bar === 5) for (let k = 0; k < 16; k++) {
      const ns = k < 8 ? ['A4', 'C5', 'E5', 'A5'] : ['F4', 'A4', 'C5', 'F5'];
      both((o) => voice(o, t0 + k * S16, S16 * 0.9, { f: hz(ns[k % 4]) * (k >= 12 ? 2 : 1), duty: 0.25, vol: 0.11, d: 0.04, s: 0.5 }));
    }
    if (bar === 6) for (let k = 0; k < 16; k++) {
      both((o) => snare(o, t0 + k * S16, 0.08 + 0.17 * (k / 15)));
      both((o) => voice(o, t0 + k * S16, S16 * 0.9, { f: hz('E4') * 2 ** (k / 12), duty: 0.5, vol: 0.09 + 0.05 * (k / 15), d: 0.03, s: 0.7 }));
    }
    // pads: the chord as a quiet 12.5 % pulse on every beat (bars 2+)
    if (bar >= 2) for (let b = 0; b < 4; b++) for (const n of [c1, c2]) both((o) => voice(o, t0 + b * BEAT, BEAT * 0.5, { f: hz(n), duty: 0.125, vol: 0.035, d: 0.1, s: 0.3 }));
  }
  // bar 7, downbeat: the click – full A major hit with a crash, ringing out
  const th = 7 * BAR;
  both((o) => kick(o, th, 0.7));
  both((o) => voice(o, th, 0.9, { kind: 'noise', f: 22000, vol: 0.18, d: 0.8, s: 0, r: 0.3 }));
  for (const n of ['A2', 'A3', 'C#4', 'E4', 'A4', 'E5']) both((o) => voice(o, th, 0.7, { kind: n === 'A2' ? 'tri' : 'pulse', f: hz(n), duty: 0.25, vol: n === 'A2' ? 0.35 : 0.07, d: 0.4, s: 0.4, r: 0.5, vib: 0.006 }));
  save('chiptune.wav', L, R);
}

// ---------------------------------------------------------------- DOS boot sounds
{
  const ev = JSON.parse(fs.readFileSync(path.join(OUT, 'dos.events.json'), 'utf8'));
  const o = buf(ev.end + 0.5);
  // fan + power hum under everything
  voice(o, 0, ev.end, { kind: 'noise', f: 2500, vol: 0.025, a: 0.2, d: 0.1, s: 1, r: 0.2 });
  voice(o, 0, ev.end, { kind: 'tri', f: 50, vol: 0.05, a: 0.2, d: 0.1, s: 1, r: 0.2 });
  for (const e of ev.events) {
    if (e.kind === 'beep') voice(o, e.t, 0.22, { kind: 'pulse', f: 1000, duty: 0.5, vol: 0.12, a: 0.001, d: 0.01, s: 1, r: 0.005 });
    if (e.kind === 'disk') {
      // spin-up whirr and seek clicks
      voice(o, e.t, 1.1, { kind: 'tri', f: 180, vol: 0.05, a: 0.3, d: 0.1, s: 1, r: 0.3, slide: 0.6 });
      let t = e.t; let seed = 7;
      while (t < e.t + 1.0) { seed = (seed * 16807) % 2147483647; voice(o, t, 0.012, { kind: 'noise', f: 6000, vol: 0.22, d: 0.01, s: 0, r: 0.004 }); t += 0.03 + (seed % 100) / 1000; }
    }
    if (e.kind === 'key') voice(o, e.t, 0.025, { kind: 'noise', f: 12000, vol: 0.2, d: 0.02, s: 0, r: 0.01 });
    if (e.kind === 'enter') { voice(o, e.t, 0.04, { kind: 'noise', f: 7000, vol: 0.3, d: 0.035, s: 0, r: 0.01 }); voice(o, e.t + 0.12, 0.5, { kind: 'noise', f: 6000, vol: 0.12, d: 0.02, s: 0.3, r: 0.1 }); }
  }
  save('dos-sfx.wav', o);
}

// ---------------------------------------------------------------- editor clicks
{
  const ev = JSON.parse(fs.readFileSync(path.join(OUT, '10-editor.events.json'), 'utf8'));
  const o = buf(ev.end + 0.5);
  for (const e of ev.events) {
    if (e.kind === 'key') voice(o, e.t, 0.02, { kind: 'noise', f: 12000, vol: 0.12, d: 0.018, s: 0, r: 0.008 });
    if (e.kind === 'place') {
      voice(o, e.t, 0.012, { kind: 'noise', f: 9000, vol: 0.18, d: 0.01, s: 0, r: 0.004 });   // mouse click
      voice(o, e.t, 0.05, { f: 660 * 2 ** ((e.k % 12) / 24), duty: 0.25, vol: 0.05, d: 0.04, s: 0, r: 0.01 }); // blip
    }
    if (e.kind === 'click') voice(o, e.t, 0.015, { kind: 'noise', f: 9000, vol: 0.3, d: 0.012, s: 0, r: 0.004 });
  }
  save('editor-sfx.wav', o);
}
