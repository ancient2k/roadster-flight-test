// Visible vehicle damage (setting "Vehicle damage": Visual / Full): dents as CPU vertex displacement of the body
// panels, torn-off parts as copies of the real model parts that follow their Rapier bodies — model nodes (wing,
// doors, wheels) are cloned, bumpers / diffuser / nozzle covers are cut out of the Body mesh (BODY_PART_CUTS:
// their triangles move into a debris mesh and leave the Body's index). Driven by VehicleState.damage
// (src/shared/damage.ts); everything is undone when the sim repairs the car (rev back to 0 / damage off).
import * as THREE from 'three/webgpu';
import { BODY_PART_CUTS, PART_GEOMETRY, inBox, type DamageState, type DebrisPose, type Dent, type DetachablePart } from '../../shared/damage';

/** Nodes that keep their shape (rigid parts, cabin) – everything else under the model is a body panel. */
const RIGID = /^(Wheel_|Caliper_|Wing|Seat|Yoke|Nozzle_)/;
/** Debris that moves less than this (m) keeps its last matrix (resting parts cost nothing). */
const POSE_EPS = 1e-4;
/** Visual depth cap (m): deeper crush would push vertices through the cabin. */
const MAX_DEPTH_M = 0.35;
/** Rebuild the dents at most this often while they grow during an impact (s). */
const MIN_INTERVAL_S = 0.12;

interface Panel {
  geo: THREE.BufferGeometry;
  pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  nor: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null;
  orig: Float32Array;       // original local positions
  origN: Float32Array | null;
  toBody: THREE.Matrix4;    // mesh local → body frame (model root)
  toLocalDir: THREE.Matrix3;
  dirty: boolean;
}

/** A mesh of the Body node, for cutting out the BODY_PART_CUTS parts (built on first use). */
interface BodyMesh {
  mesh: THREE.Mesh;
  index: THREE.BufferAttribute;
  orig: Uint32Array;           // original index
  owner: Int8Array;            // per triangle: BODY_PART_CUTS entry, −1 = stays on the body
  toBody: THREE.Matrix4;
}

export class CarDamageView {
  /** Torn-off parts (world space); added next to the car root on first use. */
  readonly debrisGroup = new THREE.Group();
  private panels: Panel[] = [];
  private model: THREE.Object3D | null = null;
  private appliedRev = 0;
  private sinceBuild = 1;
  private clones = new Map<string, THREE.Object3D>();
  private hidden: THREE.Object3D[] = [];
  private bodyMeshes: BodyMesh[] | null = null;
  private cut = new Set<DetachablePart>();

  constructor() { this.debrisGroup.name = 'CarDebris'; }

