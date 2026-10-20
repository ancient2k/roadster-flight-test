// small panel in the Sun scene – how ramming Roadster 1 changed its heliocentric orbit (src/game/orbit.ts).
import { AU_M, ROADSTER1_MASS_KG, ROADSTER1_STACK_KG, ROADSTER1_STATE, orbitAfterDv, stackEquivalentDv, type RamResult, type V } from './orbit';
import { fmtNum, onLocaleChange, t, tn, type MsgKey } from '../i18n';

const fmt = (v: number, d = 1) => fmtNum(v, d);
const days = (d: number) => tn('unit.days', d, { n: fmt(d, 2) });
const sgn = (v: number, d = 1) => (v >= 0 ? '+' : '−') + fmt(Math.abs(v), d);
/** Below this Δv (m/s) the drift of the scene counts as "not rammed". */
const MIN_DV = 0.002;

export class OrbitPanel {
  readonly el: HTMLDivElement;
  private lines: Record<string, HTMLSpanElement> = {};
  private last: { r: RamResult | null; m: number } = { r: null, m: 0 };
  private offLocale: () => void;
  /** Latest result (null until rammed) – read by tests. */
  result: RamResult | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'rft-orbitpanel';
    this.el.style.cssText = [
      'position:absolute', 'top:84px', 'left:24px', 'min-width:330px',
      'padding:12px 18px', 'background:rgba(0,0,0,.45)', 'border:1px solid rgba(255,255,255,.18)',
      'color:#fff', 'font:600 13px/1.5 "RFT Display",system-ui,"Noto Sans",sans-serif', 'letter-spacing:.06em',
      'text-transform:uppercase', 'pointer-events:none', 'backdrop-filter:blur(4px)',
    ].join(';');
    root.appendChild(this.el);
    this.build();
    this.offLocale = onLocaleChange(() => this.build());
  }

  /** (Re)build the static captions in the current language. */
  private build(): void {
    this.el.replaceChildren();
    this.lines = {};
    const title = document.createElement('div');
    title.textContent = t('orbit.title');
    title.style.cssText = 'font-size:15px;margin-bottom:6px;color:#ff6b6b';
    this.el.append(title);
    const row = (key: string, label: string) => {
      const d = document.createElement('div');
      d.style.cssText = 'display:flex;justify-content:space-between;gap:24px';
      const a = document.createElement('span'); a.textContent = label; a.style.opacity = '.65';
      const b = document.createElement('span'); this.lines[key] = b; b.dataset.k = key;
      d.append(a, b); this.el.append(d);
    };
    const rows: Array<[string, MsgKey]> = [['state', 'orbit.state'], ['dv', 'orbit.dv'], ['dir', 'orbit.dir'], ['peri', 'orbit.peri'], ['aph', 'orbit.aph'], ['ecc', 'orbit.ecc'], ['per', 'orbit.period']];
    for (const [k, m] of rows) row(k, t(m));
    row('stack', t('orbit.stack', { mass: fmt(ROADSTER1_STACK_KG / 1000, 1) }));
    const note = document.createElement('div');
    note.textContent = t('orbit.note', { epoch: ROADSTER1_STATE.epoch, mass: fmt(ROADSTER1_MASS_KG, 0), stack: fmt(ROADSTER1_STACK_KG / 1000, 1), small: fmt(0.001, 3) });
    note.style.cssText = 'margin-top:8px;font:400 11px/1.4 system-ui,"Noto Sans",sans-serif;text-transform:none;letter-spacing:0;opacity:.6;max-width:330px';
    this.el.append(note);
    this.render(this.last.r, this.last.m);
  }

  /** dv = Roadster 1's velocity change since the start (scene frame, m/s); playerMassKg for the stack estimate. */
  update(dv: V, playerMassKg: number): void {
    const m = Math.hypot(dv.x, dv.y, dv.z);
    this.result = m > MIN_DV ? orbitAfterDv(dv) : null;
    this.render(this.result, playerMassKg);
  }

  private render(r: RamResult | null, playerMassKg: number): void {
    this.last = { r, m: playerMassKg };
    const L = this.lines;
    const au = t('unit.au');
    const b = r?.before ?? orbitAfterDv({ x: 0, y: 0, z: 0 }).before;
    if (!r) {
      L.state.textContent = t('orbit.idle');
      L.dv.textContent = '0 m/s'; L.dir.textContent = '–';
      L.peri.textContent = `${fmt(b.q / AU_M, 4)} ${au}`; L.aph.textContent = `${fmt(b.Q / AU_M, 4)} ${au}`;
      L.ecc.textContent = fmt(b.e, 5); L.per.textContent = days(b.periodS / 86400); L.stack.textContent = '–';
      return;
    }
    const a = r.after;
    L.state.textContent = t('orbit.rammed');
    L.dv.textContent = `${fmt(r.dvMag, 3)} m/s`;
    L.dir.textContent = `${sgn(r.prograde, 2)} / ${sgn(r.radial, 2)} / ${sgn(r.normal, 2)}`;
    const km = (x: number) => sgn(x / 1000, 0) + ' km';
    L.peri.textContent = `${fmt(a.q / AU_M, 4)} ${au} (${km(a.q - b.q)})`;
    L.aph.textContent = `${fmt(a.Q / AU_M, 4)} ${au} (${km(a.Q - b.Q)})`;
    L.ecc.textContent = `${fmt(a.e, 5)} (${sgn(a.e - b.e, 5)})`;
    L.per.textContent = `${days(a.periodS / 86400)} (${sgn((a.periodS - b.periodS) / 3600, 1)} h)`;
    const s = orbitAfterDv(stackEquivalentDv(r.dv, playerMassKg));
    L.stack.textContent = `Δv ${fmt(s.dvMag, 3)} m/s, ${sgn((s.after.periodS - s.before.periodS) / 3600, 1)} h`;
  }

  dispose(): void { this.offLocale(); this.el.remove(); }
}
