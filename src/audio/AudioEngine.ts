// Fully procedural WebAudio engine: cold-gas jets (per nozzle group, spatial, with shock crackle and
// screech), fan whine, motor + inverter whine, road/wind noise, tyre squeal, landing impacts,
// compressor, crowd with cheers/applause, UI clicks. No samples, no licences.
// The graph is built once in start(); update() only moves AudioParams (setTargetAtTime).
import { qrot, v3, type Vec3 } from '../shared/math';
import { ROADSTER } from '../shared/roadster';
import type { TelemetryFrame, VehicleState } from '../shared/types';
import * as M from './model';

export interface ListenerPose { pos: Vec3; forward: Vec3; up: Vec3 }
export interface AudioVolumes { master: number; effects: number; crowd: number; muted: boolean }
type UiSound = 'move' | 'select' | 'back' | 'error';

const VOICE_GROUPS: Array<{ name: string; ids: number[]; level: number; throatD: number }> = [
  { name: 'main', ids: [0, 1, 2, 3], level: 1.0, throatD: 0.065 },
  { name: 'liftFL', ids: [4], level: 0.62, throatD: 0.055 },
  { name: 'liftFR', ids: [5], level: 0.62, throatD: 0.055 },
  { name: 'liftRL', ids: [6], level: 0.62, throatD: 0.055 },
  { name: 'liftRR', ids: [7], level: 0.62, throatD: 0.055 },
  { name: 'yawL', ids: [8], level: 0.38, throatD: 0.025 },
  { name: 'yawR', ids: [9], level: 0.38, throatD: 0.025 },
];

interface JetVoice {
  ids: number[]; level: number; throatD: number; nominal: number;
  out: GainNode; roar: GainNode; hiss: GainNode; crackle: GainNode; screech: GainNode; screechF: BiquadFilterNode;
  roarF: BiquadFilterNode; panner: PannerNode; wasOpen: boolean[]; lastPop: number;
}

export class AudioEngine {
  ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private crowdBus!: GainNode;
  private ui!: GainNode;
  private duckGain!: GainNode;
  private reverbSend!: GainNode;
  private buf!: { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer; crackle: AudioBuffer };
  private jets: JetVoice[] = [];
  private fan!: { out: GainNode; tone: GainNode; whoosh: GainNode; whooshF: BiquadFilterNode; rumble: GainNode; osc: OscillatorNode[]; panner: PannerNode };
  private motor!: { out: GainNode; osc: OscillatorNode[]; inv: OscillatorNode[]; invGain: GainNode; road: GainNode; roadF: BiquadFilterNode; panner: PannerNode };
  private squeal!: { out: GainNode; f: BiquadFilterNode[]; panner: PannerNode };
  private wind!: { out: GainNode; f: BiquadFilterNode; whistle: GainNode; whistleF: BiquadFilterNode };
  private comp!: { out: GainNode; osc: OscillatorNode };
  private crowd!: { bed: GainNode; roar: GainNode; excite: number };
  private volumes: AudioVolumes = { master: 0.8, effects: 1, crowd: 0.7, muted: false };
  private duckAmount = 0;
  private contactEdge = new M.Edge();
  private crashEdge = new M.Edge();
  private airborneFor = 0;
  private lastVy = 0;
  private lastAir = NaN;
  private lastT = NaN;
  private altHigh = 0;
  private startPromise: Promise<boolean> | null = null;

  get running(): boolean { return !!this.ctx && this.ctx.state === 'running'; }

