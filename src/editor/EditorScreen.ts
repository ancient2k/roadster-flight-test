// Track editor (docs/EDITOR.md): a 2D top view of the Boca Chica build area in the look of a 1990 DOS game. Pieces
// snap to the 20 m tiles, decoration is placed freely; levels live in the browser, as .json files and in share links.
// DOM-only module, loaded on demand from the title menu; the 3D test drive is App.playLevel.
import { PARTS, DECO_TYPES, partDef, type PartType, type DecoType } from '../shared/parts';
import { canPlace, emptyLevel, levelToJson, partAt, partTiles, validateLevel, type Level, type LevelPart, type Rot, type GridSize } from '../shared/level';
import { et, type EditorKey } from './i18n';
import { VGA, pixelTitle, partIcon, decoColour } from './retro';
import { deleteLevel, lastLevelId, listLevels, loadLevel, saveLevel } from './storage';
import { decodeLevel, shareUrl, trackCodeFromHash } from './share';
import { SAMPLE_LEVELS } from './samples';
import { buildCourse, drawRot } from '../shared/course';

export interface EditorHost {
  /** Drive the level in 3D (resolves when the world is ready). */
  testDrive(level: Level): Promise<void>;
  /** Leave the editor to the title menu. */
  exit(): void;
}

type Tool = { kind: 'part'; type: PartType } | { kind: 'deco'; type: DecoType } | { kind: 'erase' };
type Group = 'road' | 'stunt' | 'special' | 'deco';

const GRID: GridSize = { nx: 48, nz: 36 };
const CSS = `
.rfte{position:fixed;inset:0;z-index:40;display:grid;grid-template:auto 1fr auto/220px 1fr;background:${VGA.navy};color:${VGA.white};
  font:700 13px/1.25 ui-monospace,"Courier New",monospace;user-select:none;-webkit-user-select:none}
.rfte *{box-sizing:border-box}
.rfte-pixel{image-rendering:pixelated;image-rendering:crisp-edges}
.rfte-bar{grid-column:1/3;display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:4px 6px;background:${VGA.grey};color:${VGA.black};border-bottom:2px solid ${VGA.black}}
.rfte-btn{font:inherit;text-transform:uppercase;letter-spacing:.04em;padding:4px 8px;cursor:pointer;color:${VGA.black};background:${VGA.grey};
  border:2px solid;border-color:${VGA.white} ${VGA.dkgrey} ${VGA.dkgrey} ${VGA.white}}
.rfte-btn:active,.rfte-btn.on{border-color:${VGA.dkgrey} ${VGA.white} ${VGA.white} ${VGA.dkgrey};background:#c8c8c8}
.rfte-btn.hot{background:${VGA.yellow}}
.rfte-name{font:inherit;width:14em;padding:3px 6px;background:${VGA.black};color:${VGA.ltgreen};border:2px inset ${VGA.dkgrey}}
.rfte-side{overflow:auto;padding:6px;background:${VGA.navy};border-right:2px solid ${VGA.black}}
.rfte-tabs{display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-bottom:6px}
.rfte-pal{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.rfte-item{display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px 2px;cursor:pointer;color:${VGA.white};background:#000066;
  border:2px solid;border-color:${VGA.blue} ${VGA.black} ${VGA.black} ${VGA.blue};font-size:11px;text-align:center}
.rfte-item.on{background:${VGA.cyan};color:${VGA.black}}
.rfte-item canvas{width:48px;height:auto;max-height:56px;object-fit:contain}
.rfte-tools{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}
.rfte-main{position:relative;overflow:hidden;background:${VGA.black};cursor:crosshair}
.rfte-main canvas{position:absolute;inset:0;width:100%;height:100%}
.rfte-status{grid-column:1/3;display:flex;justify-content:space-between;gap:12px;padding:3px 8px;background:${VGA.cyan};color:${VGA.black};font-size:12px}
.rfte-msg{color:${VGA.navy}}
.rfte-dlg{position:absolute;inset:0;z-index:5;display:grid;place-items:center;background:rgba(0,0,40,.6)}
.rfte-box{min-width:min(560px,92vw);max-height:84vh;overflow:auto;padding:14px 16px;background:${VGA.grey};color:${VGA.black};
  border:3px solid;border-color:${VGA.white} ${VGA.dkgrey} ${VGA.dkgrey} ${VGA.white};box-shadow:8px 8px 0 ${VGA.black}}
.rfte-box h3{margin:0 0 8px;padding:3px 6px;background:${VGA.navy};color:${VGA.yellow};font-size:14px;text-transform:uppercase}
.rfte-list{list-style:none;margin:0 0 10px;padding:0}
.rfte-list li{display:flex;gap:6px;align-items:center;justify-content:space-between;padding:3px 4px;border-bottom:1px solid ${VGA.dkgrey}}
.rfte-list li:hover{background:${VGA.ltcyan}}
.rfte-entry{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;
  background:linear-gradient(${VGA.black} 0 55%,#2b0a3d 70%,#a8326a 82%,#ff9a3c 92%,#ffd23c 100%)}
.rfte-entry .rfte-box{min-width:min(460px,92vw)}
.rfte-opt{display:flex;gap:6px;align-items:center;margin-top:6px;font-size:12px}
.rfte-opt input{width:5em;font:inherit}
@media (max-width:760px){.rfte{grid-template:auto 1fr auto/150px 1fr}.rfte-item canvas{width:36px}}
`;

