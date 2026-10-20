// Offline rendering of the procedural mix for a sequence of frames (tests, report, tuning).
import type { TelemetryFrame, VehicleState } from '../shared/types';
import { AudioEngine } from './AudioEngine';

export interface OfflineFrame { state: VehicleState; tel: TelemetryFrame }

/**
 * Render `frames` (spaced 1/fps) through a fresh AudioEngine into a stereo buffer. Uses
 * OfflineAudioContext.suspend() to apply each frame's update at its exact time.
 */
export async function renderOffline(frames: OfflineFrame[], fps = 30, opts: { sampleRate?: number; cheerAt?: number } = {}): Promise<AudioBuffer> {
  const sr = opts.sampleRate ?? 44100;
  const dur = frames.length / fps + 0.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);
  const eng = new AudioEngine();
  eng.attachContext(ctx);
  eng.setVolume({ master: 0.9, effects: 1, crowd: 0.8, muted: false });
  frames.forEach((f, i) => {
    const t = i / fps;
    ctx.suspend(t).then(() => {
      eng.update(f.state, f.tel);
      if (opts.cheerAt !== undefined && Math.abs(t - opts.cheerAt) < 0.5 / fps) eng.cheer(1);
      ctx.resume();
    });
  });
  return ctx.startRendering();
}

/** 16-bit PCM WAV encoder. */
export function toWav(buf: AudioBuffer): ArrayBuffer {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const out = new ArrayBuffer(44 + n * ch * 2);
  const v = new DataView(out);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, data[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return out;
}
