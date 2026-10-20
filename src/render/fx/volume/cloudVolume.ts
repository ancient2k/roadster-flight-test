// Ground-cloud volume: owns the CPU simulation (cloudSim.ts), the 3D textures the ray
// marcher reads and the uniforms describing the grid. Fed by Emitters (jet ground hits, wall jet),
// drawn by CloudVolumeNode in the post chain (post.ts). One instance per page (module singleton),
// like the fxLight uniforms.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { CloudSim, runStep, type CloudLights, type CloudSource, type CloudStepRequest, type CloudStepResult } from './cloudSim';
import { fxLight } from '../fxLight';

const SIM_HZ = 24;

/** a stage light that only lights the ground cloud (bake), not the scene. */
export interface CloudStageLight {
  pos: THREE.Vector3; dir: THREE.Vector3; halfAngleDeg: number;
  /** Photometric intensity [cd] (converted with `PHOTOMETRIC` like the FloodRig slots). */
  cd: number;
  colour: 'white' | 'red';
}
/**
 * per stunt site, the stage lights that colour the cloud there and how much of the uniform
 * flood fill it gets (the fill greys every face alike; the stream finale is lit white from one side,
 * red from the other). Registered by the track (world/track.ts), picked by the car position.
 */
export interface CloudStageZone { x: number; z: number; r: number; fill: number; lights: CloudStageLight[] }
const PHOTOMETRIC_CD = 0.05;   // = lighting.ts PHOTOMETRIC (no import: keeps the worker-free module small)
/** Build flag for A/B image acceptance: VITE_NO_VOLUME=1 keeps the R8 particle clouds. */
const DISABLED = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_NO_VOLUME === '1';

function makeDetailNoise(S = 32): THREE.Data3DTexture {
  // tileable billow noise: inverted Worley (round cauliflower lobes) mixed with value fbm
  const data = new Uint8Array(S * S * S * 4);
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const C = 4; // feature cells per tile edge
  const pts: number[] = [];
  for (let i = 0; i < C * C * C; i++) pts.push(rnd(), rnd(), rnd());
  const V = 8;
  const lat = new Float32Array(V * V * V).map(() => rnd());
  const vnoise = (x: number, y: number, z: number, p: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let ax = x - xi, ay = y - yi, az = z - zi;
    ax = ax * ax * (3 - 2 * ax); ay = ay * ay * (3 - 2 * ay); az = az * az * (3 - 2 * az);
    let s = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const w = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay) * (dz ? az : 1 - az);
      s += w * lat[((xi + dx) % p) + V * (((yi + dy) % p) + V * ((zi + dz) % p))];
    }
    return s;
  };
  for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const fx = x / S * C, fy = y / S * C, fz = z / S * C;
    const cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
    let f1 = 9;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx, gy = cy + dy, gz = cz + dz;
      const o = (((gx + C) % C) + C * (((gy + C) % C) + C * ((gz + C) % C))) * 3;
      const px = gx + pts[o] - fx, py = gy + pts[o + 1] - fy, pz = gz + pts[o + 2] - fz;
      f1 = Math.min(f1, px * px + py * py + pz * pz);
    }
    const worley = 1 - Math.min(1, Math.sqrt(f1) * 1.1);
    const X = x / S * V, Y = y / S * V, Z = z / S * V;
    const v = 0.65 * vnoise(X, Y, Z, V) + 0.35 * vnoise(X * 2 % V, Y * 2 % V, Z * 2 % V, V);
    const o = (x + S * (y + S * z)) * 4;
    // warp vectors: three decorrelated low-frequency value noises
    data[o] = Math.round(vnoise((X + 3.3) % V, (Y + 1.7) % V, (Z + 5.1) % V, V) * 255);
    data[o + 1] = Math.round(vnoise((X + 6.1) % V, (Y + 4.2) % V, (Z + 2.6) % V, V) * 255);
    data[o + 2] = Math.round(vnoise((X + 1.4) % V, (Y + 7.3) % V, (Z + 3.9) % V, V) * 255);
    data[o + 3] = Math.round(Math.min(1, Math.max(0, worley * 0.62 + v * 0.38)) * 255);
  }
  const tex = new THREE.Data3DTexture(data, S, S, S);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/**
 * fine detail noise (tiling, 32³). rgb = curl of a value-noise vector potential (divergence
 * free, signed, encoded 0.5 ± 0.5): advects the fine structure like small turbulent eddies;
 * a = two octaves of inverted Worley (8 and 16 cells per tile) – the small cauliflower crumbs and
 * wisps that fray the rims.
 */
