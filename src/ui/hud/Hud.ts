// Stream-style HUD: one DPR-aware canvas, redrawn per update() with transforms only
// (no DOM changes per frame). Layout measured from the Tesla stream at 1920x1080 and scaled
// by viewport height (see gaugeMath.ts).
import type { AssistLevel, StuntId, TelemetryFrame, VehicleState } from '../../shared/types';
import { ROADSTER } from '../../shared/roadster';
import { DISPLAY_FONT, loadFonts } from '../fonts';
import { AERO_LABEL, ASSIST_LABEL, FAN_LABEL, airWarning, phaseLabel, stuntInfo } from '../labels';
import { getLocale, t, upper } from '../../i18n';
import * as U from '../units';
import { ARC_SWEEP_DEG, LAYOUT, REF_H, SCALES, fillAngleRad, follow, fraction, hudScale } from './gaugeMath';
import { CAR_FACES, HeadingTracker, SPHERE_CAMERA, paintMesh, removeYaw } from './carModel';
import { drawNozzles, drawTopViewArt } from './topView';
import { drawDamageView } from './damageView';
import type { DamageState } from '../../shared/damage';
import { drawTimerText, timerWidth } from './timerDigits';
import { ZeroSixtyWatch } from './stopwatch';
import '../ui.css';

export type HudLayout = 'flight' | 'ramp';

export interface HudContext {
  mode: 'auto' | 'manual';
  stunt?: StuntId;
  assist?: AssistLevel;
  units: U.Units;
  /** Force a layout; default derives it from stunt, contact and attitude. */
  layout?: HudLayout;
  /** Explicit 0-60 timer value (s). If omitted, the zero60 stunt runs its own timer from speed. */
  timerS?: number | null;
  /** Launch time (telemetry clock) of the running stunt phase, so the zero60 timer starts exactly there. */
  timerT0?: number;
  /** HUD scale multiplier from settings (0.5..2). */
  scale?: number;
  /** Show the extra (non-stream) panels. */
  extras?: boolean;
  /** Bindings of the reset control (keyboard · gamepad · touch) for the "destroyed" banner. */
  resetHint?: string;
}

const COLORS = {
  track: 'rgb(60,60,60)',
  fill: '#ffffff',
  label: 'rgb(178,178,178)',
  unit: 'rgb(160,160,160)',
  value: '#ffffff',
  sphere: 'rgb(58,58,58)',
  disk: 'rgb(98,98,98)',
  warn: '#ff4b3e',
};


/** HUD colour of the manual control level: ASSIST green, STABILIZED amber, RAW red. */
const ASSIST_COLOR: Record<AssistLevel, string> = { ASSIST: '#62d68c', STABILIZED: '#ffb53d', RAW: COLORS.warn };

interface RingAnim { g: number; alt: number; df: number; pitch: number }

export class Hud {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private flashEl: HTMLDivElement;
  /** Total loss (vehicle damage "Full"): persistent "Destroyed – reset" banner. */
  private destroyedEl: HTMLDivElement;
  private destroyedKey = '';
  private art: HTMLCanvasElement = document.createElement('canvas');
  private panel: HTMLCanvasElement = document.createElement('canvas');
  private ro: ResizeObserver;
  private cssW = 1920; private cssH = 1080; private dpr = 1; private s = 1; private userScale = 1;
  private visible = true;
  private anim: RingAnim = { g: NaN, alt: NaN, df: NaN, pitch: NaN };
  private rampMix = 0;
  private lastT = NaN;
  private lastWall = NaN;
  private snapLayout = true;
  private heading = new HeadingTracker();
  private text = { g: '', alt: '', df: '', pitch: '', altUnit: 'FT', at: -1 };
  private readonly timer = new ZeroSixtyWatch();
  private lastStunt: StuntId | undefined;
  private fontsReady = false;
  private flashTimer = 0;

