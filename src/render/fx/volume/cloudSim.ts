// CPU side of the ground-cloud volume: a coarse 3D grid of vapour density and velocity
// around the stunt site, fed by the jet ground hits, advected semi-Lagrangian with a little
// turbulence, diffused and evaporated. After every step the grid is "baked" into four 8-bit
// channels per cell (density, key light reaching the cell, sky/flood fill reaching it, red LED
// light reaching it) so that the GPU ray marcher needs a single 3D texture fetch per sample.
// No three.js dependency (unit-tested in tests/render/cloudSim.test.ts).

/** One frame's injection: vapour mass and momentum around a point (world metres, m/s). */
export interface CloudSource {
  x: number; y: number; z: number;
  /** Radius of the splat [m]. */
  r: number;
  /** vertical radius [m] (default r): flat splats for the ground sheet of the wall jet. */
  ry?: number;
  /** Density added per second at the splat centre [1/m per s]. */
  rate: number;
  /** Velocity the gas leaves the splat with [m/s]; blended into the local flow. */
  vx: number; vy: number; vz: number;
  /** Radial outflow speed away from the splat centre (ground hit: the jet spreads radially) [m/s]. */
  radial?: number;
  /** How long this source was active [s] (frames between two steps); default = the step's dt. */
  dt?: number;
}

/** Lights for the bake (same numbers the particle shading uses, see fxLight.ts). */
export interface CloudLights {
  /** Spotlights: position, intensity [cd], unit axis, cos outer / inner half angle. */
  spots: { x: number; y: number; z: number; I: number; dx: number; dy: number; dz: number; cosOuter: number; cosInner: number }[];
  /** Directional key (worlds); `E` illuminance, direction points from the scene towards the sun. */
  sun: { dx: number; dy: number; dz: number; E: number } | null;
  /** LED bars along world Z at x, from z0 to z1. */
  leds: { x: number; z0: number; z1: number; gain: number }[];
  /**
   * red stage floods (same fields as `spots`). They go into the red channel like the LED bars,
   * but as body light shadowed towards the flood – the stream finale's deep red smoke zone next to
   * the white-lit part ("too grey instead of spatially separated white/red").
   */
  reds?: CloudLights['spots'];
}

export interface CloudBake {
  /** RGBA8, x fastest then y then z: sqrt(density/DMAX), sqrt(key/keyMax), fill transmittance, sqrt(red/redMax). */
  data: Uint8Array;
  keyMax: number;
  redMax: number;
  /** Unit direction towards the dominant light (for the phase function). */
  keyDir: [number, number, number];
  /** unit direction towards the red floods (weighted at the cloud centre). */
  redDir?: [number, number, number];
  /** share of the brightest red cell that comes from red floods (0 = LED bars only). */
  redSpot?: number;
}

export const DMAX = 3.0;          // density encoding range [1/m]

const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
/** Transmittance with a cheap multiple-scattering lobe (dense cores grey instead of black). */
// (floor 0.14 → 0.07 and steeper – the stream's cores are clearly darker than their lit crowns)
export const transm = (tau: number) => Math.max(Math.exp(-tau), 0.07 * Math.exp(-tau * 0.35));

export class CloudSim {
  readonly n: number;
  /** World position of the grid's min corner (cell (0,0,0) corner). */
  ox = 0; oy = 0; oz = 0;
  d: Float32Array; u: Float32Array; v: Float32Array; w: Float32Array;
  private d2: Float32Array; private u2: Float32Array; private v2: Float32Array; private w2: Float32Array;
  private sources: CloudSource[] = [];
  /** Occupied cells (density above the threshold), inclusive; null = empty grid. */
  bounds: { i0: number; i1: number; j0: number; j1: number; k0: number; k1: number } | null = null;
  /** Accumulated simulated time (drives the turbulence). */
  time = 0;
  /** Sum of density · cell volume [m²] (diagnostics, tests). */
  mass = 0;
  private turb: Float32Array;
  private readonly TN = 8;
  /** random vector potential on a periodic 16³ lattice (its curl = the small eddies). */
  private curl: Float32Array;
  private curlNorm = 1;
  private readonly CN = 16;

