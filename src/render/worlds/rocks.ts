// Boulder scatter: deterministic placement (power-law sizes, denser on slopes/rims and where the splat
// map says rock), procedural displaced-icosahedron variants or 's rocks_*.glb, instanced per 256 m cell
// so frustum culling and distance visibility work per cell.
// the cells are plain meshes on InstancedBufferGeometry with the instance matrices as named vertex
// attributes (not InstancedMesh): three.js keys an InstancedMesh's node build by its uuid, so ~100 cells
// meant ~100 node builds/pipelines per pass (7 s of shader preparation per site); now all cells share one.
import * as THREE from 'three/webgpu';
import type { UVec3 } from './types';
import { vec3, float, positionWorld, mx_noise_float, normalWorld, dot, max, min, cameraPosition, normalize, tan, acos, clamp, Fn, attribute, mat4, positionLocal, positionPrevious, normalLocal, transformNormal } from 'three/tsl';
import type { TerrainField } from './terrainData';
import type { LookParams } from './skyParams';
import { scatterRocks, type RockInstance } from './scatter';

export interface RockOptions {
  count: number;
  /** Cells farther than this are hidden (m). */
  viewDist: number;
  cellM: number;
  seed: number;
  /** 0..1 weight per position for extra rocks (e.g. splat R); optional. */
  extraWeight?: (x: number, z: number) => number;
}

/** Displaced icosahedron, flattened bottom; deterministic per seed. */
export function rockGeometry(seed: number, detail = 2): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const h = (x: number, y: number, z: number) => {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 4.1) * 43758.5453;
    return s - Math.floor(s);
  };
  // a few random cutting planes give faceted, fractured shapes like real boulders
  const planes: { n: THREE.Vector3; d: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const n = new THREE.Vector3(h(i, 1, 2) - 0.5, h(i, 3, 4) - 0.5, h(i, 5, 6) - 0.5).normalize();
    planes.push({ n, d: 0.62 + h(i, 7, 8) * 0.3 });
  }
  const v = new THREE.Vector3();
  const sx = 0.8 + h(1, 1, 1) * 0.5, sy = 0.55 + h(2, 2, 2) * 0.35, sz = 0.8 + h(3, 3, 3) * 0.5;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 1 + (h(Math.round(v.x * 9), Math.round(v.y * 9), Math.round(v.z * 9)) - 0.5) * 0.18;
    v.multiplyScalar(n);
    for (const pl of planes) {
      const dd = v.dot(pl.n);
      if (dd > pl.d) v.addScaledVector(pl.n, pl.d - dd);
    }
    v.set(v.x * sx, Math.max(v.y * sy, -0.25), v.z * sz);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.deleteAttribute('normal');
  // flat-shaded facets: non-indexed (PolyhedronGeometry already is – avoid the toNonIndexed() warning)
  const ng = g.index ? g.toNonIndexed() : g;
  ng.computeVertexNormals();
  if (ng !== g) g.dispose();
  return ng;
}

function rockMaterial(look: LookParams, sunDir: UVec3): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'Boulder';
  const a = look.groundAlbedo;
  const base = vec3(a[0], a[1], a[2]).mul(look.regolith ? 1.25 : 0.95);
  const n = mx_noise_float(positionWorld.mul(2.7)).mul(0.5).add(0.5);
  const n2 = mx_noise_float(positionWorld.mul(11)).mul(0.5).add(0.5);
  let col = base.mul(n.mul(0.35).add(0.8)).mul(n2.mul(0.2).add(0.9));
  if (look.regolith) {
    const V = normalize(cameraPosition.sub(positionWorld));
    const L = sunDir as unknown as ReturnType<typeof vec3>;
    const mu0 = max(dot(normalWorld, L), float(0.02)), mu = max(dot(normalWorld, V), float(0.02));
    const g = acos(clamp(dot(L, V), -1, 1));
    const surge = float(look.oppositionB0).div(float(1).add(tan(g.mul(0.5)).div(look.oppositionH)));
    col = col.mul(min(float(2).div(mu0.add(mu)), float(4))).mul(surge.add(1)).mul(0.62);
  }
  m.colorNode = col;
  m.roughnessNode = float(0.88);
  m.metalnessNode = float(0);
  return m;
}

