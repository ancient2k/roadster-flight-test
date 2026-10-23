// Time-trial display of a track-editor level: clock, penalty, sections and best time at the top (the Starship launch
// countdown below it is src/editor/launchHud.ts). Plain DOM over the canvas; texts from src/editor/i18n.ts.
import { et } from './i18n';
import type { LevelRun } from '../game/levelRun';

const CSS = `
.rfth{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:20;display:flex;flex-direction:column;align-items:center;gap:6px;
  pointer-events:none;font:700 15px/1.2 ui-monospace,"Courier New",monospace;color:#fff;text-shadow:0 1px 2px #000}
.rfth-row{display:flex;gap:16px;padding:4px 12px;background:rgba(0,0,40,.55);border:1px solid rgba(255,255,255,.25)}
.rfth-row b{color:#ffff55;font-weight:700}
.rfth-pen{color:#ff7a6a}
.rfth-row.hidden{display:none}
`;

export const fmtTime = (s: number): string => {
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
};

export class RaceHud {
  private el: HTMLDivElement;
  private row: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'rfth';
    const st = document.createElement('style');
    st.textContent = CSS;
    this.row = document.createElement('div');
    this.row.className = 'rfth-row';
    this.el.append(st, this.row);
    root.appendChild(this.el);
  }

  update(run: LevelRun): void {
    if (run.course) {
      const best = run.best();
      this.row.classList.remove('hidden');
      this.row.innerHTML = '';
      const add = (label: string, value: string, cls = '') => {
        const s = document.createElement('span');
        if (cls) s.className = cls;
        s.append(`${label} `);
        const b = document.createElement('b'); b.textContent = value; s.append(b);
        this.row.append(s);
      };
      add(et('race.time'), fmtTime(run.t));
      if (run.penalty > 0) add(et('race.penalty'), `+${run.penalty.toFixed(1)}`, 'rfth-pen');
      add('', `${Math.min(run.progress + 1, run.sections)}/${run.sections}`);
      if (best) add(et('race.best'), fmtTime(best));
    } else this.row.classList.add('hidden');
  }

  dispose(): void { this.el.remove(); }
}
