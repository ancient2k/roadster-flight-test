// pure logic of the world renderer (no GPU): 16-bit PNG decoding, terrain data/field, CDLOD selection
// and crack-freedom, chunk geometry, baked horizon shadows, sky/atmosphere parameters, black-body colour,
// Sun-scene distance/heat model, boulder scatter.
import { describe, expect, it } from 'vitest';
import { deflateSync, crc32 } from 'node:zlib';
import { decodePngGrey, unfilter } from '../../../src/render/worlds/png16';
import {
  gridHeight, insideDistance, TerrainField, synthHeightmap, loadTerrainData, syntheticAssets, gridNormalsRGBA8, type HeightGrid,
} from '../../../src/render/worlds/terrainData';
import { selectLod, lodRanges, depthForSpacing, morphFactor, boxDistSq, nodeKey, type LodConfig, type LodNode } from '../../../src/render/worlds/lod';
import { buildChunk, parentHeight, gridIndices, sampleRange } from '../../../src/render/worlds/chunk';
import { bakeSunVisibility, stampOccluders } from '../../../src/render/worlds/terrainShadow';
import {
  airmass, sunTransmittance, skyRadiance, lookParams, earthDirForSite, sunLightAtGround, skyIrradiance, EARTH_ATMOSPHERE, MARS_ATMOSPHERE, raySphere,
} from '../../../src/render/worlds/skyParams';
import { blackbodyRGB, blackbodyLuminance } from '../../../src/render/worlds/colorScience';
import { SUN_SCENE, physicalDistance, irradianceAt, equilibriumTempK, heatToTempK, tempToHeat, glowRadiance, sunDistance } from '../../../src/render/worlds/sunLayout';
import { scatterRocks, powerLawSize } from '../../../src/render/worlds/scatter';
import { SITES } from '../../../src/shared/worlds';

// ------------------------------------------------------------------ helpers

/** Minimal PNG encoder (grey, 8/16 bit) with a chosen filter per row, for decoder round trips. */
function encodePng(w: number, h: number, data: Uint16Array, bitDepth: 8 | 16, filters: number[]): Uint8Array {
  const bpp = bitDepth / 8, stride = w * bpp;
  const rows: Uint8Array[] = [];
  const px = new Uint8Array(h * stride);
  for (let i = 0; i < w * h; i++) {
    if (bitDepth === 16) { px[i * 2] = data[i] >> 8; px[i * 2 + 1] = data[i] & 255; } else px[i] = data[i] >> 8;
  }
  for (let y = 0; y < h; y++) {
    const ft = filters[y % filters.length];
    const row = new Uint8Array(stride + 1);
    row[0] = ft;
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const pred = [0, a, b, (a + b) >> 1, pr][ft];
      row[x + 1] = (v - pred) & 255;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows.map((r) => Buffer.from(r)));
  const chunk = (type: string, body: Uint8Array) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(body)]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = bitDepth; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0)),
  ]));
}

const plane = (size: number, extentM: number, f: (x: number, z: number) => number): HeightGrid => {
  const h = new Float32Array(size * size), cell = extentM / (size - 1);
  let minM = Infinity, maxM = -Infinity;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const v = f(-extentM / 2 + c * cell, -extentM / 2 + r * cell);
    h[r * size + c] = v; minM = Math.min(minM, v); maxM = Math.max(maxM, v);
  }
  return { size, extentM, cx: 0, cz: 0, h, minM, maxM };
};

function respond(body: BodyInit | null, type = 'application/octet-stream', status = 200) {
  return new Response(body, { status, headers: { 'content-type': type } });
}

// ------------------------------------------------------------------ PNG

