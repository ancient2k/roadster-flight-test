// Roads and paved slabs painted into the terrain (Starbase: tools/worlds/starbase_ground.py). As meshes on the
// ungraded ground they were steps the car caught on, jagged where the per-segment boxes met, and they flickered or
// vanished against the coarser terrain LODs in the distance; as a mask in the terrain shader they follow the ground
// exactly at every distance and the car simply drives on the terrain.
import * as THREE from 'three/webgpu';
import type { LandmarkDef } from './terrainData';
import { landmarkMatrix } from './landmarks';

export interface PavedGroundFile {
  roads: { kind: 'asphalt' | 'concrete'; w: number; pts: [number, number][] }[];
  slabs: { kind: 'asphalt' | 'concrete'; pts: [number, number][] }[];
}

export interface PavedGround {
  /** R = concrete, G = asphalt coverage (0..1, RG8), over the world rectangle x0/z0 + size. */
  tex: THREE.Texture;
  x0: number; z0: number; sizeX: number; sizeZ: number;
  /** Linear albedo of the two surfaces (the materials of the old model). */
  concrete: [number, number, number];
  asphalt: [number, number, number];
  /** Paved (or within ~1 m of it): no vegetation there. */
  covered(x: number, z: number): boolean;
}

/** Finest texel size of the mask (m); coarser when the roads reach far (Highway 4: ≈ 2.9 km → 0.73 m). */
const CELL_MIN_M = 0.5;
/** Largest mask side (texels): within every WebGPU/WebGL2 device limit, ≈ 20 MB as RG8. */
const MAX_TEXELS = 4000;

export async function loadPavedGround(dir: string, def: LandmarkDef): Promise<PavedGround | null> {
  if (!def.ground) return null;
  let file: PavedGroundFile;
  try {
    const r = await fetch(`${dir}/${def.ground}`);
    if (!r.ok) return null;
    file = await r.json() as PavedGroundFile;
  } catch { return null; }
  return buildPavedGround(file, landmarkMatrix(def, 0));
}

export function buildPavedGround(file: PavedGroundFile, matrix: THREE.Matrix4): PavedGround | null {
  // model frame (glTF): x = east, z = -north
  const v = new THREE.Vector3();
  const toWorld = (p: [number, number]): [number, number] => { v.set(p[0], 0, -p[1]).applyMatrix4(matrix); return [v.x, v.z]; };
  const roads = file.roads.map((r) => ({ ...r, w: r.w, pts: r.pts.map(toWorld) }));
  const slabs = file.slabs.map((s) => ({ ...s, pts: s.pts.map(toWorld) }));
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const f of [...roads, ...slabs]) for (const [x, z] of f.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  if (!Number.isFinite(x0)) return null;
  const pad = 12;
  x0 = Math.floor(x0 - pad); z0 = Math.floor(z0 - pad); x1 = Math.ceil(x1 + pad); z1 = Math.ceil(z1 + pad);
  const CELL_M = Math.max(CELL_MIN_M, (x1 - x0) / MAX_TEXELS, (z1 - z0) / MAX_TEXELS);
  const w = Math.ceil((x1 - x0) / CELL_M), h = Math.ceil((z1 - z0) / CELL_M);
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter'; // channels add: concrete in R, asphalt in G
  const col = (k: 'asphalt' | 'concrete') => (k === 'asphalt' ? '#00ff00' : '#ff0000');
  // slabs first, roads on top; per surface one composite pass so overlaps of one kind do not exceed 1
  for (const kind of ['concrete', 'asphalt'] as const) {
    const layer = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const c2 = layer.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    c2.setTransform(1 / CELL_M, 0, 0, 1 / CELL_M, -x0 / CELL_M, -z0 / CELL_M);
    c2.fillStyle = col(kind); c2.strokeStyle = col(kind); c2.lineJoin = 'round'; c2.lineCap = 'round';
    for (const s of slabs) if (s.kind === kind) { c2.beginPath(); s.pts.forEach(([x, z], i) => (i ? c2.lineTo(x, z) : c2.moveTo(x, z))); c2.closePath(); c2.fill(); }
    for (const r of roads) if (r.kind === kind) {
      c2.lineWidth = r.w;
      c2.beginPath(); r.pts.forEach(([x, z], i) => (i ? c2.lineTo(x, z) : c2.moveTo(x, z))); c2.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer as CanvasImageSource, 0, 0);
  }
  const img = ctx.getImageData(0, 0, w, h);
  // grass mask: covered or within ~1 m (3 texels) of it
  const cov = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) cov[i] = img.data[i * 4] > 40 || img.data[i * 4 + 1] > 40 ? 1 : 0;
  const grown = new Uint8Array(w * h), R = Math.ceil(1 / CELL_M);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!cov[j * w + i]) continue;
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < w && jj < h) grown[jj * w + ii] = 1;
    }
  }
  const data = new Uint8Array(w * h * 2);
  for (let i = 0; i < w * h; i++) { data[i * 2] = img.data[i * 4]; data[i * 2 + 1] = img.data[i * 4 + 1]; }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return {
    tex, x0, z0, sizeX: w * CELL_M, sizeZ: h * CELL_M,
    concrete: [0.46, 0.45, 0.40], asphalt: [0.10, 0.12, 0.13],
    covered: (x, z) => {
      const i = Math.floor((x - x0) / CELL_M), j = Math.floor((z - z0) / CELL_M);
      return i >= 0 && j >= 0 && i < w && j < h && grown[j * w + i] === 1;
    },
  };
}
