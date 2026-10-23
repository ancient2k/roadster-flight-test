// On-screen side of the Starship launch (docs/EDITOR.md): before liftoff the announcement with a big countdown, an
// arrow with the distance to the launch site, the viewpoint hint and the exclusion-zone warning; after it the mission
// clock (with the time-lapse factor), stream-style ticker messages, the flight display (altitude and speed of both
// stages, the trajectory over the Gulf, "catch in m:ss") and a marker on the stage that is coming back.
// Plain DOM over the canvas; texts from src/editor/i18n.ts.
import { et, type EditorKey } from './i18n';
import { FT, MPH } from '../shared/math';
import type { Units } from '../ui/units';
import {
  BOOSTER_CATCH_T, ENTRY_T, SECO_T, SHIP_CATCH_T, boosterState, shipState, type LaunchEvent, type StageState,
} from '../shared/starshipFlight';

const CSS = `
.rftl{position:absolute;inset:0;pointer-events:none;z-index:19;font-family:var(--rft-display);color:#fff;text-transform:uppercase}
.rftl .hidden{display:none!important}
.rftl-top{position:absolute;left:50%;top:52px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center}
.rftl-title{font-size:13px;letter-spacing:.32em;opacity:.85}
.rftl-count{font:700 clamp(40px,8vh,88px)/1 var(--rft-display);letter-spacing:.06em;text-shadow:0 0 22px rgba(232,38,28,.55),0 2px 4px #000}
.rftl-count.final{color:#ffd7d3}
.rftl-clock{font:600 22px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.08em;text-shadow:0 1px 3px #000}
.rftl-warp{font-size:12px;letter-spacing:.2em;padding:3px 9px;border:1px solid rgba(255,255,255,.4);background:rgba(0,0,0,.45)}
.rftl-pad{display:flex;align-items:center;gap:10px;padding:5px 12px;background:linear-gradient(90deg,transparent,rgba(0,0,0,.55) 15%,rgba(0,0,0,.55) 85%,transparent);font-size:14px;letter-spacing:.12em}
.rftl-pad svg{width:26px;height:26px;flex:none}
.rftl-hint{font-size:12px;letter-spacing:.1em;opacity:.85;text-transform:none}
.rftl-zone{font-size:14px;letter-spacing:.14em;color:#ffd7d3;padding:5px 14px;border-top:1px solid #e8261c;border-bottom:1px solid #e8261c;background:rgba(80,0,0,.5);animation:rftlblink 1s steps(2) infinite}
@keyframes rftlblink{50%{opacity:.35}}
.rftl-tick{position:absolute;left:16px;top:96px;width:min(360px,44vw);display:flex;flex-direction:column;gap:4px}
.rftl-tick div{display:flex;gap:8px;align-items:baseline;padding:4px 10px 4px 8px;background:rgba(0,0,0,.55);border-left:3px solid #e8261c;font-size:12px;letter-spacing:.08em;text-transform:none;transition:opacity .8s}
.rftl-tick div.old{opacity:.0}
.rftl-tick b{font:600 11px/1 ui-monospace,Menlo,monospace;color:#ffb0a8;flex:none}
.rftl-fd{position:absolute;right:14px;top:140px;width:250px;padding:8px 10px;background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.18)}
.rftl-st{display:grid;grid-template-columns:1fr auto;gap:1px 8px;font-size:11px;letter-spacing:.12em;margin-bottom:6px}
.rftl-st .n{grid-column:1/3;font-size:12px;letter-spacing:.2em}
.rftl-st .n i{display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:50%}
.rftl-st span{opacity:.7}.rftl-st b{font:600 12px/1.2 ui-monospace,Menlo,monospace;text-align:right}
.rftl-st .s{grid-column:1/3;color:#ffd27a;font-size:11px}
.rftl-fd canvas{display:block;width:100%;height:96px;margin-top:2px}
.rftl-mark{position:absolute;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;font-size:11px;letter-spacing:.14em;text-shadow:0 1px 2px #000}
.rftl-mark svg{width:34px;height:34px}
.rftl-alert{position:absolute;left:50%;top:30%;transform:translateX(-50%);padding:.7em 1.6em;white-space:nowrap;font:700 clamp(16px,2.4vh,34px)/1.1 var(--rft-display);letter-spacing:.16em;color:#ffd7d3;
  background:linear-gradient(90deg,transparent,rgba(90,0,0,.7) 15%,rgba(90,0,0,.7) 85%,transparent);border-top:1px solid #e8261c;border-bottom:1px solid #e8261c;text-shadow:0 0 18px rgba(232,38,28,.6);animation:rftlblink 0.7s steps(2) 6}
@media (max-width:760px),(max-height:480px){
  .rftl-top{top:40px}.rftl-tick{top:auto;bottom:34%;width:46vw}.rftl-tick div{font-size:10px;padding:2px 8px}.rftl-tick div:nth-child(n+3){display:none}
  .rftl-fd{top:92px;left:50%;right:auto;transform:translateX(-50%);width:auto;display:flex;gap:14px;padding:3px 8px}
  .rftl-fd canvas{display:none}.rftl-st{margin:0;font-size:9px;min-width:120px}.rftl-st b,.rftl-st .n,.rftl-st .s{font-size:10px}
  .rftl-count{font-size:44px}.rftl-clock{font-size:16px}
}
`;