  constructor(private root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'rft-hud';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'rft-hud-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'rft-flash';
    this.flashEl.setAttribute('role', 'status');
    this.flashEl.setAttribute('aria-live', 'polite');
    this.destroyedEl = document.createElement('div');
    this.destroyedEl.className = 'rft-destroyed';
    this.destroyedEl.setAttribute('role', 'alert');
    this.destroyedEl.hidden = true;
    this.el.append(this.canvas, this.flashEl, this.destroyedEl);
    root.appendChild(this.el);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.resize();
    loadFonts().then(() => { this.fontsReady = true; this.resize(); });
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.visibility = v ? 'visible' : 'hidden';
  }
  isVisible(): boolean { return this.visible; }

  /** Centered broadcast-style message ("SUCCESS", "FANS SUCTION"). */
  flash(message: string, kind: 'info' | 'success' | 'warn' = 'info', ms = 2200): void {
    this.flashEl.textContent = message;
    this.flashEl.dataset.kind = kind;
    this.flashEl.classList.remove('show');
    void this.flashEl.offsetWidth; // restart the CSS animation (once per flash, not per frame)
    this.flashEl.classList.add('show');
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.flashEl.classList.remove('show'), ms);
  }

  /** Reset internal filters/timers (new run). */
  reset(): void {
    this.anim = { g: NaN, alt: NaN, df: NaN, pitch: NaN };
    this.heading.reset();
    this.timer.reset();
    this.lastT = NaN;
    this.snapLayout = true;
  }

  dispose(): void { this.ro.disconnect(); this.el.remove(); clearTimeout(this.flashTimer); }

  // ------------------------------------------------------------------ frame update
  update(tel: TelemetryFrame, state: Readonly<VehicleState>, ctx: HudContext): void {
    if (!this.visible) return;
    // UI animation runs on wall-clock time (works while the sim is paused or in slow motion)
    const now = performance.now();
    const dt = Number.isFinite(this.lastWall) ? Math.min(0.1, Math.max(0, (now - this.lastWall) / 1000)) : 1 / 60;
    this.lastWall = now;
    if (tel.t < this.lastT - 0.5 || ctx.stunt !== this.lastStunt) this.reset();
    this.lastT = tel.t; this.lastStunt = ctx.stunt;
    if ((ctx.scale ?? 1) !== this.userScale) { this.userScale = ctx.scale ?? 1; this.resize(); }

    // ring smoothing (telemetry g is already 10 Hz low-passed; this only removes frame jitter)
    const a = this.anim, tau = 0.05;
    a.g = follow(a.g, fraction(tel.gForce, SCALES.gForce), dt, tau);
    a.alt = follow(a.alt, fraction(tel.altitudeM, SCALES.altitudeM), dt, tau);
    a.df = follow(a.df, fraction(tel.downforceKg, SCALES.downforceKg), dt, tau);
    a.pitch = follow(a.pitch, fraction(Math.abs(tel.pitchDeg), SCALES.pitchDeg), dt, tau);

    const layout = ctx.layout ?? this.deriveLayout(tel, state, ctx);
    this.rampMix = this.snapLayout ? (layout === 'ramp' ? 1 : 0) : follow(this.rampMix, layout === 'ramp' ? 1 : 0, dt, 0.12);
    this.snapLayout = false;
    if (Math.abs(this.rampMix - (layout === 'ramp' ? 1 : 0)) < 0.002) this.rampMix = layout === 'ramp' ? 1 : 0;

    // numbers refresh at ~20 Hz like a broadcast graphic (readable, no flicker)
    if (tel.t - this.text.at >= 0.05 || tel.t < this.text.at) {
      const alt = U.altitude(tel.altitudeM, ctx.units);
      this.text = { g: U.gForce(tel.gForce).value, alt: alt.value, altUnit: alt.unit, df: U.downforce(tel.downforceKg).value, pitch: U.pitch(Math.abs(tel.pitchDeg)).value, at: tel.t };
    }

    const timerValue = this.updateTimer(tel, ctx);
    this.draw(tel, state, ctx, timerValue);
    this.updateDestroyed(!!state.damage?.totalLoss, ctx.resetHint ?? '');
  }

  /** "Destroyed – reset" banner while the car is a total loss (DOM, so it stays crisp and is announced). */
  private updateDestroyed(on: boolean, hint: string): void {
    if (this.destroyedEl.hidden === !on && (!on || this.destroyedKey === hint + getLocale())) return;
    this.destroyedEl.hidden = !on;
    if (!on) return;
    this.destroyedKey = hint + getLocale();
    const b = document.createElement('b'), sp = document.createElement('span');
    b.textContent = upper(t('damage.destroyed'));
    sp.textContent = t('damage.resetHint', { keys: hint });
    this.destroyedEl.replaceChildren(b, sp);
  }

  private deriveLayout(tel: TelemetryFrame, state: Readonly<VehicleState>, ctx: HudContext): HudLayout {
    if (ctx.stunt === 'ramp_hang') return 'ramp';
    if (ctx.stunt === 'ramp_launch') return state.groundContact && tel.altitudeM > 0.3 ? 'ramp' : (this.rampMix > 0.5 && state.groundContact ? 'ramp' : 'flight');
    // manual: on a wall with the fans sucking
    if (state.groundContact && state.fans.mode === 'grip' && Math.abs(tel.pitchDeg) > 20) return 'ramp';
    return 'flight';
  }

  private updateTimer(tel: TelemetryFrame, ctx: HudContext): number | null {
    if (ctx.timerS !== undefined) return ctx.timerS;
    if (ctx.stunt !== 'zero60') return null;
    return this.timer.update(tel.t, tel.speedMs, tel.phase, ctx.timerT0);
  }

  // ------------------------------------------------------------------ layout
  private resize(): void {
    const r = this.el.getBoundingClientRect();
    this.cssW = Math.max(1, r.width || this.root.clientWidth || window.innerWidth);
    this.cssH = Math.max(1, r.height || this.root.clientHeight || window.innerHeight);
    this.dpr = Math.min(window.devicePixelRatio || 1, this.cssW > 2600 ? 1.5 : 2);
    this.s = hudScale(this.cssW, this.cssH) * this.userScale;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    // pre-render static art (top view line drawing)
    const s = this.s;
    const w = Math.ceil(170 * s), h = Math.ceil(190 * s);
    this.art.width = Math.ceil(w * this.dpr); this.art.height = Math.ceil(h * this.dpr);
    const actx = this.art.getContext('2d')!;
    actx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    actx.clearRect(0, 0, w, h);
    drawTopViewArt(actx, w / 2, h / 2, s);
    this.renderPanel();
  }

  /** Reference-px anchor helpers. */
  private fromLeft(xRef: number): number { return xRef * this.s; }
  private fromRight(xRef: number): number { return this.cssW - (1920 - xRef) * this.s; }
  private rowY(): number { return this.cssH - (REF_H - LAYOUT.ringY) * this.s; }

  // ------------------------------------------------------------------ drawing
  private draw(tel: TelemetryFrame, state: Readonly<VehicleState>, ctx: HudContext, timer: number | null): void {
    const c = this.ctx, s = this.s;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.cssW, this.cssH);
    if (!this.fontsReady) return;

    const y = this.rowY();
    const xL = this.fromLeft(LAYOUT.leftRingX), xS = this.fromLeft(LAYOUT.sphereX);
    const xT = this.fromRight(LAYOUT.topViewX), xR = this.fromRight(LAYOUT.rightRingX);
    const m = this.rampMix;

    this.drawPanels(y);

    // left ring: G-FORCE (flight) <-> DOWNFORCE (ramp)
    this.drawTrack(xL, y);
    if (m < 1) this.drawRing(xL, y, this.anim.g, 'G-FORCE', this.text.g, 'G', 1 - m);
    if (m > 0) this.drawRing(xL, y, this.anim.df, 'DOWNFORCE', this.text.df, 'KG', m);

    this.drawSphere(xS, y, state);

    // right: top view (flight) <-> PITCH ring (ramp)
    if (m < 1) {
      const aw = this.art.width / this.dpr, ah = this.art.height / this.dpr;
      c.globalAlpha = 1 - m;
      c.drawImage(this.art, xT - aw / 2, y - 9 * s - ah / 2, aw, ah);
      c.globalAlpha = 1;
      drawNozzles(c, xT, y - 9 * s, s, tel.thrusterDuty, 1 - m);
    }
    if (m > 0) { this.drawTrack(xT, y, m); this.drawRing(xT, y, this.anim.pitch, 'PITCH', this.text.pitch, 'DEG', m); }

    this.drawTrack(xR, y);
    this.drawRing(xR, y, this.anim.alt, 'ALTITUDE', this.text.alt, this.text.altUnit, 1);

    if (timer !== null) this.drawTimer(timer);
    const aw = airWarning(tel.phase);
    if (ctx.extras !== false) this.drawExtras(tel, state, ctx, aw !== null);
    if (aw) this.drawAirWarning(aw);
  }

  /** Soft dark backing behind each group (the stream keys its HUD over a subtle vignette). Pre-rendered on resize. */
  private drawPanels(y: number): void {
    const c = this.ctx;
    const pw = this.panel.width / this.dpr, ph = this.panel.height / this.dpr;
    const top = y + 130 * this.s - ph;
    c.drawImage(this.panel, -pw * 0.08, top, pw, ph);
    c.save();
    c.translate(this.cssW, 0); c.scale(-1, 1);
    c.drawImage(this.panel, -pw * 0.08, top, pw, ph);
    c.restore();
  }

  private renderPanel(): void {
    const s = this.s, w = 560 * s, h = 300 * s, blur = 38 * s;
    this.panel.width = Math.ceil(w * this.dpr); this.panel.height = Math.ceil(h * this.dpr);
    const p = this.panel.getContext('2d')!;
    p.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    p.clearRect(0, 0, w, h);
    if ('filter' in (p as object)) {
      p.filter = `blur(${blur.toFixed(1)}px)`;
      p.fillStyle = 'rgba(0,0,0,0.38)';
      p.beginPath(); p.roundRect(0, blur * 1.6, w - blur * 1.6, h, 28 * s); p.fill();
      p.filter = 'none';
    } else {
      // no canvas filter (older Safari): soft radial falloff instead of a blurred box
      const g = p.createRadialGradient(0, h, 0, 0, h, Math.max(w, h));
      g.addColorStop(0, 'rgba(0,0,0,0.34)'); g.addColorStop(0.6, 'rgba(0,0,0,0.18)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      p.fillStyle = g; p.fillRect(0, 0, w, h);
    }
  }

  private drawTrack(x: number, y: number, alpha = 1): void {
    const c = this.ctx, s = this.s, r = LAYOUT.ringR * s;
    c.save();
    c.globalAlpha = alpha;
    c.lineWidth = LAYOUT.ringStroke * s;
    c.lineCap = 'round';
    c.strokeStyle = COLORS.track;
    c.beginPath(); c.arc(x, y, r, fillAngleRad(0), fillAngleRad(1)); c.stroke();
    this.endTick(x, y, 1, COLORS.track);
    c.restore();
  }

  /** Small inward hook at an arc end (stream detail). */
  private endTick(x: number, y: number, f: number, color: string): void {
    const c = this.ctx, s = this.s, r = LAYOUT.ringR * s;
    const a = fillAngleRad(f);
    const ca = Math.cos(a), sa = Math.sin(a);
    // stream detail: a short foot pointing horizontally toward the gauge centre
    const dir = f < 0.5 ? 1 : -1;
    c.strokeStyle = color;
    c.beginPath();
    c.moveTo(x + ca * r, y + sa * r);
    c.lineTo(x + ca * r + dir * 6.5 * s, y + sa * r + 1.2 * s);
    c.stroke();
  }

  private drawRing(x: number, y: number, f: number, label: string, value: string, unit: string, alpha: number): void {
    const c = this.ctx, s = this.s, r = LAYOUT.ringR * s;
    c.save();
    c.globalAlpha = alpha;
    c.lineCap = 'round';
    c.lineWidth = LAYOUT.ringStroke * s;
    const ff = Number.isFinite(f) ? f : 0;
    // minimum visible stub like the stream (the fill always shows a few degrees)
    const shown = Math.max(ff, 3 / ARC_SWEEP_DEG);
    c.strokeStyle = COLORS.fill;
    c.beginPath(); c.arc(x, y, r, fillAngleRad(0), fillAngleRad(shown)); c.stroke();
    this.endTick(x, y, 0, COLORS.fill);
    if (ff >= 0.999) this.endTick(x, y, 1, COLORS.fill);

    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    this.text1(label, x, y - 29.8 * s, 15 * s, 600, COLORS.label, 0.3 * s);
    this.text1(value, x, y + 13.5 * s, 41.5 * s, 400, COLORS.value, 1 * s);
    this.text1(unit, x, y + 36.5 * s, 13 * s, 600, COLORS.unit, 0.4 * s);
    c.restore();
  }

  /** maxW: squeeze longer (translated) text into its slot instead of overlapping the neighbour. */
  private text1(str: string, x: number, y: number, px: number, weight: number, color: string, spacing: number, maxW?: number): void {
    const c = this.ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    c.font = `${weight} ${px.toFixed(2)}px ${DISPLAY_FONT}`;
    if ('letterSpacing' in c) c.letterSpacing = `${spacing.toFixed(2)}px`;
    c.fillStyle = color;
    if (maxW !== undefined) c.fillText(str, x, y, maxW); else c.fillText(str, x, y);
    if ('letterSpacing' in c) c.letterSpacing = '0px';
  }

  private drawSphere(x: number, y: number, state: Readonly<VehicleState>): void {
    const c = this.ctx, s = this.s, R = LAYOUT.sphereR * s;
    const q = removeYaw(state.quat, this.heading.update(state.quat));
    c.save();
    // sphere body
    const g = c.createRadialGradient(x - R * 0.3, y - R * 0.35, R * 0.1, x, y, R);
    g.addColorStop(0, 'rgba(255,255,255,0.05)');
    g.addColorStop(1, 'rgba(255,255,255,0.0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2); c.fill();
    c.lineWidth = 1.4 * s;
    c.strokeStyle = COLORS.sphere;
    c.stroke();
    // world horizon disk (stays level like in the stream; only the car rotates)
    const cam = SPHERE_CAMERA;
    const el = Math.asin(-cam.fwd.y);
    const ry = R * Math.sin(el);
    const dg = c.createLinearGradient(0, y - ry, 0, y + ry);
    dg.addColorStop(0, 'rgba(255,255,255,0.025)');
    dg.addColorStop(1, 'rgba(255,255,255,0.08)');
    c.fillStyle = dg;
    c.beginPath(); c.ellipse(x, y, R, ry, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = COLORS.disk;
    c.lineWidth = 1.2 * s;
    c.stroke();
    // floor grid lines on the disk (world X and Z axes)
    c.strokeStyle = 'rgba(80,80,80,0.75)';
    c.lineWidth = 1 * s;
    for (const [ax, az] of [[1, 0], [0, 1]] as const) {
      const px = (ax * cam.right.x + az * cam.right.z) * R, py = -(ax * cam.up.x + az * cam.up.z) * R;
      c.beginPath(); c.moveTo(x - px, y - py); c.lineTo(x + px, y + py); c.stroke();
    }
    const k = 0.345 * R; // px per metre
    paintMesh(c, CAR_FACES, q, cam, x, y, k, 1, { x: 0, y: 0.32, z: 0 });
    c.restore();
  }

  private drawTimer(t: number): void {
    const c = this.ctx, s = this.s;
    const text = U.streamTimer(t);
    const cap = 64 * s, stroke = 8.2 * s;        // measured: 72 px tall incl. stroke at 1080p
    const cy = this.cssH - (REF_H - 868) * s;
    const w = timerWidth(text, cap);
    c.save();
    c.translate(this.cssW / 2, cy);
    c.transform(1, 0, -0.2, 1, 0, 0);            // italic ≈ 11°
    c.translate(-w / 2, -cap / 2);
    c.shadowColor = 'rgba(0,0,0,0.5)';
    c.shadowBlur = 8 * s;
    c.strokeStyle = '#fff';
    c.fillStyle = '#fff';
    drawTimerText(c, text, cap, stroke);
    c.restore();
  }

  /** Discreet extra telemetry (not in the stream): mode/phase top-left, systems top-right. */
  /** 0..1 pulse (1.6 Hz, wall clock) for warnings. */
  private pulse(): number { return 0.5 + 0.5 * Math.sin((performance.now() / 1000) * Math.PI * 2 * 1.6); }

  /** Low-air warning from ManualAssist (phase ids LOW_AIR / AUTOLAND): top centre, pulsing red. */
  private drawAirWarning(kind: 'low' | 'autoland'): void {
    const c = this.ctx, s = Math.max(0.7, this.s), p = this.pulse();
    const title = upper(t(kind === 'autoland' ? 'hud.autoland' : 'hud.lowAir'));
    const sub = upper(t(kind === 'autoland' ? 'hud.autolandSub' : 'hud.lowAirSub'));
    const cx = this.cssW / 2, top = 74 * s, w = 380 * s, hgt = 66 * s;
    c.save();
    c.globalAlpha = 0.72 + 0.28 * p;
    c.shadowColor = `rgba(255,59,48,${0.35 + 0.5 * p})`;
    c.shadowBlur = (14 + 16 * p) * s;
    c.fillStyle = 'rgba(40,4,2,0.78)';
    c.beginPath(); c.roundRect(cx - w / 2, top, w, hgt, 6 * s); c.fill();
    c.shadowBlur = 0;
    c.lineWidth = 1.6 * s;
    c.strokeStyle = COLORS.warn;
    c.stroke();
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    this.text1(title, cx, top + 33 * s, 27 * s, 800, '#ffffff', 3 * s, w - 24 * s);
    this.text1(sub, cx, top + 53 * s, 11 * s, 600, 'rgb(255,190,184)', 1.4 * s, w - 20 * s);
    c.restore();
  }

  private drawExtras(tel: TelemetryFrame, state: Readonly<VehicleState>, ctx: HudContext, lowAir = false): void {
    const c = this.ctx, s = Math.max(0.7, this.s);
    const pad = 34 * s;
    c.save();
    c.textBaseline = 'alphabetic';
    // ---- top-left: mode / stunt / phase / assist
    c.textAlign = 'left';
    let yy = pad + 12 * s;
    const leftW = Math.max(120 * s, this.cssW / 2 - 230 * s - pad); // never into the centred warning box
    const modeTxt = t(ctx.mode === 'auto' ? 'hud.autopilot' : 'hud.manual');
    this.text1(modeTxt, pad, yy, 13 * s, 600, COLORS.label, 1.2 * s, leftW);
    if (ctx.stunt) {
      c.textAlign = 'left';
      this.text1(upper(stuntInfo(ctx.stunt).title), pad, yy + 22 * s, 20 * s, 600, '#fff', 0.8 * s, leftW);
      yy += 22 * s;
    }
    if (tel.phase) { this.text1(`${t('hud.phase')}  ${phaseLabel(tel.phase)}`, pad, yy + 20 * s, 12 * s, 600, 'rgb(200,200,200)', 1 * s, leftW); yy += 20 * s; }
    if (ctx.mode === 'manual' && ctx.assist) {
      // the active control level, large and coloured (R14: RAW has no damping at all, it must be obvious)
      this.text1(t('hud.assist'), pad, yy + 20 * s, 11 * s, 600, COLORS.label, 1.2 * s, leftW);
      this.text1(upper(ASSIST_LABEL[ctx.assist]), pad, yy + 42 * s, 19 * s, 800, ASSIST_COLOR[ctx.assist], 1.2 * s, leftW);
    }

    // ---- top-right: systems
    c.textAlign = 'right';
    const xr = this.cssW - pad;
    const rows: Array<[string, string, string, number | null, boolean]> = [];
    const sp = U.speed(tel.speedMs, ctx.units);
    rows.push([t('hud.speed'), sp.value, sp.unit, null, false]);
    const pr = U.pressure(tel.tankPressureBar, ctx.units);
    const regBar = ROADSTER.tank.regulatorSetpointPa / 1e5;
    rows.push([t('hud.tankPressure'), pr.value, pr.unit, tel.tankPressureBar / (ROADSTER.tank.fullPressurePa / 1e5), lowAir || tel.tankPressureBar < regBar]);
    rows.push([t('hud.airMass'), tel.airMassKg.toFixed(1), 'KG', tel.airMassKg / ROADSTER.tank.fullMassKg, lowAir || tel.airMassKg < 20]);
    const pulse = lowAir ? this.pulse() : 1;
    const warnCol = lowAir ? `rgba(255,75,62,${0.45 + 0.55 * pulse})` : COLORS.warn;
    rows.push([t('hud.fans'), upper(FAN_LABEL[state.fans.mode]), state.fans.mode === 'off' ? '' : `${tel.fanDeltaPKPa.toFixed(1)} KPA`, state.fans.mode === 'off' ? null : state.fans.rpmNorm, false]);
    rows.push([t('hud.aero'), upper(AERO_LABEL[state.aero.mode]), `${Math.round(state.aero.wingAngleDeg)}°`, null, false]);
    yy = pad + 12 * s;
    for (const [lab, val, unit, bar, warn] of rows) {
      const valX = xr - (unit ? 52 * s : 0);
      // value right-aligned at valX; the label (right-aligned left of the value column) gets what is left
      c.font = `400 ${(17 * s).toFixed(2)}px ${DISPLAY_FONT}`;
      const valW = c.measureText(val).width;
      const labX = Math.min(xr - 150 * s, valX - valW - 12 * s);
      this.text1(lab, labX, yy, 11 * s, 600, COLORS.label, 1 * s, 170 * s);
      this.text1(val, valX, yy + 1 * s, 17 * s, 400, warn ? warnCol : '#fff', 0.3 * s);
      if (unit) this.text1(unit, xr, yy, 11 * s, 600, COLORS.unit, 0.8 * s);
      if (bar !== null) {
        const bw = 96 * s, bx = xr - bw, by = yy + 7 * s, bh = (warn && lowAir ? 3 : 2) * s;
        c.fillStyle = warn && lowAir ? `rgba(255,59,48,${0.12 + 0.18 * pulse})` : 'rgba(255,255,255,0.13)';
        c.fillRect(bx, by, bw, bh);
        c.fillStyle = warn ? warnCol : 'rgba(255,255,255,0.85)';
        if (warn && lowAir) { c.shadowColor = 'rgba(255,59,48,0.9)'; c.shadowBlur = 8 * s * pulse; }
        c.fillRect(bx, by, Math.max(2 * s, bw * Math.max(0, Math.min(1, bar))), bh);
        c.shadowBlur = 0;
      }
      yy += (bar !== null ? 30 : 25) * s;
    }
    if (state.damage) yy = this.drawDamage(state.damage, xr, yy, s);
    if (state.crashed) { c.textAlign = 'right'; this.text1(state.damage?.totalLoss ? upper(t('damage.totalLoss')) : t('hud.collision'), xr, yy + 6 * s, 14 * s, 800, COLORS.warn, 1.5 * s); }
    c.restore();
  }

  /** Vehicle damage (setting "Realistic"): zone top view under the system rows, LEAK warning. Returns the next y. */
  private drawDamage(d: Readonly<DamageState>, xr: number, yy: number, s: number): number {
    const len = 78 * s, w = (len * 2.2) / 4.6;
    this.ctx.textAlign = 'right';
    this.text1(t('damage.hud'), xr - w - 12 * s, yy, 11 * s, 600, COLORS.label, 1 * s);
    if (d.leakKgS > 0.01) this.text1(t('damage.leak'), xr - w - 12 * s, yy + 18 * s, 11 * s, 800, COLORS.warn, 1 * s);
    drawDamageView(this.ctx, xr - w / 2, yy - 8 * s + len / 2, len, d);
    return yy + len + 8 * s;
  }
}