  // tuning (seconds, m/s, m)
  /** Horizontal momentum damping time (above the ground sheet). */
  tauU = 0.75;
  /** damping time of the ground sheet (lowest `sheetCells` layers): the wall jet and the
   *  radial outflow of a landing keep running along the pad – long flat tail, wide flat landings. */
  tauSheet = 1.35;
  sheetCells = 2;
  /** extra horizontal diffusion of the bottom layer (0..0.2): a cold gravity current – the
   *  footprint at the pad runs out beyond the body, a thin ground seam instead of a hard foot. */
  sheetSpread = 0.15;
  /** outward push of the bottom layer down its density gradient [m²/s² per (1/m)]: the cold,
   *  dense vapour slumps and runs out along the pad as a thin seam. */
  slump = 2.2;
  /** Vertical momentum damping time. */
  tauW = 0.6;
  /** Evaporation time of dense vapour. */
  tauD = 7.0;
  /** Constant evaporation [1/m per s]: thin wisps vanish, the edge stays defined. */
  evap = 0.03;
  /** Lift where the radial outflow decelerates (front roll-up) [m]. (0.9 → 0.6, flatter) */
  roll = 0.6;
  /** Diffusion per step (0..1/6). (the fine structure comes from the shader) */
  diffuse = 0.05;
  /** Turbulence velocity amplitude [m/s]. */
  turbAmp = 1.6;
  /** vertical share of the turbulence (lower = flatter clouds). */
  turbUp = 0.55;
  /** height above which rising vapour is braked [m] and the brake rate [1/s²·m]. */
  ceil = 2.5;
  ceilBrake = 1.4;
  /** amplitude of the small curl eddies [m/s] (0 = off). */
  curlAmp = 1.5;
  /** Ambient drift [m/s] (same as the particles). */
  wind: [number, number, number] = [0.24, 0, 0.1];

  constructor(readonly nx = 64, readonly ny = 16, readonly nz = 64, readonly h = 0.8) {
    this.n = nx * ny * nz;
    const f = () => new Float32Array(this.n);
    this.d = f(); this.u = f(); this.v = f(); this.w = f();
    this.d2 = f(); this.u2 = f(); this.v2 = f(); this.w2 = f();
    // smooth random vector field on a periodic 8³ lattice (turbulence)
    const T = this.TN;
    this.turb = new Float32Array(T * T * T * 3);
    let s = 1234567;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
    for (let i = 0; i < this.turb.length; i++) this.turb[i] = rnd();
    // curl noise – the eddies shear and stretch the vapour into tongues and filaments instead
    // of compressing it into clumps (the random field above is not divergence free). A random vector
    // potential on a periodic lattice; curlAt differentiates its interpolant analytically.
    this.curl = new Float32Array(this.CN ** 3 * 3);
    for (let i = 0; i < this.curl.length; i++) this.curl[i] = rnd();
    const probe = [0, 0, 0];
    let cmax = 1e-6;
    for (let i = 0; i < 400; i++) { this.curlAt(i * 0.731, i * 0.389 % 7, i * 1.177, probe); cmax = Math.max(cmax, Math.hypot(probe[0], probe[1], probe[2])); }
    this.curlNorm = 1 / cmax;
  }

  get sizeX(): number { return this.nx * this.h; }
  get sizeY(): number { return this.ny * this.h; }
  get sizeZ(): number { return this.nz * this.h; }

  idx(i: number, j: number, k: number): number { return i + this.nx * (j + this.ny * k); }

  clear(): void {
    this.d.fill(0); this.u.fill(0); this.v.fill(0); this.w.fill(0);
    this.sources.length = 0;
    this.bounds = null;
    this.mass = 0;
  }

  addSource(s: CloudSource): void { if (s.rate > 0 && s.r > 0) this.sources.push(s); }

  /** Place the (empty) grid centred on x/z with its floor at `ground`. */
  centreOn(x: number, z: number, ground: number): void {
    this.ox = Math.round((x - this.sizeX / 2) / this.h) * this.h;
    this.oz = Math.round((z - this.sizeZ / 2) / this.h) * this.h;
    this.oy = ground;
  }