describe('16-bit PNG decoder', () => {
  it('round-trips 16-bit grey with every filter type', async () => {
    const w = 37, h = 23;
    const data = new Uint16Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7919 + (i % 13) * 4099) & 65535;
    const png = encodePng(w, h, data, 16, [0, 1, 2, 3, 4]);
    const img = await decodePngGrey(png);
    expect(img.width).toBe(w);
    expect(img.height).toBe(h);
    expect(img.bitDepth).toBe(16);
    expect(Array.from(img.data)).toEqual(Array.from(data));
  });
  it('expands 8-bit grey to 16 bit', async () => {
    const data = new Uint16Array([0, 255 << 8, 128 << 8, 64 << 8]);
    const img = await decodePngGrey(encodePng(2, 2, data, 8, [4]));
    expect(Array.from(img.data)).toEqual([0, 65535, 128 * 257, 64 * 257]);
  });
  it('rejects non-PNG data and unknown filters', async () => {
    await expect(decodePngGrey(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).rejects.toThrow();
    expect(() => unfilter(new Uint8Array([9, 0]), 1, 1, 1)).toThrow();
  });
});

// ------------------------------------------------------------------ terrain data

describe('terrain data', () => {
  const g = plane(65, 640, (x, z) => 0.1 * x - 0.05 * z + 3);
  it('bilinear sampling is exact on a plane and clamps outside', () => {
    expect(gridHeight(g, 12.3, -45.6)).toBeCloseTo(0.1 * 12.3 + 0.05 * 45.6 + 3, 4);
    expect(gridHeight(g, 1e6, 0)).toBeCloseTo(gridHeight(g, 320, 0), 4);
    expect(insideDistance(g, 0, 0)).toBe(320);
    expect(insideDistance(g, 400, 0)).toBe(-80);
  });
  it('field blends near into far smoothly and continuously', () => {
    const near = plane(65, 640, () => 10);
    const far = plane(65, 6400, () => 0);
    const f = new TerrainField(near, far, 100);
    expect(f.height(0, 0)).toBeCloseTo(10, 5);           // deep inside: near
    expect(f.height(320, 0)).toBeCloseTo(0, 5);          // border: far
    expect(f.height(2000, 0)).toBeCloseTo(0, 5);
    const mid = f.height(270, 0);
    expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(10);
    let prev = f.height(150, 0);
    for (let x = 151; x < 330; x++) { const v = f.height(x, 0); expect(Math.abs(v - prev)).toBeLessThan(0.3); expect(v).toBeLessThanOrEqual(prev + 1e-9); prev = v; }
    expect(f.halfExtent).toBe(3200);
    expect(f.spacing(0, 0)).toBeCloseTo(10, 6);
    expect(f.spacing(3000, 0)).toBeCloseTo(100, 6);
  });
  it('normals point up on flat ground and tilt against the slope', () => {
    const f = new TerrainField(g, null);
    const n = f.normal(0, 0);
    expect(n.x).toBeLessThan(0);    // height rises toward +x → normal leans to −x
    expect(n.z).toBeGreaterThan(0); // height falls toward +z
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
    const nb = gridNormalsRGBA8(plane(9, 80, () => 0));
    expect(nb[4 * 40]).toBe(128); expect(nb[4 * 40 + 1]).toBe(255); expect(nb[4 * 40 + 2]).toBe(128);
  });
  it('synthetic heightmaps are deterministic and zero at the centre', () => {
    for (const k of ['earth', 'moon', 'mars'] as const) {
      const a = synthHeightmap(k, 129, 2000, 5), b = synthHeightmap(k, 129, 2000, 5);
      expect(a.h).toEqual(b.h);
      expect(a.h[64 * 129 + 64]).toBe(0);
      expect(a.maxM - a.minM).toBeGreaterThan(1);
    }
    const s = syntheticAssets('moon');
    expect(gridHeight(s.near, 0, 0)).toBeCloseTo(gridHeight(s.far!, 0, 0), 4);
  });
  it('loads the pipeline format (16-bit PNG tiles) without re-zeroing', async () => {
    const n = 17;
    const u16 = new Uint16Array(n * n).map((_, i) => (i * 211) % 65536);
    const png = encodePng(n, n, u16, 16, [1, 4]);
    const meta = {
      tiles: { near: { heightmap: 'terrain_h16.png', resolution: n, sizeM: 160, heightMinM: -10, heightMaxM: 30, albedo: 'albedo.jpg', splat: 'splat.png' } },
      spawn: { x: 5, y: 0, z: -3, headingDeg: 90 }, sun: { direction: [0, 1, 0], illuminanceLux: 1e5, colorTempK: 5800 },
      landmarks: [{ file: 'a.glb', x: 1, y: 2, z: 3, headingDeg: 45 }], rocks: { file: '../_shared/rocks.glb' },
      detailTextures: { fine: 'sand', rock: 'limestone' }, sources: [{ credit: 'X' }, { credit: 'X' }],
    };
    const fetchFn = async (u: string) => u.endsWith('meta.json') ? respond(JSON.stringify(meta), 'application/json') : u.endsWith('terrain_h16.png') ? respond(png as BodyInit) : respond(null, 'text/html', 404);
    const a = (await loadTerrainData('/w/x', fetchFn))!;
    expect(a.format).toBe('wsf');
    expect(a.near.size).toBe(n);
    expect(a.near.h[5]).toBeCloseTo(-10 + (u16[5] / 65535) * 40, 4);
    expect(a.terrainMeta).toMatchObject({ size: n, extentM: 160, minM: -10, maxM: 30 });
    expect(a.detailTextures).toEqual({ fine: 'sand', rock: 'limestone' });
    expect(a.rocksUrl).toBe('/w/x/../_shared/rocks.glb');
    expect(a.landmarks[0].headingDeg).toBe(45);
    expect(a.spawn).toEqual({ x: 5, y: 0, z: -3, headingDeg: 90 });
    expect(a.credits).toEqual(['X']);
  });
  it('loads the contract format (height.bin) with decodeHeightmap centre = 0', async () => {
    const n = 5;
    const u16 = new Uint16Array(n * n).map((_, i) => i * 1000);
    const meta = { size: n, extentM: 40, minM: 0, maxM: 65.535, source: 'test' };
    const fetchFn = async (u: string) => u.endsWith('meta.json') ? respond(JSON.stringify(meta), 'application/json')
      : u.endsWith('height.bin') ? respond(u16.buffer as BodyInit) : respond(null, 'text/html', 404);
    const a = (await loadTerrainData('/w/y', fetchFn))!;
    expect(a.format).toBe('contract');
    expect(a.near.h[12]).toBeCloseTo(0, 6);
    expect(a.near.h[13]).toBeCloseTo(1, 4);
  });
  it('returns null for a site without terrain (Sun scene meta, missing files)', async () => {
    const f1 = async (u: string) => u.endsWith('meta.json') ? respond(JSON.stringify({ tiles: {} }), 'application/json') : respond(null, 'text/html', 404);
    expect(await loadTerrainData('/w/s', f1)).toBeNull();
    const f2 = async () => respond('<html>', 'text/html', 200);
    expect(await loadTerrainData('/w/s', f2)).toBeNull();
  });
});