function makeFineNoise(S = 32): THREE.Data3DTexture {
  const data = new Uint8Array(S * S * S * 4);
  let seed = 192837465;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const worley = (C: number) => {
    const pts = Array.from({ length: C * C * C * 3 }, rnd);
    const out = new Float32Array(S * S * S);
    for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const fx = x / S * C, fy = y / S * C, fz = z / S * C;
      const cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
      let f1 = 9;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx, gy = cy + dy, gz = cz + dz;
        const o = (((gx + C) % C) + C * (((gy + C) % C) + C * ((gz + C) % C))) * 3;
        const px = gx + pts[o] - fx, py = gy + pts[o + 1] - fy, pz = gz + pts[o + 2] - fz;
        f1 = Math.min(f1, px * px + py * py + pz * pz);
      }
      out[x + S * (y + S * z)] = 1 - Math.min(1, Math.sqrt(f1) * 1.15);
    }
    return out;
  };
  const w8 = worley(8), w16 = worley(16);
  // vector potential: three periodic value noises on a 4³ lattice (eddies ≈ ¼ tile)
  const V = 4;
  const lat = [0, 1, 2].map(() => new Float32Array(V * V * V).map(rnd));
  const vn = (f: Float32Array, x: number, y: number, z: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let ax = x - xi, ay = y - yi, az = z - zi;
    ax = ax * ax * (3 - 2 * ax); ay = ay * ay * (3 - 2 * ay); az = az * az * (3 - 2 * az);
    let s = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const wgt = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay) * (dz ? az : 1 - az);
      s += wgt * f[(((xi + dx) % V + V) % V) + V * ((((yi + dy) % V + V) % V) + V * (((zi + dz) % V + V) % V))];
    }
    return s;
  };
  const curl = new Float32Array(S * S * S * 3);
  const e = 0.5 / S * V;
  let cmax = 1e-6;
  for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const X = x / S * V, Y = y / S * V, Z = z / S * V;
    const d = (f: Float32Array, ax: number) => (ax === 0 ? vn(f, X + e, Y, Z) - vn(f, X - e, Y, Z)
      : ax === 1 ? vn(f, X, Y + e, Z) - vn(f, X, Y - e, Z) : vn(f, X, Y, Z + e) - vn(f, X, Y, Z - e)) / (2 * e);
    const o = (x + S * (y + S * z)) * 3;
    curl[o] = d(lat[2], 1) - d(lat[1], 2);
    curl[o + 1] = d(lat[0], 2) - d(lat[2], 0);
    curl[o + 2] = d(lat[1], 0) - d(lat[0], 1);
    cmax = Math.max(cmax, Math.abs(curl[o]), Math.abs(curl[o + 1]), Math.abs(curl[o + 2]));
  }
  for (let i = 0; i < S * S * S; i++) {
    const o = i * 4;
    data[o] = Math.round((0.5 + 0.5 * curl[i * 3] / cmax) * 255);
    data[o + 1] = Math.round((0.5 + 0.5 * curl[i * 3 + 1] / cmax) * 255);
    data[o + 2] = Math.round((0.5 + 0.5 * curl[i * 3 + 2] / cmax) * 255);
    data[o + 3] = Math.round(Math.min(1, Math.max(0, w8[i] * 0.65 + w16[i] * 0.35)) * 255);
  }
  const tex = new THREE.Data3DTexture(data, S, S, S);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

