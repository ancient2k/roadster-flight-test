// Chunked CDLOD terrain mesh + PBR material for the world sites. Geometry is built on the CPU per quadtree
// node (identical on WebGPU and WebGL2); the vertex shader geomorphs toward the parent level by camera
// distance; shading uses per-texel world normals from the height grid (no LOD popping), macro albedo,
// slope/splat-driven detail layers (planar + triplanar), macro variation, micro normals, baked horizon
// shadows and – on the Moon – a Lommel–Seeliger/opposition regolith response.
import * as THREE from 'three/webgpu';
import type { UFloat, UVec3 } from './types';
import type { Node } from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, attribute, positionLocal, modelWorldMatrix, cameraPosition, positionWorld, texture,
  mix, smoothstep, clamp, length, normalize, dot, max, min, abs, pow, mx_noise_float, uniform, cameraViewMatrix,
  tan, acos, sqrt,
} from 'three/tsl';
import { TerrainField, gridNormalsRGBA8, type HeightGrid } from './terrainData';
import { selectLod, depthForSpacing, nodeKey, type LodConfig, type LodNode } from './lod';
import { buildChunk, sampleRange } from './chunk';
import type { LookParams } from './skyParams';

type N3 = Node<'vec3'>;
type NF = Node<'float'>;

export interface DetailLayer {
  diff: THREE.Texture;
  nor: THREE.Texture | null;
  arm: THREE.Texture | null;
  /** Mean linear albedo of diff (to turn it into a modulation around 1). */
  mean: [number, number, number];
  /** Tile size (m). */
  scaleM: number;
}

export interface TerrainTextures {
  albedo: THREE.Texture | null;
  splat: THREE.Texture | null;
  fine: DetailLayer | null;
  rock: DetailLayer | null;
  /** Baked sun visibility (near and far tile). */
  shadowNear: THREE.Texture | null;
  shadowFar: THREE.Texture | null;
  /** Strength (0..1) of the fine layer's luminance detail and how much of its hue is kept (grassland: low). */
  fineStrength?: number;
  fineChroma?: number;
  /** disturbed regolith around a landing site (albedo multiplier, centred at cx/cz, sizeM wide). */
  trampled?: { tex: THREE.Texture; cx: number; cz: number; sizeM: number } | null;
  /** procedural small-crater field below the DEM resolution ('moon' dense, 'mars' sparse). */
  craters?: 'moon' | 'mars' | null;
  /** multiplier on the macro albedo (Giza: warmer desert sand than the composite). */
  albedoTint?: [number, number, number];
  /** sedimentary layering on slopes (Mars: Mount Sharp, Valles walls, delta scarps). */
  strata?: boolean;
  /** roads and paved slabs painted into the ground (src/render/worlds/pavedGround.ts). */
  paved?: import('./pavedGround').PavedGround | null;
}

/**
 * periodic small-crater tile (CPU, once per site): slope (dh/dx, dh/dz) and fresh-rim brightness of a
 * Worley-placed crater population on a torus of `tileM` metres, packed into RGBA8 (R,G = slope·0.25+0.5,
 * B = rim). Profile in units of the radius R: bowl −D·(1−d²), rim +0,22·D·exp(−((d−1)/0,32)²) (degraded
 * Pike-like shapes); sizes R = S·(0,1…0,46) with a steep power law; `density` = share of occupied cells.
 * Sampled at two rotated scales in the shader (two texture fetches instead of 27 Worley cells per pixel).
 */