  /** Create/resume the context. Must be called from a user gesture (click/key/touch). */
  start(): Promise<boolean> {
    if (this.ctx) return (this.ctx as AudioContext).resume().then(() => true, () => false);
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return false;
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        this.build();
        await (this.ctx as AudioContext).resume();
        return true;
      } catch { return false; }
    })();
    return this.startPromise;
  }

  /** Start on the first user gesture on `target` (browsers block audio before that). */
  unlockOn(target: Window | HTMLElement = window): () => void {
    const go = () => { this.start(); off(); };
    const off = () => { for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) target.removeEventListener(ev, go); };
    for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) target.addEventListener(ev, go, { once: true, passive: true });
    return off;
  }

  setVolume(v: Partial<AudioVolumes>): void {
    Object.assign(this.volumes, v);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const m = this.volumes.muted ? 0 : this.volumes.master;
    this.master.gain.setTargetAtTime(m * m, t, 0.05); // perceptual (squared) volume curve
    this.sfx.gain.setTargetAtTime(this.volumes.effects ** 2, t, 0.05);
    this.crowdBus.gain.setTargetAtTime(this.volumes.crowd ** 2, t, 0.05);
  }

  /** Lower the world sound (menus, pause, photo mode). 0 = normal, 1 = silent. */
  duck(amount: number, rampS = 0.35): void {
    this.duckAmount = Math.max(0, Math.min(1, amount));
    if (!this.ctx) return;
    this.duckGain.gain.setTargetAtTime(1 - this.duckAmount * 0.92, this.ctx.currentTime, rampS / 3);
  }

  suspend(): void { (this.ctx as AudioContext | null)?.suspend(); }
  resume(): void { (this.ctx as AudioContext | null)?.resume(); }

  /** Use an existing context (e.g. OfflineAudioContext for rendering tests). Builds the graph. */
  attachContext(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    this.build();
  }

  /** Silence all continuous voices (new run / reset). */
  reset(): void {
    this.contactEdge.reset(true); this.crashEdge.reset(false);
    this.airborneFor = 0; this.lastAir = NaN; this.lastT = NaN; this.altHigh = 0;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const j of this.jets) j.out.gain.setTargetAtTime(0, t, 0.02);
  }

  dispose(): void { const c = this.ctx as AudioContext | null; if (c && 'close' in c) c.close(); this.ctx = null; }

  // ------------------------------------------------------------------ per-frame update
  update(state: Readonly<VehicleState>, tel: Readonly<TelemetryFrame>, listener?: ListenerPose): void {
    const ctx = this.ctx;
    if (!ctx || (ctx.state !== 'running' && !(ctx instanceof OfflineAudioContext))) return;
    const now = ctx.currentTime;
    const dt = Number.isFinite(this.lastT) ? Math.max(0, Math.min(0.1, tel.t - this.lastT)) : 0;
    if (tel.t < this.lastT - 0.5) this.reset();
    this.lastT = tel.t;
    const tc = 0.03;

    // listener: given pose, or a default chase position 9 m behind / 3 m above the car
    const L = listener ?? this.defaultListener(state);
    this.setListener(L, now);

    // ---------------------------------------------------------------- jets
    const pr = state.tank.feedPressurePa / ROADSTER.tank.regulatorSetpointPa;
    for (const j of this.jets) {
      let thrust = 0, epr = 0;
      const p = v3();
      for (const id of j.ids) {
        const n = state.nozzles[id];
        thrust += n?.thrustN ?? 0;
        epr = Math.max(epr, n?.exitPressureRatio ?? 0);
        const spec = ROADSTER.nozzles[id];
        p.x += spec.pos.x; p.y += spec.pos.y; p.z += spec.pos.z;
        // valve chatter: a short pop on each opening edge (rate-limited)
        const isOpen = !!n?.open || (tel.thrusterDuty[id] ?? 0) > 0.5;
        if (isOpen && !j.wasOpen[id] && now - j.lastPop > 0.035) { this.valvePop(j, Math.min(1, 0.4 + pr * 0.6)); j.lastPop = now; }
        j.wasOpen[id] = isOpen;
      }
      // fall back to commanded duty if the sim does not report thrust (sandbox / early integration)
      let frac = M.thrustFrac(thrust, j.nominal);
      if (thrust === 0) { let d = 0; for (const id of j.ids) d += tel.thrusterDuty[id] ?? 0; frac = d / j.ids.length * Math.min(1, pr); }
      const g = M.jetGain(frac) * j.level;
      j.out.gain.setTargetAtTime(g, now, frac > 0 ? 0.012 : 0.05);
      j.roar.gain.setTargetAtTime(1.5, now, tc);
      // jet mixing noise peaks near St≈0.2: f ≈ 0.2·U/D (≈ 2 kHz for U≈600 m/s, D≈6 cm)
      j.roarF.frequency.setTargetAtTime(Math.min(4000, (0.2 * 600) / j.throatD) * (0.55 + 0.45 * frac), now, 0.05);
      j.hiss.gain.setTargetAtTime(0.22 + 0.22 * pr, now, tc);
      j.crackle.gain.setTargetAtTime(M.crackleAmount(epr, frac) * 1.3, now, 0.04);
      j.screechF.frequency.setTargetAtTime(M.screechHz(epr, j.throatD), now, 0.08);
      j.screech.gain.setTargetAtTime(frac > 0.3 ? 0.05 * Math.min(1, epr / 3) : 0, now, 0.06);
      v3setScale(p, 1 / j.ids.length);
      this.placePanner(j.panner, state, p, now);
    }

    // ---------------------------------------------------------------- fans
    const rpm = state.fans.rpmNorm;
    const bpf = Math.max(20, M.fanBpfHz(rpm));
    this.fan.osc.forEach((o, i) => o.frequency.setTargetAtTime(bpf * (1 + (i - 1.5) * 0.006), now, 0.08));
    const fg = M.fanGain(rpm, state.fans.powerW);
    this.fan.out.gain.setTargetAtTime(fg * 0.55, now, 0.08);
    this.fan.whooshF.frequency.setTargetAtTime(300 + 2200 * rpm, now, 0.1);
    this.fan.rumble.gain.setTargetAtTime(0.4 * Math.min(1, state.fans.powerW / 80000), now, 0.1);
    this.placePanner(this.fan.panner, state, ROADSTER.fans.centerOfSuction, now);

    // ---------------------------------------------------------------- motor + road
    const mf = Math.max(20, M.motorHz(state.speedMs));
    this.motor.osc.forEach((o, i) => o.frequency.setTargetAtTime(mf * (i === 0 ? 1 : 1.004), now, 0.03));
    this.motor.inv.forEach((o, i) => o.frequency.setTargetAtTime(9200 + (i === 0 ? mf : -mf) * 0.5, now, 0.05));
    const mg = M.motorGain(state.motorPowerW, state.speedMs);
    this.motor.out.gain.setTargetAtTime(mg * 0.32, now, 0.05);
    this.motor.invGain.gain.setTargetAtTime(0.008 * Math.min(1, Math.abs(state.motorPowerW) / 400000), now, 0.05);
    const roadAmt = state.groundContact ? Math.min(1, state.speedMs / 45) : 0;
    this.motor.road.gain.setTargetAtTime(roadAmt * 0.38, now, 0.06);
    this.motor.roadF.frequency.setTargetAtTime(180 + state.speedMs * 22, now, 0.1);
    this.placePanner(this.motor.panner, state, { x: 0, y: -0.2, z: -1.25 }, now);

    // ---------------------------------------------------------------- tyre squeal
    let sq = 0;
    for (const w of state.wheels) sq = Math.max(sq, M.squealAmount(w.slipRatio, w.slipAngleRad, w.contact, state.speedMs));
    this.squeal.out.gain.setTargetAtTime(sq * 0.3, now, 0.04);
    this.placePanner(this.squeal.panner, state, { x: 0, y: -0.4, z: 0 }, now);

    // ---------------------------------------------------------------- wind
    const vy = state.linVel.y;
    const air = Math.hypot(state.linVel.x, state.linVel.y, state.linVel.z);
    const wg = M.windGain(air);
    this.wind.out.gain.setTargetAtTime(wg * 0.5, now, 0.15);
    this.wind.f.frequency.setTargetAtTime(250 + air * 14, now, 0.2);
    this.wind.whistle.gain.setTargetAtTime(Math.max(0, wg - 0.35) * 0.08, now, 0.3);
    this.wind.whistleF.frequency.setTargetAtTime(1800 + air * 20, now, 0.3);

    // ---------------------------------------------------------------- compressor (refill) inferred from rising air mass
    const refilling = Number.isFinite(this.lastAir) && state.tank.airMassKg > this.lastAir + 1e-6 && dt > 0;
    this.lastAir = state.tank.airMassKg;
    this.comp.out.gain.setTargetAtTime(refilling ? 0.12 : 0, now, 0.3);

    // ---------------------------------------------------------------- impacts
    if (!state.groundContact) this.airborneFor += dt;
    if (this.contactEdge.rising(state.groundContact) && this.airborneFor > 0.12) {
      const s = M.impactStrength(this.lastVy);
      if (s > 0.02) this.impact(s);
    }
    if (state.groundContact) this.airborneFor = 0;
    if (this.crashEdge.rising(state.bodyContact || state.crashed)) this.impact(1, true);
    this.lastVy = vy;

    // crowd "ooh" swell during big air
    this.altHigh = tel.altitudeM > 4 ? Math.min(1, this.altHigh + dt * 0.6) : Math.max(0, this.altHigh - dt * 0.4);
    this.crowd.roar.gain.setTargetAtTime(Math.max(this.crowd.excite, this.altHigh * 0.35), now, 0.4);
    this.crowd.excite = Math.max(0, this.crowd.excite - dt * 0.12);
  }

  // ------------------------------------------------------------------ one-shots (public)
  /** Crowd cheer + applause (success, landing). intensity 0..1. */
  cheer(intensity = 1): void {
    const ctx = this.ctx; if (!ctx) return;
    const now = ctx.currentTime;
    const i = Math.max(0.2, Math.min(1, intensity));
    this.crowd.excite = i;
    this.crowd.roar.gain.cancelScheduledValues(now);
    this.crowd.roar.gain.setTargetAtTime(i, now, 0.35);
    // applause: dense filtered clap bursts with a rising-then-falling density
    const dur = 3.5 + 2.5 * i;
    const claps = Math.round(220 * i);
    for (let k = 0; k < claps; k++) {
      const u = Math.random();
      const t = now + 0.15 + dur * (u < 0.7 ? Math.random() * 0.55 : 0.55 + Math.random() * 0.45);
      this.clap(t, 0.04 + Math.random() * 0.06 * i);
    }
    // whistles
    for (let k = 0; k < Math.round(4 * i); k++) this.whistle(now + 0.3 + Math.random() * 2.2, i);
  }

  /** Landing / crash impact (also triggered automatically from contact edges). */
  impact(strength: number, crash = false): void {
    const ctx = this.ctx; if (!ctx) return;
    const now = ctx.currentTime, s = Math.max(0, Math.min(1, strength));
    // body thump: falling sine
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(95 - 25 * s, now); o.frequency.exponentialRampToValueAtTime(34, now + 0.35);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.0001, now); og.gain.exponentialRampToValueAtTime(0.9 * s + 0.15, now + 0.008); og.gain.exponentialRampToValueAtTime(0.0001, now + 0.5 + 0.3 * s);
    o.connect(og).connect(this.sfxIn()); o.start(now); o.stop(now + 1);
    // suspension / tyre slap: brown noise burst
    const n = this.noise(this.buf.brown, false);
    const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 380 + 600 * s;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.0001, now); ng.gain.exponentialRampToValueAtTime(0.8 * s + 0.1, now + 0.01); ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.3 + 0.2 * s);
    n.connect(nf).connect(ng).connect(this.sfxIn()); n.start(now, Math.random() * 2); n.stop(now + 0.8);
    // metallic clank (chassis, bump stops)
    if (s > 0.25 || crash) {
      const w = this.noise(this.buf.white, false);
      const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.0001, now); g2.gain.exponentialRampToValueAtTime((crash ? 0.5 : 0.18) * s + 0.02, now + 0.004); g2.gain.exponentialRampToValueAtTime(0.0001, now + (crash ? 0.6 : 0.22));
      for (const [f, q] of [[740, 9], [1630, 14], [2890, 18]] as const) {
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * (0.95 + Math.random() * 0.1); bp.Q.value = q;
        w.connect(bp).connect(g2);
      }
      g2.connect(this.sfxIn()); w.start(now); w.stop(now + 0.7);
    }
  }

  playUi(kind: UiSound): void {
    const ctx = this.ctx; if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const [f0, f1, dur, lvl] = kind === 'select' ? [880, 1320, 0.09, 0.16] : kind === 'back' ? [660, 440, 0.08, 0.12] : kind === 'error' ? [220, 180, 0.15, 0.15] : [1400, 1500, 0.035, 0.07];
    const o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(f0, now); o.frequency.exponentialRampToValueAtTime(f1, now + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(lvl, now + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.05);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 5000;
    o.connect(f).connect(g).connect(this.ui); o.start(now); o.stop(now + dur + 0.1);
  }

  // ------------------------------------------------------------------ graph construction
  private build(): void {
    const ctx = this.ctx!;
    this.buf = { white: whiteNoise(ctx, 6), pink: pinkNoise(ctx, 6), brown: brownNoise(ctx, 6), crackle: crackleNoise(ctx, 5) };

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12; limiter.knee.value = 10; limiter.ratio.value = 4; limiter.attack.value = 0.004; limiter.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.connect(limiter).connect(ctx.destination);
    this.duckGain = ctx.createGain(); this.duckGain.connect(this.master);
    this.sfx = ctx.createGain(); this.sfx.connect(this.duckGain);
    this.crowdBus = ctx.createGain(); this.crowdBus.connect(this.duckGain);
    this.ui = ctx.createGain(); this.ui.connect(this.master);
    // open-air reverb (pad + grandstands): generated impulse response
    const conv = ctx.createConvolver(); conv.buffer = reverbIR(ctx, 2.4, 2.6);
    this.reverbSend = ctx.createGain(); this.reverbSend.gain.value = 0.22;
    this.reverbSend.connect(conv).connect(this.duckGain);
    this.sfx.connect(this.reverbSend);
    this.setVolume({});

    // ---- jets
    this.jets = VOICE_GROUPS.map((g) => {
      const out = ctx.createGain(); out.gain.value = 0;
      const panner = this.panner();
      out.connect(panner).connect(this.sfx);
      // roar: pink noise, broad band, follows thrust
      const roarF = ctx.createBiquadFilter(); roarF.type = 'bandpass'; roarF.frequency.value = 1200; roarF.Q.value = 0.42;
      const roarLow = ctx.createBiquadFilter(); roarLow.type = 'lowshelf'; roarLow.frequency.value = 180; roarLow.gain.value = 5;
      const roar = ctx.createGain();
      const p = this.noise(this.buf.pink); p.connect(roarF).connect(roarLow).connect(roar).connect(out);
      // hiss: white noise, high band with a presence peak (the "tearing" sound of a choked jet)
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2800; hp.Q.value = 0.5;
      const pk = ctx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 4600; pk.Q.value = 0.8; pk.gain.value = 3;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000; lp.Q.value = 0.5;
      const hiss = ctx.createGain();
      const w = this.noise(this.buf.white); w.connect(hp).connect(pk).connect(lp).connect(hiss).connect(out);
      // screech: narrow resonance at the shock-cell feedback frequency
      const screechF = ctx.createBiquadFilter(); screechF.type = 'bandpass'; screechF.frequency.value = 5000; screechF.Q.value = 38;
      const screech = ctx.createGain(); screech.gain.value = 0;
      w.connect(screechF).connect(screech).connect(out);
      // crackle: sparse positive-skew shock pops
      const ch = ctx.createBiquadFilter(); ch.type = 'highpass'; ch.frequency.value = 900;
      const crackle = ctx.createGain(); crackle.gain.value = 0;
      const cl = ctx.createBiquadFilter(); cl.type = 'lowpass'; cl.frequency.value = 6500; cl.Q.value = 0.6;
      const c = this.noise(this.buf.crackle); c.connect(ch).connect(cl).connect(crackle).connect(out);
      const nominal = g.ids.reduce((a, id) => a + ROADSTER.nozzles[id].nominalThrustN, 0);
      return { ids: g.ids, level: g.level, throatD: g.throatD, nominal, out, roar, hiss, crackle, screech, screechF, roarF, panner, wasOpen: [], lastPop: 0 };
    });

    // ---- fans: 4 slightly detuned blade-pass tones with rich harmonics + flow noise + rumble
    {
      const out = ctx.createGain(); out.gain.value = 0;
      const panner = this.panner(); out.connect(panner).connect(this.sfx);
      const wave = ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0, 0, 0]), new Float32Array([0, 1, 0.42, 0.22, 0.1, 0.05]));
      const tone = ctx.createGain(); tone.gain.value = 0.16;
      const toneBp = ctx.createBiquadFilter(); toneBp.type = 'bandpass'; toneBp.frequency.value = 2600; toneBp.Q.value = 0.4;
      const osc: OscillatorNode[] = [];
      for (let i = 0; i < 4; i++) { const o = ctx.createOscillator(); o.setPeriodicWave(wave); o.frequency.value = 20; o.connect(tone); o.start(); osc.push(o); }
      // slow AM wobble (turbulence, blade loading)
      const lfo = ctx.createOscillator(); lfo.frequency.value = 2.7; const lfoG = ctx.createGain(); lfoG.gain.value = 0.04; lfo.connect(lfoG).connect(tone.gain); lfo.start();
      tone.connect(toneBp).connect(out);
      const whooshF = ctx.createBiquadFilter(); whooshF.type = 'bandpass'; whooshF.Q.value = 0.7; whooshF.frequency.value = 500;
      const whoosh = ctx.createGain(); whoosh.gain.value = 0.55;
      this.noise(this.buf.pink).connect(whooshF).connect(whoosh).connect(out);
      const rl = ctx.createBiquadFilter(); rl.type = 'lowpass'; rl.frequency.value = 160;
      const rumble = ctx.createGain(); rumble.gain.value = 0;
      this.noise(this.buf.brown).connect(rl).connect(rumble).connect(out);
      this.fan = { out, tone, whoosh, whooshF, rumble, osc, panner };
    }

    // ---- motor: electrical orders (1, 2, 6, 12, 18) + inverter carrier sidebands + road noise
    {
      const out = ctx.createGain(); out.gain.value = 0;
      const panner = this.panner(); out.connect(panner).connect(this.sfx);
      const im = new Float32Array(20); im[1] = 1; im[2] = 0.25; im[6] = 0.55; im[12] = 0.3; im[18] = 0.12;
      const wave = ctx.createPeriodicWave(new Float32Array(20), im);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 70;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
      const osc: OscillatorNode[] = [];
      for (let i = 0; i < 2; i++) { const o = ctx.createOscillator(); o.setPeriodicWave(wave); o.frequency.value = 20; o.connect(hp); o.start(); osc.push(o); }
      hp.connect(lp).connect(out);
      const invGain = ctx.createGain(); invGain.gain.value = 0;
      const inv: OscillatorNode[] = [];
      for (let i = 0; i < 2; i++) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 9200; o.connect(invGain); o.start(); inv.push(o); }
      invGain.connect(panner);
      const roadF = ctx.createBiquadFilter(); roadF.type = 'lowpass'; roadF.frequency.value = 300; roadF.Q.value = 0.3;
      const road = ctx.createGain(); road.gain.value = 0;
      this.noise(this.buf.pink).connect(roadF).connect(road).connect(panner);
      this.motor = { out, osc, inv, invGain, road, roadF, panner };
    }

    // ---- tyre squeal: resonant bands with jittering pitch
    {
      const out = ctx.createGain(); out.gain.value = 0;
      const panner = this.panner(); out.connect(panner).connect(this.sfx);
      const src = this.noise(this.buf.white);
      const f: BiquadFilterNode[] = [];
      for (const [freq, q, lfoHz] of [[930, 22, 5.3], [1390, 26, 7.1], [2280, 30, 3.7]] as const) {
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
        const lfo = ctx.createOscillator(); lfo.frequency.value = lfoHz; const lg = ctx.createGain(); lg.gain.value = freq * 0.03;
        lfo.connect(lg).connect(bp.frequency); lfo.start();
        src.connect(bp).connect(out); f.push(bp);
      }
      this.squeal = { out, f, panner };
    }

    // ---- wind (head-locked, not spatial)
    {
      const out = ctx.createGain(); out.gain.value = 0; out.connect(this.sfx);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.45; f.frequency.value = 400;
      const gust = ctx.createOscillator(); gust.frequency.value = 0.23; const gg = ctx.createGain(); gg.gain.value = 0.18;
      const base = ctx.createGain(); base.gain.value = 0.82;
      gust.connect(gg).connect(base.gain); gust.start();
      this.noise(this.buf.pink).connect(f).connect(base).connect(out);
      const whistleF = ctx.createBiquadFilter(); whistleF.type = 'bandpass'; whistleF.Q.value = 14; whistleF.frequency.value = 2000;
      const whistle = ctx.createGain(); whistle.gain.value = 0;
      this.noise(this.buf.white).connect(whistleF).connect(whistle).connect(out);
      this.wind = { out, f, whistle, whistleF };
    }

    // ---- compressor hum
    {
      const out = ctx.createGain(); out.gain.value = 0; out.connect(this.sfx);
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 49;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
      o.connect(lp).connect(out); o.start();
      const rattleF = ctx.createBiquadFilter(); rattleF.type = 'bandpass'; rattleF.frequency.value = 1300; rattleF.Q.value = 2;
      const rattle = ctx.createGain(); rattle.gain.value = 0.25;
      const am = ctx.createOscillator(); am.frequency.value = 24.5; const amg = ctx.createGain(); amg.gain.value = 0.25; am.connect(amg).connect(rattle.gain); am.start();
      this.noise(this.buf.white).connect(rattleF).connect(rattle).connect(out);
      this.comp = { out, osc: o };
    }

    // ---- crowd: murmur bed (3 formant bands, slow AM) + excitement roar
    {
      const pan = ctx.createStereoPanner(); pan.pan.value = -0.35; pan.connect(this.crowdBus);
      const bed = ctx.createGain(); bed.gain.value = 0.05; bed.connect(pan);
      const roar = ctx.createGain(); roar.gain.value = 0; roar.connect(pan);
      for (const [f, q, rate] of [[420, 1.3, 0.13], [1050, 1.6, 0.21], [2500, 2.2, 0.37]] as const) {
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
        const am = ctx.createGain(); am.gain.value = 0.7;
        const lfo = ctx.createOscillator(); lfo.frequency.value = rate; const lg = ctx.createGain(); lg.gain.value = 0.3; lfo.connect(lg).connect(am.gain); lfo.start();
        this.noise(this.buf.pink).connect(bp).connect(am);
        am.connect(bed);
        const am2 = ctx.createGain(); am2.gain.value = f > 2000 ? 0.5 : 1;
        am.connect(am2).connect(roar);
      }
      this.crowd = { bed, roar, excite: 0 };
    }
  }

  // ------------------------------------------------------------------ helpers
  private sfxIn(): AudioNode { return this.sfx; }

  private noise(buf: AudioBuffer, loop = true): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = buf; s.loop = loop;
    if (loop) s.start(0, Math.random() * buf.duration);
    return s;
  }

  private panner(): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 4; p.rolloffFactor = 0.9; p.maxDistance = 600;
    return p;
  }

  private placePanner(p: PannerNode, state: Readonly<VehicleState>, local: Vec3, now: number): void {
    const w = qrot(state.quat, local);
    const x = state.pos.x + w.x, y = state.pos.y + w.y, z = state.pos.z + w.z;
    if (p.positionX) {
      p.positionX.setTargetAtTime(x, now, 0.02); p.positionY.setTargetAtTime(y, now, 0.02); p.positionZ.setTargetAtTime(z, now, 0.02);
    } else p.setPosition(x, y, z);
  }

  private defaultListener(state: Readonly<VehicleState>): ListenerPose {
    const f = qrot(state.quat, { x: 0, y: 0, z: 1 });
    const h = Math.hypot(f.x, f.z) || 1;
    const fx = f.x / h, fz = f.z / h;
    return { pos: { x: state.pos.x - fx * 9, y: state.pos.y + 3, z: state.pos.z - fz * 9 }, forward: { x: fx, y: -0.25, z: fz }, up: { x: 0, y: 1, z: 0 } };
  }

  private setListener(L: ListenerPose, now: number): void {
    const l = this.ctx!.listener;
    if (l.positionX) {
      l.positionX.setTargetAtTime(L.pos.x, now, 0.02); l.positionY.setTargetAtTime(L.pos.y, now, 0.02); l.positionZ.setTargetAtTime(L.pos.z, now, 0.02);
      l.forwardX.setTargetAtTime(L.forward.x, now, 0.02); l.forwardY.setTargetAtTime(L.forward.y, now, 0.02); l.forwardZ.setTargetAtTime(L.forward.z, now, 0.02);
      l.upX.setTargetAtTime(L.up.x, now, 0.02); l.upY.setTargetAtTime(L.up.y, now, 0.02); l.upZ.setTargetAtTime(L.up.z, now, 0.02);
    } else {
      l.setPosition(L.pos.x, L.pos.y, L.pos.z);
      l.setOrientation(L.forward.x, L.forward.y, L.forward.z, L.up.x, L.up.y, L.up.z);
    }
  }

  private valvePop(j: JetVoice, level: number): void {
    const ctx = this.ctx!, now = ctx.currentTime;
    const n = this.noise(this.buf.white, false);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1600 + Math.random() * 900; bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.22 * level * j.level, now + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
    n.connect(bp).connect(g).connect(j.panner);
    n.start(now, Math.random() * 3); n.stop(now + 0.08);
  }

  private clap(t: number, lvl: number): void {
    const ctx = this.ctx!;
    const n = this.noise(this.buf.white, false);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900 + Math.random() * 1600; bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(lvl, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03 + Math.random() * 0.03);
    const p = ctx.createStereoPanner(); p.pan.value = -0.9 + Math.random() * 1.1;
    n.connect(bp).connect(g).connect(p).connect(this.crowdBus);
    n.start(t, Math.random() * 5); n.stop(t + 0.1);
  }

  private whistle(t: number, i: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = 'sine';
    const f0 = 1900 + Math.random() * 900, up = Math.random() < 0.5;
    const d = 0.35 + Math.random() * 0.6;
    o.frequency.setValueAtTime(up ? f0 : f0 * 1.35, t);
    o.frequency.exponentialRampToValueAtTime(up ? f0 * 1.35 : f0 * 0.95, t + d);
    const vib = ctx.createOscillator(); vib.frequency.value = 6 + Math.random() * 3; const vg = ctx.createGain(); vg.gain.value = 25; vib.connect(vg).connect(o.frequency);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.035 * i, t + 0.04); g.gain.setTargetAtTime(0.0001, t + d - 0.08, 0.04);
    const p = ctx.createStereoPanner(); p.pan.value = -0.8 + Math.random() * 0.9;
    o.connect(g).connect(p).connect(this.crowdBus);
    o.start(t); vib.start(t); o.stop(t + d + 0.3); vib.stop(t + d + 0.3);
  }
}