/** Instance transform from the per-cell attributes `cellM0..3` (columns), as three.js' instance() does. */
const cellInstance = Fn((_: readonly unknown[], nb: THREE.NodeBuilder) => {
  const builder = nb as unknown as { needsPreviousData(): boolean; hasGeometryAttribute(n: string): boolean };
  const m = mat4(attribute('cellM0', 'vec4'), attribute('cellM1', 'vec4'), attribute('cellM2', 'vec4'), attribute('cellM3', 'vec4'));
  if (builder.needsPreviousData()) positionPrevious.assign(m.mul(positionPrevious).xyz); // static: no false motion vectors
  if (builder.hasGeometryAttribute('normal')) normalLocal.assign(transformNormal(normalLocal, m));
  return m.mul(positionLocal).xyz;
});

/** Node material whose positionNode applies the cell instance transform (GLB materials are converted). */
export function cellInstancedMaterial(src: THREE.Material): THREE.NodeMaterial {
  let m = src as THREE.NodeMaterial;
  if (!m.isNodeMaterial) {
    const std = src as THREE.MeshStandardMaterial;
    const nm = (std as unknown as { isMeshPhysicalMaterial?: boolean }).isMeshPhysicalMaterial ? new THREE.MeshPhysicalNodeMaterial() : new THREE.MeshStandardNodeMaterial();
    for (const key in src) (nm as unknown as Record<string, unknown>)[key] = (src as unknown as Record<string, unknown>)[key]; // as NodeLibrary.fromMaterial
    m = nm;
  }
  m.positionNode = cellInstance();
  return m;
}

/** One draw of `count` instances of `base` (shared vertex data) with its own matrix buffer and world bounds. */
export function cellMesh(base: THREE.BufferGeometry, material: THREE.Material, matrices: Float32Array, name: string): THREE.Mesh {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  for (const [k, a] of Object.entries(base.attributes)) g.setAttribute(k, a);
  const ib = new THREE.InstancedInterleavedBuffer(matrices, 16, 1);
  for (let c = 0; c < 4; c++) g.setAttribute(`cellM${c}`, new THREE.InterleavedBufferAttribute(ib, 4, c * 4));
  const n = matrices.length / 16;
  g.instanceCount = n;
  // world bounds of all instances (frustum culling per cell)
  if (!base.boundingSphere) base.computeBoundingSphere();
  const bs = base.boundingSphere!, M = new THREE.Matrix4(), c = new THREE.Vector3(), box = new THREE.Box3();
  const spheres: THREE.Sphere[] = [];
  for (let i = 0; i < n; i++) {
    M.fromArray(matrices, i * 16);
    c.copy(bs.center).applyMatrix4(M);
    const sp = new THREE.Sphere(c.clone(), bs.radius * M.getMaxScaleOnAxis());
    spheres.push(sp);
    box.expandByPoint(sp.center.clone().addScalar(sp.radius)).expandByPoint(sp.center.clone().subScalar(sp.radius));
  }
  g.boundingBox = box;
  const center = box.getCenter(new THREE.Vector3());
  let r = 0;
  for (const sp of spheres) r = Math.max(r, sp.center.distanceTo(center) + sp.radius);
  g.boundingSphere = new THREE.Sphere(center, r);
  const mesh = new THREE.Mesh(g, material);
  mesh.name = name;
  return mesh;
}

export class RockField {
  readonly group = new THREE.Group();
  private cells: { mesh: THREE.Mesh; cx: number; cz: number }[] = [];
  private geoms: THREE.BufferGeometry[] = [];
  private material: THREE.NodeMaterial;
  private ownsMaterial: boolean;
  private ownsGeoms: boolean;
  readonly instances: RockInstance[];
  viewDist: number;