export function craterTile(kind: 'moon' | 'mars', res = 1024, tileM = 128): THREE.DataTexture {
  const pops: [number, number, number][] = kind === 'moon'
    ? [[tileM / 8, 0.14, 0.07], [tileM / 28, 0.24, 0.09], [tileM / 96, 0.32, 0.11]]
    : [[tileM / 10, 0.07, 0.08], [tileM / 40, 0.07, 0.1]];
  const gx = new Float32Array(res * res), gz = new Float32Array(res * res), rim = new Float32Array(res * res);
  let seed = kind === 'moon' ? 17 : 29;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const px = tileM / res;
  for (const [S, dens, depth] of pops) {
    const n = Math.round(tileM / S), cs = tileM / n;
    for (let cj = 0; cj < n; cj++) for (let ci = 0; ci < n; ci++) {
      const keep = rnd() < dens, hx = rnd(), hz = rnd(), sz = rnd();
      if (!keep) continue;
      const R = cs * (0.1 + 0.36 * sz * sz * sz);
      const cx = (ci + 0.15 + 0.7 * hx) * cs, cz = (cj + 0.15 + 0.7 * hz) * cs;
      const D = depth * (1.3 - 0.6 * sz), A = 0.22 * D, w = 0.32;
      const ext = R * 2.2, r0 = Math.floor((cz - ext) / px), r1 = Math.ceil((cz + ext) / px);
      const c0 = Math.floor((cx - ext) / px), c1 = Math.ceil((cx + ext) / px);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const dx = (c + 0.5) * px - cx, dz = (r + 0.5) * px - cz;
        const len = Math.hypot(dx, dz), d = len / R;
        if (d >= 2.2 || len < 1e-6) continue;
        const e = Math.exp(-(((d - 1) / w) ** 2));
        const slope = (d < 1 ? 2 * D * d : 0) - (2 * A * (d - 1) / (w * w)) * e;
        const i = ((r % res + res) % res) * res + ((c % res + res) % res);
        gx[i] += (dx / len) * slope; gz[i] += (dz / len) * slope;
        rim[i] += e * (1 - sz) * (S < tileM / 50 ? 1 : 0.5);
      }
    }
  }
  const data = new Uint8Array(res * res * 4);
  for (let i = 0; i < res * res; i++) {
    data[i * 4] = Math.max(0, Math.min(255, Math.round((gx[i] * 0.25 + 0.5) * 255)));
    data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round((gz[i] * 0.25 + 0.5) * 255)));
    data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(Math.min(1, rim[i]) * 255)));
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export interface TerrainQuality {
  /** Leaf range multiplier (detail distance). */
  detail: number;
  gridN: number;
  /** Finest vertex spacing as a multiple of the native height-sample spacing. */
  spacingFactor: number;
}

export const TERRAIN_QUALITY: Record<'low' | 'medium' | 'high' | 'ultra', TerrainQuality> = {
  low: { detail: 1.0, gridN: 16, spacingFactor: 2 },
  medium: { detail: 1.0, gridN: 32, spacingFactor: 2 },
  high: { detail: 1.0, gridN: 32, spacingFactor: 1 },
  ultra: { detail: 1.5, gridN: 32, spacingFactor: 1 },
};

function dataTex(data: Uint8Array, size: number, format: THREE.PixelFormat, mip = true): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, format, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mip;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Pack a grid normal map as a texture (row 0 = north = v 0). */
export function normalTexture(g: HeightGrid): THREE.DataTexture {
  return dataTex(gridNormalsRGBA8(g), g.size, THREE.RGBAFormat);
}
export function visibilityTexture(v: Uint8Array, res: number): THREE.DataTexture {
  return dataTex(v, res, THREE.RedFormat);
}

export interface TerrainUniforms {
  sunDir: UVec3;
  /** Distance (from the shadow-camera centre) where the real-time shadow hands over to the baked one. */
  rtShadowCenter: UVec3;
  rtShadowRadius: UFloat;
  detailStrength: UFloat;
  /** 0..1: debug blend toward plain albedo (look comparison). */
  debugFlat: UFloat;
}

export class TerrainRenderer {
  readonly group = new THREE.Group();
  readonly field: TerrainField;
  readonly material: THREE.MeshStandardNodeMaterial;
  readonly uniforms: TerrainUniforms;
  private cfg: LodConfig;
  private cache = new Map<string, { geom: THREE.BufferGeometry; used: number }>();
  private rangeCache = new Map<string, [number, number]>();
  /**
   * One mesh per LOD node, kept by its key. Three derives the motion vectors of a mesh from its own previous matrix:
   * the old pool handed out meshes by selection index, so whenever the selection changed while driving a mesh moved
   * to another chunk and its ground got the offset between the two chunk centres as a one-frame "velocity" – TRAA
   * and motion blur smeared and flashed patches of ground. A node keeps its mesh; a new node gets a new mesh (its
   * history starts at its own matrix).
   */
  private meshes = new Map<string, { mesh: THREE.Mesh; used: number }>();
  private frame = 0;
  private selected: LodNode[] = [];
  private leafRangeU = uniform(1);
  private quality: TerrainQuality;
  private normalNear: THREE.DataTexture;
  private normalFar: THREE.DataTexture | null;
  private craterTex: THREE.DataTexture | null = null;
  /** Final albedo node of the ground (shared with the footprint decals so they shade like the regolith). */
  surfaceColor!: Node<'vec3'>;
  /** Statistics of the last update. */
  stats = { nodes: 0, built: 0, cached: 0, triangles: 0 };

