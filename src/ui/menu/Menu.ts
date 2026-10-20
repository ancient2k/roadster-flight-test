// Menus: title, stunt select, free test, settings (incl. rebinding), pause, help, results.
// Vanilla DOM, built once per screen change (never per frame). Keyboard: native focus + arrow-key
// spatial navigation; gamepad: feed InputManager's MenuNav into menu.nav().
import type { AssistLevel, StuntId, TelemetryFrame } from '../../shared/types';
import { TRACK } from '../../shared/track';
import { FT } from '../../shared/math';
import { VIDEO_REFERENCE } from '../../shared/reference';
import { CONTROL_IDS, type ControlId, type MenuNav } from '../../input/types';
import { CONTROL_META } from '../../input/bindings';
import type { InputManager } from '../../input/InputManager';
import { Emitter, fmtDe, h, svg } from '../dom';
import { loadFonts } from '../fonts';
import { ASSIST_DESC, ASSIST_LABEL, REFERENCE_LABEL, STUNTS, reasonText, stuntInfo } from '../labels';
import type { Settings, SettingsStore } from '../settings';
import type { Units } from '../units';
import { SERIES, SPEED_SERIES, bestOffset, grade, refSeries, seriesToPlot, simSeries } from '../results/chartMath';
import { drawChart, type ChartPanel } from '../results/chart';
import { ASSIST_ICONS, BODY_ICONS, STUNT_ICONS, WORLD_ICONS } from './icons';
import { BODIES, bodyFacts, gravityText, sitesOf } from '../worlds';
import type { SiteId } from '../../shared/worlds';
import type { BodyId } from '../../shared/environment';
import '../ui.css';
import './menu.css';

export type MenuScreen = 'title' | 'stunts' | 'free' | 'worlds' | 'settings' | 'pause' | 'help' | 'results' | 'none';
export type FreeSite = 'ground_flip' | 'ramp_hang' | 'kickflip' | 'zero60';

export interface ResultData {
  mode: 'auto' | 'manual';
  stunt?: StuntId;
  success: boolean;
  /** Short German reason, e.g. "Dach berührt Boden" or "Landung zu hart (3,1 g)". */
  reason?: string;
  /** Measured values keyed like TRACK.sites[].reference (SI units: m, g, °, kg, s). */
  metrics: Partial<Record<string, number>>;
  telemetry: readonly TelemetryFrame[];
  /** Sim time (s) of the manoeuvre start for aligning with the video curves. Auto-aligned if omitted. */
  startT?: number;
}

export interface MenuEvents {
  startStunt: StuntId;
  startFree: { assist: AssistLevel; site: FreeSite };
  /** Phase 2 world selection (only sites with available = true emit it). */
  startWorld: { body: BodyId; site: SiteId };
  resume: void;
  restart: void;
  quitToTitle: void;
  settingsChanged: Readonly<Settings>;
  screenChange: MenuScreen;
  uiSound: 'move' | 'select' | 'back';
}

export interface MenuOptions {
  settings: SettingsStore;
  input?: InputManager;
  /** 'keyart': opaque title backdrop; 'scene': translucent so the 3D scene shows through. */
  backdrop?: 'keyart' | 'scene';
  /** Show the "Welten" entry on the title screen (Phase 2). The screen is always reachable via show('worlds'). */
  worlds?: boolean;
}

const FREE_SITES: Array<{ id: FreeSite; label: string; hint: string }> = [
  { id: 'ground_flip', label: 'Freie Fläche', hint: 'Asphalt-Pad, viel Platz zum Schweben' },
  { id: 'ramp_hang', label: 'Wandrampe', hint: 'Lüfter ansaugen und die Wand hoch' },
  { id: 'kickflip', label: 'Kicker', hint: 'Kicker vor Semi und Fahrzeugreihe' },
  { id: 'zero60', label: 'Startgerade', hint: 'Beschleunigungsstrecke mit Tor' },
];

type SettingsTab = 'grafik' | 'anzeige' | 'audio' | 'steuerung' | 'simulation';

export class Menu extends Emitter<MenuEvents> {
  readonly el: HTMLDivElement;
  private screenEl: HTMLDivElement;
  private screen: MenuScreen = 'none';
  private stack: MenuScreen[] = [];
  private settingsTab: SettingsTab = 'grafik';
  private freeAssist: AssistLevel;
  private freeSite: FreeSite = 'ground_flip';
  private worldBody: BodyId = 'earth';
  private lastResult: ResultData | null = null;
  private best = new Map<StuntId, string>();
  private chartCleanup: (() => void) | null = null;
  private capturing = false;
  private disposers: Array<() => void> = [];