// ------------------------------------------------------------------ CDLOD

/** Same rule as TerrainRenderer: leaf range ≥ 2√2 × leaf size keeps neighbours within one level. */
function lodConfig(field: TerrainField, rangeFactor = 3): LodConfig {
  const root = field.halfExtent * 2;
  const maxDepth = depthForSpacing(root, 16, field.spacing(0, 0));
  return {
    x0: -field.halfExtent, z0: -field.halfExtent, size: root, gridN: 16, maxDepth,
    leafRange: (root / 2 ** maxDepth) * rangeFactor, morphStartRatio: 0.7, heightRange: (x0, z0, s) => sampleRange((x, z) => field.height(x, z), x0, z0, s, 8),
  };
}

describe('CDLOD selection', () => {
  const field = new TerrainField(synthHeightmap('moon', 1025, 4096, 3), null);
  it('ranges double per level; depth reaches the native spacing', () => {
    expect(lodRanges(10, 4)).toEqual([10, 20, 40, 80]);
    expect(depthForSpacing(4096, 32, 2)).toBe(6);       // 4096 / 2^6 / 32 = 2
    expect(depthForSpacing(4096, 32, 1.9)).toBe(7);
    expect(morphFactor(5, 10, 20)).toBe(0);
    expect(morphFactor(15, 10, 20)).toBeCloseTo(0.5);
    expect(morphFactor(25, 10, 20)).toBe(1);
    expect(boxDistSq({ x: 0, y: 0, z: 0 }, 1, 0, 0, 2, 1, 1)).toBe(1);
  });
  it('tiles the root exactly once (no gaps, no overlaps)', () => {
    const cfg = lodConfig(field);
    for (const cam of [{ x: 0, y: 5, z: 0 }, { x: 1700, y: 40, z: -1900 }, { x: -300, y: 900, z: 250 }]) {
      const nodes = selectLod(cfg, cam);
      const area = nodes.reduce((s, n) => s + n.size * n.size, 0);
      expect(area).toBeCloseTo(cfg.size * cfg.size, 3);
      const keys = new Set(nodes.map(nodeKey));
      expect(keys.size).toBe(nodes.length);
    }
  });
  it('is finest under the camera and coarse far away; neighbours differ by at most one level', () => {
    const cfg = lodConfig(field);
    const cam = { x: 100, y: 3, z: -200 };
    const nodes = selectLod(cfg, cam);
    const under = nodes.find((n) => cam.x >= n.x0 && cam.x < n.x0 + n.size && cam.z >= n.z0 && cam.z < n.z0 + n.size)!;
    expect(under.level).toBe(0);
    expect(Math.max(...nodes.map((n) => n.level))).toBeGreaterThanOrEqual(2);
    // neighbour levels: sample points on each node edge and find the node across
    const at = (x: number, z: number) => nodes.find((n) => x >= n.x0 && x < n.x0 + n.size && z >= n.z0 && z < n.z0 + n.size);
    for (const n of nodes) {
      for (const [x, z] of [[n.x0 - 0.01, n.z0 + n.size / 2], [n.x0 + n.size + 0.01, n.z0 + n.size / 2], [n.x0 + n.size / 2, n.z0 - 0.01], [n.x0 + n.size / 2, n.z0 + n.size + 0.01]]) {
        const m = at(x, z);
        if (m) expect(Math.abs(m.level - n.level)).toBeLessThanOrEqual(1);
      }
    }
  });
  it('fine nodes are fully morphed where they meet a coarser neighbour (crack-free)', () => {
    const cfg = lodConfig(field);
    const cam = { x: -500, y: 12, z: 700 };
    const nodes = selectLod(cfg, cam);
    const at = (x: number, z: number) => nodes.find((n) => x >= n.x0 && x < n.x0 + n.size && z >= n.z0 && z < n.z0 + n.size);
    let checked = 0;
    for (const n of nodes) {
      const N = cfg.gridN, step = n.size / N;
      const edges: [number, number, number, number][] = [[n.x0, n.z0, 1, 0], [n.x0, n.z0 + n.size, 1, 0], [n.x0, n.z0, 0, 1], [n.x0 + n.size, n.z0, 0, 1]];
      for (const [ex, ez, dx, dz] of edges) {
        const ox = dz ? (ex === n.x0 ? -0.01 : 0.01) : 0, oz = dx ? (ez === n.z0 ? -0.01 : 0.01) : 0;
        const m = at(ex + dx * n.size / 2 + ox, ez + dz * n.size / 2 + oz);
        if (!m || m.level <= n.level) continue;
        for (let i = 1; i < N; i += 2) {               // odd vertices are the ones that could crack
          const x = ex + dx * i * step, z = ez + dz * i * step, y = field.height(x, z);
          const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
          expect(morphFactor(d, n.morphStart, n.morphEnd)).toBe(1);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
  it('a depth cap (coarse far tile) stops subdivision there', () => {
    const cfg = { ...lodConfig(field), depthCap: (x0: number) => (x0 > 0 ? 3 : 99) };
    const nodes = selectLod(cfg, { x: 10, y: 2, z: 0 });
    // nodes whose parent already lay in the capped zone stop at the cap
    expect(nodes.filter((n) => n.x0 >= 1024).every((n: LodNode) => n.depth <= 3)).toBe(true);
    expect(nodes.some((n) => n.x0 < 0 && n.depth > 3)).toBe(true);
  });
});

// ------------------------------------------------------------------ chunk geometry

describe('chunk geometry', () => {
  it('parent heights equal the coarse surface (planar field: identical)', () => {
    const f = (x: number, z: number) => 2 * x - 3 * z + 1;
    const c = buildChunk(f, 0, 0, 32, 8, 0);
    for (let v = 0; v < 81; v++) expect(c.parentY[v]).toBeCloseTo(c.positions[v * 3 + 1], 4);
  });
  it('odd vertices interpolate along coarse edges and the coarse diagonal', () => {
    const h = [0, 0, 4, 0, 0, 0, 8, 0, 2]; // 3×3
    expect(parentHeight(h, 3, 1, 0)).toBe(2);       // edge: (0 + 4) / 2
    expect(parentHeight(h, 3, 0, 1)).toBe(4);       // edge: (0 + 8) / 2
    expect(parentHeight(h, 3, 1, 1)).toBe(1);       // diagonal (0,0)–(2,2): (0 + 2) / 2
    expect(parentHeight(h, 3, 2, 2)).toBe(2);
  });
  it('morphed fine edge matches the coarse neighbour edge exactly', () => {
    const f = (x: number, z: number) => Math.sin(x * 0.07) * 6 + Math.cos(z * 0.05) * 4;
    const fine = buildChunk(f, 0, 0, 32, 8, 0);      // level L, edge x = 32
    const coarse = buildChunk(f, 32, 0, 64, 8, 0);   // level L+1 to the right, shares x = 32 from z 0..32
    for (let j = 0; j <= 8; j++) {
      const z = j * 4;
      const yFine = fine.parentY[j * 9 + 8];          // fully morphed (morph = 1)
      // coarse edge x = 32 is its i = 0 column with spacing 8: linear between rows
      const jc = z / 8, j0 = Math.floor(jc), t = jc - j0;
      const yc = coarse.positions[(j0 * 9) * 3 + 1] * (1 - t) + (t > 0 ? coarse.positions[((j0 + 1) * 9) * 3 + 1] * t : 0);
      expect(yFine).toBeCloseTo(yc, 4);
    }
  });
  it('indices are in range, up-facing, with skirts below the surface', () => {
    const c = buildChunk(() => 0, -8, -8, 16, 4, 1.5);
    const n1 = 5, nv = n1 * n1 + 4 * n1;
    expect(c.positions.length).toBe(nv * 3);
    expect(c.indices.length).toBe((16 + 16) * 6);
    expect(Math.max(...c.indices)).toBeLessThan(nv);
    const p = (i: number) => [c.positions[i * 3], c.positions[i * 3 + 1], c.positions[i * 3 + 2]];
    const [a, b, d] = [p(c.indices[0]), p(c.indices[1]), p(c.indices[2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    expect(u[2] * v[0] - u[0] * v[2]).toBeGreaterThan(0); // cross(u, v).y > 0
    expect(c.minY).toBeCloseTo(-1.5);
    expect(c.positions[(n1 * n1) * 3 + 1]).toBeCloseTo(-1.5);
    expect(gridIndices(300, false)).toBeInstanceOf(Uint32Array);
    expect(gridIndices(32, true)).toBeInstanceOf(Uint16Array);
  });
});

// ------------------------------------------------------------------ baked shadow

describe('baked horizon shadow', () => {
  const sun = (elDeg: number) => ({ x: Math.cos(elDeg * Math.PI / 180), y: Math.sin(elDeg * Math.PI / 180), z: 0 });
  it('flat ground is lit; sun below the horizon is dark', () => {
    const g = plane(65, 640, () => 0);
    expect(bakeSunVisibility(g, { res: 32, sun: sun(20), penumbra: 0.005, maxDist: 1000 }).every((v) => v === 255)).toBe(true);
    expect(bakeSunVisibility(g, { res: 8, sun: sun(-5), penumbra: 0.005, maxDist: 1000 }).every((v) => v === 0)).toBe(true);
  });
  it('a 20 m wall casts a shadow of length h / tan(elevation) away from the sun', () => {
    const g = plane(161, 800, (x) => (x >= 100 && x <= 140 ? 20 : 0));  // 40 m wide block from x = 100, sun toward +x
    const res = 160, vis = bakeSunVisibility(g, { res, sun: sun(30), penumbra: 0.003, maxDist: 2000 });
    const row = Math.floor(res / 2);
    const xAt = (c: number) => -400 + (c + 0.5) * (800 / res);
    let shadowStart = Infinity, shadowEnd = -Infinity;
    for (let c = 0; c < res; c++) if (vis[row * res + c] < 128) { shadowStart = Math.min(shadowStart, xAt(c)); shadowEnd = Math.max(shadowEnd, xAt(c)); }
    expect(shadowEnd).toBeLessThan(101);   // the shadow ends at the wall
    expect(100 - shadowStart).toBeGreaterThan(20 / Math.tan(Math.PI / 6) - 8);
    expect(100 - shadowStart).toBeLessThan(20 / Math.tan(Math.PI / 6) + 8);
  });
  it('row slices (parallel bake) reassemble to the full bake bit for bit', () => {
    const g = plane(129, 1000, (x, z) => 30 * Math.sin(x / 60) * Math.cos(z / 45));
    const o = { res: 96, sun: sun(12), penumbra: 0.004, maxDist: 3000 };
    const full = bakeSunVisibility(g, o);
    const joined = new Uint8Array(full.length);
    for (const [from, to] of [[0, 31], [31, 64], [64, 96]]) joined.set(bakeSunVisibility(g, { ...o, rows: { from, to } }), from * o.res);
    expect(joined).toEqual(full);
  });
  it('stamps landmark triangles as occluders', () => {
    const g = plane(41, 400, () => 0);
    const tri = new Float32Array([-50, 30, -50, 50, 30, -50, 0, 30, 50]);
    const s = stampOccluders(g, tri);
    expect(gridHeight(s, 0, 0)).toBeCloseTo(30, 3);
    expect(gridHeight(s, 150, 150)).toBe(0);
    expect(g.h.every((v) => v === 0)).toBe(true);    // input untouched
  });
});

// ------------------------------------------------------------------ sky & light

describe('sky parameters', () => {
  it('air mass: 1 at the zenith, ≈ 38 at the horizon (Kasten–Young)', () => {
    expect(airmass(1)).toBeCloseTo(1, 2);
    expect(airmass(0)).toBeGreaterThan(30);
    expect(airmass(0)).toBeLessThan(45);
    expect(raySphere(6371000, 0, 1, 6371000 + 80000)).toBeCloseTo(80000, 0);
  });
  it('Earth: sun reddens toward the horizon, zenith sky is blue', () => {
    const hi = sunTransmittance(EARTH_ATMOSPHERE, 1), lo = sunTransmittance(EARTH_ATMOSPHERE, Math.sin(5 * Math.PI / 180));
    expect(hi[2]).toBeGreaterThan(0.6);
    expect(lo[0] / lo[2]).toBeGreaterThan(3 * hi[0] / hi[2]);
    const z = skyRadiance(EARTH_ATMOSPHERE, 2, 1, Math.sin(Math.PI / 4), Math.sin(Math.PI / 4));
    expect(z[2]).toBeGreaterThan(z[0] * 2);
  });
  it('Mars: butterscotch zenith (red > blue), bluish near the sun', () => {
    const s = Math.sin(40 * Math.PI / 180);
    const zen = skyRadiance(MARS_ATMOSPHERE, 2, 1, s, s);
    expect(zen[0]).toBeGreaterThan(zen[2] * 1.3);
    const near = skyRadiance(MARS_ATMOSPHERE, 2, Math.sin(43 * Math.PI / 180), Math.cos(3 * Math.PI / 180), s);
    expect(near[2] / near[0]).toBeGreaterThan(zen[2] / zen[0]);
  });
  it('look table: Moon has no atmosphere and uses the regolith BRDF; Mars sun is weaker', () => {
    const m = lookParams('lunar_day');
    expect(m.atmosphere).toBeNull();
    expect(m.regolith).toBe(true);
    expect(m.sky).toBe('black');
    expect(lookParams('mars_day').sunIrradiance).toBeCloseTo(lookParams('day').sunIrradiance / 1.524 ** 2, 5);
    expect(lookParams('deep_space').sky).toBe('space');
    for (const s of SITES) expect(lookParams(s.look, s.id)).toBeTruthy();
    const sl = sunLightAtGround(lookParams('day', 'earth_stonehenge'), Math.sin(6 * Math.PI / 180));
    expect(sl.color[0]).toBeGreaterThan(sl.color[2]);
    const irr = skyIrradiance(lookParams('day', 'earth_giza'), [0, 1, 0]);
    expect(irr.sky[2]).toBeGreaterThan(irr.sky[0]);
    expect(skyIrradiance(lookParams('lunar_day'), [0, 1, 0]).sky).toEqual([0, 0, 0]);
  });
  it('Earth stands high in the west at Tranquility Base and on the horizon at Shackleton', () => {
    const t = earthDirForSite('moon_tranquility');
    expect(Math.hypot(...t)).toBeCloseTo(1, 6);
    expect(Math.asin(t[1]) * 180 / Math.PI).toBeCloseTo(66.5, 1);
    expect(t[0]).toBeLessThan(-0.3);                    // west = −X
    expect(Math.asin(earthDirForSite('moon_shackleton')[1]) * 180 / Math.PI).toBeLessThan(8);
  });
});

describe('black-body colour', () => {
  it('6500 K is near white, low temperatures are red, luminance rises steeply', () => {
    const w = blackbodyRGB(6500);
    for (const c of w) expect(c).toBeGreaterThan(0.9);
    for (const c of w) expect(c).toBeLessThan(1.1);
    const r = blackbodyRGB(1500);
    expect(r[0]).toBeGreaterThan(r[1]); expect(r[1]).toBeGreaterThan(r[2]);
    expect(blackbodyLuminance(1500)).toBeGreaterThan(blackbodyLuminance(1000) * 100);
    expect(blackbodyLuminance(300)).toBe(0);
  });
});

// ------------------------------------------------------------------ Sun scene

describe('Sun scene layout and heat model', () => {
  it('maps the spawn to 1 AU and the photosphere to the solar radius', () => {
    const d0 = sunDistance({ x: 0, y: 0, z: 0 });
    expect(physicalDistance(d0) / SUN_SCENE.au).toBeCloseTo(1, 6);
    expect(physicalDistance(SUN_SCENE.sunRadius) / SUN_SCENE.realSunRadius).toBeCloseTo(1, 6);
    expect(irradianceAt(d0)).toBeCloseTo(1361, 0);
    expect(irradianceAt(SUN_SCENE.sunRadius * 1.5)).toBeGreaterThan(5e6);
    const t1au = equilibriumTempK(d0);
    expect(t1au).toBeGreaterThan(250); expect(t1au).toBeLessThan(350);
    expect(equilibriumTempK(SUN_SCENE.sunRadius * 1.2)).toBeGreaterThan(2500);
  });
  it('heat01 and surface temperature are inverse; glow is monotonic and starts at dull red', () => {
    for (const h of [0, 0.2, 0.5, 1]) expect(tempToHeat(heatToTempK(h))).toBeCloseTo(h, 9);
    expect(glowRadiance(500)).toBe(0);
    expect(glowRadiance(1000)).toBeCloseTo(0.02, 3);
    let prev = 0;
    for (let T = 700; T <= 6000; T += 100) { const g = glowRadiance(T); expect(g).toBeGreaterThan(prev); prev = g; }
    expect(glowRadiance(3200)).toBeLessThan(60000);
  });
});

describe('boulder scatter', () => {
  it('is deterministic, respects the count and the size range', () => {
    const f = new TerrainField(synthHeightmap('moon', 129, 2000, 2), null);
    const a = scatterRocks(f, { count: 500, seed: 7 }), b = scatterRocks(f, { count: 500, seed: 7 });
    expect(a).toEqual(b);
    expect(a.length).toBe(500);
    for (const r of a) {
      expect(r.size).toBeGreaterThanOrEqual(0.125 - 1e-9);
      expect(r.size).toBeLessThanOrEqual(1.6 + 1e-9);
      expect(r.y).toBeCloseTo(f.height(r.x, r.z), 6);
    }
    expect(powerLawSize(0, 0.2, 3)).toBeCloseTo(0.2, 6);
    expect(powerLawSize(1, 0.2, 3)).toBeCloseTo(3, 6);
    // power law: many more small than big rocks
    expect(a.filter((r) => r.size < 0.3).length).toBeGreaterThan(a.filter((r) => r.size > 0.8).length * 3);
  });
});