  constructor(field: TerrainField, readonly look: LookParams, readonly tex: TerrainTextures, q: TerrainQuality, readonly maxCacheNodes = 900) {
    this.field = field;
    this.quality = q;
    this.group.name = 'Terrain';
    this.normalNear = normalTexture(field.near);
    this.normalFar = field.far ? normalTexture(field.far) : null;
    this.uniforms = {
      sunDir: uniform(new THREE.Vector3(0, 1, 0)),
      rtShadowCenter: uniform(new THREE.Vector3()),
      rtShadowRadius: uniform(0),
      detailStrength: uniform(1),
      debugFlat: uniform(0),
    };
    this.cfg = this.makeConfig(q);
    this.leafRangeU.value = this.cfg.leafRange;
    this.craterTex = tex.craters ? craterTile(tex.craters) : null;
    this.material = this.makeMaterial();
  }

  private makeConfig(q: TerrainQuality): LodConfig {
    const f = this.field;
    const root = f.halfExtent * 2;
    const nearSp = f.near.extentM / (f.near.size - 1);
    const maxDepth = depthForSpacing(root, q.gridN, nearSp * q.spacingFactor);
    const farDepth = f.far ? depthForSpacing(root, q.gridN, f.far.extentM / (f.far.size - 1)) : maxDepth;
    const leafSize = root / 2 ** maxDepth;
    const nb = f.near, pad = f.blendM;
    const nx0 = nb.cx - nb.extentM / 2 - pad, nx1 = nb.cx + nb.extentM / 2 + pad;
    const nz0 = nb.cz - nb.extentM / 2 - pad, nz1 = nb.cz + nb.extentM / 2 + pad;
    return {
      x0: -f.halfExtent, z0: -f.halfExtent, size: root, gridN: q.gridN, maxDepth,
      // ≥ 2√2 × leaf size keeps neighbouring nodes within one level (CDLOD condition, see lod.ts tests)
      leafRange: leafSize * 3 * Math.max(1, q.detail), morphStartRatio: 0.7,
      depthCap: f.far ? (x0, z0, s) => (x0 + s > nx0 && x0 < nx1 && z0 + s > nz0 && z0 < nz1 ? maxDepth : farDepth) : undefined,
      heightRange: (x0, z0, s) => {
        const k = `${x0}:${z0}:${s}`;
        let r = this.rangeCache.get(k);
        if (!r) {
          r = sampleRange((x, z) => f.height(x, z), x0, z0, s, 8);
          // sampling can miss peaks between lattice points: pad by a slope allowance
          const padY = (s / 8) * 0.6;
          r = [r[0] - padY, r[1] + padY];
          this.rangeCache.set(k, r);
        }
        return r;
      },
    };
  }

  setQuality(q: TerrainQuality): void {
    if (q.gridN !== this.quality.gridN || q.spacingFactor !== this.quality.spacingFactor) { this.clearCache(); this.rangeCache.clear(); }
    this.quality = q;
    const hr = this.cfg.heightRange;
    this.cfg = { ...this.makeConfig(q), heightRange: hr };
    this.leafRangeU.value = this.cfg.leafRange;
  }

  private clearCache(): void {
    for (const c of this.cache.values()) c.geom.dispose();
    this.cache.clear();
  }