  /** New car model: collect its body panels (positions copied once). */
  attach(model: THREE.Object3D): void {
    this.repair();
    this.model = model;
    this.panels = [];
    this.bodyMeshes = null;
    model.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || this.rigid(mesh)) return;
      const geo = mesh.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos || this.panels.some((p) => p.geo === geo)) return;
      const nor = (geo.getAttribute('normal') as THREE.BufferAttribute | undefined) ?? null;
      const toBody = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
      const toLocalDir = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().copy(toBody).invert());
      this.panels.push({ geo, pos, nor, orig: copyAttr(pos), origN: nor ? copyAttr(nor) : null, toBody, toLocalDir, dirty: false });
    });
  }

  private rigid(o: THREE.Object3D): boolean {
    for (let p: THREE.Object3D | null = o; p && p !== this.model; p = p.parent) if (RIGID.test(p.name)) return true;
    return false;
  }

  update(d: Readonly<DamageState> | undefined, carRoot: THREE.Object3D, dt: number): void {
    if (!this.debrisGroup.parent && carRoot.parent) carRoot.parent.add(this.debrisGroup);
    this.sinceBuild += dt;
    const rev = d?.rev ?? 0;
    if (rev === 0 || rev < this.appliedRev) { if (this.appliedRev !== 0) this.repair(); if (rev === 0) return; }
    if (!d) return;
    // torn-off parts: hide the node (or cut the part out of the Body), show a copy at the debris body's pose
    for (const p of d.debris) this.placeDebris(p);
    // debris cleared by the sim (lifetime / count limit): the copy goes, the part stays missing
    if (this.clones.size > d.debris.length) {
      for (const [part, c] of this.clones) {
        if (c.parent && !d.debris.some((p) => p.part === part)) this.debrisGroup.remove(c);
      }
    }
    if (rev !== this.appliedRev && (this.sinceBuild >= MIN_INTERVAL_S || this.appliedRev === 0)) {
      this.buildDents(d.dents);
      this.appliedRev = rev;
      this.sinceBuild = 0;
    }
  }

  private placeDebris(p: DebrisPose): void {
    let c = this.clones.get(p.part);
    if (!c) {
      const made = PART_CUT.has(p.part) ? this.cutOut(p.part) : this.cloneNode(p.part);
      if (!made) return;
      c = made;
      c.name = `Debris_${p.part}`;
      c.matrixAutoUpdate = false;
      this.debrisGroup.add(c);
      this.clones.set(p.part, c);
    } else if (!c.parent) return;   // cleared
    if (Math.abs(c.position.x - p.pos.x) + Math.abs(c.position.y - p.pos.y) + Math.abs(c.position.z - p.pos.z) < POSE_EPS
      && Math.abs(c.quaternion.x - p.quat.x) + Math.abs(c.quaternion.y - p.quat.y) + Math.abs(c.quaternion.z - p.quat.z) + Math.abs(c.quaternion.w - p.quat.w) < POSE_EPS) return;
    c.position.set(p.pos.x, p.pos.y, p.pos.z);
    c.quaternion.set(p.quat.x, p.quat.y, p.quat.z, p.quat.w);
    c.updateMatrix();
  }

  /** Model node (wing, door, wheel + caliper): clone it into a group whose origin is the part origin. */
  private cloneNode(part: DetachablePart): THREE.Object3D | null {
    const node = this.model?.getObjectByName(part);
    if (!node || !this.model) return null;
    const g = new THREE.Group();
    const c = node.clone(true);
    // the node's pose relative to the part origin (its own rotation: wheel spin/steer, wing angle)
    const o = PART_GEOMETRY[part].origin;
    c.position.set(node.position.x - o.x, node.position.y - o.y, node.position.z - o.z);
    g.add(c);
    node.visible = false; this.hidden.push(node);
    const cal = part.startsWith('Wheel_') ? this.model.getObjectByName(part.replace('Wheel_', 'Caliper_')) : null;
    if (cal) {
      const cc = cal.clone(true);
      cc.position.set(cal.position.x - o.x, cal.position.y - o.y, cal.position.z - o.z);
      g.add(cc);
      cal.visible = false; this.hidden.push(cal);
    }
    return g;
  }

  /** Meshes of the Body node with every triangle assigned to its BODY_PART_CUTS part (once per model). */
  private bodyParts(): BodyMesh[] {
    if (this.bodyMeshes) return this.bodyMeshes;
    this.bodyMeshes = [];
    const body = this.model?.getObjectByName('Body');
    if (!body || !this.model) return this.bodyMeshes;
    this.model.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.model.matrixWorld).invert();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = { x: 0, y: 0, z: 0 };
    body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const geo = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!mesh.isMesh || !geo?.index) return;
      const matName = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)?.name ?? '';
      const index = geo.index as THREE.BufferAttribute, pos = geo.getAttribute('position');
      const toBody = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
      const orig = Uint32Array.from(index.array as ArrayLike<number>);
      const owner = new Int8Array(orig.length / 3).fill(-1);
      // only the parts this material can belong to, and only triangles near their boxes
      const cuts = BODY_PART_CUTS.map((cut, k) => ({ k, box: PART_GEOMETRY[cut.part].box, ok: !cut.materials || cut.materials.includes(matName) })).filter((x) => x.ok);
      if (!cuts.length) return;
      for (let t = 0; t < owner.length; t++) {
        a.fromBufferAttribute(pos, orig[t * 3]).applyMatrix4(toBody);
        b.fromBufferAttribute(pos, orig[t * 3 + 1]).applyMatrix4(toBody);
        c.fromBufferAttribute(pos, orig[t * 3 + 2]).applyMatrix4(toBody);
        p.x = (a.x + b.x + c.x) / 3; p.y = (a.y + b.y + c.y) / 3; p.z = (a.z + b.z + c.z) / 3;
        for (const cut of cuts) if (inBox(cut.box, p)) { owner[t] = cut.k; break; }
      }
      this.bodyMeshes!.push({ mesh, index, orig, owner, toBody });
    });
    return this.bodyMeshes;
  }

  /** Cut a part out of the Body mesh: its triangles (current, dented shape) go into a debris mesh. */
  private cutOut(part: DetachablePart): THREE.Object3D | null {
    const k = BODY_PART_CUTS.findIndex((c) => c.part === part);
    const o = PART_GEOMETRY[part].origin;
    const toPart = new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z);
    const g = new THREE.Group();
    for (const B of this.bodyParts()) {
      let n = 0;
      for (let t = 0; t < B.owner.length; t++) if (B.owner[t] === k) n++;
      if (!n) continue;
      const src = B.mesh.geometry as THREE.BufferGeometry;
      // compact copy of the used vertices (attributes copied, not shared: later dents must not move the debris)
      const remap = new Map<number, number>();
      const idx = new Uint32Array(n * 3);
      let w = 0;
      for (let t = 0; t < B.owner.length; t++) {
        if (B.owner[t] !== k) continue;
        for (let j = 0; j < 3; j++) {
          const v = B.orig[t * 3 + j];
          let m = remap.get(v);
          if (m === undefined) { m = remap.size; remap.set(v, m); }
          idx[w++] = m;
        }
      }
      const geo = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(src.attributes)) {
        const sz = attr.itemSize, out = new Float32Array(remap.size * sz);
        for (const [v, m] of remap) for (let j = 0; j < sz; j++) out[m * sz + j] = attr.getComponent(v, j);
        geo.setAttribute(name, new THREE.BufferAttribute(out, sz, false));
      }
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, B.mesh.material);
      mesh.userData.ownGeometry = true;
      mesh.castShadow = B.mesh.castShadow; mesh.receiveShadow = B.mesh.receiveShadow;
      new THREE.Matrix4().multiplyMatrices(toPart, B.toBody).decompose(mesh.position, mesh.quaternion, mesh.scale);
      g.add(mesh);
    }
    if (!g.children.length) return null;
    this.cut.add(part);
    this.applyCuts();
    return g;
  }

  /** Rebuild the Body index without the triangles of the parts cut out so far (in place + draw range). */
  private applyCuts(): void {
    const ks = new Set(BODY_PART_CUTS.flatMap((c, k) => (this.cut.has(c.part) ? [k] : [])));
    for (const B of this.bodyMeshes ?? []) {
      const arr = B.index.array as Uint32Array | Uint16Array;
      let w = 0;
      for (let t = 0; t < B.owner.length; t++) {
        if (B.owner[t] >= 0 && ks.has(B.owner[t])) continue;
        arr[w++] = B.orig[t * 3]; arr[w++] = B.orig[t * 3 + 1]; arr[w++] = B.orig[t * 3 + 2];
      }
      for (let i = w; i < arr.length; i++) arr[i] = 0;   // degenerate tail (beyond the draw range anyway)
      B.index.needsUpdate = true;
      (B.mesh.geometry as THREE.BufferGeometry).setDrawRange(0, ks.size ? w : Infinity);
    }
  }

  /** Displace every panel vertex by the dents (from the original shape), then fix the normals around them. */
  private buildDents(dents: readonly Dent[]): void {
    const v = new THREE.Vector3(), disp = new THREE.Vector3(), loc = new THREE.Vector3();
    for (const P of this.panels) {
      const n = P.pos.count, moved = new Uint8Array(n);
      let any = false;
      for (let i = 0; i < n; i++) {
        v.set(P.orig[i * 3], P.orig[i * 3 + 1], P.orig[i * 3 + 2]).applyMatrix4(P.toBody);
        disp.set(0, 0, 0);
        for (const dn of dents) {
          const depth = Math.min(dn.depthM, MAX_DEPTH_M);
          if (depth < 0.002) continue;
          const dx = v.x - dn.p.x, dy = v.y - dn.p.y, dz = v.z - dn.p.z;
          const r2 = (dx * dx + dy * dy + dz * dz) / (dn.radiusM * dn.radiusM);
          if (r2 >= 1) continue;
          // smooth bowl with crumple wrinkles (deterministic, from the position)
          const f = (1 - r2) * (1 - r2) * (1 + 0.18 * Math.sin(23 * v.x + 17 * v.y + 29 * v.z));
          disp.x += dn.dir.x * depth * f; disp.y += dn.dir.y * depth * f; disp.z += dn.dir.z * depth * f;
        }
        if (disp.x === 0 && disp.y === 0 && disp.z === 0) {
          if (P.dirty) P.pos.setXYZ(i, P.orig[i * 3], P.orig[i * 3 + 1], P.orig[i * 3 + 2]);
          continue;
        }
        loc.copy(disp).applyMatrix3(P.toLocalDir);
        P.pos.setXYZ(i, P.orig[i * 3] + loc.x, P.orig[i * 3 + 1] + loc.y, P.orig[i * 3 + 2] + loc.z);
        moved[i] = 1; any = true;
      }
      if (!any && !P.dirty) continue;
      P.pos.needsUpdate = true;
      if (P.nor && P.origN) {
        // recompute normals, keep the authored ones wherever nothing moved (hard edges, custom normals)
        P.geo.computeVertexNormals();
        const nor = P.geo.getAttribute('normal') as THREE.BufferAttribute;
        for (let i = 0; i < n; i++) if (!moved[i]) nor.setXYZ(i, P.origN[i * 3], P.origN[i * 3 + 1], P.origN[i * 3 + 2]);
        nor.needsUpdate = true;
        P.nor = nor;
      }
      P.geo.computeBoundingSphere();
      P.dirty = any;
    }
  }

  /** Back to the intact car (restart / setting off). */
  repair(): void {
    for (const P of this.panels) {
      if (!P.dirty) continue;
      for (let i = 0; i < P.pos.count; i++) P.pos.setXYZ(i, P.orig[i * 3], P.orig[i * 3 + 1], P.orig[i * 3 + 2]);
      P.pos.needsUpdate = true;
      const nor = P.geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
      if (nor && P.origN) { for (let i = 0; i < nor.count; i++) nor.setXYZ(i, P.origN[i * 3], P.origN[i * 3 + 1], P.origN[i * 3 + 2]); nor.needsUpdate = true; }
      P.geo.computeBoundingSphere();
      P.dirty = false;
    }
    for (const n of this.hidden) n.visible = true;
    this.hidden = [];
    if (this.cut.size) { this.cut.clear(); this.applyCuts(); }
    for (const c of this.clones.values()) {
      this.debrisGroup.remove(c);
      // the cut-out meshes own their geometry (the node clones share the model's)
      c.traverse((o) => { if (o.userData.ownGeometry) (o as THREE.Mesh).geometry.dispose(); });
    }
    this.clones.clear();
    this.appliedRev = 0;
  }

  /** Diagnostics (tests): copies of torn-off parts in the scene, and Body triangles cut out. */
  debrisInfo(): { parts: string[]; cutTriangles: number } {
    let cut = 0;
    for (const B of this.bodyMeshes ?? []) {
      const r = (B.mesh.geometry as THREE.BufferGeometry).drawRange.count;
      if (Number.isFinite(r)) cut += B.owner.length - r / 3;
    }
    return { parts: [...this.clones].filter(([, c]) => c.parent).map(([p]) => p), cutTriangles: cut };
  }

  /** Diagnostics (tests): largest vertex displacement currently applied (m, local units). */
  maxDisplacement(): number {
    let m = 0;
    for (const P of this.panels) {
      if (!P.dirty) continue;
      for (let i = 0; i < P.pos.count; i++) {
        m = Math.max(m, Math.hypot(P.pos.getX(i) - P.orig[i * 3], P.pos.getY(i) - P.orig[i * 3 + 1], P.pos.getZ(i) - P.orig[i * 3 + 2]));
      }
    }
    return m;
  }
}

const PART_CUT = new Set<DetachablePart>(BODY_PART_CUTS.map((c) => c.part));

function copyAttr(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) { out[i * 3] = a.getX(i); out[i * 3 + 1] = a.getY(i); out[i * 3 + 2] = a.getZ(i); }
  return out;
}