const COL = { booster: '#ffb347', ship: '#8fd3ff' };
const NAME = { booster: 'SUPER HEAVY', ship: 'STARSHIP' };
const ARROW = '<svg viewBox="-12 -12 24 24"><path d="M0-10 L7 6 L0 2 L-7 6Z" fill="#fff" stroke="#000" stroke-width="1"/></svg>';
const BRACKET = '<svg viewBox="0 0 34 34"><path d="M2 10V2h8M24 2h8v8M32 24v8h-8M10 32H2v-8" fill="none" stroke="#ffd27a" stroke-width="2.5"/></svg>';

const clock = (s: number): string => {
  const a = Math.abs(s), h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60), sec = Math.floor(a % 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return `T${s < 0 ? '−' : '+'}${p(h)}:${p(m)}:${p(sec)}`;
};
const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export function fmtDist(m: number, units: Units): string {
  if (units === 'imperial') { const mi = m / 1609.344; return mi < 0.2 ? `${Math.round(m / FT / 10) * 10} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`; }
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${m < 10_000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)} km`;
}
const fmtAlt = (m: number, u: Units) => u === 'imperial' ? (m < 1609 ? `${Math.round(m / FT)} ft` : `${(m / 1609.344).toFixed(1)} mi`) : (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const fmtSpeed = (ms: number, u: Units) => u === 'imperial' ? `${Math.round(ms / MPH).toLocaleString('en-US')} mph` : `${Math.round(ms * 3.6).toLocaleString('en-US')} km/h`;

export interface LaunchHudFrame {
  met: number; warp: number; units: Units;
  /** Before liftoff: distance (m) and bearing (rad, 0 = straight ahead, + = right) from the car/camera to the pad. */
  padDist: number; padBearing: number; viewDist: number; inZone: boolean;
  booster: StageState; ship: StageState & { fromB: boolean };
  boosterIn: number | null; shipIn: number | null;
  /** Screen marker of the stage that is coming back (CSS px; behind = pointing off screen), null if none. */
  mark: { stage: 'booster' | 'ship'; x: number; y: number; onScreen: boolean; angle: number; dist: number } | null;
}

export class LaunchHud {
  private el: HTMLDivElement;
  private top: HTMLDivElement; private title: HTMLDivElement; private count: HTMLDivElement; private clockEl: HTMLDivElement; private warp: HTMLDivElement;
  private pad: HTMLDivElement; private padTxt: HTMLSpanElement; private padArrow: HTMLSpanElement; private hint: HTMLDivElement; private zone: HTMLDivElement;
  private tick: HTMLDivElement; private fd: HTMLDivElement; private rows: Record<'booster' | 'ship', HTMLDivElement>; private canvas: HTMLCanvasElement;
  private mark: HTMLDivElement; private alert: HTMLDivElement | null = null;
  private paths: { booster: [number, number, number][]; shipUp: [number, number, number][]; shipBack: [number, number, number][] };

  constructor(root: HTMLElement) {
    const d = (cls: string, parent: HTMLElement) => { const e = document.createElement('div'); e.className = cls; parent.appendChild(e); return e; };
    this.el = document.createElement('div');
    this.el.className = 'rftl';
    const st = document.createElement('style'); st.textContent = CSS; this.el.appendChild(st);
    this.top = d('rftl-top', this.el);
    this.title = d('rftl-title', this.top);
    this.count = d('rftl-count', this.top);
    this.clockEl = d('rftl-clock hidden', this.top);
    this.warp = d('rftl-warp hidden', this.top);
    this.pad = d('rftl-pad', this.top);
    this.padArrow = document.createElement('span'); this.padArrow.innerHTML = ARROW;
    this.padTxt = document.createElement('span');
    this.pad.append(this.padArrow, this.padTxt);
    this.hint = d('rftl-hint', this.top);
    this.zone = d('rftl-zone hidden', this.top);
    this.tick = d('rftl-tick', this.el);
    this.fd = d('rftl-fd hidden', this.el);
    this.rows = { booster: d('rftl-st', this.fd), ship: d('rftl-st', this.fd) };
    this.canvas = document.createElement('canvas'); this.fd.appendChild(this.canvas);
    this.mark = d('rftl-mark hidden', this.el);
    root.appendChild(this.el);
    // planned tracks for the trajectory display (MET, d, h)
    const sample = (f: (t: number) => StageState, t0: number, t1: number, dt: number) => { const o: [number, number, number][] = []; for (let t = t0; t <= t1; t += dt) { const s = f(t); o.push([t, s.d, s.h]); } return o; };
    this.paths = { booster: sample(boosterState, 0, BOOSTER_CATCH_T, 2), shipUp: sample(shipState, 0, SECO_T, 3), shipBack: sample(shipState, ENTRY_T, SHIP_CATCH_T, 5) };
  }

  /** A ticker line (newest on top, at most four, each fades after 12 s). */
  event(e: LaunchEvent): void {
    const key = `launch.ev.${e.msg}` as EditorKey;
    const text = et(key, { stage: e.stage ? NAME[e.stage] : '' });
    const row = document.createElement('div');
    const b = document.createElement('b'); b.textContent = clock(e.met);
    const s = document.createElement('span'); s.textContent = text;
    row.append(b, s);
    this.tick.prepend(row);
    while (this.tick.children.length > 4) this.tick.lastElementChild!.remove();
    setTimeout(() => row.classList.add('old'), 12_000);
    setTimeout(() => row.remove(), 13_000);
    if (e.msg === 'alert') this.showAlert(text);
  }

  private showAlert(text: string): void {
    this.alert?.remove();
    const a = document.createElement('div');
    a.className = 'rftl-alert'; a.textContent = text;
    this.el.appendChild(a);
    this.alert = a;
    setTimeout(() => { if (this.alert === a) { a.remove(); this.alert = null; } }, 6000);
  }

  update(f: LaunchHudFrame): void {
    const pre = f.met < 0;
    this.title.textContent = et('launch.title');
    this.count.classList.toggle('hidden', !pre);
    this.count.classList.toggle('final', f.met > -10);
    if (pre) this.count.textContent = `T−${mmss(Math.ceil(-f.met))}`;
    this.clockEl.classList.toggle('hidden', pre);
    if (!pre) this.clockEl.textContent = clock(f.met);
    this.warp.classList.toggle('hidden', f.warp <= 1);
    if (f.warp > 1) this.warp.textContent = et('launch.timelapse', { n: f.warp });
    const showPad = f.met < 20;
    this.pad.classList.toggle('hidden', !showPad);
    this.hint.classList.toggle('hidden', !showPad);
    if (showPad) {
      this.padTxt.textContent = et('launch.pad', { d: fmtDist(f.padDist, f.units) });
      this.padArrow.style.transform = `rotate(${f.padBearing}rad)`;
      this.hint.textContent = et('launch.viewpoint', { d: fmtDist(f.viewDist, f.units) });
    }
    this.zone.classList.toggle('hidden', !(f.inZone && f.met < 3));
    this.zone.textContent = et('launch.zone');
    // flight display
    this.fd.classList.toggle('hidden', pre);
    if (!pre) {
      this.row('booster', f.booster, f.boosterIn, f.units);
      this.row('ship', f.ship, f.shipIn, f.units);
      if (this.canvas.offsetParent) this.draw(f);
    }
    // marker on the returning stage
    const m = f.mark;
    this.mark.classList.toggle('hidden', !m);
    if (m) {
      this.mark.style.left = `${m.x}px`; this.mark.style.top = `${m.y}px`;
      this.mark.innerHTML = (m.onScreen ? BRACKET : ARROW.replace('<svg', `<svg style="transform:rotate(${m.angle}rad)"`))
        + `<span style="color:${COL[m.stage]}">${NAME[m.stage]} · ${fmtDist(m.dist, f.units)}</span>`;
    }
  }

  private row(id: 'booster' | 'ship', s: StageState, inS: number | null, u: Units): void {
    const status = s.caught ? et('launch.caught') : s.phase === 'orbit' ? et('launch.orbit') : inS !== null ? et('launch.catchIn', { t: mmss(inS) }) : '';
    const orbit = s.phase === 'orbit';
    const html = `<div class="n"><i style="background:${COL[id]}"></i>${NAME[id]}</div>`
      + `<span>${et('launch.alt')}</span><b>${orbit || !s.caught ? fmtAlt(Math.max(0, s.h), u) : '—'}</b>`
      + `<span>${et('launch.speed')}</span><b>${fmtSpeed(s.speed, u)}</b>`
      + (status ? `<div class="s">${status}</div>` : '');
    if (html !== this.rowHtml[id]) { this.rows[id].innerHTML = html; this.rowHtml[id] = html; }
  }
  private rowHtml = { booster: '', ship: '' };

  /** Side view of the flight: distance along the azimuth (√-scaled, pad in the middle) against √altitude. */
  private draw(f: LaunchHudFrame): void {
    const c = this.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const dMax = f.met < SECO_T + 60 || f.met > ENTRY_T ? (f.met > ENTRY_T ? 3_400_000 : 400_000) : 3_400_000, hMax = 200_000;
    const X = (d: number) => W / 2 + Math.sign(d) * Math.sqrt(Math.min(1, Math.abs(d) / dMax)) * (W / 2 - 6);
    const Y = (h: number) => H - 8 - Math.sqrt(Math.max(0, Math.min(1, h / hMax))) * (H - 16);
    // ground, coast, pad
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, H - 8); g.lineTo(W, H - 8); g.stroke();
    g.fillStyle = 'rgba(80,140,200,.35)'; g.fillRect(W / 2 + 3, H - 8, W / 2 - 3, 3);   // the Gulf
    g.fillStyle = '#fff'; g.fillRect(W / 2 - 1, H - 15, 2, 7);
    const line = (pts: [number, number, number][], col: string, upto: number) => {
      for (const flown of [false, true]) {
        g.strokeStyle = flown ? col : 'rgba(255,255,255,.18)'; g.lineWidth = flown ? 1.8 : 1;
        g.beginPath();
        let first = true;
        for (const [t, d, h] of pts) {
          if (flown && t > upto) break;
          if (Math.abs(d) > dMax) { first = true; continue; }
          if (first) g.moveTo(X(d), Y(h)); else g.lineTo(X(d), Y(h));
          first = false;
        }
        g.stroke();
      }
    };
    line(this.paths.booster, COL.booster, f.met);
    if (f.met < ENTRY_T) line(this.paths.shipUp, COL.ship, f.met); else line(this.paths.shipBack, COL.ship, f.met);
    for (const [id, s] of [['booster', f.booster], ['ship', f.ship]] as const) {
      if (s.phase === 'orbit' || Math.abs(s.d) > dMax) continue;
      g.fillStyle = COL[id];
      g.beginPath(); g.arc(X(s.d), Y(s.h), 3.5, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '9px ui-monospace, Menlo, monospace';
    g.fillText(`${Math.round(dMax / 1000)} km`, W - 48, H - 12);
  }

  dispose(): void { this.el.remove(); }
}
