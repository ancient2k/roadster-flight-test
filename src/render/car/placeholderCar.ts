// Procedural Roadster placeholder following the GLB contract (src/shared/roadster.ts): metres, +Y up, nose +Z,
// left side +X, origin = dry CoG. Faceted wedge lofted from cross-sections, flat shaded.
import * as THREE from 'three/webgpu';
import { ROADSTER } from '../../shared/roadster';

interface Key { z: number; roofY: number; roofHW: number; beltY: number; beltHW: number; maxHW: number; midY: number; sillY: number; sillHW: number; floorY: number; floorHW: number }

// Key sections from nose (+Z) to tail (−Z). Values in metres (body frame).
const KEYS: Key[] = [
  { z: 2.22, roofY: -0.03, roofHW: 0.50, beltY: -0.02, beltHW: 0.72, maxHW: 0.80, midY: -0.13, sillY: -0.26, sillHW: 0.74, floorY: -0.31, floorHW: 0.55 },
  { z: 2.02, roofY: 0.05, roofHW: 0.52, beltY: 0.18, beltHW: 0.88, maxHW: 0.95, midY: -0.08, sillY: -0.28, sillHW: 0.90, floorY: -0.35, floorHW: 0.70 },
  { z: 1.45, roofY: 0.16, roofHW: 0.56, beltY: 0.33, beltHW: 0.93, maxHW: 1.00, midY: -0.02, sillY: -0.28, sillHW: 0.94, floorY: -0.35, floorHW: 0.76 },
  { z: 0.85, roofY: 0.26, roofHW: 0.56, beltY: 0.33, beltHW: 0.90, maxHW: 0.99, midY: 0.00, sillY: -0.28, sillHW: 0.93, floorY: -0.35, floorHW: 0.78 },
  { z: 0.22, roofY: 0.62, roofHW: 0.44, beltY: 0.30, beltHW: 0.86, maxHW: 0.97, midY: 0.00, sillY: -0.28, sillHW: 0.92, floorY: -0.35, floorHW: 0.78 },
  { z: -0.40, roofY: 0.67, roofHW: 0.46, beltY: 0.31, beltHW: 0.87, maxHW: 0.98, midY: 0.02, sillY: -0.28, sillHW: 0.93, floorY: -0.35, floorHW: 0.78 },
  { z: -1.00, roofY: 0.56, roofHW: 0.52, beltY: 0.35, beltHW: 0.93, maxHW: 1.00, midY: 0.04, sillY: -0.27, sillHW: 0.95, floorY: -0.35, floorHW: 0.78 },
  { z: -1.60, roofY: 0.43, roofHW: 0.64, beltY: 0.37, beltHW: 0.95, maxHW: 1.00, midY: 0.05, sillY: -0.26, sillHW: 0.95, floorY: -0.34, floorHW: 0.78 },
  { z: -2.04, roofY: 0.33, roofHW: 0.74, beltY: 0.31, beltHW: 0.93, maxHW: 0.96, midY: 0.00, sillY: -0.22, sillHW: 0.90, floorY: -0.30, floorHW: 0.76 },
  { z: -2.13, roofY: 0.27, roofHW: 0.68, beltY: 0.25, beltHW: 0.87, maxHW: 0.89, midY: -0.03, sillY: -0.22, sillHW: 0.82, floorY: -0.28, floorHW: 0.70 },
];

function keyAt(z: number): Key {
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i], b = KEYS[i + 1];
    if (z <= a.z && z >= b.z) {
      const f = (a.z - z) / (a.z - b.z);
      const o = { ...a };
      for (const k of Object.keys(a) as (keyof Key)[]) o[k] = a[k] + (b[k] - a[k]) * f;
      return o;
    }
  }
  return z > KEYS[0].z ? KEYS[0] : KEYS[KEYS.length - 1];
}

const WHEEL_ZONES = ROADSTER.wheels.filter((w) => w.pos.x > 0).map((w) => ({ z: w.pos.z, r: w.radius + 0.07 }));
const inWheel = (z: number) => WHEEL_ZONES.some((w) => Math.abs(z - w.z) < w.r);

/** Half-section polyline (x ≥ 0) from roof centre to floor centre. */
function halfSection(z: number): [number, number][] {
  const k = keyAt(z);
  const wheel = inWheel(z);
  const archY = 0.29, innerHW = 0.72;
  return [
    [0, k.roofY],
    [k.roofHW, k.roofY - 0.03],
    [k.beltHW, k.beltY],
    [k.maxHW, wheel ? Math.min(archY + 0.03, k.beltY - 0.01) : k.midY],
    [wheel ? innerHW + 0.02 : k.maxHW * 0.985, wheel ? archY : k.midY - 0.12],
    [wheel ? innerHW : k.sillHW, k.sillY],
    [Math.min(k.floorHW, innerHW - 0.02), k.floorY],
    [0, k.floorY],
  ];
}