  constructor(field: TerrainField, look: LookParams, sunDir: UVec3, o: RockOptions, source?: { geoms: THREE.BufferGeometry[]; material: THREE.Material } | null) {
    this.group.name = 'Rocks';
    this.viewDist = o.viewDist;
    this.ownsGeoms = !source;
    // own (instanced) copy of a GLB material; the procedural one is ours anyway
    const srcMat = source?.material ?? rockMaterial(look, sunDir);
    this.material = cellInstancedMaterial(srcMat);
    this.ownsMaterial = this.material !== srcMat || !source;
    this.geoms = source && source.geoms.length ? source.geoms : [0, 1, 2, 3].map((i) => rockGeometry(o.seed * 10 + i, 2));
    this.instances = scatterRocks(field, { count: o.count, seed: o.seed, extraWeight: o.extraWeight });
    // bucket by cell and variant
    const buckets = new Map<string, RockInstance[]>();
    for (const r of this.instances) {
      const key = `${Math.floor(r.x / o.cellM)}:${Math.floor(r.z / o.cellM)}:${r.variant % this.geoms.length}`;
      let b = buckets.get(key);
      if (!b) { b = []; buckets.set(key, b); }
      b.push(r);
    }
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), t = new THREE.Vector3();
    for (const [key, list] of buckets) {
      const [cxs, czs, vs] = key.split(':').map(Number);
      const mats = new Float32Array(list.length * 16);
      list.forEach((r, i) => {
        e.set(r.tilt * 0.6, r.yaw, r.tilt * 0.4);
        q.setFromEuler(e);
        s.set(r.size, r.size * r.flat, r.size * (0.8 + 0.4 * ((r.variant * 0.37) % 1)));
        t.set(r.x, r.y - r.size * 0.22, r.z);
        mtx.compose(t, q, s);
        mtx.toArray(mats, i * 16);
      });
      const mesh = cellMesh(this.geoms[vs], this.material, mats, 'RockCell');
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.cells.push({ mesh, cx: (cxs + 0.5) * o.cellM, cz: (czs + 0.5) * o.cellM });
      this.group.add(mesh);
    }
  }

  update(cam: THREE.Vector3): void {
    const d2 = this.viewDist * this.viewDist;
    for (const c of this.cells) {
      const dx = c.cx - cam.x, dz = c.cz - cam.z;
      c.mesh.visible = dx * dx + dz * dz < d2 + 256 * 256;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const c of this.cells) c.mesh.geometry.dispose();
    if (this.ownsGeoms) for (const g of this.geoms) g.dispose();
    if (this.ownsMaterial) this.material.dispose();
  }
}

/** rock set (_shared/rocks_*.glb: meshes Rock_0..n, one material): geometries normalised to radius ≈ 1. */
export async function loadRockSet(url: string | null): Promise<{ geoms: THREE.BufferGeometry[]; material: THREE.Material } | null> {
  if (!url) return null;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok || (head.headers.get('content-type') ?? '').includes('text/html')) return null;
    const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js')]);
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
    const geoms: THREE.BufferGeometry[] = [];
    let material: THREE.Material | null = null;
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry.clone();
      g.applyMatrix4(m.matrixWorld);
      g.computeBoundingBox();
      const b = g.boundingBox!, c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
      const k = 2 / Math.max(sz.x, sz.z, 1e-3);
      g.translate(-c.x, -b.min.y, -c.z);
      g.scale(k, k, k);
      g.translate(0, -0.25, 0);
      g.computeBoundingSphere();
      geoms.push(g);
      material ??= m.material as THREE.Material;
    });
    return geoms.length && material ? { geoms, material } : null;
  } catch (e) {
    console.warn('[worlds] Felsen-GLB nicht ladbar:', url, e);
    return null;
  }
}