class CloudVolume {
  readonly sim = new CloudSim();
  readonly texture: THREE.Data3DTexture;
  readonly noise: THREE.Data3DTexture;
  /** fine detail (curl vectors + small Worley crumbs) for the frayed rims. */
  readonly fine: THREE.Data3DTexture;
  /** Grid min corner (world) and size. */
  readonly uOrigin = uniform(new THREE.Vector3(0, -1000, 0));
  readonly uSize = uniform(new THREE.Vector3(1, 1, 1));
  /** Occupied box (world, with a margin); empty box = nothing to march. */
  readonly uBoxMin = uniform(new THREE.Vector3(0, -1000, 0));
  readonly uBoxMax = uniform(new THREE.Vector3(0, -1001, 0));
  readonly uKeyDir = uniform(new THREE.Vector3(0, 1, 0));
  /** x = key irradiance scale, y = red scale. */
  readonly uScale = uniform(new THREE.Vector2(1, 1));
  readonly uTime = uniform(0);
  /** xyz = unit direction towards the red floods, w = their share of the red channel. */
  readonly uRed = uniform(new THREE.Vector4(0, 1, 0, 0));
  /** scale of the uniform flood fill at the current site (1 = unscaled). */
  readonly uFill = uniform(1);
  private zones: CloudStageZone[] = [];
  /** Diagnostics: CPU time of the last simulation step and bake [ms], occupied cells, mass [m²], box size [m]. */
  readonly stats = { stepMs: 0, bakeMs: 0, cells: 0, mass: 0, size: [0, 0, 0], worker: false };
  /** True while a post chain draws the volume (the blast particles then only add fine wisps). */
  rendering = false;
  /** True on the McGregor pad (dense air, flat ground); the worlds keep the particle clouds. */
  site = true;
  private acc = 0;
  private focus: { x: number; z: number } | null = null;
  private pending: CloudSource[] = [];
  private worker: Worker | null = null;
  private busy = false;
  private gen = 0;
  private clearPending = false;
  private spare: ArrayBuffer;

  constructor() {
    const s = this.sim;
    const t = new THREE.Data3DTexture(new Uint8Array(s.n * 4), s.nx, s.ny, s.nz);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    this.texture = t;
    this.spare = new ArrayBuffer(s.n * 4);
    this.noise = makeDetailNoise();
    this.fine = makeFineNoise();
    this.uSize.value.set(s.sizeX, s.sizeY, s.sizeZ);
  }

  /** Volume on: the post chain draws it and we are on a site with a ground cloud. */
  get active(): boolean { return this.rendering && this.site && !DISABLED; }