  constructor(root: HTMLElement, private opts: MenuOptions) {
    super();
    this.freeAssist = opts.settings.get().assistDefault;
    this.el = h('div', { class: `rft-menu backdrop-${opts.backdrop ?? 'keyart'}`, hidden: true });
    this.screenEl = h('div', { class: 'rft-screen' });
    this.el.append(this.keyArt(), this.screenEl);
    root.appendChild(this.el);
    loadFonts();
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));
    if (opts.input) this.disposers.push(opts.input.onBindingsChange(() => { if (this.screen === 'settings' && this.settingsTab === 'steuerung' && !this.capturing) this.render(); }));
  }

  // ------------------------------------------------------------------ public API
  get current(): MenuScreen { return this.screen; }
  isOpen(): boolean { return this.screen !== 'none'; }

  show(screen: MenuScreen, opts: { push?: boolean } = {}): void {
    if (screen === 'none') { this.hide(); return; }
    if (opts.push !== false && this.screen !== 'none' && this.screen !== screen) this.stack.push(this.screen);
    if (screen === 'title' || screen === 'pause' || screen === 'results') this.stack = [];
    this.screen = screen;
    this.render();
    this.emit('screenChange', screen);
  }

  hide(): void {
    this.screen = 'none'; this.stack = [];
    this.el.hidden = true;
    this.chartCleanup?.(); this.chartCleanup = null;
    this.emit('screenChange', 'none');
  }

  back(): void {
    if (this.capturing) return;
    if (this.screen === 'pause') { this.emit('uiSound', 'back'); this.hide(); this.emit('resume', undefined); return; }
    const prev = this.stack.pop();
    if (!prev) return;
    this.emit('uiSound', 'back');
    this.screen = prev;
    this.render();
    this.emit('screenChange', prev);
  }

  showResults(r: ResultData): void { this.lastResult = r; this.show('results'); }

  /** Optional best value shown on the stunt card ("Bestwert: 0,84 s"). */
  setBest(stunt: StuntId, text: string): void { this.best.set(stunt, text); }

  /** Gamepad navigation (from InputManager.poll().menuNav). */
  nav(n: MenuNav): void {
    if (!this.isOpen() || this.capturing) return;
    const a = document.activeElement as HTMLElement | null;
    const inMenu = !!a && this.el.contains(a);
    if (n.confirm) { if (inMenu) { a!.click(); } else this.focusFirst(); }
    if (n.back) this.back();
    if (n.tabPrev || n.tabNext) this.cycleTab(n.tabNext ? 1 : -1);
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      if (!n[dir]) continue;
      if (inMenu && a instanceof HTMLInputElement && a.type === 'range' && (dir === 'left' || dir === 'right')) {
        dir === 'left' ? a.stepDown() : a.stepUp();
        a.dispatchEvent(new Event('input', { bubbles: true }));
        a.dispatchEvent(new Event('change', { bubbles: true }));
        continue;
      }
      this.moveFocus(dir);
    }
  }

  dispose(): void { for (const d of this.disposers) d(); this.chartCleanup?.(); this.el.remove(); }

  // ------------------------------------------------------------------ rendering
  private render(): void {
    this.chartCleanup?.(); this.chartCleanup = null;
    this.el.hidden = false;
    this.el.dataset.screen = this.screen;
    const s = this.screen;
    const view =
      s === 'title' ? this.titleView() :
      s === 'stunts' ? this.stuntsView() :
      s === 'free' ? this.freeView() :
      s === 'worlds' ? this.worldsView() :
      s === 'settings' ? this.settingsView() :
      s === 'pause' ? this.pauseView() :
      s === 'help' ? this.helpView() :
      s === 'results' ? this.resultsView() : h('div');
    this.screenEl.replaceChildren(view);
    this.screenEl.setAttribute('role', 'dialog');
    this.screenEl.setAttribute('aria-modal', 'true');
    this.screenEl.setAttribute('aria-label', view.dataset.title ?? 'Menü');
    requestAnimationFrame(() => this.focusFirst());
  }

  private focusFirst(): void {
    const pref = this.screenEl.querySelector<HTMLElement>('[data-autofocus]') ?? this.focusables()[0];
    pref?.focus({ preventScroll: false });
  }

  private keyArt(): HTMLElement {
    // Night pad, red LED bands, flood lights and the curved wall ramp (signature shapes of the stream).
    return h('div', { class: 'rft-keyart', 'aria-hidden': 'true' },
      svg(`<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
        <defs>
          <radialGradient id="ka-sky" cx="62%" cy="30%" r="80%"><stop offset="0" stop-color="#1b1e24"/><stop offset=".55" stop-color="#08090b"/><stop offset="1" stop-color="#000"/></radialGradient>
          <linearGradient id="ka-pad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d0e10"/><stop offset="1" stop-color="#18191c"/></linearGradient>
          <linearGradient id="ka-ramp" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#55575c"/><stop offset=".7" stop-color="#2c2d31"/><stop offset="1" stop-color="#16171a"/></linearGradient>
          <filter id="ka-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
          <filter id="ka-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="28"/></filter>
        </defs>
        <rect width="1600" height="900" fill="url(#ka-sky)"/>
        <g opacity=".9">
          <circle cx="1270" cy="250" r="5" fill="#fff"/><circle cx="1290" cy="250" r="5" fill="#fff"/><circle cx="1310" cy="250" r="5" fill="#fff"/>
          <circle cx="1270" cy="268" r="5" fill="#fff"/><circle cx="1290" cy="268" r="5" fill="#fff"/><circle cx="1310" cy="268" r="5" fill="#fff"/>
          <circle cx="1290" cy="259" r="70" fill="#cfe3ff" opacity=".18" filter="url(#ka-soft)"/>
        </g>
        <path d="M1290 270 V640" stroke="#1a1b1e" stroke-width="5"/>
        <path d="M0 640 H1600 V900 H0 Z" fill="url(#ka-pad)"/>
        <g class="ka-ramp" transform="translate(1180 640) scale(1.22) translate(-1180 -640)">
          <path d="M930 640 H1010 A170 170 0 0 0 1180 470 V330 A48 48 0 0 0 1132 282 L1112 290 A40 40 0 0 1 1150 330 V470 A140 140 0 0 1 1010 610 H930 Z" fill="url(#ka-ramp)"/>
          <path d="M930 640 H1010 A170 170 0 0 0 1180 470 V330 A48 48 0 0 0 1132 282" fill="none" stroke="#e8261c" stroke-width="3" filter="url(#ka-glow)" opacity=".9"/>
          <path d="M930 640 H1010 A170 170 0 0 0 1180 470 V330 A48 48 0 0 0 1132 282" fill="none" stroke="#ff6a5c" stroke-width="1.2"/>
          <path d="M1190 640 V300 M1230 640 V330 M1190 360 L1230 420 M1230 360 L1190 420 M1190 480 L1230 540 M1230 480 L1190 540" stroke="#2a3a55" stroke-width="2" opacity=".7"/>
        </g>
        <g class="ka-led">
          <path d="M-20 720 L800 655 L1620 700" stroke="#e8261c" stroke-width="6" fill="none" filter="url(#ka-glow)"/>
          <path d="M-20 720 L800 655 L1620 700" stroke="#ff8a7e" stroke-width="1.6" fill="none"/>
          <path d="M-20 820 L800 690 L1620 790" stroke="#e8261c" stroke-width="7" fill="none" filter="url(#ka-glow)" opacity=".75"/>
          <path d="M-20 820 L800 690 L1620 790" stroke="#ff8a7e" stroke-width="1.6" fill="none" opacity=".75"/>
        </g>
        <path d="M0 900 L800 660 L1600 900" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="2"/>
        <rect width="1600" height="900" fill="url(#ka-sky)" opacity=".25"/>
      </svg>`),
      h('div', { class: 'rft-grain' }),
    );
  }

  // ------------------------------------------------------------------ screens
  private titleView(): HTMLElement {
    const btn = (label: string, sub: string, fn: () => void, auto = false) =>
      h('button', { class: 'rft-mainbtn', onclick: () => { this.emit('uiSound', 'select'); fn(); }, 'data-autofocus': auto || null },
        h('span', { class: 'rft-mainbtn-label', text: label }), h('span', { class: 'rft-mainbtn-sub', text: sub }));
    return h('section', { class: 'rft-title', 'data-title': 'Hauptmenü' },
      h('div', { class: 'rft-title-block' },
        h('p', { class: 'rft-eyebrow', text: 'Kaltgas-Düsen · Lüfter-Ansaugung · 10 Düsen · 690 bar' }),
        h('h1', { class: 'rft-logo' }, h('span', { class: 'l1', text: 'Roadster' }), h('span', { class: 'l2', text: 'Flight Test' })),
        h('p', { class: 'rft-tagline', text: 'Die fünf Stunts aus dem Livestream – physikalisch nachgeflogen.' }),
      ),
      h('nav', { class: 'rft-mainnav', 'aria-label': 'Hauptmenü' },
        btn('Stunts nachfliegen', 'Autopilot · 5 Manöver aus dem Video', () => this.show('stunts'), true),
        btn('Freies Testen', 'Manuell fliegen mit Assistenzstufe', () => this.show('free')),
        this.opts.worlds ? btn('Welten', 'Erde · Mond · Mars · Sonne', () => this.show('worlds')) : null,
        btn('Einstellungen', 'Grafik · Einheiten · Audio · Steuerung', () => this.show('settings')),
        btn('Hilfe & Steuerung', 'Tastenbelegung und HUD-Erklärung', () => this.show('help')),
      ),
      h('footer', { class: 'rft-footer' },
        h('span', { text: 'Inoffizielles Fan-Projekt · keine Verbindung zu Tesla, Inc. oder SpaceX' }),
        h('span', { class: 'rft-hintkeys', text: '↑↓ wählen · Eingabe bestätigen · Esc zurück' })),
    );
  }

  private header(title: string, sub?: string): HTMLElement {
    return h('header', { class: 'rft-header' },
      h('button', { class: 'rft-back', 'aria-label': 'Zurück', onclick: () => this.back() }, '←'),
      h('div', null, h('h2', { text: title }), sub ? h('p', { text: sub }) : null));
  }

  private stuntsView(): HTMLElement {
    const units = this.opts.settings.get().units;
    const cards = STUNTS.map((st, i) => {
      const site = TRACK.sites.find((x) => x.stunt === st.id);
      const chips = site ? referenceChips(site.reference, units) : [];
      const best = this.best.get(st.id);
      return h('button', {
        class: 'rft-card', 'data-autofocus': i === 0 || null,
        'aria-label': `${st.title}: ${st.short}`,
        onclick: () => { this.emit('uiSound', 'select'); this.hide(); this.emit('startStunt', st.id); },
      },
      h('span', { class: 'rft-card-num', text: String(i + 1).padStart(2, '0') }),
      svg(STUNT_ICONS[st.id], 'rft-card-icon'),
      h('span', { class: 'rft-card-title', text: st.title }),
      h('span', { class: 'rft-card-short', text: st.short }),
      h('span', { class: 'rft-card-desc', text: st.description }),
      h('span', { class: 'rft-chips' }, ...chips.map((c) => h('span', { class: 'rft-chip' }, h('b', { text: c.value }), ` ${c.label}`))),
      h('span', { class: 'rft-card-foot' }, h('span', { text: `Stream ${st.videoTime}` }), best ? h('span', { class: 'rft-best', text: `Bestwert ${best}` }) : null),
      );
    });
    return h('section', { class: 'rft-page', 'data-title': 'Stunt wählen' },
      this.header('Stunt wählen', 'Der Autopilot fliegt das Manöver mit derselben Physik nach, die du im manuellen Modus steuerst.'),
      h('div', { class: 'rft-cards' }, ...cards));
  }

  private freeView(): HTMLElement {
    const assistCards = (['ASSIST', 'STABILIZED', 'RAW'] as AssistLevel[]).map((lvl) =>
      h('button', {
        class: 'rft-option', 'aria-pressed': String(this.freeAssist === lvl), 'data-autofocus': this.freeAssist === lvl || null,
        onclick: () => { this.freeAssist = lvl; this.emit('uiSound', 'move'); this.render(); },
      }, svg(ASSIST_ICONS[lvl], 'rft-option-icon'), h('span', { class: 'rft-option-title', text: ASSIST_LABEL[lvl] }), h('span', { class: 'rft-option-desc', text: ASSIST_DESC[lvl] })));
    const sites = FREE_SITES.map((s) => h('button', {
      class: 'rft-seg', 'aria-pressed': String(this.freeSite === s.id), title: s.hint,
      onclick: () => { this.freeSite = s.id; this.emit('uiSound', 'move'); this.render(); },
    }, s.label));
    const inp = this.opts.input;
    const hint = (id: ControlId) => (inp ? inp.hint(id) : '');
    return h('section', { class: 'rft-page', 'data-title': 'Freies Testen' },
      this.header('Freies Testen', 'Du fliegst selbst. Die Assistenzstufe bestimmt, wie viel der Regler übernimmt.'),
      h('h3', { class: 'rft-subhead', text: 'Assistenzstufe' }),
      h('div', { class: 'rft-options' }, ...assistCards),
      h('h3', { class: 'rft-subhead', text: 'Startort' }),
      h('div', { class: 'rft-segs', role: 'group', 'aria-label': 'Startort' }, ...sites),
      h('p', { class: 'rft-note', text: FREE_SITES.find((s) => s.id === this.freeSite)!.hint }),
      inp ? h('p', { class: 'rft-note dim' },
        `Fahren ${hint('throttle')}/${hint('brake')}/${hint('steerLeft')}/${hint('steerRight')} · Hub ${hint('lift')} · Boost ${hint('boost')} · Rollen ${hint('rollLeft')}/${hint('rollRight')} · Nicken ${hint('pitchDown')}/${hint('pitchUp')} · Gieren ${hint('yawLeft')}/${hint('yawRight')} · Lüfter ${hint('fanModeCycle')}`) : null,
      h('div', { class: 'rft-actions' },
        h('button', { class: 'rft-primary', onclick: () => { this.emit('uiSound', 'select'); this.hide(); this.emit('startFree', { assist: this.freeAssist, site: this.freeSite }); } }, 'Losfliegen')),
    );
  }

  private worldsView(): HTMLElement {
    const body = BODIES.find((b) => b.id === this.worldBody)!;
    const tabs = h('div', { class: 'rft-tabs rft-bodytabs', role: 'tablist', 'aria-label': 'Himmelskörper' },
      ...BODIES.map((b) => h('button', {
        role: 'tab', class: 'rft-tab', 'aria-selected': String(b.id === this.worldBody), id: `wtab-${b.id}`, 'aria-controls': 'rft-worldpanel',
        'data-autofocus': b.id === this.worldBody || null,
        onclick: () => { this.worldBody = b.id; this.emit('uiSound', 'move'); this.render(); },
      }, svg(BODY_ICONS[b.id], 'rft-bodyicon'), b.label)));
    const facts = h('div', { class: 'rft-chips rft-bodyfacts' }, ...bodyFacts(body.id).map((f) => h('span', { class: 'rft-chip' }, h('b', { text: f.value }), ` ${f.label}`)));
    const cards = sitesOf(body.id).map((w, i) => h('button', {
      class: `rft-card rft-world${w.available ? '' : ' wip'}`, 'aria-disabled': w.available ? null : 'true',
      'aria-label': `${w.name}, ${w.subtitle}${w.available ? '' : ', in Arbeit'}`, 'data-world': w.id,
      onclick: () => {
        if (!w.available) { this.emit('uiSound', 'back'); this.toast(`${w.name} ist noch in Arbeit.`); return; }
        this.emit('uiSound', 'select'); this.hide(); this.emit('startWorld', { body: w.body, site: w.id });
      },
    },
    h('span', { class: 'rft-card-num', text: String(i + 1).padStart(2, '0') }),
    svg(WORLD_ICONS[w.id], 'rft-card-icon'),
    h('span', { class: 'rft-card-title', text: w.name }),
    h('span', { class: 'rft-card-short', text: w.subtitle }),
    h('span', { class: 'rft-chips' },
      h('span', { class: 'rft-chip rft-gravity' }, h('b', { text: 'g' }), ` ${gravityText(w.body)}`)),
    h('span', { class: 'rft-card-desc rft-coords', text: w.coords }),
    h('span', { class: 'rft-card-foot' }, w.available ? h('span', { class: 'rft-best', text: 'Verfügbar' }) : h('span', { class: 'rft-wip', text: 'In Arbeit' }))));
    return h('section', { class: 'rft-page', 'data-title': 'Welten' },
      this.header('Welten', 'Dieselbe Physik unter anderer Schwerkraft und Atmosphäre.'),
      tabs,
      h('div', { id: 'rft-worldpanel', role: 'tabpanel', 'aria-labelledby': `wtab-${body.id}` },
        h('p', { class: 'rft-note', text: body.tagline }), facts,
        h('div', { class: 'rft-cards rft-worldcards' }, ...cards)));
  }

  private pauseView(): HTMLElement {
    const b = (label: string, fn: () => void, auto = false) => h('button', { class: 'rft-listbtn', onclick: () => { this.emit('uiSound', 'select'); fn(); }, 'data-autofocus': auto || null }, label);
    return h('section', { class: 'rft-pause', 'data-title': 'Pause' },
      h('h2', { class: 'rft-pause-title', text: 'Pause' }),
      h('div', { class: 'rft-list' },
        b('Fortsetzen', () => { this.hide(); this.emit('resume', undefined); }, true),
        b('Neu starten', () => { this.hide(); this.emit('restart', undefined); }),
        b('Einstellungen', () => this.show('settings')),
        b('Hilfe & Steuerung', () => this.show('help')),
        b('Hauptmenü', () => { this.emit('quitToTitle', undefined); this.show('title'); }),
      ));
  }

  // ------------------------------------------------------------------ settings
  private settingsView(): HTMLElement {
    const tabs: Array<[SettingsTab, string]> = [['grafik', 'Grafik'], ['anzeige', 'Anzeige'], ['audio', 'Audio'], ['steuerung', 'Steuerung'], ['simulation', 'Simulation']];
    const tabBar = h('div', { class: 'rft-tabs', role: 'tablist', 'aria-label': 'Einstellungen' },
      ...tabs.map(([id, label]) => h('button', {
        role: 'tab', class: 'rft-tab', 'aria-selected': String(this.settingsTab === id), id: `tab-${id}`, 'aria-controls': 'rft-tabpanel',
        'data-autofocus': this.settingsTab === id || null,
        onclick: () => { this.settingsTab = id; this.emit('uiSound', 'move'); this.render(); },
      }, label)));
    const panel = h('div', { class: 'rft-tabpanel', id: 'rft-tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${this.settingsTab}` });
    const st = this.opts.settings;
    const s = st.get();
    const upd = (fn: (d: Settings) => void, key: string) => { const n = st.update(fn, key); this.emit('settingsChanged', n); };

    switch (this.settingsTab) {
      case 'grafik':
        panel.append(
          this.segRow('Qualität', [['low', 'Niedrig'], ['medium', 'Mittel'], ['high', 'Hoch'], ['ultra', 'Ultra']], s.graphics.quality, (v) => upd((d) => { d.graphics.quality = v as Settings['graphics']['quality']; }, 'graphics.quality'),
            'Ultra: volle Auflösung für AO/SSR, Mach-Diamanten in voller Dichte. Niedrig: für integrierte Grafik.'),
          this.toggleRow('Dynamische Auflösung', s.graphics.dynamicResolution, (v) => upd((d) => { d.graphics.dynamicResolution = v; }, 'graphics.dynamicResolution'), 'Hält 60 fps, indem die Renderauflösung bei Last sinkt.'),
          this.toggleRow('Bewegungsunschärfe', s.graphics.motionBlur, (v) => upd((d) => { d.graphics.motionBlur = v; }, 'graphics.motionBlur')),
        );
        break;
      case 'anzeige':
        panel.append(
          this.segRow('Einheiten', [['imperial', 'ft · mph (wie im Stream)'], ['metric', 'm · km/h']], s.units, (v) => upd((d) => { d.units = v as Units; }, 'units'), 'Downforce bleibt in kg, genau wie im Stream.'),
          this.rangeRow('HUD-Größe', s.hud.scale, 0.5, 2, 0.05, (v) => `${Math.round(v * 100)} %`, (v) => upd((d) => { d.hud.scale = v; }, 'hud.scale')),
          this.toggleRow('HUD anzeigen', s.hud.visible, (v) => upd((d) => { d.hud.visible = v; }, 'hud.visible')),
          this.toggleRow('Zusatzanzeigen', s.hud.showExtras, (v) => upd((d) => { d.hud.showExtras = v; }, 'hud.showExtras'), 'Tankdruck, Luftmasse, Lüfter, Aero und Phase am oberen Rand.'),
        );
        break;
      case 'audio':
        panel.append(
          this.rangeRow('Gesamtlautstärke', s.audio.master, 0, 1, 0.01, pct, (v) => upd((d) => { d.audio.master = v; }, 'audio.master')),
          this.rangeRow('Effekte', s.audio.effects, 0, 1, 0.01, pct, (v) => upd((d) => { d.audio.effects = v; }, 'audio.effects')),
          this.rangeRow('Publikum', s.audio.crowd, 0, 1, 0.01, pct, (v) => upd((d) => { d.audio.crowd = v; }, 'audio.crowd')),
          this.toggleRow('Stumm', s.audio.muted, (v) => upd((d) => { d.audio.muted = v; }, 'audio.muted')),
        );
        break;
      case 'steuerung':
        panel.append(
          this.toggleRow('Nicken invertieren', s.controls.invertPitch, (v) => upd((d) => { d.controls.invertPitch = v; }, 'controls.invertPitch')),
          this.toggleRow('Maus für Lage (rechte Taste halten)', s.controls.mouseAttitude, (v) => upd((d) => { d.controls.mouseAttitude = v; }, 'controls.mouseAttitude')),
          this.rangeRow('Mausempfindlichkeit', s.controls.mouseSensitivity, 0.1, 5, 0.1, (v) => fmtDe(v, 1), (v) => upd((d) => { d.controls.mouseSensitivity = v; }, 'controls.mouseSensitivity')),
          this.rangeRow('Stick-Totzone', s.controls.stickDeadzone, 0, 0.6, 0.01, pct, (v) => upd((d) => { d.controls.stickDeadzone = v; }, 'controls.stickDeadzone')),
          this.rangeRow('Trigger-Totzone', s.controls.triggerDeadzone, 0, 0.5, 0.01, pct, (v) => upd((d) => { d.controls.triggerDeadzone = v; }, 'controls.triggerDeadzone')),
          this.bindingsTable(),
        );
        break;
      case 'simulation':
        panel.append(
          this.segRow('Tank-Nachfüllrate', [['realistic', 'Realistisch (6–7 h)'], ['game', 'Spiel (20 s)']], s.refillRate, (v) => upd((d) => { d.refillRate = v as Settings['refillRate']; }, 'refillRate'),
            'Der Bordkompressor füllt die zwei COPV-Tanks (600 l, 250 kg Luft, 690 bar).'),
          this.segRow('Standard-Assistenz', (['ASSIST', 'STABILIZED', 'RAW'] as AssistLevel[]).map((a) => [a, ASSIST_LABEL[a]] as [string, string]), s.assistDefault, (v) => upd((d) => { d.assistDefault = v as AssistLevel; }, 'assistDefault')),
          this.toggleRow('Unendlich Druckluft', s.realism.infiniteAir, (v) => upd((d) => { d.realism.infiniteAir = v; }, 'realism.infiniteAir'), 'Spielhilfe: Tank leert sich nicht.'),
          this.toggleRow('Ventilverzögerung', s.realism.valveDelays, (v) => upd((d) => { d.realism.valveDelays = v; }, 'realism.valveDelays'), '8 ms Öffnen, 15 ms Mindest-Einschaltzeit.'),
          this.toggleRow('Sensorrauschen', s.realism.sensorNoise, (v) => upd((d) => { d.realism.sensorNoise = v; }, 'realism.sensorNoise'), 'Der Regler sieht einen verrauschten Zustand.'),
          this.toggleRow('Wind', s.realism.wind, (v) => upd((d) => { d.realism.wind = v; }, 'realism.wind'), 'Böen über dem Pad.'),
          this.toggleRow('Kollisionsschaden', s.realism.crashDamage, (v) => upd((d) => { d.realism.crashDamage = v; }, 'realism.crashDamage'), 'Aufsetzen mit Dach oder Seite beendet den Lauf.'),
        );
        break;
    }
    return h('section', { class: 'rft-page rft-settings', 'data-title': 'Einstellungen' },
      this.header('Einstellungen', 'Änderungen gelten sofort und werden lokal gespeichert.'),
      tabBar, panel,
      h('div', { class: 'rft-actions' }, h('button', { class: 'rft-ghost', onclick: () => { st.reset(); this.opts.input?.resetBindings(); this.emit('settingsChanged', st.get()); this.render(); } }, 'Alles zurücksetzen')));
  }

  private row(label: string, control: HTMLElement, note?: string): HTMLElement {
    return h('div', { class: 'rft-row' }, h('div', { class: 'rft-row-label' }, h('span', { text: label }), note ? h('small', { text: note }) : null), control);
  }

  private segRow(label: string, opts: Array<[string, string]>, value: string, onPick: (v: string) => void, note?: string): HTMLElement {
    const grp = h('div', { class: 'rft-segs', role: 'radiogroup', 'aria-label': label },
      ...opts.map(([v, l]) => h('button', {
        class: 'rft-seg', role: 'radio', 'aria-checked': String(v === value),
        onclick: () => { this.emit('uiSound', 'move'); onPick(v); this.render(); this.refocus(label, v); },
        'data-v': v,
      }, l)));
    grp.dataset.label = label;
    return this.row(label, grp, note);
  }

  private toggleRow(label: string, value: boolean, onSet: (v: boolean) => void, note?: string): HTMLElement {
    const btn = h('button', { class: 'rft-toggle', role: 'switch', 'aria-checked': String(value), 'aria-label': label }, h('span', { class: 'knob' }));
    btn.onclick = () => {
      const nv = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', String(nv));
      this.emit('uiSound', 'move');
      onSet(nv);
    };
    return this.row(label, btn, note);
  }

  private rangeRow(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, onSet: (v: number) => void): HTMLElement {
    const out = h('output', { class: 'rft-range-val', text: fmt(value) });
    const inp = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label, class: 'rft-range' }) as HTMLInputElement;
    const paint = () => inp.style.setProperty('--p', `${((Number(inp.value) - min) / (max - min)) * 100}%`);
    paint();
    inp.addEventListener('input', () => { out.textContent = fmt(Number(inp.value)); paint(); });
    inp.addEventListener('change', () => onSet(Number(inp.value)));
    return this.row(label, h('div', { class: 'rft-rangewrap' }, inp, out));
  }

  private refocus(groupLabel: string, v: string): void {
    requestAnimationFrame(() => {
      const g = [...this.screenEl.querySelectorAll<HTMLElement>('.rft-segs')].find((x) => x.dataset.label === groupLabel);
      g?.querySelector<HTMLElement>(`[data-v="${CSS.escape(v)}"]`)?.focus();
    });
  }

  private bindingsTable(): HTMLElement {
    const inp = this.opts.input;
    const wrap = h('div', { class: 'rft-bindings' });
    if (!inp) { wrap.append(h('p', { class: 'rft-note', text: 'Steuerung wird im Spiel angezeigt.' })); return wrap; }
    const b = inp.getBindings();
    const groups = new Map<string, ControlId[]>();
    for (const id of CONTROL_IDS) { const g = CONTROL_META[id].group; groups.set(g, [...(groups.get(g) ?? []), id]); }
    const table = h('table', { class: 'rft-bindtable' },
      h('thead', null, h('tr', null, h('th', { text: 'Aktion' }), h('th', { text: 'Taste 1' }), h('th', { text: 'Taste 2' }), h('th', { text: 'Gamepad' }))));
    const tbody = h('tbody');
    for (const [g, ids] of groups) {
      tbody.append(h('tr', { class: 'grp' }, h('th', { colspan: '4', text: g })));
      for (const id of ids) {
        const keyCell = (slot: number) => {
          const code = b[id].keys[slot];
          const btn = h('button', { class: 'rft-keycap', 'aria-label': `${CONTROL_META[id].label}, Taste ${slot + 1}: ${code ? inp.keyLabel(code) : 'frei'}. Zum Ändern drücken.` }, code ? inp.keyLabel(code) : '—');
          btn.onclick = async () => {
            this.capturing = true;
            btn.textContent = 'Taste drücken …'; btn.classList.add('capturing');
            const got = await inp.captureKey();
            this.capturing = false;
            if (got === 'Backspace' || got === 'Delete') inp.clearBinding(id, 'key', slot);
            else if (got) {
              const stolen = inp.bindKey(id, got, slot);
              if (stolen.length) this.toast(`${inp.keyLabel(got)} entfernt von: ${stolen.map((s) => CONTROL_META[s].label).join(', ')}`);
            }
            this.render();
          };
          return h('td', null, btn);
        };
        const padCode = b[id].pad[0];
        const padBtn = h('button', { class: 'rft-keycap pad', 'aria-label': `${CONTROL_META[id].label}, Gamepad: ${padCode ? inp.padLabel(padCode) : 'frei'}` }, padCode ? inp.padLabel(padCode) : '—');
        padBtn.onclick = async () => {
          this.capturing = true;
          padBtn.textContent = 'Gamepad-Taste …'; padBtn.classList.add('capturing');
          const got = await inp.capturePad();
          this.capturing = false;
          if (got) {
            const stolen = inp.bindPad(id, got, 0);
            if (stolen.length) this.toast(`${inp.padLabel(got)} entfernt von: ${stolen.map((s) => CONTROL_META[s].label).join(', ')}`);
          }
          this.render();
        };
        tbody.append(h('tr', null, h('td', { text: CONTROL_META[id].label }), keyCell(0), keyCell(1), h('td', null, padBtn)));
      }
    }
    table.append(tbody);
    wrap.append(
      h('div', { class: 'rft-bindhead' }, h('span', { text: 'Belegung · Feld wählen und neue Taste drücken (Rücktaste = löschen, Esc = abbrechen)' }),
        h('button', { class: 'rft-ghost', onclick: () => { inp.resetBindings(); this.render(); } }, 'Standardbelegung')),
      table);
    return wrap;
  }

  private toast(msg: string): void {
    const t = h('div', { class: 'rft-toast', role: 'status', text: msg });
    this.el.append(t);
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => t.remove(), 3200);
  }

  // ------------------------------------------------------------------ help
  private helpView(): HTMLElement {
    const inp = this.opts.input;
    const groups = new Map<string, ControlId[]>();
    for (const id of CONTROL_IDS) { const g = CONTROL_META[id].group; groups.set(g, [...(groups.get(g) ?? []), id]); }
    const cols = [...groups].map(([g, ids]) => h('div', { class: 'rft-helpcol' },
      h('h3', { text: g }),
      h('dl', null, ...ids.flatMap((id) => {
        const b = inp?.getBindings()[id];
        const keys = b ? b.keys.map((k) => inp!.keyLabel(k)) : [];
        const pad = b?.pad[0] ? inp!.padLabel(b.pad[0]) : '';
        return [h('dt', { text: CONTROL_META[id].label }), h('dd', null, ...keys.map((k) => h('kbd', { text: k })), pad ? h('kbd', { class: 'pad', text: pad }) : null)];
      }))));
    const hudItems: Array<[string, string]> = [
      ['G-FORCE', 'Gefilterte Beschleunigung (10 Hz), wie ein Beschleunigungsmesser. Skala bis 4 g.'],
      ['Lage-Kugel', 'Das Auto in seiner Lage zum Horizont (Pitch und Roll; der Kurs ist herausgerechnet).'],
      ['Draufsicht', 'Die 10 Düsen: 4 Heck (Boost), 4 Hubdüsen an den Ecken, 2 Gierdüsen vorn. Helligkeit = Ventilöffnung.'],
      ['ALTITUDE', 'Unterster Karosseriepunkt über dem Boden. Skala bis 75 ft (23 m).'],
      ['DOWNFORCE · PITCH', 'Auf der Wandrampe: Ansaugkraft der Lüfter plus Aero in kg, Pitch bis 180°.'],
    ];
    return h('section', { class: 'rft-page rft-help', 'data-title': 'Hilfe und Steuerung' },
      this.header('Hilfe & Steuerung', 'Belegung ändern unter Einstellungen → Steuerung.'),
      h('div', { class: 'rft-helpgrid' }, ...cols,
        h('div', { class: 'rft-helpcol hud' }, h('h3', { text: 'HUD' }), h('dl', null, ...hudItems.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { class: 'txt', text: v })])))),
      h('div', { class: 'rft-actions' }, h('button', { class: 'rft-primary', 'data-autofocus': true, onclick: () => this.back() }, 'Verstanden')));
  }

  // ------------------------------------------------------------------ results
  private resultsView(): HTMLElement {
    const r = this.lastResult;
    if (!r) return h('div');
    const units = this.opts.settings.get().units;
    const reason = reasonText(r.reason);
    const info = r.stunt ? stuntInfo(r.stunt) : null;
    const site = r.stunt ? TRACK.sites.find((s) => s.stunt === r.stunt) : undefined;

    // metrics table (reference keys first, then extra sim metrics)
    // only metrics with a German label are shown (never raw keys)
    const keys = [...new Set([...Object.keys(site?.reference ?? {}), ...Object.keys(r.metrics)])].filter((k) => REFERENCE_LABEL[k]);
    const rows = keys.map((k) => {
      const meta = REFERENCE_LABEL[k] ?? { label: k, unit: '' };
      const sim = r.metrics[k];
      const ref = site?.reference[k];
      const g = sim !== undefined && ref !== undefined ? grade(sim, ref, k === 'zeroToSixtyS' ? 0.12 : 0.15) : null;
      return h('tr', null,
        h('td', { text: meta.label }),
        h('td', { class: 'num', text: sim !== undefined ? fmtRef(k, sim, units).value + ' ' + fmtRef(k, sim, units).unit : '–' }),
        h('td', { class: 'num ref', text: ref !== undefined ? fmtRef(k, ref, units).value + ' ' + fmtRef(k, ref, units).unit : '–' }),
        h('td', null, g ? h('span', { class: `rft-badge ${g.level}`, text: devText(g.ratio) }) : null));
    });

    const canvas = h('canvas', { class: 'rft-chart', role: 'img', 'aria-label': 'Telemetrie-Diagramm Simulation gegen Tesla-Stream' }) as HTMLCanvasElement;
    const panels = this.chartPanels(r, units);
    const redraw = () => drawChart(canvas, panels.panels);
    requestAnimationFrame(redraw);
    loadFonts().then(() => requestAnimationFrame(redraw));
    const ro = new ResizeObserver(redraw); ro.observe(canvas);
    this.chartCleanup = () => ro.disconnect();

    const nextStunt = r.stunt ? STUNTS[(STUNTS.findIndex((s) => s.id === r.stunt) + 1) % STUNTS.length].id : null;
    const btn = (label: string, fn: () => void, cls = 'rft-ghost', auto = false) => h('button', { class: cls, onclick: () => { this.emit('uiSound', 'select'); fn(); }, 'data-autofocus': auto || null }, label);
    return h('section', { class: `rft-page rft-results ${r.success ? 'ok' : 'fail'}`, 'data-title': 'Ergebnis' },
      h('header', { class: 'rft-result-head' },
        h('p', { class: 'rft-eyebrow', text: r.mode === 'auto' ? `Autopilot · ${info?.title ?? ''}` : `Freies Testen${info ? ' · ' + info.title : ''}` }),
        h('h2', { class: 'rft-result-title', text: r.success ? 'Stunt geschafft' : 'Fehlgeschlagen' }),
        reason ? h('p', { class: 'rft-result-reason', text: reason }) : null),
      h('div', { class: 'rft-result-grid' },
        h('div', { class: 'rft-result-metrics' },
          h('h3', { class: 'rft-subhead', text: 'Kennzahlen' }),
          h('table', { class: 'rft-metrics' },
            h('thead', null, h('tr', null, h('th', { text: 'Kennzahl' }), h('th', { text: 'Simulation' }), h('th', { text: 'Tesla-Stream' }), h('th', { text: 'Abw.' }))),
            h('tbody', null, ...rows)),
          h('p', { class: 'rft-note dim', text: 'Grün: innerhalb ±15 %, gelb: ±30 %. Referenz: HUD-Werte aus dem Livestream vom 15.10.2026.' })),
        h('div', { class: 'rft-result-chart' },
          h('div', { class: 'rft-legend' }, h('span', { class: 'sim', text: 'Simulation' }), panels.hasRef ? h('span', { class: 'ref', text: 'Tesla-Stream' }) : null,
            panels.note ? h('span', { class: 'note', text: panels.note }) : null),
          canvas)),
      h('div', { class: 'rft-actions' },
        btn('Wiederholen', () => { this.hide(); this.emit('restart', undefined); }, 'rft-primary', true),
        r.mode === 'auto' && nextStunt ? btn('Nächster Stunt', () => { this.hide(); this.emit('startStunt', nextStunt); }) : null,
        btn('Stunt-Auswahl', () => this.show('stunts')),
        btn('Hauptmenü', () => { this.emit('quitToTitle', undefined); this.show('title'); })));
  }

  private chartPanels(r: ResultData, units: Units): { panels: ChartPanel[]; hasRef: boolean; note: string } {
    const ref = r.stunt ? VIDEO_REFERENCE[r.stunt] : undefined;
    const defs = seriesToPlot(ref, r.telemetry);
    let t0 = r.startT;
    let note = '';
    if (t0 === undefined) {
      t0 = r.telemetry[0]?.t ?? 0;
      if (ref?.length && r.telemetry.length > 2) {
        const alt = SERIES[0];
        const simAll = simSeries(r.telemetry, alt, 'metric', 0, 800);
        const refAlt = refSeries(ref, alt, 'metric');
        const tEnd = r.telemetry[r.telemetry.length - 1].t;
        t0 = bestOffset(simAll, refAlt, [r.telemetry[0].t - 5, tEnd], 0.05);
        note = 'Zeitachse automatisch ausgerichtet';
      }
    }
    const panels = defs.map((d) => ({ label: d.label, unit: d.unit(units), sim: simSeries(r.telemetry, d, units, t0!), ref: ref ? refSeries(ref, d, units) : [] }));
    let hasRef = !!ref?.length;
    if (r.stunt === 'zero60') {
      // no video curve for the drag run: plot speed with the Tesla target point (60 mph at 0.81 s)
      const target = TRACK.sites.find((x) => x.stunt === 'zero60')?.reference.zeroToSixtyS ?? 0.81;
      panels.unshift({ label: 'Tempo', unit: SPEED_SERIES.unit(units), sim: simSeries(r.telemetry, SPEED_SERIES, units, t0!), ref: [{ t: 0, v: 0 }, { t: target, v: units === 'imperial' ? 60 : 96.56 }] });
      hasRef = true;
    }
    return { panels, hasRef, note };
  }

  // ------------------------------------------------------------------ navigation
  private focusables(): HTMLElement[] {
    return [...this.screenEl.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, [tabindex]:not([tabindex="-1"])')]
      .filter((e) => e.offsetParent !== null || e === document.activeElement);
  }

  private moveFocus(dir: 'up' | 'down' | 'left' | 'right'): void {
    const list = this.focusables();
    if (!list.length) return;
    const a = document.activeElement as HTMLElement | null;
    if (!a || !list.includes(a)) { list[0].focus(); return; }
    const r0 = a.getBoundingClientRect();
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const el of list) {
      if (el === a) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const dx = x - cx, dy = y - cy;
      const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
      const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      if (along <= 4) continue;
      const score = along + across * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (!best) {
      // wrap around in list order for vertical lists
      const i = list.indexOf(a);
      if (dir === 'down' || dir === 'right') best = list[(i + 1) % list.length];
      else best = list[(i - 1 + list.length) % list.length];
    }
    best.focus();
    best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.emit('uiSound', 'move');
  }

  private cycleTab(d: number): void {
    if (this.screen === 'worlds') {
      const ids = BODIES.map((b) => b.id);
      this.worldBody = ids[(ids.indexOf(this.worldBody) + d + ids.length) % ids.length];
      this.emit('uiSound', 'move');
      this.render();
      return;
    }
    if (this.screen !== 'settings') return;
    const order: SettingsTab[] = ['grafik', 'anzeige', 'audio', 'steuerung', 'simulation'];
    this.settingsTab = order[(order.indexOf(this.settingsTab) + d + order.length) % order.length];
    this.emit('uiSound', 'move');
    this.render();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.isOpen() || this.capturing) return;
    const a = document.activeElement as HTMLElement | null;
    const isRange = a instanceof HTMLInputElement && a.type === 'range';
    switch (e.key) {
      case 'Escape': e.preventDefault(); this.back(); break;
      case 'ArrowUp': case 'ArrowDown':
        e.preventDefault(); this.moveFocus(e.key === 'ArrowUp' ? 'up' : 'down'); break;
      case 'ArrowLeft': case 'ArrowRight':
        if (isRange) return; // native slider handling
        if (a?.getAttribute('role') === 'tab') { e.preventDefault(); this.cycleTab(e.key === 'ArrowRight' ? 1 : -1); return; }
        e.preventDefault(); this.moveFocus(e.key === 'ArrowLeft' ? 'left' : 'right'); break;
      case 'PageUp': case 'PageDown': if (this.screen === 'settings' || this.screen === 'worlds') { e.preventDefault(); this.cycleTab(e.key === 'PageDown' ? 1 : -1); } break;
    }
  }
}

