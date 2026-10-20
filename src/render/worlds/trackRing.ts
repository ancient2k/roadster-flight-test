// ring buffer of tyre-track segments (pure, no three): one segment per wheel every SEG_M of
// travel on loose ground, from the previous contact point to the current one. The oldest segments are
// overwritten when the buffer is full; the renderer fades them out before that (see fadeOf).

/** Floats per segment: x0 y0 z0 x1 y1 z1 width depth s0 strength seq wheel */
export const SEG_STRIDE = 12;
/** Segment length (m) along the track. */
export const SEG_M = 0.35;
/** A contact point that jumped further than this (teleport, reset, air time) starts a new track. */
const BREAK_M = 3;
/** After a loss of contact the track resumes only if the wheel lands within this distance (m). */
const GAP_M = 3;

export interface TrackPoint { x: number; y: number; z: number }

export class TrackRing {
  readonly data: Float32Array;
  /** Next slot to write. */
  head = 0;
  /** Segments ever written (seq of the next one). */
  total = 0;
  /** Lowest/highest slot written since the last takeDirty() (-1 = none). */
  private dirtyFrom = -1;
  private dirtyTo = -1;
  private last: (TrackPoint & { s: number; on: boolean; gap: boolean })[] = [];

  constructor(readonly capacity: number, wheels = 4) {
    this.data = new Float32Array(capacity * SEG_STRIDE);
    for (let w = 0; w < wheels; w++) this.last.push({ x: 0, y: 0, z: 0, s: 0, on: false, gap: false });
  }

  get count(): number { return Math.min(this.total, this.capacity); }

  /**
   * Wheel `wheel` is at `p`. `active` = on loose ground with contact. Writes a segment once the wheel has
   * moved SEG_M since the last one; returns its slot or -1.
   */
  step(wheel: number, p: TrackPoint, active: boolean, width: number, depth: number): number {
    const l = this.last[wheel];
    // (a short loss of contact – a bump, a flickering ray – must not cut the track into dashes: the track
    // resumes from the last point unless the wheel came down more than GAP_M away)
    if (!active) { if (l.on) l.gap = true; return -1; }
    if (!l.on) { l.x = p.x; l.y = p.y; l.z = p.z; l.on = true; l.gap = false; return -1; }
    const d = Math.hypot(p.x - l.x, p.z - l.z);
    if (d > BREAK_M || (l.gap && d > GAP_M)) { l.x = p.x; l.y = p.y; l.z = p.z; l.gap = false; return -1; }
    l.gap = false;
    if (d < SEG_M) return -1;
    const i = this.head, k = i * SEG_STRIDE, D = this.data;
    D[k] = l.x; D[k + 1] = l.y; D[k + 2] = l.z;
    D[k + 3] = p.x; D[k + 4] = p.y; D[k + 5] = p.z;
    D[k + 6] = width; D[k + 7] = depth; D[k + 8] = l.s; D[k + 9] = 1;
    D[k + 10] = this.total; D[k + 11] = wheel;
    l.s += d; l.x = p.x; l.y = p.y; l.z = p.z;
    this.markDirty(i);
    this.head = (i + 1) % this.capacity;
    this.total++;
    return i;
  }

  /** Forget the last contact points (new session / teleport): the next contact starts a new track. */
  breakAll(): void { for (const l of this.last) l.on = false; }

  /**
   * Jet scour: blow the tracks within radius r of (x, z) away by `amount` (0..1 of their strength).
   * Returns the number of segments touched.
   */
  erase(x: number, z: number, r: number, amount: number): number {
    let n = 0;
    const D = this.data, r2 = r * r, cnt = this.count;
    for (let i = 0; i < cnt; i++) {
      const k = i * SEG_STRIDE;
      if (D[k + 9] <= 0) continue;
      const mx = (D[k] + D[k + 3]) * 0.5 - x, mz = (D[k + 2] + D[k + 5]) * 0.5 - z;
      const q = mx * mx + mz * mz;
      if (q > r2) continue;
      // fully blown away at the centre, less towards the rim
      D[k + 9] = Math.max(0, D[k + 9] - amount * (1 - q / r2 * 0.6));
      this.markDirty(i);
      n++;
    }
    return n;
  }

  /** Age fade (1 = fresh, 0 = about to be overwritten): the oldest quarter of the ring fades out. */
  fadeOf(seq: number): number {
    const age = this.total - 1 - seq;
    const f = (this.capacity - age) / (this.capacity * 0.25);
    return Math.max(0, Math.min(1, f));
  }

  private markDirty(i: number): void {
    if (this.dirtyFrom < 0) { this.dirtyFrom = this.dirtyTo = i; return; }
    if (i < this.dirtyFrom || i > this.dirtyTo) {
      // a write before the range (ring wrap) or an erase somewhere: widen the range (a wrap uploads the
      // whole ring once per lap)
      this.dirtyFrom = Math.min(this.dirtyFrom, i);
      this.dirtyTo = Math.max(this.dirtyTo, i);
    }
  }

  /** Slot range(s) written since the last call: [from, to] inclusive, or null. */
  takeDirty(): [number, number] | null {
    if (this.dirtyFrom < 0) return null;
    const r: [number, number] = [this.dirtyFrom, this.dirtyTo];
    this.dirtyFrom = this.dirtyTo = -1;
    return r;
  }
}

/** jet scour spots (pure). Nearby hits strengthen and widen one spot instead of stacking new ones. */
export const SCOUR_STRIDE = 6; // x y z radius strength seed
export class ScourRing {
  readonly data: Float32Array;
  head = 0;
  total = 0;
  dirty = false;
  constructor(readonly capacity: number) { this.data = new Float32Array(capacity * SCOUR_STRIDE); }
  get count(): number { return Math.min(this.total, this.capacity); }

  /** A jet hits loose ground at (x, y, z) with a footprint radius r; `dose` adds to the spot's strength (0..1). */
  add(x: number, y: number, z: number, r: number, dose: number): number {
    const D = this.data;
    for (let i = 0; i < this.count; i++) {
      const k = i * SCOUR_STRIDE;
      const d = Math.hypot(D[k] - x, D[k + 2] - z);
      if (d < Math.max(D[k + 3], r) * 0.6) {
        // the spot creeps towards the newest hit and widens to cover it
        const wNew = dose / Math.max(1e-3, D[k + 4] + dose);
        D[k] += (x - D[k]) * wNew; D[k + 2] += (z - D[k + 2]) * wNew; D[k + 1] = Math.min(D[k + 1], y);
        D[k + 3] = Math.min(6, Math.max(D[k + 3], r, d + r * 0.6));
        D[k + 4] = Math.min(1, D[k + 4] + dose);
        this.dirty = true;
        return i;
      }
    }
    const i = this.head, k = i * SCOUR_STRIDE;
    D[k] = x; D[k + 1] = y; D[k + 2] = z; D[k + 3] = Math.min(6, r); D[k + 4] = Math.min(1, dose); D[k + 5] = (this.total * 0.618034) % 1;
    this.head = (i + 1) % this.capacity;
    this.total++;
    this.dirty = true;
    return i;
  }
}