export const PAINT = 0, GLASS = 1, TRIM = 2;

function buildBodyGeometry(): THREE.BufferGeometry {
  const zs = new Set<number>();
  for (let z = KEYS[0].z; z >= KEYS[KEYS.length - 1].z - 1e-6; z -= 0.12) zs.add(+z.toFixed(4));
  for (const k of KEYS) zs.add(k.z);
  for (const w of WHEEL_ZONES) for (const e of [-w.r, w.r]) { zs.add(+(w.z + e - 0.004).toFixed(4)); zs.add(+(w.z + e + 0.004).toFixed(4)); }
  const Z = [...zs].sort((a, b) => b - a);
  const rings = Z.map((z) => {
    const h = halfSection(z);
    const left = h.map(([x, y]) => new THREE.Vector3(x, y, z));
    const right = h.slice(1, -1).reverse().map(([x, y]) => new THREE.Vector3(-x, y, z));
    return [...left, ...right]; // closed loop
  });
  const n = rings[0].length;
  const half = 8;
  const pos: number[] = [];
  const groups: { start: number; count: number; mat: number }[] = [];
  const pushTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, mat: number) => {
    const start = pos.length / 3;
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    const last = groups[groups.length - 1];
    if (last && last.mat === mat && last.start + last.count === start) last.count += 3;
    else groups.push({ start, count: 3, mat });
  };
  const matFor = (k: number, z: number) => {
    // segment k between ring points k and k+1 (left half 0..6, mirrored right half)
    const kk = k < half - 1 ? k : n - 1 - k;
    const canopy = z < 0.8 && z > -1.55;
    if ((kk === 0 || kk === 1) && canopy) return GLASS;
    if (kk >= 4) return TRIM;
    return PAINT;
  };
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], B = rings[i + 1];
    const zMid = (A[0].z + B[0].z) / 2;
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      const m = matFor(k, zMid);
      // ring order is CCW seen from the front for the left half (x>0 first) -> outward faces
      pushTri(A[k], A[k2], B[k], m);
      pushTri(A[k2], B[k2], B[k], m);
    }
  }
  // caps
  const capRing = (R: THREE.Vector3[], front: boolean) => {
    const c = R.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(R.length);
    for (let k = 0; k < n; k++) {
      const a = R[k], b = R[(k + 1) % n];
      if (front) pushTri(c, b, a, TRIM); else pushTri(c, a, b, TRIM);
    }
  };
  capRing(rings[0], true);
  capRing(rings[rings.length - 1], false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.mat);
  g.computeVertexNormals(); // non-indexed -> faceted
  // fix orientation: ensure normals point away from the body centre line
  return g;
}

function buildWheel(radius: number, width: number, tire: THREE.Material, rim: THREE.Material, rimDark: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const w = width / 2;
  const prof = [[radius * 0.72, -w], [radius * 0.93, -w], [radius, -w * 0.7], [radius, w * 0.7], [radius * 0.93, w], [radius * 0.72, w]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const t = new THREE.Mesh(new THREE.LatheGeometry(prof, 40).rotateZ(Math.PI / 2), tire);
  g.add(t);
  // aero disc with 6 spokes (outer face toward +X; mirrored for the right side by the caller)
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.72, radius * 0.72, 0.02, 36).rotateZ(Math.PI / 2), rimDark);
  disc.position.x = w * 0.55;
  g.add(disc);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.7, 0.018, 6, 40).rotateY(Math.PI / 2), rim);
  ring.position.x = w * 0.62;
  g.add(ring);
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.03, radius * 0.62, 0.07), rim);
    s.geometry.translate(0, radius * 0.33, 0);
    s.rotation.x = (i * Math.PI) / 3;
    s.position.x = w * 0.62;
    g.add(s);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 16).rotateZ(Math.PI / 2), rim);
  hub.position.x = w * 0.64;
  g.add(hub);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/** Builds the placeholder with the same node/material names as the GLB. */