export class EditorScreen {
  readonly el: HTMLDivElement;
  private level: Level;
  private levelId: string | null = null;
  private tool: Tool = { kind: 'part', type: 'road' };
  private rot: Rot = 0;
  private lv: 0 | 1 = 0;
  private opt = 60;
  private group: Group = 'road';
  private canvas!: HTMLCanvasElement;
  private main!: HTMLDivElement;
  private side!: HTMLDivElement;
  private nameInput!: HTMLInputElement;
  private status!: HTMLSpanElement;
  private msg!: HTMLSpanElement;
  private hover: { x: number; z: number } | null = null;
  private view = { scale: 16, ox: 20, oz: 20 };
  private undo: string[] = [];
  private redo: string[] = [];
  private dirty = false;
  private pan: { x: number; y: number; ox: number; oz: number } | null = null;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private ro: ResizeObserver | null = null;

  constructor(private host: EditorHost, root: HTMLElement) {
    this.level = emptyLevel(et('editor.untitled'));
    this.el = document.createElement('div');
    this.el.className = 'rfte';
    const style = document.createElement('style');
    style.textContent = CSS;
    this.el.appendChild(style);
    this.build();
    root.appendChild(this.el);
    window.addEventListener('keydown', this.keyHandler);
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.main);
    void this.start();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.ro?.disconnect();
    this.el.remove();
  }

  get visible(): boolean { return this.el.style.display !== 'none'; }
  show(): void { this.el.style.display = ''; this.draw(); }
  hide(): void { this.el.style.display = 'none'; }
  get current(): Level { return this.level; }

  // ------------------------------------------------------------------ start: share link, last level or entry screen
  private async start(): Promise<void> {
    const code = trackCodeFromHash();
    if (code) {
      try {
        const r = await decodeLevel(code, GRID);
        this.setLevel(r.level, null);
        if (r.dropped) this.say(et('editor.dropped', { n: r.dropped }));
        history.replaceState(null, '', location.pathname + location.search);
        return;
      } catch (e) { this.say(et('editor.loadFailed', { error: String((e as Error).message ?? e) })); }
    }
    this.entryScreen();
  }

  // ------------------------------------------------------------------ layout
  private build(): void {
    const bar = div('rfte-bar');
    bar.append(pixelTitle(et('editor.title').toUpperCase(), 2));
    this.nameInput = document.createElement('input');
    this.nameInput.className = 'rfte-name';
    this.nameInput.maxLength = 60;
    this.nameInput.setAttribute('aria-label', et('editor.name'));
    this.nameInput.addEventListener('input', () => { this.level.name = this.nameInput.value || et('editor.untitled'); this.dirty = true; });
    this.nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    bar.append(this.nameInput,
      btn(et('editor.new'), () => this.newLevel()),
      btn(et('editor.open'), () => this.openDialog()),
      btn(et('editor.save'), () => this.save()),
      btn(et('editor.download'), () => this.download()),
      btn(et('editor.upload'), () => this.upload()),
      btn(et('editor.share'), () => void this.share()),
      btn(et('editor.testDrive'), () => void this.testDrive(), 'hot'),
      btn(et('editor.back'), () => this.host.exit()));
    this.side = div('rfte-side');
    this.main = div('rfte-main');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'rfte-pixel';
    this.main.appendChild(this.canvas);
    const st = div('rfte-status');
    this.status = document.createElement('span');
    this.msg = document.createElement('span');
    this.msg.className = 'rfte-msg';
    st.append(this.status, this.msg);
    this.el.append(bar, this.side, this.main, st);
    this.renderPalette();
    this.wireCanvas();
    this.updateStatus();
  }

  private renderPalette(): void {
    this.side.textContent = '';
    const tabs = div('rfte-tabs');
    for (const g of ['road', 'stunt', 'special', 'deco'] as Group[]) {
      tabs.append(btn(et(`editor.group.${g}` as EditorKey), () => { this.group = g; this.renderPalette(); }, this.group === g ? 'on' : ''));
    }
    const pal = div('rfte-pal');
    if (this.group === 'deco') {
      for (const d of DECO_TYPES) {
        const it = div('rfte-item' + (this.tool.kind === 'deco' && this.tool.type === d ? ' on' : ''));
        const c = document.createElement('canvas'); c.width = 16; c.height = 16; c.className = 'rfte-pixel';
        const g = c.getContext('2d')!; g.fillStyle = decoColour(d); g.fillRect(4, 3, 8, 10);
        it.append(c, text(et(`deco.${d}` as EditorKey)));
        it.onclick = () => { this.tool = { kind: 'deco', type: d }; this.renderPalette(); this.draw(); };
        pal.append(it);
      }
    } else {
      for (const p of PARTS.filter((q) => q.group === this.group)) {
        const it = div('rfte-item' + (this.tool.kind === 'part' && this.tool.type === p.type ? ' on' : ''));
        const ic = partIcon(p.type, 0, 16);
        const c = document.createElement('canvas'); c.width = ic.width; c.height = ic.height; c.className = 'rfte-pixel';
        c.getContext('2d')!.drawImage(ic, 0, 0);
        it.append(c, text(et(`part.${p.type}` as EditorKey)));
        it.onclick = () => { this.tool = { kind: 'part', type: p.type }; if (p.opt) this.opt = p.opt.def; this.renderPalette(); this.draw(); };
        pal.append(it);
      }
    }
    const tools = div('rfte-tools');
    tools.append(
      btn(`${et('editor.rotate')} (R)`, () => this.rotate()),
      btn(`${et('editor.level')} ${this.lv} (E)`, () => this.toggleLevel(), this.lv ? 'on' : ''),
      btn(et('editor.erase'), () => { this.tool = { kind: 'erase' }; this.renderPalette(); }, this.tool.kind === 'erase' ? 'on' : ''));
    this.side.append(tabs, pal, tools);
    if (this.tool.kind === 'part') {
      const def = partDef(this.tool.type);
      if (def.opt) {
        const row = div('rfte-opt');
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = String(def.opt.min); inp.max = String(def.opt.max); inp.step = String(def.opt.step); inp.value = String(this.opt);
        inp.addEventListener('change', () => { this.opt = Math.min(def.opt!.max, Math.max(def.opt!.min, Number(inp.value) || def.opt!.def)); });
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        row.append(text(et('editor.countdown', { s: '' }).replace(/\s*s$/, '').trim()), inp, text('s'));
        this.side.append(row);
      }
    }
  }

  // ------------------------------------------------------------------ level state
  private setLevel(l: Level, id: string | null): void {
    this.level = l;
    this.levelId = id;
    this.nameInput.value = l.name;
    this.undo = []; this.redo = [];
    this.dirty = false;
    this.fit();
    this.draw();
    this.updateStatus();
  }

  private snapshot(): void {
    this.undo.push(levelToJson(this.level));
    if (this.undo.length > 200) this.undo.shift();
    this.redo = [];
    this.dirty = true;
  }

  private restore(json: string): void {
    const name = this.level.name;
    this.level = validateLevel(JSON.parse(json), GRID).level;
    this.level.name = name;
    this.draw();
    this.updateStatus();
  }

  private newLevel(): void {
    this.setLevel(emptyLevel(et('editor.untitled')), null);
    this.closeDialogs();
  }

  private save(): void {
    const id = saveLevel(this.level, this.levelId ?? undefined);
    if (id) { this.levelId = id; this.dirty = false; this.say(et('editor.saved')); }
  }

  private download(): void {
    const blob = new Blob([JSON.stringify(JSON.parse(levelToJson(this.level)), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(this.level.name || 'track').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40)}.rft-track.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  private upload(): void {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const r = validateLevel(JSON.parse(await f.text()), GRID);
        this.setLevel(r.level, null);
        this.say(r.dropped ? et('editor.dropped', { n: r.dropped }) : r.level.name);
        this.closeDialogs();
      } catch (e) { this.say(et('editor.loadFailed', { error: String((e as Error).message ?? e) })); }
    };
    inp.click();
  }

  private async share(): Promise<void> {
    try {
      const url = await shareUrl(this.level);
      await navigator.clipboard.writeText(url);
      this.say(et('editor.shareCopied'));
    } catch (e) { this.say(String((e as Error).message ?? e)); }
  }

  private async testDrive(): Promise<void> {
    this.closeDialogs();
    if (this.dirty || !this.levelId) this.save();
    await this.host.testDrive(this.level);
  }

  // ------------------------------------------------------------------ dialogs
  private closeDialogs(): void { this.el.querySelectorAll('.rfte-dlg,.rfte-entry').forEach((d) => d.remove()); }

  private trackList(onPick: () => void): HTMLElement {
    const box = document.createElement('div');
    const mine = listLevels();
    const h = (k: EditorKey) => { const e = document.createElement('h3'); e.textContent = et(k); return e; };
    box.append(h('editor.myTracks'));
    const ul = document.createElement('ul'); ul.className = 'rfte-list';
    if (!mine.length) ul.append(Object.assign(document.createElement('li'), { textContent: et('editor.empty') }));
    for (const e of mine) {
      const li = document.createElement('li');
      li.append(text(`${e.name}  ·  ${e.modified.slice(0, 10)}`));
      const right = document.createElement('span');
      right.append(btn(et('editor.open'), () => { const l = loadLevel(e.id, GRID); if (l) { this.setLevel(l, e.id); onPick(); } }),
        btn(et('editor.delete'), () => { if (confirm(et('editor.confirmDelete', { name: e.name }))) { deleteLevel(e.id); li.remove(); } }));
      li.append(right);
      ul.append(li);
    }
    box.append(ul, h('editor.samples'));
    const ul2 = document.createElement('ul'); ul2.className = 'rfte-list';
    for (const s of SAMPLE_LEVELS) {
      const li = document.createElement('li');
      li.append(text(s.name), btn(et('editor.open'), () => { this.setLevel(validateLevel(JSON.parse(JSON.stringify(s)), GRID).level, null); onPick(); }));
      ul2.append(li);
    }
    box.append(ul2);
    return box;
  }

  private openDialog(): void {
    this.closeDialogs();
    const dlg = div('rfte-dlg');
    const box = div('rfte-box');
    box.append(this.trackList(() => this.closeDialogs()), btn('OK', () => this.closeDialogs()));
    dlg.append(box);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) this.closeDialogs(); });
    this.main.append(dlg);
  }

  private entryScreen(): void {
    const ent = div('rfte-entry');
    ent.append(pixelTitle(et('editor.title').toUpperCase(), 6));
    const box = div('rfte-box');
    const row = div('rfte-tools');
    row.append(btn(et('editor.new'), () => this.newLevel(), 'hot'), btn(et('editor.upload'), () => this.upload()), btn(et('editor.back'), () => this.host.exit()));
    const last = lastLevelId();
    if (last && loadLevel(last, GRID)) row.prepend(btn(`${et('editor.open')}: ${loadLevel(last, GRID)!.name}`, () => { this.setLevel(loadLevel(last, GRID)!, last); this.closeDialogs(); }));
    box.append(row, this.trackList(() => this.closeDialogs()));
    ent.append(box);
    this.el.append(ent);
  }

  // ------------------------------------------------------------------ canvas
  private fit(): void {
    const w = this.main.clientWidth || 800, h = this.main.clientHeight || 600;
    const s = Math.max(6, Math.floor(Math.min((w - 20) / GRID.nx, (h - 20) / GRID.nz)));
    this.view = { scale: s, ox: Math.round((w - s * GRID.nx) / 2), oz: Math.round((h - s * GRID.nz) / 2) };
  }

  private toTile(ev: MouseEvent): { x: number; z: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left - this.view.ox) / this.view.scale, z: (ev.clientY - r.top - this.view.oz) / this.view.scale };
  }

  private wireCanvas(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointermove', (e) => {
      if (this.pan) {
        this.view.ox = this.pan.ox + (e.clientX - this.pan.x);
        this.view.oz = this.pan.oz + (e.clientY - this.pan.y);
        this.draw();
        return;
      }
      this.hover = this.toTile(e);
      this.draw();
      this.updateStatus();
    });
    c.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    c.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        this.pan = { x: e.clientX, y: e.clientY, ox: this.view.ox, oz: this.view.oz };
        c.setPointerCapture(e.pointerId);
        return;
      }
      const p = this.toTile(e);
      if (e.button === 2 || this.tool.kind === 'erase') this.eraseAt(p.x, p.z);
      else if (e.button === 0) this.placeAt(p.x, p.z);
    });
    c.addEventListener('pointerup', () => { this.pan = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const s0 = this.view.scale, s1 = Math.min(64, Math.max(6, Math.round(s0 * (e.deltaY < 0 ? 1.25 : 0.8))));
      this.view.ox = mx - (mx - this.view.ox) * s1 / s0;
      this.view.oz = my - (my - this.view.oz) * s1 / s0;
      this.view.scale = s1;
      this.draw();
    }, { passive: false });
  }

  /** Piece the current tool would place with its footprint's lower corner under the pointer tile. */
  private ghost(x: number, z: number): LevelPart | null {
    if (this.tool.kind !== 'part') return null;
    const def = partDef(this.tool.type);
    const [w, d] = this.rot % 2 === 0 ? [def.w, def.d] : [def.d, def.w];
    const p: LevelPart = { type: this.tool.type, i: Math.floor(x - (w - 1) / 2), j: Math.floor(z - (d - 1) / 2), rot: this.rot };
    if (this.lv && def.elevated) p.lv = 1;
    if (def.opt) p.opt = this.opt;
    return p;
  }

  private placeAt(x: number, z: number): void {
    if (this.tool.kind === 'deco') {
      if (x < 0 || z < 0 || x > GRID.nx || z > GRID.nz) return;
      this.snapshot();
      this.level.deco.push({ type: this.tool.type, x: Math.round(x * 20) / 20, z: Math.round(z * 20) / 20, rotDeg: this.rot * 90 });
      this.draw();
      return;
    }
    const p = this.ghost(x, z);
    if (!p) return;
    if (!canPlace(this.level, GRID, p)) { this.say(et('editor.blocked')); return; }
    this.snapshot();
    this.level.parts.push(p);
    this.draw();
    this.updateStatus();
  }

  private eraseAt(x: number, z: number): void {
    const near = this.level.deco.findIndex((d) => Math.hypot(d.x - x, d.z - z) < 0.35);
    if (near >= 0) { this.snapshot(); this.level.deco.splice(near, 1); this.draw(); return; }
    const i = Math.floor(x), j = Math.floor(z);
    let k = partAt(this.level, i, j, 1);
    if (k < 0) k = partAt(this.level, i, j, 0);
    if (k < 0) return;
    this.snapshot();
    this.level.parts.splice(k, 1);
    this.draw();
    this.updateStatus();
  }

  private rotate(): void { this.rot = ((this.rot + 1) % 4) as Rot; this.draw(); }
  private toggleLevel(): void { this.lv = this.lv ? 0 : 1; this.renderPalette(); this.draw(); }

  private onKey(e: KeyboardEvent): void {
    if (this.el.style.display === 'none') return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); const s = e.shiftKey ? this.redo.pop() : this.undo.pop(); if (s) { (e.shiftKey ? this.undo : this.redo).push(levelToJson(this.level)); this.restore(s); } return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); const s = this.redo.pop(); if (s) { this.undo.push(levelToJson(this.level)); this.restore(s); } return; }
    if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); this.save(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'r') this.rotate();
    else if (k === 'e') this.toggleLevel();
    else if (k === 'delete' || k === 'backspace') { this.tool = { kind: 'erase' }; this.renderPalette(); }
    else if (k === 'escape') this.closeDialogs();
    else return;
    e.preventDefault();
  }

  // ------------------------------------------------------------------ drawing
  private draw(): void {
    const c = this.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = this.main.clientWidth, H = this.main.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    const { scale: s, ox, oz } = this.view;
    // surroundings (beach-ridge plain) and the field
    g.fillStyle = '#5d6b3c'; g.fillRect(0, 0, W, H);
    g.fillStyle = VGA.field; g.fillRect(ox, oz, GRID.nx * s, GRID.nz * s);
    g.strokeStyle = VGA.fieldLine; g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i <= GRID.nx; i++) { g.moveTo(ox + i * s + 0.5, oz); g.lineTo(ox + i * s + 0.5, oz + GRID.nz * s); }
    for (let j = 0; j <= GRID.nz; j++) { g.moveTo(ox, oz + j * s + 0.5); g.lineTo(ox + GRID.nx * s, oz + j * s + 0.5); }
    g.stroke();
    g.strokeStyle = VGA.yellow; g.lineWidth = 2; g.strokeRect(ox - 1, oz - 1, GRID.nx * s + 2, GRID.nz * s + 2);
    // compass and the launch site direction (east)
    g.fillStyle = VGA.white; g.font = '700 12px ui-monospace,monospace';
    g.fillText('N', ox + GRID.nx * s / 2 - 4, oz - 6);
    g.fillText('STARBASE →', ox + GRID.nx * s - 92, oz - 6);
    // pieces: ground level first, elevated on top
    // markings that read one way (boost chevrons) follow the way the course runs, as in 3D
    const course = buildCourse(this.level);
    const order = this.level.parts.map((p, k) => ({ p, rot: drawRot(this.level, k, course) })).sort((a, b) => (a.p.lv ?? 0) - (b.p.lv ?? 0));
    for (const { p, rot } of order) this.drawPart(g, p, 1, rot);
    for (const d of this.level.deco) {
      g.fillStyle = decoColour(d.type);
      const r = Math.max(2, s * 0.12);
      g.fillRect(ox + d.x * s - r, oz + d.z * s - r, r * 2, r * 2);
    }
    // ghost
    if (this.hover && this.tool.kind === 'part') {
      const p = this.ghost(this.hover.x, this.hover.z)!;
      const ok = canPlace(this.level, GRID, p);
      this.drawPart(g, p, 0.6);
      const [w, d] = p.rot % 2 === 0 ? [partDef(p.type).w, partDef(p.type).d] : [partDef(p.type).d, partDef(p.type).w];
      g.strokeStyle = ok ? VGA.ltgreen : VGA.ltred; g.lineWidth = 2;
      g.strokeRect(ox + p.i * s, oz + p.j * s, w * s, d * s);
    } else if (this.hover && this.tool.kind === 'erase') {
      g.strokeStyle = VGA.ltred; g.lineWidth = 2;
      g.strokeRect(ox + Math.floor(this.hover.x) * s, oz + Math.floor(this.hover.z) * s, s, s);
    }
  }

  private drawPart(g: CanvasRenderingContext2D, p: LevelPart, alpha: number, rot: number = p.rot): void {
    const { scale: s, ox, oz } = this.view;
    const ic = partIcon(p.type, rot, 16);
    g.globalAlpha = alpha;
    // the icon's rows run along +z = south = down on screen
    g.drawImage(ic, ox + p.i * s, oz + p.j * s, ic.width / 16 * s, ic.height / 16 * s);
    if (p.lv) { g.strokeStyle = VGA.ltcyan; g.lineWidth = 1; const t = partTiles(p); for (const [a, b] of t) g.strokeRect(ox + a * s + 1.5, oz + b * s + 1.5, s - 3, s - 3); }
    g.globalAlpha = 1;
  }

  private updateStatus(): void {
    const h = this.hover;
    const tile = h ? `${Math.floor(h.x)},${Math.floor(h.z)}` : '–';
    const name = this.tool.kind === 'part' ? et(`part.${this.tool.type}` as EditorKey) : this.tool.kind === 'deco' ? et(`deco.${this.tool.type}` as EditorKey) : et('editor.erase');
    const start = this.level.parts.some((p) => p.type === 'start') ? '' : `  ·  ${et('editor.noStart')}`;
    this.status.textContent = `[${tile}]  ${name}  ·  ${this.level.parts.length}/${this.level.deco.length}${start}  ·  ${et('editor.keys')}`;
  }

  private say(m: string): void {
    this.msg.textContent = m;
    window.setTimeout(() => { if (this.msg.textContent === m) this.msg.textContent = ''; }, 4000);
  }
}

function div(cls: string): HTMLDivElement { const d = document.createElement('div'); d.className = cls; return d; }
function text(t: string): HTMLSpanElement { const s = document.createElement('span'); s.textContent = t; return s; }
function btn(label: string, fn: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `rfte-btn ${cls}`.trim();
  b.textContent = label;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}