  private geometryFor(n: LodNode): THREE.BufferGeometry {
    const key = nodeKey(n);
    const hit = this.cache.get(key);
    if (hit) { hit.used = this.frame; this.stats.cached++; return hit.geom; }
    const f = this.field;
    const skirt = Math.max(0.5, n.size / this.cfg.gridN * 0.6);
    const a = buildChunk((x, z) => f.height(x, z), n.x0, n.z0, n.size, this.cfg.gridN, skirt);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(a.normals, 3));
    g.setAttribute('parentY', new THREE.BufferAttribute(a.parentY, 1));
    // node side length per vertex: the vertex shader derives the morph window from it (one material for all levels)
    g.setAttribute('chunkSize', new THREE.BufferAttribute(new Float32Array(a.parentY.length).fill(n.size), 1));
    g.setIndex(new THREE.BufferAttribute(a.indices, 1));
    const h = n.size / 2;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-h, a.minY, -h), new THREE.Vector3(h, a.maxY, h));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    g.userData = { cx: a.cx, cz: a.cz };
    this.cache.set(key, { geom: g, used: this.frame });
    this.stats.built++;
    return g;
  }

  private evict(): void {
    if (this.cache.size <= this.maxCacheNodes) return;
    const items = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < items.length - this.maxCacheNodes; i++) {
      items[i][1].geom.dispose();
      this.cache.delete(items[i][0]);
    }
  }

  update(cam: THREE.Vector3): void {
    this.frame++;
    this.stats.built = 0; this.stats.cached = 0;
    selectLod(this.cfg, cam, this.selected);
    let tris = 0;
    for (let i = 0; i < this.selected.length; i++) {
      const n = this.selected[i];
      const key = nodeKey(n);
      let e = this.meshes.get(key);
      if (!e) {
        const g = this.geometryFor(n);
        const m = new THREE.Mesh(g, this.material);
        m.castShadow = true; m.receiveShadow = true;
        m.matrixAutoUpdate = false;
        m.name = 'TerrainChunk';
        m.position.set(g.userData.cx, 0, g.userData.cz);
        m.updateMatrix(); m.updateMatrixWorld();
        this.group.add(m);
        e = { mesh: m, used: this.frame };
        this.meshes.set(key, e);
      } else {
        this.geometryFor(n); // keeps the cached geometry alive
      }
      e.used = this.frame;
      e.mesh.visible = true;
      tris += (e.mesh.geometry.index!.count / 3);
    }
    // nodes that left the selection: hidden, dropped after a while (their geometry may be evicted from the cache)
    for (const [key, e] of this.meshes) {
      if (e.used === this.frame) continue;
      e.mesh.visible = false;
      if (this.frame - e.used > 240 || !this.cache.has(key)) { e.mesh.removeFromParent(); this.meshes.delete(key); }
    }
    this.stats.nodes = this.selected.length;
    this.stats.triangles = tris;
    this.evict();
  }

  /** Height at world (x, z) – for spawn placement and the camera rig. */
  heightAt(x: number, z: number): number { return this.field.height(x, z); }

  private makeMaterial(): THREE.MeshStandardNodeMaterial {
    const m = new THREE.MeshStandardNodeMaterial();
    m.name = 'TerrainCDLOD';
    const f = this.field, look = this.look, T = this.tex, U = this.uniforms;
    const nearE = f.near.extentM, nearMin = vec2(f.near.cx - nearE / 2, f.near.cz - nearE / 2);
    const far = f.far;
    const farE = far ? far.extentM : nearE, farMin = far ? vec2(far.cx - farE / 2, far.cz - farE / 2) : nearMin;
    const leafSize = this.cfg.size / 2 ** this.cfg.maxDepth;

    // --- vertex: geomorph by camera distance. Morph window from the node size (size = leaf·2^level, so
    // range = leafRange·2^level = size·leafRange/leaf).
    const leafRangeU = this.leafRangeU;
    const morphY = Fn(() => {
      const local = positionLocal;
      const wp = modelWorldMatrix.mul(vec4(local, 1)).xyz;
      const d = length(wp.sub(cameraPosition));
      const size = attribute<'float'>('chunkSize', 'float');
      const end = size.mul(leafRangeU).div(leafSize);
      const start = end.mul(this.cfg.morphStartRatio);
      const k = clamp(d.sub(start).div(end.sub(start).max(1e-3)), 0, 1);
      return vec3(local.x, mix(local.y, attribute<'float'>('parentY', 'float'), k), local.z);
    });
    m.positionNode = morphY();

    // --- fragment
    const wxz = positionWorld.xz;
    const uvN = wxz.sub(nearMin).div(nearE);
    const uvF = wxz.sub(farMin).div(farE);
    const inside = min(float(nearE / 2).sub(abs(wxz.x.sub(f.near.cx))), float(nearE / 2).sub(abs(wxz.y.sub(f.near.cz))));
    const wN = far ? smoothstep(float(0), float(f.blendM), inside) : float(1);
    const dec = (c: Node<'vec4'>) => vec3(c.x.mul(2).sub(1), c.y, c.z.mul(2).sub(1));
    const nNear = dec(texture(this.normalNear, uvN));
    const nFar = this.normalFar ? dec(texture(this.normalFar, uvF)) : nNear;
    const nMacro = normalize(mix(nFar, nNear, wN)).toVar('nMacro');
    const slope = float(1).sub(nMacro.y);
    const dist = length(positionWorld.sub(cameraPosition));
    const n1 = mx_noise_float(vec3(wxz.x, 0, wxz.y).mul(1 / 90)).mul(0.5).add(0.5);
    const n2 = mx_noise_float(vec3(wxz.x, 0, wxz.y).mul(1 / 420)).mul(0.5).add(0.5);
    const n3 = mx_noise_float(vec3(wxz.x, 0, wxz.y).mul(1 / 13)).mul(0.5).add(0.5);
    const macroVar = n1.mul(0.6).add(n2.mul(0.4)).sub(0.5);

    // macro albedo
    const pal = vec3(look.groundAlbedo[0], look.groundAlbedo[1], look.groundAlbedo[2]);
    const farAlb = pal.mul(macroVar.mul(0.35).add(1));
    const nearAlb = T.albedo ? texture(T.albedo, uvN).rgb : farAlb;
    const macroAlb = T.albedoTint ? mix(farAlb, nearAlb, wN).mul(vec3(...T.albedoTint)) : mix(farAlb, nearAlb, wN);

    // layer weights: rock by slope (+ splat R), fine material elsewhere
    const splat = T.splat ? texture(T.splat, uvN) : vec4(0, 1, 0, 0);
    const rockSlope = smoothstep(float(0.18), float(0.4), slope.add(n3.sub(0.5).mul(0.12)));
    const rockW = max(rockSlope, splat.x.mul(wN)).clamp(0, 1).toVar('rockW');
    const detailFade = float(1).sub(smoothstep(float(80), float(700), dist)).mul(U.detailStrength);

    let colorMod: N3 = vec3(1, 1, 1) as N3;
    let rough: NF = float(0.95) as NF;
    let ao: NF = float(1) as NF;
    let nDetail: N3 = nMacro as unknown as N3;
    const planar = (L: DetailLayer) => {
      // two scales against visible tiling, the larger one rotated
      const uvA = wxz.div(L.scaleM);
      const uvB = vec2(wxz.x.mul(0.8).sub(wxz.y.mul(0.6)), wxz.x.mul(0.6).add(wxz.y.mul(0.8))).div(L.scaleM * 4.7);
      const mean = vec3(L.mean[0], L.mean[1], L.mean[2]);
      const cA = texture(L.diff, uvA).rgb.div(mean), cB = texture(L.diff, uvB).rgb.div(mean);
      const c = mix(cA, cB, 0.35);
      const arm = L.arm ? texture(L.arm, uvA) : vec4(1, 0.9, 0, 1);
      const nT = L.nor ? texture(L.nor, uvA).xyz.mul(2).sub(1) : vec3(0, 0, 1);
      return { c, arm, nW: vec3(nT.x, 0, nT.y) };
    };
    const triplanar = (L: DetailLayer) => {
      const sc = 1 / L.scaleM;
      const bw = pow(abs(nMacro), vec3(4));
      const w = bw.div(bw.x.add(bw.y).add(bw.z));
      const p = positionWorld.mul(sc);
      const mean = vec3(L.mean[0], L.mean[1], L.mean[2]);
      const cx = texture(L.diff, p.zy).rgb, cy = texture(L.diff, p.xz).rgb, cz = texture(L.diff, p.xy).rgb;
      const c = cx.mul(w.x).add(cy.mul(w.y)).add(cz.mul(w.z)).div(mean);
      const ax = L.arm ? texture(L.arm, p.zy) : vec4(1, 0.85, 0, 1);
      const ay = L.arm ? texture(L.arm, p.xz) : vec4(1, 0.85, 0, 1);
      const az = L.arm ? texture(L.arm, p.xy) : vec4(1, 0.85, 0, 1);
      const arm = ax.mul(w.x).add(ay.mul(w.y)).add(az.mul(w.z));
      let nW: N3 = vec3(0, 0, 0) as N3;
      if (L.nor) {
        // whiteout-style: tangent offsets applied in each projection plane
        const tx = texture(L.nor, p.zy).xyz.mul(2).sub(1), ty = texture(L.nor, p.xz).xyz.mul(2).sub(1), tz = texture(L.nor, p.xy).xyz.mul(2).sub(1);
        nW = vec3(0, tx.y, tx.x).mul(w.x).add(vec3(ty.x, 0, ty.y).mul(w.y)).add(vec3(tz.x, tz.y, 0).mul(w.z)) as N3;
      }
      return { c, arm, nW };
    };
    if (T.fine || T.rock) {
      // WebGPU allows 16 sampled textures per stage: with the crater tile / trampled map the ARM maps
      // (roughness ≥ 0,72 anyway, faint AO) give way
      const lean = !!(T.craters || T.trampled || T.paved);
      const fine = T.fine ? planar(lean ? { ...T.fine, arm: null } : T.fine) : null;
      const rock = T.rock ? triplanar(lean ? { ...T.rock, arm: null } : T.rock) : null;
      const cF = fine ? fine.c : vec3(1, 1, 1), cR = rock ? rock.c : cF;
      const aF = fine ? fine.arm : vec4(1, 0.95, 0, 1), aR = rock ? rock.arm : aF;
      const nF = fine ? fine.nW : vec3(0, 0, 0), nR = rock ? rock.nW : nF;
      // keep the macro hue: detail modulates luminance (and only mildly the chroma)
      const cm = mix(cF, cR, rockW);
      const lum = dot(cm, vec3(0.2126, 0.7152, 0.0722));
      const chroma = mix(float(T.fineChroma ?? 0.35), float(0.35), rockW);
      const strength = mix(float(T.fineStrength ?? 1), float(1), rockW);
      colorMod = mix(vec3(1, 1, 1), mix(vec3(lum, lum, lum), cm, chroma), detailFade.mul(strength)) as N3;
      const armM = mix(aF, aR, rockW);
      rough = mix(float(0.95), armM.y.max(0.72), detailFade) as unknown as NF;
      ao = mix(float(1), armM.x, detailFade.mul(0.6)) as unknown as NF;
      // grazing sun (Shackleton): sub-metre facets would flip between full sun and black – real regolith
      // averages that out (shadow hiding inside the footprint), so the micro-normals are toned down
      const nOff = mix(nF, nR, rockW).mul(detailFade).mul(look.look === 'lunar_low_sun' ? 0.3 : 0.8);
      nDetail = normalize(nMacro.add(nOff)) as N3;
    }
    // small craters below the DEM resolution (normals + bright fresh rims) from the baked periodic tile,
    // two rotated scales against repetition, faded out before the pattern turns into noise
    let craterRim: NF = float(0) as NF;
    if (T.craters && this.craterTex) {
      const tileM = 128;
      const ct = this.craterTex;
      const uvA = wxz.div(tileM);
      const uvB = vec2(wxz.x.mul(0.6).sub(wxz.y.mul(0.8)), wxz.x.mul(0.8).add(wxz.y.mul(0.6))).div(tileM * 2.7);
      const a = texture(ct, uvA), b = texture(ct, uvB);
      const fA = float(1).sub(smoothstep(float(60), float(260), dist)).mul(U.detailStrength);
      const fB = float(1).sub(smoothstep(float(150), float(700), dist)).mul(U.detailStrength);
      const gx = a.x.sub(0.5).mul(4).mul(fA).add(b.x.sub(0.5).mul(4 / 2.7).mul(fB));
      const gz = a.y.sub(0.5).mul(4).mul(fA).add(b.y.sub(0.5).mul(4 / 2.7).mul(fB));
      craterRim = a.z.mul(fA).add(b.z.mul(fB).mul(0.5)) as NF;
      nDetail = normalize(nDetail.add(vec3(gx.negate(), 0, gz.negate()).mul(sqrt(nDetail.y.max(0.05))))) as N3;
    }
    // far-field variation where no detail texture reaches
    const farMod = float(1).add(n3.sub(0.5).mul(0.12).mul(float(1).sub(detailFade)));
    let albedo: N3 = macroAlb.mul(colorMod).mul(farMod).mul(mix(float(1), float(0.82), rockW.mul(0.5))) as N3;
    if (T.strata) {
      // horizontal beds, gently dipping/warped, read on slopes: thin (≈3 m) and thick (≈20 m) sets, lighter
      // yellowish sulfate-rich beds against darker clay/basaltic ones (Mastcam colour of Mount Sharp)
      const wy = positionWorld.y.add(mx_noise_float(vec3(wxz.x, 0, wxz.y).mul(1 / 900)).mul(18)).add(wxz.x.mul(0.004));
      // incommensurate sines in the warped height: cheap, aperiodic-looking bed sets (one noise for the warp)
      const thin = wy.mul(2.24).sin().mul(0.55).add(wy.mul(5.31).add(1.7).sin().mul(0.3)).add(wy.mul(0.93).add(0.4).sin().mul(0.15));
      const thick = wy.mul(0.331).add(1.1).sin().mul(0.65).add(wy.mul(0.137).add(2.3).sin().mul(0.35));
      const sw = smoothstep(float(0.05), float(0.22), slope).mul(mix(float(0.75), float(1), wN));
      const k = thin.mul(0.16).add(thick.mul(0.26)).mul(sw);
      const tint = mix(vec3(0.9, 0.93, 1.0), vec3(1.1, 1.03, 0.9), thick.mul(0.5).add(0.5));
      albedo = albedo.mul(k.add(1)).mul(mix(vec3(1, 1, 1), tint, sw)) as N3;
    }
    if (T.craters) albedo = albedo.mul(craterRim.mul(T.craters === 'moon' ? 0.06 : 0.03).add(1)) as N3;
    if (T.trampled) {
      const tr = T.trampled;
      const uvT = wxz.sub(vec2(tr.cx - tr.sizeM / 2, tr.cz - tr.sizeM / 2)).div(tr.sizeM);
      const inT = min(min(uvT.x, uvT.y), min(float(1).sub(uvT.x), float(1).sub(uvT.y)));
      const tm = texture(tr.tex, uvT).x;
      albedo = albedo.mul(mix(float(1), tm, smoothstep(float(0), float(0.02), inT))) as N3;
    }

    // lunar regolith: Lommel–Seeliger brightening toward grazing view/sun + opposition surge (Hapke B(g))
    if (look.regolith) {
      const V = normalize(cameraPosition.sub(positionWorld));
      const L = U.sunDir as unknown as N3;
      const mu0 = max(dot(nDetail, L), float(0.02));
      const mu = max(dot(nDetail, V), float(0.02));
      const ls = min(float(2).div(mu0.add(mu)), float(look.look === 'lunar_low_sun' ? 2.6 : 4));
      const g = acos(clamp(dot(L, V), -1, 1));
      const surge = float(look.oppositionB0).div(float(1).add(tan(g.mul(0.5)).div(look.oppositionH)));
      albedo = albedo.mul(ls.mul(surge.add(1))).mul(0.62) as N3;
    }
    if (T.paved) {
      // concrete (R) and asphalt (G) from the mask; a little of the ground detail as wear, flat and a bit smoother
      const pv = T.paved;
      const uvP = wxz.sub(vec2(pv.x0, pv.z0)).div(vec2(pv.sizeX, pv.sizeZ));
      const mk = texture(pv.tex, uvP);
      const wC = smoothstep(float(0.35), float(0.65), mk.x), wA = smoothstep(float(0.35), float(0.65), mk.y);
      const wear = mix(vec3(1, 1, 1), colorMod, 0.35).mul(n3.sub(0.5).mul(0.1).add(1));
      albedo = mix(mix(albedo, vec3(...pv.concrete).mul(wear), wC), vec3(...pv.asphalt).mul(wear), wA) as N3;
      const wP = max(wC, wA);
      rough = mix(rough, mix(float(0.82), float(0.9), wA), wP) as unknown as NF;
      nDetail = normalize(mix(nDetail, nMacro, wP)) as N3;
    }
    m.colorNode = mix(albedo, macroAlb, U.debugFlat);
    this.surfaceColor = m.colorNode as N3;
    m.roughnessNode = rough;
    m.metalnessNode = float(0);
    m.aoNode = ao;
    m.normalNode = cameraViewMatrix.mul(vec4(nDetail, 0)).xyz.normalize();

    // baked horizon shadow beyond the real-time shadow map
    if (T.shadowNear) {
      const sN = texture(T.shadowNear, uvN).x;
      const sF = T.shadowFar ? texture(T.shadowFar, uvF).x : sN;
      const baked = mix(sF, sN, wN);
      const dc = length(positionWorld.xz.sub(U.rtShadowCenter.xz));
      const handover = smoothstep(U.rtShadowRadius.mul(0.7), U.rtShadowRadius, dc);
      m.receivedShadowNode = Fn(([s]: [NF]) => min(s, mix(float(1), baked, handover)).mul(1)) as never;
    }
    return m;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.clearCache();
    this.material.dispose();
    this.normalNear.dispose();
    this.normalFar?.dispose();
    this.craterTex?.dispose();
    this.meshes.clear();
  }
}