  /**
   * Keep the point (x, z) inside the inner part of the grid by shifting the grid in whole cells
   * (contents move with the world). Returns true when the grid moved.
   */
  follow(x: number, z: number, margin = 0.22): boolean {
    const mx = this.sizeX * margin, mz = this.sizeZ * margin;
    let si = 0, sk = 0;
    const lx = x - this.ox, lz = z - this.oz;
    if (lx < mx) si = -Math.ceil((mx - lx) / this.h);
    else if (lx > this.sizeX - mx) si = Math.ceil((lx - (this.sizeX - mx)) / this.h);
    if (lz < mz) sk = -Math.ceil((mz - lz) / this.h);
    else if (lz > this.sizeZ - mz) sk = Math.ceil((lz - (this.sizeZ - mz)) / this.h);
    if (!si && !sk) return false;
    this.shift(si, sk);
    return true;
  }

  /** Move the grid origin by (si, sk) cells; content keeps its world position. */
  private shift(si: number, sk: number): void {
    const { nx, ny, nz } = this;
    for (const [a, b] of [[this.d, this.d2], [this.u, this.u2], [this.v, this.v2], [this.w, this.w2]] as const) {
      b.fill(0);
      for (let k = 0; k < nz; k++) {
        const ks = k + sk; if (ks < 0 || ks >= nz) continue;
        for (let j = 0; j < ny; j++) {
          const row = nx * (j + ny * k), rows = nx * (j + ny * ks);
          for (let i = 0; i < nx; i++) {
            const is = i + si; if (is < 0 || is >= nx) continue;
            b[row + i] = a[rows + is];
          }
        }
      }
      a.set(b);
    }
    this.ox += si * this.h; this.oz += sk * this.h;
    this.updateBounds();
  }