// ------------------------------------------------------------------ formatting helpers
const pct = (v: number) => `${Math.round(v * 100)} %`;
const devText = (ratio: number) => {
  const d = Math.round((ratio - 1) * 100);
  return d === 0 ? '±0 %' : `${d > 0 ? '+' : '−'}${Math.abs(d)} %`;
};

export function fmtRef(key: string, v: number, units: Units): { value: string; unit: string } {
  const kind = REFERENCE_LABEL[key]?.kind;
  switch (kind) {
    case 'alt': return units === 'imperial' ? { value: fmtDe(v / FT, 1), unit: 'ft' } : { value: fmtDe(v, 1), unit: 'm' };
    case 'deg': return { value: fmtDe(v, 0), unit: '°' };
    case 'g': return { value: fmtDe(v, 1), unit: 'g' };
    case 'kg': return { value: Math.round(v).toLocaleString('de-DE'), unit: 'kg' };
    case 'kg1': return { value: fmtDe(v, v < 100 ? 1 : 0), unit: 'kg' };
    case 's': return { value: fmtDe(v, v < 10 ? 2 : 0), unit: 's' };
    default: return { value: fmtDe(v, 2), unit: REFERENCE_LABEL[key]?.unit ?? '' };
  }
}

export function referenceChips(ref: Record<string, number>, units: Units): Array<{ value: string; label: string }> {
  return Object.entries(ref).map(([k, v]) => {
    const f = fmtRef(k, v, units);
    return { value: `${f.value}${f.unit === '°' ? '°' : ' ' + f.unit}`, label: REFERENCE_LABEL[k]?.label ?? k };
  });
}