  /** Simulation and bake run in a worker (created on first use); main-thread fallback without workers. */
  private ensureWorker(): void {
    if (this.worker || this.stats.worker || typeof Worker === 'undefined') return;
    this.stats.worker = true;  // (one attempt)
    try {
      const w = new Worker(new URL('./cloudWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<CloudStepResult>) => this.onResult(e.data);
      w.onerror = () => { w.terminate(); this.worker = null; this.busy = false; this.spare = new ArrayBuffer(this.sim.n * 4); };
      this.worker = w;
    } catch {
      this.worker = null;
    }
  }

  /** stage lights per stunt site (replaces the previous set). */
  setStageZones(zones: CloudStageZone[]): void { this.zones = zones; }

  private zoneAt(x: number, z: number): CloudStageZone | null {
    for (const zn of this.zones) if (Math.hypot(x - zn.x, z - zn.z) < zn.r) return zn;
    return null;
  }

  addSource(s: CloudSource): void {
    if (!this.active) return;
    this.pending.push(s);
    // emission centroid of this frame: the grid follows it
    this.focus = this.focus ? { x: (this.focus.x + s.x) * 0.5, z: (this.focus.z + s.z) * 0.5 } : { x: s.x, z: s.z };
  }

  clear(): void {
    this.gen++;
    this.sim.clear();
    this.pending.length = 0;
    this.acc = 0;
    this.focus = null;
    this.clearPending = true;
    (this.texture.image.data as Uint8Array).fill(0);
    this.texture.needsUpdate = true;
    this.uBoxMin.value.set(0, -1000, 0);
    this.uBoxMax.value.set(0, -1001, 0);
  }

  /** Advance at a fixed rate (sources of this frame were added before). `car` places an empty grid. */
  update(dt: number, carX: number, carZ: number): void {
    if (!this.active) return;
    this.ensureWorker();
    for (let i = this.pending.length - 1; i >= 0 && this.pending[i].dt === undefined; i--) this.pending[i].dt = dt;
    this.acc = Math.min(this.acc + dt, 2 / SIM_HZ);
    const steps = Math.floor(this.acc * SIM_HZ + 1e-6);
    if (steps < 1 || this.busy) return;
    this.acc -= steps / SIM_HZ;
    const req: CloudStepRequest = {
      clear: this.clearPending, sources: this.pending, steps, dt: 1 / SIM_HZ, focus: this.focus,
      car: { x: carX, z: carZ }, lights: this.readLights(carX, carZ), buf: this.spare,
    };
    this.pending = [];
    this.focus = null;
    this.clearPending = false;
    if (this.worker) {
      this.busy = true;
      const gen = this.gen;
      this.reqGen = gen;
      this.worker.postMessage(req, [req.buf]);
    } else {
      this.onResult(runStep(this.sim, req));
    }
  }
  private reqGen = 0;

  private onResult(r: CloudStepResult): void {
    this.busy = false;
    if (this.worker && this.reqGen !== this.gen) { this.spare = r.buf; return; }   // cleared meanwhile
    const img = this.texture.image as { data: Uint8Array };
    this.spare = img.data.buffer as ArrayBuffer;
    img.data = new Uint8Array(r.buf);
    this.texture.needsUpdate = true;
    const h = this.sim.h, b = r.bounds;
    this.uOrigin.value.set(r.origin[0], r.origin[1], r.origin[2]);
    if (b) {
      // (margin ≥ the shader's lookup displacement: warp ±1.6 m + curl eddies ±0.9 m – a
      // smaller box cut the displaced rims off in straight lines)
      const m = 1.5 * h + 2.6, [ox, oy, oz] = r.origin;
      this.uBoxMin.value.set(ox + b.i0 * h - m, oy, oz + b.k0 * h - m);
      this.uBoxMax.value.set(ox + (b.i1 + 1) * h + m, oy + (b.j1 + 1) * h + m, oz + (b.k1 + 1) * h + m);
      this.stats.cells = (b.i1 - b.i0 + 1) * (b.j1 - b.j0 + 1) * (b.k1 - b.k0 + 1);
      this.stats.size = [(b.i1 - b.i0 + 1) * h, (b.j1 + 1) * h, (b.k1 - b.k0 + 1) * h];
    } else {
      this.uBoxMin.value.set(0, -1000, 0);
      this.uBoxMax.value.set(0, -1001, 0);
      this.stats.cells = 0;
      this.stats.size = [0, 0, 0];
    }
    this.uKeyDir.value.set(r.keyDir[0], r.keyDir[1], r.keyDir[2]);
    this.uScale.value.set(r.keyMax, r.redMax);
    this.uRed.value.set(r.redDir[0], r.redDir[1], r.redDir[2], r.redSpot);
    this.uTime.value = r.time;
    if (r.stepMs) this.stats.stepMs = r.stepMs;
    this.stats.bakeMs = r.bakeMs;
    this.stats.mass = r.mass;
  }

  private readLights(carX: number, carZ: number): CloudLights {
    const L: CloudLights = { spots: [], sun: null, leds: [], reds: [] };
    const pos = fxLight.pos.array as THREE.Vector4[], dir = fxLight.dir.array as THREE.Vector4[], inner = fxLight.inner.array as THREE.Vector4[];
    for (let i = 0; i < pos.length; i++) {
      if (pos[i].w <= 0) continue;
      L.spots.push({ x: pos[i].x, y: pos[i].y, z: pos[i].z, I: pos[i].w, dx: dir[i].x, dy: dir[i].y, dz: dir[i].z, cosOuter: dir[i].w, cosInner: inner[i].x });
    }
    const sun = fxLight.sunDir.value as THREE.Vector4;
    L.sun = sun.w > 0 ? { dx: sun.x, dy: sun.y, dz: sun.z, E: sun.w } : null;
    L.leds = (fxLight.leds.array as THREE.Vector4[]).map((b) => ({ x: b.x, z0: b.y, z1: b.z, gain: b.w }));
    // the site's stage lights (white ones join the key light, red ones the red channel)
    const zn = this.zoneAt(carX, carZ);
    this.uFill.value = zn ? zn.fill : 1;
    if (zn && !L.sun) for (const l of zn.lights) {
      const cosO = Math.cos(l.halfAngleDeg * Math.PI / 180), cosI = Math.cos(l.halfAngleDeg * 0.55 * Math.PI / 180);
      const sp = { x: l.pos.x, y: l.pos.y, z: l.pos.z, I: l.cd * PHOTOMETRIC_CD, dx: l.dir.x, dy: l.dir.y, dz: l.dir.z, cosOuter: cosO, cosInner: cosI };
      (l.colour === 'red' ? L.reds! : L.spots).push(sp);
    }
    return L;
  }
}

export const cloudVolume = new CloudVolume();
// diagnostics hook for the acceptance scripts (tools, tests/render)
(globalThis as unknown as { __cloudVolume?: CloudVolume }).__cloudVolume = cloudVolume;
