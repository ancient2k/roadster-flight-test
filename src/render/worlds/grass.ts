// Camera-centred grass for Earth grassland sites (Stonehenge): 's grass_clump.glb instanced on a
// world-anchored jittered lattice inside a radius around the camera (no swimming when the camera moves),
// thinned with distance and slope, tinted from the macro albedo, faded out at the edge.
import * as THREE from 'three/webgpu';
import { float, positionWorld, positionLocal, mx_noise_float, smoothstep, length, cameraPosition, vec3, vec4, mix, texture, uv, uniform, normalize, dot, max, pow, cameraViewMatrix } from 'three/tsl';
import type { TerrainField } from './terrainData';

export interface GrassOptions { radius: number; spacing: number; maxInstances: number }

const hash = (x: number, z: number, s: number) => {
  const h = Math.sin(x * 127.1 + z * 311.7 + s * 74.7) * 43758.5453;
  return h - Math.floor(h);
};

export class GrassField {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private center = new THREE.Vector2(Infinity, Infinity);
  private opts: GrassOptions;

  /** Direction to the sun and its colour × intensity (for the back-light translucency). */
  readonly sunDir = uniform(new THREE.Vector3(0, 1, 0));
  readonly sunColor = uniform(new THREE.Color(1, 1, 1));

  constructor(private field: TerrainField, opts: GrassOptions) {
    this.group.name = 'Grass';
    this.opts = opts;
  }

  async load(url: string): Promise<boolean> {
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (!head.ok || (head.headers.get('content-type') ?? '').includes('text/html')) return false;
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync(url);
      let src: THREE.Mesh | null = null;
      gltf.scene.traverse((o) => { if (!src && (o as THREE.Mesh).isMesh) src = o as THREE.Mesh; });
      if (!src) return false;
      const s = src as THREE.Mesh;
      const geom = s.geometry.clone();
      s.updateWorldMatrix(true, false);
      geom.applyMatrix4(s.matrixWorld);
      const base = s.material as THREE.MeshStandardMaterial;
      const m = new THREE.MeshStandardNodeMaterial();
      m.name = 'GrassClump';
      m.map = base.map ?? null;
      m.alphaMap = base.alphaMap ?? null;
      m.alphaTest = base.alphaTest || 0.5;
      m.side = THREE.DoubleSide;
      m.roughness = 0.85;
      m.normalMap = base.normalMap ?? null;
      // summer chalk grassland: patchy green ↔ straw, fading with distance into the terrain colour
      const p = positionWorld;
      const patch = mx_noise_float(vec3(p.x, 0, p.z).mul(0.08)).mul(0.5).add(0.5);
      const tint = mix(vec3(0.55, 0.95, 0.35), vec3(0.95, 0.9, 0.55), smoothstep(float(0.55), float(0.9), patch));
      const d = length(p.sub(cameraPosition));
      const fade = smoothstep(float(this.opts.radius), float(this.opts.radius * 0.7), d);
      const albedo = base.map ? texture(base.map, uv()).rgb.mul(tint).mul(1.1) : tint.mul(0.5);
      m.colorNode = albedo;
      // light the clumps like the turf they stand in (normal ≈ up, slightly from the blade) – random
      // blade normals with double-sided lighting made the tufts read as dark blobs against the lawn
      m.normalNode = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz.normalize();
      // thin blades transmit light: glow when the sun is behind them (sunrise at Stonehenge)
      const V = normalize(positionWorld.sub(cameraPosition));
      const back = pow(max(dot(V, this.sunDir), float(0)), float(5));
      m.emissiveNode = albedo.mul(this.sunColor).mul(back.mul(0.07).add(0.01));
      // alpha-tested blades: the GLB keeps alpha in the base colour map (alphaMode MASK)
      if (base.alphaMap) m.opacityNode = texture(base.alphaMap, uv()).g;
      else if (base.map) m.opacityNode = texture(base.map, uv()).a;
      void fade; void positionLocal;
      this.mesh = new THREE.InstancedMesh(geom, m, this.opts.maxInstances);
      this.mesh.name = 'GrassInstances';
      this.mesh.castShadow = false;
      this.mesh.receiveShadow = true;
      this.mesh.frustumCulled = false;
      this.mesh.count = 0;
      this.group.add(this.mesh);
      return true;
    } catch (e) {
      console.warn('[worlds] Gras nicht ladbar:', e);
      return false;
    }
  }

  /** Re-scatter when the camera moved more than a lattice cell (world-anchored, so stable). */
  update(cam: THREE.Vector3): void {
    if (!this.mesh) return;
    const { radius, spacing } = this.opts;
    const ground = this.field.height(cam.x, cam.z);
    const above = cam.y - (Number.isFinite(ground) ? ground : 0);
    this.mesh.visible = above < radius;
    if (!this.mesh.visible) return;
    if (Math.abs(cam.x - this.center.x) < spacing * 2 && Math.abs(cam.z - this.center.y) < spacing * 2) return;
    this.center.set(cam.x, cam.z);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const i0 = Math.floor((cam.x - radius) / spacing), i1 = Math.ceil((cam.x + radius) / spacing);
    const j0 = Math.floor((cam.z - radius) / spacing), j1 = Math.ceil((cam.z + radius) / spacing);
    let n = 0;
    const max = this.opts.maxInstances;
    for (let j = j0; j <= j1 && n < max; j++) for (let i = i0; i <= i1 && n < max; i++) {
      const x = (i + hash(i, j, 1)) * spacing, z = (j + hash(i, j, 2)) * spacing;
      const dx = x - cam.x, dz = z - cam.z, d = Math.hypot(dx, dz);
      if (d > radius) continue;
      // thin out with distance (density ∝ 1/(1 + d/12))
      if (hash(i, j, 3) > 1 / (1 + d / 9)) continue;
      const nrm = this.field.normal(x, z);
      if (nrm.y < 0.85) continue;
      q.setFromAxisAngle(up, hash(i, j, 4) * Math.PI * 2);
      // short chalk-grassland turf (≈ 15–35 cm), slightly larger far away to keep the coverage
      // shrink toward the edge of the radius instead of popping
      const edge = Math.min(1, Math.max(0, (radius - d) / (radius * 0.3)));
      const k = (0.11 + hash(i, j, 5) * 0.12 + Math.min(0.25, d / 90)) * (0.25 + 0.75 * edge * edge * (3 - 2 * edge));
      s.set(k, k * (0.8 + hash(i, j, 6) * 0.5), k);
      t.set(x, this.field.height(x, z) - 0.02, z);
      m.compose(t, q, s);
      this.mesh.setMatrixAt(n++, m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get count(): number { return this.mesh?.count ?? 0; }

  dispose(): void {
    this.group.removeFromParent();
    if (this.mesh) { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.dispose(); }
  }
}
