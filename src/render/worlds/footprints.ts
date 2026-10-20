// Apollo boot prints (footprints.json + bootprint decal) as instanced quads that reuse the terrain's
// albedo graph – the prints darken/relight the actual regolith instead of pasting a picture on top.
import * as THREE from 'three/webgpu';
import { texture, uv, vec3, float, normalMap, mix, smoothstep, length, positionWorld, cameraPosition } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { TerrainField } from './terrainData';
import { loadTex } from './textures';

export interface FootprintFile {
  lm: { x: number; z: number };
  bootSizeM: [number, number];
  decal: { normal: string; albedo: string };
  trampled?: { file: string; sizeM: number };
  prints: { x: number; z: number; yawDeg: number; foot: 'L' | 'R' }[];
}

export async function loadFootprintFile(dir: string): Promise<FootprintFile | null> {
  try {
    const r = await fetch(`${dir}/footprints.json`);
    if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) return null;
    return (await r.json()) as FootprintFile;
  } catch { return null; }
}

/** Trampled-area albedo multiplier (grey PNG), centred on the LM. */
export async function loadTrampled(dir: string, f: FootprintFile): Promise<{ tex: THREE.Texture; cx: number; cz: number; sizeM: number } | null> {
  if (!f.trampled) return null;
  const tex = await loadTex(`${dir}/${f.trampled.file}`, { srgb: false, flipY: false, anisotropy: 4 });
  if (!tex) return null;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return { tex, cx: f.lm.x, cz: f.lm.z, sizeM: f.trampled.sizeM };
}

export class Footprints {
  readonly mesh: THREE.InstancedMesh;
  private textures: THREE.Texture[] = [];

  /** x/z of every print (for the jet scour). */
  private xz: Float32Array = new Float32Array(0);
  private constructor(mesh: THREE.InstancedMesh, tex: THREE.Texture[]) { this.mesh = mesh; this.textures = tex; }

  /** a jet blew the soil away around (x, z): the prints within r are gone (instance collapsed). */
  scour(x: number, z: number, r: number): number {
    const M = new THREE.Matrix4().makeScale(0, 0, 0);
    let n = 0;
    for (let i = 0; i < this.xz.length / 2; i++) {
      const dx = this.xz[i * 2] - x, dz = this.xz[i * 2 + 1] - z;
      if (dx * dx + dz * dz > r * r || !Number.isFinite(this.xz[i * 2])) continue;
      this.mesh.setMatrixAt(i, M);
      this.xz[i * 2] = NaN;
      n++;
    }
    if (n) this.mesh.instanceMatrix.needsUpdate = true;
    return n;
  }

  static async create(dir: string, f: FootprintFile, field: TerrainField, groundColor: Node<'vec3'>): Promise<Footprints | null> {
    const [alb, nor] = await Promise.all([
      loadTex(`${dir}/${f.decal.albedo}`, { srgb: false, flipY: true, anisotropy: 8 }),
      loadTex(`${dir}/${f.decal.normal}`, { srgb: false, flipY: true, anisotropy: 8 }),
    ]);
    if (!alb || !nor) return null;
    for (const t of [alb, nor]) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    const [L, W] = f.bootSizeM;
    // quad in XZ: u along the boot length (+Z at yaw 0), v across
    const g = new THREE.PlaneGeometry(L * 1.15, W * 1.3);
    g.rotateX(-Math.PI / 2);
    g.rotateY(-Math.PI / 2);   // plane +X (u) → +Z
    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    m.name = 'Footprint';
    const a = texture(alb, uv());
    // the decal's alpha masks it; the multiplier (1 = unchanged) darkens the compacted sole and its shadowed ribs
    m.colorNode = groundColor.mul(mix(float(1), a.x, a.w.mul(a.w).mul(0.55)));
    m.normalNode = normalMap(texture(nor, uv()), float(1.2) as never) as never;
    m.roughnessNode = float(0.95);
    m.metalnessNode = float(0);
    const fade = float(1).sub(smoothstep(float(40), float(90), length(positionWorld.sub(cameraPosition))));
    m.opacityNode = a.w.mul(a.w).mul(fade);
    m.emissiveNode = vec3(0, 0, 0);
    const n = f.prints.length;
    const mesh = new THREE.InstancedMesh(g, m, n);
    mesh.name = 'Footprints';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    const xz = new Float32Array(n * 2);
    const up = new THREE.Vector3(0, 1, 0), nrm = new THREE.Vector3(), qt = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const pr = f.prints[i];
      const x = f.lm.x + pr.x, z = f.lm.z + pr.z;
      const y = field.height(x, z);
      xz[i * 2] = x; xz[i * 2 + 1] = z;
      // follow the local slope
      const e = 0.4;
      nrm.set(field.height(x - e, z) - field.height(x + e, z), 2 * e, field.height(x, z - e) - field.height(x, z + e)).normalize();
      qt.setFromUnitVectors(up, nrm);
      q.setFromAxisAngle(up, pr.yawDeg * Math.PI / 180).premultiply(qt);
      if (pr.foot === 'L') s.set(1, 1, -1); else s.set(1, 1, 1);
      p.set(x, y + 0.025, z);
      M.compose(p, q, s);
      mesh.setMatrixAt(i, M);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    const fp = new Footprints(mesh, [alb, nor]);
    fp.xz = xz;
    return fp;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    for (const t of this.textures) t.dispose();
  }
}