  /** small curl eddies (≈ 2.4 m) at (x, y, z, t) into out[0..2] (≈ unit amplitude): the exact
   *  curl of the smoothly interpolated potential, so the field is divergence free. */
  curlAt(x: number, y: number, z: number, out: number[]): void {
    const C = this.CN, P = this.curl;
    const sx = 0.42, sy = 0.5, sz = 0.42;
    const fx = x * sx + this.time * 0.5, fy = y * sy - this.time * 0.35, fz = z * sz - this.time * 0.3;
    const xi = Math.floor(fx), yi = Math.floor(fy), zi = Math.floor(fz);
    const ax = fx - xi, ay = fy - yi, az = fz - zi;
    const wx = ax * ax * (3 - 2 * ax), wy = ay * ay * (3 - 2 * ay), wz = az * az * (3 - 2 * az);
    const gx = 6 * ax * (1 - ax) * sx, gy = 6 * ay * (1 - ay) * sy, gz = 6 * az * (1 - az) * sz;
    // gradients of the three potential components (d[c][axis])
    let dAxdy = 0, dAxdz = 0, dAydx = 0, dAydz = 0, dAzdx = 0, dAzdy = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const ux = dx ? wx : 1 - wx, uy = dy ? wy : 1 - wy, uz = dz ? wz : 1 - wz;
      const vx = dx ? gx : -gx, vy = dy ? gy : -gy, vz = dz ? gz : -gz;
      const o = ((((xi + dx) & (C - 1)) + C * (((yi + dy) & (C - 1)) + C * ((zi + dz) & (C - 1)))) * 3);
      const Ax = P[o], Ay = P[o + 1], Az = P[o + 2];
      const ddx = vx * uy * uz, ddy = ux * vy * uz, ddz = ux * uy * vz;
      dAxdy += Ax * ddy; dAxdz += Ax * ddz;
      dAydx += Ay * ddx; dAydz += Ay * ddz;
      dAzdx += Az * ddx; dAzdy += Az * ddy;
    }
    const k = this.curlNorm;
    out[0] = (dAzdy - dAydz) * k; out[1] = (dAxdz - dAzdx) * k; out[2] = (dAydx - dAxdy) * k;
  }

  /** Smooth periodic turbulence vector at (x, y, z, t) into out[0..2]. */
  private turbAt(x: number, y: number, z: number, out: number[]): void {
    const T = this.TN, t = this.turb;
    const fx = x * 0.2 + this.time * 0.35, fy = y * 0.32 - this.time * 0.2, fz = z * 0.2 + this.time * 0.15;
    const xi = Math.floor(fx), yi = Math.floor(fy), zi = Math.floor(fz);
    let ax = fx - xi, ay = fy - yi, az = fz - zi;
    ax = ax * ax * (3 - 2 * ax); ay = ay * ay * (3 - 2 * ay); az = az * az * (3 - 2 * az);
    out[0] = out[1] = out[2] = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const wgt = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay) * (dz ? az : 1 - az);
      const o = ((((xi + dx) & (T - 1)) + T * (((yi + dy) & (T - 1)) + T * ((zi + dz) & (T - 1)))) * 3);
      out[0] += t[o] * wgt; out[1] += t[o + 1] * wgt; out[2] += t[o + 2] * wgt;
    }
  }

  private inject(dt: number): void {
    const { nx, ny, nz, h } = this;
    for (const s of this.sources) {
      const sdt = s.dt ?? dt;
      const ci = (s.x - this.ox) / h - 0.5, cj = (s.y - this.oy) / h - 0.5, ck = (s.z - this.oz) / h - 0.5;
      const rc = s.r / h, ey = s.r / Math.max(0.05, s.ry ?? s.r);
      const rcy = rc / ey;
      const i0 = Math.max(0, Math.floor(ci - rc)), i1 = Math.min(nx - 1, Math.ceil(ci + rc));
      const j0 = Math.max(0, Math.floor(cj - rcy)), j1 = Math.min(ny - 1, Math.ceil(cj + rcy));
      const k0 = Math.max(0, Math.floor(ck - rc)), k1 = Math.min(nz - 1, Math.ceil(ck + rc));
      const inv = 1 / (rc * rc * 0.5);
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const dx = i - ci, dy = (j - cj) * ey, dz = k - ck;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 > rc * rc) continue;
        const g = Math.exp(-r2 * inv);
        const id = i + nx * (j + ny * k);
        this.d[id] = Math.min(DMAX * 1.5, this.d[id] + s.rate * g * sdt);
        // momentum: pull the local flow towards the source velocity (+ radial outflow)
        const a = Math.min(1, g * 8 * sdt);
        let vx = s.vx, vy = s.vy, vz = s.vz;
        if (s.radial) {
          const l = Math.hypot(dx, dz) || 1;
          vx += dx / l * s.radial; vz += dz / l * s.radial;
        }
        this.u[id] += (vx - this.u[id]) * a;
        this.v[id] += (vy - this.v[id]) * a;
        this.w[id] += (vz - this.w[id]) * a;
      }
    }
    this.sources.length = 0;
  }

  updateBounds(): void {
    const { nx, ny, nz, d } = this;
    let i0 = nx, i1 = -1, j0 = ny, j1 = -1, k0 = nz, k1 = -1;
    let mass = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const row = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) {
        const x = d[row + i];
        // (same threshold as the ray marcher's `dense` test – the thin ground seam no longer
        // grows the occupied box with vapour nobody sees)
        if (x > 4e-3) {
          mass += x;
          if (i < i0) i0 = i; if (i > i1) i1 = i;
          if (j < j0) j0 = j; if (j > j1) j1 = j;
          if (k < k0) k0 = k; if (k > k1) k1 = k;
        }
      }
    }
    this.mass = mass * this.h * this.h * this.h;
    this.bounds = i1 < 0 ? null : { i0, i1, j0, j1, k0, k1 };
  }

  /** Advance the simulation by dt (call at a fixed rate, e.g. 30 Hz). */
  step(dt: number): void {
    this.time += dt;
    const hadSources = this.sources.length > 0;
    this.inject(dt);
    if (hadSources || this.bounds) this.updateBounds();
    const b = this.bounds;
    if (!b) return;
    const { nx, ny, nz, h } = this;
    // region that can change this step: occupied cells plus the reach of the flow
    const m = 3;
    const I0 = Math.max(0, b.i0 - m), I1 = Math.min(nx - 1, b.i1 + m);
    const J0 = 0, J1 = Math.min(ny - 1, b.j1 + m);
    const K0 = Math.max(0, b.k0 - m), K1 = Math.min(nz - 1, b.k1 + m);
    const { d, u, v, w, d2, u2, v2, w2 } = this;
    const du = Math.exp(-dt / this.tauU), dw = Math.exp(-dt / this.tauW), dsh = Math.exp(-dt / this.tauSheet);
    const sx = 1, sy = nx, sz = nx * ny;

    // forces: damping, ground friction, front roll-up (lift where the horizontal flow converges)
    for (let k = K0; k <= K1; k++) for (let j = J0; j <= J1; j++) for (let i = I0; i <= I1; i++) {
      const id = i + nx * (j + ny * k);
      const fr = j === 0 ? 0.85 : 1;
      let div = 0;
      if (i > 0 && i < nx - 1 && k > 0 && k < nz - 1) div = (u[id + sx] - u[id - sx] + w[id + sz] - w[id - sz]) / (2 * h);
      let vy = v[id] * dw;
      if (div < 0) vy += -div * this.roll * dt * 6;
      // cold, dense vapour: whatever rises slows down again (no tall columns)
      const y = (j + 0.5) * h;
      vy -= Math.max(0, y - this.ceil) * this.ceilBrake * dt;
      if (j === 0 && vy < 0) vy = 0;
      v2[id] = vy;
      const dh = j < this.sheetCells ? dsh : du;
      u2[id] = u[id] * dh * fr;
      w2[id] = w[id] * dh * fr;
      if (j === 0 && this.slump > 0 && i > 0 && i < nx - 1 && k > 0 && k < nz - 1) {
        u2[id] -= this.slump * (d[id + sx] - d[id - sx]) / (2 * h) * dt;
        w2[id] -= this.slump * (d[id + sz] - d[id - sz]) / (2 * h) * dt;
      }
    }
    for (let k = K0; k <= K1; k++) for (let j = J0; j <= J1; j++) {
      const row = nx * (j + ny * k);
      for (let i = I0; i <= I1; i++) { u[row + i] = u2[row + i]; v[row + i] = v2[row + i]; w[row + i] = w2[row + i]; }
    }

    // semi-Lagrangian advection (velocity + turbulence + drift)
    const tv = [0, 0, 0], cv = [0, 0, 0];
    const camp = this.curlAmp;
    const [wx, wy, wz] = this.wind;
    const amp = this.turbAmp;
    const sample = (f: Float32Array, x: number, y: number, z: number): number => {
      // x, y, z in cell units (cell centres at integer + 0.5 → shift)
      x -= 0.5; y -= 0.5; z -= 0.5;
      if (x < 0 || y < -0.5 || z < 0 || x > nx - 1 || y > ny - 1 || z > nz - 1) return 0;
      if (y < 0) y = 0;
      const xi = Math.min(nx - 2, Math.floor(x)), yi = Math.min(ny - 2, Math.floor(y)), zi = Math.min(nz - 2, Math.floor(z));
      const ax = x - xi, ay = y - yi, az = z - zi;
      const o = xi + nx * (yi + ny * zi);
      const c00 = f[o] + (f[o + sx] - f[o]) * ax, c10 = f[o + sy] + (f[o + sy + sx] - f[o + sy]) * ax;
      const c01 = f[o + sz] + (f[o + sz + sx] - f[o + sz]) * ax, c11 = f[o + sz + sy] + (f[o + sz + sy + sx] - f[o + sz + sy]) * ax;
      const c0 = c00 + (c10 - c00) * ay, c1 = c01 + (c11 - c01) * ay;
      return c0 + (c1 - c0) * az;
    };
    const dd = Math.exp(-dt / this.tauD), ev = this.evap * dt;
    for (let k = K0; k <= K1; k++) for (let j = J0; j <= J1; j++) for (let i = I0; i <= I1; i++) {
      const id = i + nx * (j + ny * k);
      this.turbAt(this.ox + (i + 0.5) * h, (j + 0.5) * h, this.oz + (k + 0.5) * h, tv);
      // turbulence grows away from the ground (the wall jet stays sheet-like at the bottom)
      const ta = amp * Math.min(1, 0.35 + j * 0.25);
      // (+ small curl eddies, also weaker at the pad; only where there is vapour to move)
      let ca = 0;
      // (only where there is vapour in the cell or its neighbours – empty cells cannot receive any
      // through the backtrace of a ≤ 1-cell step; halves the cost of the eddies)
      const near = d[id] + (i > 0 ? d[id - 1] : 0) + (i < nx - 1 ? d[id + 1] : 0) + (j > 0 ? d[id - nx] : 0) + (j < ny - 1 ? d[id + nx] : 0)
        + (k > 0 ? d[id - nx * ny] : 0) + (k < nz - 1 ? d[id + nx * ny] : 0);
      if (camp > 0 && near > 1e-3) { this.curlAt(this.ox + (i + 0.5) * h, (j + 0.5) * h, this.oz + (k + 0.5) * h, cv); ca = camp * Math.min(1, 0.3 + j * 0.3); }
      const bx = (i + 0.5) - (u[id] + wx + tv[0] * ta + cv[0] * ca) * dt / h;
      const by = (j + 0.5) - (v[id] + wy + (tv[1] * ta + cv[1] * ca) * this.turbUp) * dt / h;
      const bz = (k + 0.5) - (w[id] + wz + tv[2] * ta + cv[2] * ca) * dt / h;
      d2[id] = Math.max(0, sample(d, bx, by, bz) * dd - ev);
      u2[id] = sample(u, bx, by, bz);
      v2[id] = sample(v, bx, by, bz);
      w2[id] = sample(w, bx, by, bz);
    }
    // diffusion of the density (soft volume) while copying back
    const a = this.diffuse;
    for (let k = K0; k <= K1; k++) for (let j = J0; j <= J1; j++) for (let i = I0; i <= I1; i++) {
      const id = i + nx * (j + ny * k);
      const c = d2[id];
      const xm = i > 0 ? d2[id - sx] : 0, xp = i < nx - 1 ? d2[id + sx] : 0;
      const ym = j > 0 ? d2[id - sy] : c, yp = j < ny - 1 ? d2[id + sy] : 0;
      const zm = k > 0 ? d2[id - sz] : 0, zp = k < nz - 1 ? d2[id + sz] : 0;
      let dn = c + a * (xm + xp + ym + yp + zm + zp - 6 * c);
      if (j === 0) dn += this.sheetSpread * (xm + xp + zm + zp - 4 * c);
      d[id] = dn;
      u[id] = u2[id]; v[id] = v2[id]; w[id] = w2[id];
    }
    this.updateBounds();
  }

  /** Bake density and the light reaching every cell of the occupied region into RGBA8. */
  bake(lights: CloudLights, out: CloudBake): void {
    const data = out.data;
    const { nx, ny, nz, h, d } = this;
    const b = this.bounds;
    data.fill(0);
    if (!b) { out.keyMax = 1; out.redMax = 1; return; }
    const m = 2;
    const I0 = Math.max(0, b.i0 - m), I1 = Math.min(nx - 1, b.i1 + m);
    const J1 = Math.min(ny - 1, b.j1 + m);
    const K0 = Math.max(0, b.k0 - m), K1 = Math.min(nz - 1, b.k1 + m);
    const cx = this.ox + (b.i0 + b.i1 + 1) * 0.5 * h, cy = this.oy + (b.j1 + 1) * 0.5 * h, cz = this.oz + (b.k0 + b.k1 + 1) * 0.5 * h;

    // dominant light direction at the cloud centre (like mediumLight's keyDir)
    let kx = 0, ky = 1e-4, kz = 0;
    for (const s of lights.spots) {
      const e = this.spotE(s, cx, cy, cz);
      const lx = s.x - cx, ly = s.y - cy, lz = s.z - cz, l = Math.hypot(lx, ly, lz) || 1;
      kx += lx / l * e; ky += ly / l * e; kz += lz / l * e;
    }
    if (lights.sun) { kx += lights.sun.dx * lights.sun.E; ky += lights.sun.dy * lights.sun.E; kz += lights.sun.dz * lights.sun.E; }
    const kl = Math.hypot(kx, ky, kz) || 1;
    kx /= kl; ky /= kl; kz /= kl;
    out.keyDir = [kx, ky, kz];
    // red floods – their own (weighted) direction for the shadow march and the phase function
    const reds = lights.reds ?? [];
    let rx = 0, ry = 1e-4, rz = 0;
    for (const s of reds) {
      const e = this.spotE(s, cx, cy, cz) + 1e-9 * s.I;
      const lx = s.x - cx, ly = s.y - cy, lz = s.z - cz, l = Math.hypot(lx, ly, lz) || 1;
      rx += lx / l * e; ry += ly / l * e; rz += lz / l * e;
    }
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    out.redDir = [rx, ry, rz];

    const R = (I1 - I0 + 1), Jn = J1 + 1, Kn = (K1 - K0 + 1);
    const key = new Float32Array(R * Jn * Kn), red = new Float32Array(R * Jn * Kn), up = new Float32Array(R * Jn * Kn);
    let keyMax = 1e-6, redMax = 1e-6;
    const stepX = kx * 1.25, stepY = ky * 1.25, stepZ = kz * 1.25;   // 1.25 cells per step (in cell units)
    for (let k = K0; k <= K1; k++) for (let i = I0; i <= I1; i++) {
      // optical depth from above (column prefix sum, top down)
      let tauUp = 0;
      for (let j = J1; j >= 0; j--) {
        const id = i + nx * (j + ny * k);
        const r = (i - I0) + R * (j + Jn * (k - K0));
        const dc = d[id] * h;
        up[r] = transm((tauUp + dc * 0.5) * 0.8);
        tauUp += dc;
      }
    }
    // red LED light: sideways optical depth (bars run along Z, so along ±x)
    // prefix sums of the optical depth along x: P[c] = depth from the region's min-x face to cell c's centre
    const P = new Float32Array(R + 1);
    for (let k = K0; k <= K1; k++) for (let j = 0; j <= J1; j++) {
      const row = nx * (j + ny * k);
      let t = 0;
      for (let i = I0; i <= I1; i++) { const dc = d[row + i] * h; P[i - I0] = t + dc * 0.5; t += dc; }
      P[R] = t;
      const wy = this.oy + (j + 0.5) * h, wz = this.oz + (k + 0.5) * h;
      for (let i = I0; i <= I1; i++) {
        const wx = this.ox + (i + 0.5) * h;
        // per bar, only the vapour between the bar and the cell (bars run along Z; the path
        // is taken horizontal), steep: the red sits as a seam on the side facing the bar instead of
        // tinting the whole cloud – and vapour beyond the bar no longer shades it
        let v = 0;
        for (const L of lights.leds) {
          if (L.gain <= 0) continue;
          const zc = Math.min(Math.max(wz, L.z0), L.z1);
          const dx = wx - L.x, dz = wz - zc, dy = Math.max(wy - 0.1, 0);
          const cb = Math.min(R, Math.max(0, Math.round((L.x - this.ox) / h - 0.5) - I0));
          const pb = cb >= R ? P[R] : P[cb];
          const tauSide = Math.abs(P[i - I0] - pb);
          v += L.gain / (dx * dx + dy * dy + dz * dz + 1.5) * transm(tauSide * 2.4);
        }
        const r = (i - I0) + R * (j + Jn * (k - K0));
        red[r] = v; if (v > redMax) redMax = v;
      }
    }
    // red floods – irradiance at the cell × transmittance marched towards the floods
    let redSpotMax = 0;
    if (reds.length) {
      const sx = rx * 1.25, sy = ry * 1.25, sz = rz * 1.25;
      for (let k = K0; k <= K1; k++) for (let j = 0; j <= J1; j++) for (let i = I0; i <= I1; i++) {
        const wx = this.ox + (i + 0.5) * h, wy = this.oy + (j + 0.5) * h, wz = this.oz + (k + 0.5) * h;
        let e = 0;
        for (const s of reds) e += this.spotE(s, wx, wy, wz);
        if (e <= 0) continue;
        let x = i + 0.5, y = j + 0.5, z = k + 0.5;
        let tau = d[i + nx * (j + ny * k)] * h * 0.5;
        for (let st = 0; st < 16; st++) {
          x += sx; y += sy; z += sz;
          if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) break;
          tau += d[(x | 0) + nx * ((y | 0) + ny * (z | 0))] * h * 1.25;
          if (tau > 30) break;
        }
        const r = (i - I0) + R * (j + Jn * (k - K0));
        const v = e * transm(tau);
        if (v > redSpotMax) redSpotMax = v;
        red[r] += v; if (red[r] > redMax) redMax = red[r];
      }
    }
    out.redSpot = Math.min(1, redSpotMax / redMax);
    // key light: spot irradiance at the cell × transmittance marched towards the key direction
    for (let k = K0; k <= K1; k++) for (let j = 0; j <= J1; j++) for (let i = I0; i <= I1; i++) {
      const wx = this.ox + (i + 0.5) * h, wy = this.oy + (j + 0.5) * h, wz = this.oz + (k + 0.5) * h;
      let e = 0;
      for (const s of lights.spots) e += this.spotE(s, wx, wy, wz);
      if (lights.sun) e += lights.sun.E;
      let tau = 0;
      let x = i + 0.5, y = j + 0.5, z = k + 0.5;
      // half a cell of its own, then up to 16 steps towards the light (nearest sampling)
      tau += d[i + nx * (j + ny * k)] * h * 0.5;
      for (let s = 0; s < 16; s++) {
        x += stepX; y += stepY; z += stepZ;
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) break;
        tau += d[(x | 0) + nx * ((y | 0) + ny * (z | 0))] * h * 1.25;
        if (tau > 30) break;
      }
      const r = (i - I0) + R * (j + Jn * (k - K0));
      const v = e * transm(tau);
      key[r] = v; if (v > keyMax) keyMax = v;
    }
    out.keyMax = keyMax; out.redMax = redMax;
    const ik = 1 / keyMax, ir = 1 / redMax;
    for (let k = K0; k <= K1; k++) for (let j = 0; j <= J1; j++) for (let i = I0; i <= I1; i++) {
      const id = i + nx * (j + ny * k);
      const r = (i - I0) + R * (j + Jn * (k - K0));
      const o = id * 4;
      data[o] = Math.round(Math.sqrt(Math.min(1, d[id] / DMAX)) * 255);
      data[o + 1] = Math.round(Math.sqrt(key[r] * ik) * 255);
      data[o + 2] = Math.round(up[r] * 255);
      data[o + 3] = Math.round(Math.sqrt(red[r] * ir) * 255);
    }
    // cells above the region (outside the bake) still see the full fill / key light: keep them lit
    // so the trilinear filter at the top of the cloud does not darken the crowns
    void smooth;
  }

  private spotE(s: CloudLights['spots'][number], x: number, y: number, z: number): number {
    if (s.I <= 0) return 0;
    const tx = x - s.x, ty = y - s.y, tz = z - s.z;
    const d2 = Math.max(1, tx * tx + ty * ty + tz * tz), l = Math.sqrt(d2);
    const c = (tx * s.dx + ty * s.dy + tz * s.dz) / l;
    const t = Math.min(1, Math.max(0, (c - s.cosOuter) / Math.max(1e-4, s.cosInner - s.cosOuter)));
    return s.I * t * t * (3 - 2 * t) / d2;
  }
}

