// Minimal HUD panel for the Sun scene ("Sun dive"): distance, fall speed, surface temperature, stage, warp.
// Keys: Enter = start the dive, PageUp/PageDown = time warp ×10 / ÷10.
import { AU, STAGES, SunDive } from './sun';
import { fmtNum, onLocaleChange, t, tn, type MsgKey } from '../i18n';

const fmt = (v: number, d = 1) => fmtNum(v, d);

export class SunPanel {
  readonly el: HTMLDivElement;
  dive: SunDive | null = null;
  private lines: Record<string, HTMLSpanElement> = {};
  private offLocale: () => void;
  private onKey = (e: KeyboardEvent) => {
    if (e.code === 'Enter' && !this.dive) { this.start(); e.preventDefault(); }
    if (this.dive && e.code === 'PageUp') { this.dive.warp = Math.min(1e7, this.dive.warp * 10); e.preventDefault(); }
    if (this.dive && e.code === 'PageDown') { this.dive.warp = Math.max(1e3, this.dive.warp / 10); e.preventDefault(); }
  };

  constructor(root: HTMLElement, private onStage: (label: string, final: boolean) => void) {
    this.el = document.createElement('div');
    this.el.className = 'rft-sunpanel';
    this.el.style.cssText = [
      'position:absolute', 'top:72px', 'left:50%', 'transform:translateX(-50%)', 'min-width:380px',
      'padding:12px 18px', 'background:rgba(0,0,0,.45)', 'border:1px solid rgba(255,255,255,.18)',
      'color:#fff', 'font:600 13px/1.5 "RFT Display",system-ui,"Noto Sans",sans-serif', 'letter-spacing:.06em',
      'text-transform:uppercase', 'pointer-events:none', 'backdrop-filter:blur(4px)',
    ].join(';');
    root.appendChild(this.el);
    this.build();
    this.offLocale = onLocaleChange(() => this.build());
    window.addEventListener('keydown', this.onKey);
  }

  /** (Re)build the static captions in the current language. */
  private build(): void {
    this.el.replaceChildren();
    this.lines = {};
    const row = (key: string, label: string) => {
      const d = document.createElement('div');
      d.style.cssText = 'display:flex;justify-content:space-between;gap:24px';
      const a = document.createElement('span'); a.textContent = label; a.style.opacity = '.65';
      const b = document.createElement('span'); this.lines[key] = b; b.dataset.k = key;
      d.append(a, b); this.el.append(d);
    };
    const title = document.createElement('div');
    title.textContent = t('sun.title');
    title.style.cssText = 'font-size:15px;margin-bottom:6px;color:#ffb36b';
    this.el.append(title);
    const rows: Array<[string, MsgKey]> = [['state', 'sun.state'], ['dist', 'sun.dist'], ['speed', 'sun.speed'], ['temp', 'sun.temp'], ['stage', 'sun.stage'], ['warp', 'sun.warp']];
    for (const [k, m] of rows) row(k, t(m));
    const note = document.createElement('div');
    note.textContent = t('sun.note');
    note.style.cssText = 'margin-top:8px;font:400 11px/1.4 system-ui,"Noto Sans",sans-serif;text-transform:none;letter-spacing:0;opacity:.6;max-width:380px';
    this.el.append(note);
    this.render();
  }

  start(): void {
    this.dive = new SunDive(1.0);
    this.dive.warp = 1e5;
  }

  /** Advance with real frame time; returns the current surface temperature (K) for the heat effects. */
  update(dtReal: number): number {
    if (this.dive) {
      for (const st of this.dive.update(dtReal)) this.onStage(st.label, st.id === STAGES[STAGES.length - 1].id || this.dive.state.done);
    }
    this.render();
    return this.dive?.state.tempK ?? 230;
  }

  private render(): void {
    const d = this.dive;
    if (!d) {
      this.lines.state.textContent = t('sun.ready');
      this.lines.dist.textContent = `${fmt(1, 2)} ${t('unit.au')}`; this.lines.speed.textContent = '0 km/s';
      this.lines.temp.textContent = '230 K'; this.lines.stage.textContent = '–'; this.lines.warp.textContent = '–';
      return;
    }
    const s = d.state;
    this.lines.state.textContent = s.done ? t('sun.vaporised') : tn('sun.tplus', s.t / 86400, { n: fmt(s.t / 86400, 1) });
    this.lines.dist.textContent = `${fmt(s.r / AU, 3)} ${t('unit.au')}`;
    this.lines.speed.textContent = `${fmt(s.v / 1000, 1)} km/s`;
    this.lines.temp.textContent = `${fmt(s.tempK, 0)} K`;
    this.lines.stage.textContent = d.events.length ? d.events[d.events.length - 1].label : '–';
    this.lines.warp.textContent = `×${d.warp.toExponential(0).replace('e+', 'e')}  ${t('sun.warpKeys')}`;
  }

  dispose(): void { this.offLocale(); window.removeEventListener('keydown', this.onKey); this.el.remove(); }
}