function v3setScale(v: Vec3, s: number): void { v.x *= s; v.y *= s; v.z *= s; }

// ------------------------------------------------------------------ noise generators (deterministic seed)
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function whiteNoise(ctx: BaseAudioContext, sec: number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
  const d = b.getChannelData(0), r = rng(1);
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  return b;
}

/** Paul Kellet's refined pink filter. */
function pinkNoise(ctx: BaseAudioContext, sec: number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
  const d = b.getChannelData(0), r = rng(2);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return b;
}

function brownNoise(ctx: BaseAudioContext, sec: number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
  const d = b.getChannelData(0), r = rng(3);
  let last = 0;
  for (let i = 0; i < d.length; i++) { last = (last + 0.02 * (r() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
  return b;
}

/**
 * Jet crackle: Poisson-distributed, positively skewed pressure spikes (fast rise, short exponential decay)
 * as measured in supersonic jet noise (Ffowcs Williams et al.). Mean rate ~ 140/s, Pareto-like amplitudes.
 */
function crackleNoise(ctx: BaseAudioContext, sec: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const b = ctx.createBuffer(1, Math.floor(sr * sec), sr);
  const d = b.getChannelData(0), r = rng(4);
  let t = 0;
  while (true) {
    t += -Math.log(1 - r()) / 140;
    const i0 = Math.floor(t * sr);
    if (i0 >= d.length - 400) break;
    const amp = Math.min(1, 0.12 / Math.pow(1 - r() * 0.985, 0.7));
    const decay = 0.00025 + r() * 0.0006;
    for (let k = 0; k < 400; k++) {
      const x = k / sr;
      d[i0 + k] += amp * (k < 3 ? k / 3 : 1) * Math.exp(-x / decay) - amp * 0.18 * Math.exp(-x / (decay * 4));
    }
  }
  return b;
}

/** Stereo decorrelated exponential-decay impulse response with early reflections from the stands. */
function reverbIR(ctx: BaseAudioContext, sec: number, decay: number): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(sr * sec);
  const b = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch), r = rng(10 + ch);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.pow(1 - t / sec, decay) * (t < 0.012 ? t / 0.012 : 1);
      d[i] = (r() * 2 - 1) * env * 0.45;
    }
    for (const [tt, a] of [[0.043, 0.5], [0.071, 0.35], [0.118, 0.28], [0.19, 0.2]]) {
      const i = Math.floor((tt + ch * 0.004) * sr); if (i < n) d[i] += a;
    }
  }
  return b;
}
