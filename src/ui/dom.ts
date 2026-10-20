// Minimal DOM builder + typed event emitter (no framework).
type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'number' ? String(c) : c);
  return el;
}

/** Inline SVG from markup (static, trusted strings only). */
export function svg(markup: string, cls = ''): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  const s = t.content.firstElementChild as SVGSVGElement;
  if (cls) s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  return s;
}

export class Emitter<E extends object> {
  private map = new Map<keyof E, Set<(v: never) => void>>();
  on<K extends keyof E>(type: K, fn: (v: E[K]) => void): () => void {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn as (v: never) => void);
    return () => this.off(type, fn);
  }
  off<K extends keyof E>(type: K, fn: (v: E[K]) => void): void { this.map.get(type)?.delete(fn as (v: never) => void); }
  emit<K extends keyof E>(type: K, v: E[K]): void { for (const fn of this.map.get(type) ?? []) (fn as (x: E[K]) => void)(v); }
}

/** German number formatting with a fixed number of decimals. */
export const fmtDe = (v: number, digits = 1): string =>
  Number.isFinite(v) ? v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '–';