/** One simulation request (main thread → worker, or the synchronous fallback). */
export interface CloudStepRequest {
  clear?: boolean;
  sources: CloudSource[];
  steps: number;
  dt: number;
  /** Emission centroid the grid should follow; null = keep (an empty grid centres on the car). */
  focus: { x: number; z: number } | null;
  car: { x: number; z: number };
  lights: CloudLights;
  /** RGBA8 bake target (n · 4 bytes), transferred to the worker and back. */
  buf: ArrayBuffer;
}

export interface CloudStepResult {
  buf: ArrayBuffer;
  keyMax: number;
  redMax: number;
  keyDir: [number, number, number];
  redDir: [number, number, number];
  redSpot: number;
  origin: [number, number, number];
  bounds: CloudSim['bounds'];
  time: number;
  mass: number;
  stepMs: number;
  bakeMs: number;
}

/** Apply a request to a simulation: place/follow the grid, inject, step, bake. */
export function runStep(sim: CloudSim, r: CloudStepRequest): CloudStepResult {
  if (r.clear) sim.clear();
  const t0 = performance.now();
  if (!sim.bounds && r.sources.length) sim.centreOn(r.sources[0].x, r.sources[0].z, 0);
  if (r.focus) sim.follow(r.focus.x, r.focus.z);
  else if (!sim.bounds) sim.centreOn(r.car.x, r.car.z, 0);
  for (const s of r.sources) sim.addSource(s);
  for (let i = 0; i < r.steps; i++) sim.step(r.dt);
  const t1 = performance.now();
  const bake: CloudBake = { data: new Uint8Array(r.buf), keyMax: 1, redMax: 1, keyDir: [0, 1, 0] };
  sim.bake(r.lights, bake);
  return {
    buf: r.buf, keyMax: bake.keyMax, redMax: bake.redMax, keyDir: bake.keyDir,
    redDir: bake.redDir ?? [0, 1, 0], redSpot: bake.redSpot ?? 0,
    origin: [sim.ox, sim.oy, sim.oz], bounds: sim.bounds, time: sim.time, mass: sim.mass,
    stepMs: r.steps ? (t1 - t0) / r.steps : 0, bakeMs: performance.now() - t1,
  };
}
