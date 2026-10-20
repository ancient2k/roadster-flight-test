// Collects steel members (scaffolds, light masts, trusses) and emits them as ONE InstancedMesh.
import * as THREE from 'three/webgpu';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class BeamBatch {
  private mats: THREE.Matrix4[] = [];

  /** Square-section member from a to b (world space) with edge width w. */
  beam(a: THREE.Vector3Like, b: THREE.Vector3Like, w = 0.12): void {
    _a.set(a.x, a.y, a.z); _b.set(b.x, b.y, b.z);
    _d.subVectors(_b, _a);
    const len = _d.length();
    if (len < 1e-4) return;
    _d.divideScalar(len);
    _q.setFromUnitVectors(_up, _d);
    _s.set(w, len, w);
    _m.compose(_a.clone().addScaledVector(_d, len / 2), _q, _s);
    this.mats.push(_m.clone());
  }

  /** Axis-aligned box (centre, size) in world space, optional yaw. */
  box(c: THREE.Vector3Like, size: THREE.Vector3Like, yaw = 0): void {
    _q.setFromAxisAngle(_up, yaw);
    _m.compose(new THREE.Vector3(c.x, c.y, c.z), _q, new THREE.Vector3(size.x, size.y, size.z));
    this.mats.push(_m.clone());
  }

  /** Apply a transform to every member added after `mark`. */
  mark(): number { return this.mats.length; }
  transformSince(mark: number, m: THREE.Matrix4): void {
    for (let i = mark; i < this.mats.length; i++) this.mats[i].premultiply(m);
  }

  /** Lattice mast (4 chords + zig-zag lacing) from base point to height. */
  latticeMast(base: THREE.Vector3Like, height: number, width: number, chord = 0.14, lace = 0.05, bay = 1.6): void {
    const h2 = width / 2;
    const corners = [[-h2, -h2], [h2, -h2], [h2, h2], [-h2, h2]];
    for (const [x, z] of corners) this.beam({ x: base.x + x, y: base.y, z: base.z + z }, { x: base.x + x, y: base.y + height, z: base.z + z }, chord);
    const bays = Math.max(1, Math.round(height / bay));
    for (let i = 0; i < bays; i++) {
      const y0 = base.y + (height * i) / bays, y1 = base.y + (height * (i + 1)) / bays;
      for (let k = 0; k < 4; k++) {
        const [x0, z0] = corners[k], [x1, z1] = corners[(k + 1) % 4];
        this.beam({ x: base.x + x0, y: y0, z: base.z + z0 }, { x: base.x + x1, y: y0, z: base.z + z1 }, lace);
        if (i % 2 === 0) this.beam({ x: base.x + x0, y: y0, z: base.z + z0 }, { x: base.x + x1, y: y1, z: base.z + z1 }, lace);
        else this.beam({ x: base.x + x1, y: y0, z: base.z + z1 }, { x: base.x + x0, y: y1, z: base.z + z0 }, lace);
      }
    }
  }

  /** Box truss between two points (horizontal), used for gate and stage frames. */
  truss(a: THREE.Vector3Like, b: THREE.Vector3Like, depth = 0.5, chord = 0.07, lace = 0.035): void {
    _a.set(a.x, a.y, a.z); _b.set(b.x, b.y, b.z);
    const dir = _d.subVectors(_b, _a).clone();
    const len = dir.length(); dir.normalize();
    const side = new THREE.Vector3().crossVectors(dir, _up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const up = new THREE.Vector3().crossVectors(side, dir).normalize();
    const h = depth / 2;
    const offs = [side.clone().multiplyScalar(h).addScaledVector(up, h), side.clone().multiplyScalar(-h).addScaledVector(up, h),
      side.clone().multiplyScalar(-h).addScaledVector(up, -h), side.clone().multiplyScalar(h).addScaledVector(up, -h)];
    const A = _a.clone(), B = _b.clone();
    for (const o of offs) this.beam(A.clone().add(o), B.clone().add(o), chord);
    const n = Math.max(1, Math.round(len / depth));
    for (let i = 0; i <= n; i++) {
      const p = A.clone().addScaledVector(dir, (len * i) / n);
      const q = A.clone().addScaledVector(dir, (len * Math.min(n, i + 1)) / n);
      for (let k = 0; k < 4; k++) {
        this.beam(p.clone().add(offs[k]), p.clone().add(offs[(k + 1) % 4]), lace);
        if (i < n) this.beam(p.clone().add(offs[k]), q.clone().add(offs[(k + 1) % 4]), lace);
      }
    }
  }

  build(material: THREE.Material, castShadow = true): THREE.InstancedMesh {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geo, material, this.mats.length);
    this.mats.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = false;
    return mesh;
  }

  get count(): number { return this.mats.length; }
}