export function buildPlaceholderCar(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'RoadsterPlaceholder';
  const paint = new THREE.MeshPhysicalNodeMaterial({ color: 0xe9e9e6, roughness: 0.32, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.18 });
  paint.name = 'Paint';
  const glass = new THREE.MeshPhysicalNodeMaterial({ color: 0x0c0a07, roughness: 0.05, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.03 });
  glass.name = 'Glass';
  const trim = new THREE.MeshStandardNodeMaterial({ color: 0x0d0e10, roughness: 0.55, metalness: 0.2 });
  trim.name = 'Trim';
  const body = new THREE.Mesh(buildBodyGeometry(), [paint, glass, trim]);
  body.name = 'Body';
  body.castShadow = true; body.receiveShadow = true;
  root.add(body);

  // emissive LED parts (names per contract; the renderer drives their intensity)
  const ledFront = new THREE.MeshBasicNodeMaterial({ color: 0xffffff }); ledFront.name = 'LED_Front';
  const ledTail = new THREE.MeshBasicNodeMaterial({ color: 0xff1008 }); ledTail.name = 'LED_Tail';
  const ledBrake = new THREE.MeshBasicNodeMaterial({ color: 0xff1008 }); ledBrake.name = 'LED_Brake';
  const front = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.022, 0.03), ledFront);
  front.position.set(0, -0.025, 2.215);
  front.rotation.x = -0.2;
  root.add(front);
  for (const sx of [-1, 1]) {
    const tri = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.03), ledFront);
    tri.position.set(sx * 0.62, 0.0, 2.19);
    tri.rotation.z = sx * 0.25;
    root.add(tri);
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.03, 0.03), ledTail);
  tail.position.set(0, 0.235, -2.135);
  root.add(tail);
  const brake = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.028, 0.025), ledBrake);
  brake.position.set(0, 0.19, -2.137);
  root.add(brake);

  // diffuser + four brass main nozzles
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 0.5), trim);
  diffuser.position.set(0, -0.22, -1.92);
  root.add(diffuser);
  const brass = new THREE.MeshStandardNodeMaterial({ color: 0xb08a4a, roughness: 0.28, metalness: 1.0 });
  brass.name = 'NozzleBrass';
  const nozzleInner = new THREE.MeshStandardNodeMaterial({ color: 0x050505, roughness: 0.9 });
  ROADSTER.nozzles.forEach((nz) => {
    const node = new THREE.Object3D();
    node.name = `Nozzle_${nz.id}`;
    node.position.set(nz.pos.x, nz.pos.y, nz.pos.z);
    // node +Z = exhaust direction (opposite to thrust dir)
    node.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(-nz.dir.x, -nz.dir.y, -nz.dir.z));
    root.add(node);
    const r = nz.group === 'main' ? 0.068 : nz.group === 'lift' ? 0.05 : 0.03;
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.7, 0.12, 20, 1, true).rotateX(Math.PI / 2), brass);
    bell.position.z = -0.02;
    const inner = new THREE.Mesh(new THREE.CircleGeometry(r * 0.95, 20), nozzleInner);
    inner.position.z = -0.07;
    node.add(bell, inner);
    if (nz.group !== 'main') bell.visible = inner.visible = nz.group === 'lift';
  });

  // rear wing on a pivot (leading edge forward). Positive rotation about +X raises the trailing edge.
  const wing = new THREE.Group();
  wing.name = 'Wing';
  wing.position.set(0, 0.58, -1.86);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.025, 0.36), trim);
  blade.position.z = -0.12;
  const plates = [-1, 1].map((sx) => {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.16, 0.42), trim);
    p.position.set(sx * 0.96, -0.04, -0.12);
    return p;
  });
  const lip = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.012, 0.02), ledTail);
  lip.position.set(0, 0.0, -0.3);
  wing.add(blade, ...plates, lip);
  root.add(wing);
  for (const sx of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.26, 0.14), trim);
    strut.position.set(sx * 0.45, 0.46, -1.86);
    root.add(strut);
  }

  // wheels
  const tire = new THREE.MeshStandardNodeMaterial({ color: 0x0a0a0b, roughness: 0.82 });
  const rim = new THREE.MeshStandardNodeMaterial({ color: 0xb9bcc2, roughness: 0.22, metalness: 1.0 });
  const rimDark = new THREE.MeshStandardNodeMaterial({ color: 0x15161a, roughness: 0.35, metalness: 0.6 });
  for (const w of ROADSTER.wheels) {
    const node = new THREE.Group();
    node.name = `Wheel_${w.id}`;
    node.position.set(w.pos.x, w.pos.y, w.pos.z);
    const wheel = buildWheel(w.radius, w.width, tire, rim, rimDark);
    if (w.pos.x < 0) wheel.scale.x = -1;
    node.add(wheel);
    root.add(node);
  }
  for (const id of ['Door_L', 'Door_R']) { const d = new THREE.Object3D(); d.name = id; root.add(d); }
  return root;
}
