// Visible vehicle damage (setting "Vehicle damage: Realistic"): dents as CPU vertex displacement of the body
// panels, torn-off parts (wing, wheels) as clones that follow their Rapier bodies. Driven by VehicleState.damage
// (src/shared/damage.ts); everything is undone when the sim repairs the car (rev back to 0 / damage off).
import * as THREE from 'three/webgpu';
import type { DamageState, DebrisPose, Dent } from '../../shared/damage';

/** Nodes that keep their shape (rigid parts, cabin) – everything else under the model is a body panel. */
const RIGID = /^(Wheel_|Caliper_|Wing|Seat|Yoke|Nozzle_)/;
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

export class CarDamageView {
  /** Torn-off parts (world space); added next to the car root on first use. */
  readonly debrisGroup = new THREE.Group();
  private panels: Panel[] = [];
  private model: THREE.Object3D | null = null;
  private appliedRev = 0;
  private sinceBuild = 1;
  private clones = new Map<string, THREE.Object3D>();
  private hidden: THREE.Object3D[] = [];

  constructor() { this.debrisGroup.name = 'CarDebris'; }

  /** New car model: collect its body panels (positions copied once). */
  attach(model: THREE.Object3D): void {
    this.repair();
    this.model = model;
    this.panels = [];
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
    // torn-off parts: hide the node, show a clone at the body's pose
    for (const p of d.debris) this.placeDebris(p);
    if (rev !== this.appliedRev && (this.sinceBuild >= MIN_INTERVAL_S || this.appliedRev === 0)) {
      this.buildDents(d.dents);
      this.appliedRev = rev;
      this.sinceBuild = 0;
    }
  }

  private placeDebris(p: DebrisPose): void {
    let c = this.clones.get(p.part);
    if (!c) {
      const node = this.model?.getObjectByName(p.part);
      if (!node) return;
      c = node.clone(true);
      c.name = `Debris_${p.part}`;
      this.debrisGroup.add(c);
      this.clones.set(p.part, c);
      node.visible = false; this.hidden.push(node);
      const cal = p.part.startsWith('Wheel_') ? this.model?.getObjectByName(p.part.replace('Wheel_', 'Caliper_')) : null;
      if (cal) { cal.visible = false; this.hidden.push(cal); }
    }
    c.position.set(p.pos.x, p.pos.y, p.pos.z);
    c.quaternion.set(p.quat.x, p.quat.y, p.quat.z, p.quat.w);
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
    for (const c of this.clones.values()) this.debrisGroup.remove(c);
    this.clones.clear();
    this.appliedRev = 0;
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

function copyAttr(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) { out[i * 3] = a.getX(i); out[i * 3 + 1] = a.getY(i); out[i * 3 + 2] = a.getZ(i); }
  return out;
}
