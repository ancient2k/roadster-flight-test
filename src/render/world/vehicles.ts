// Procedural placeholder vehicles for the obstacle row (until props exist).
// Object frame: x = width, y = up, z = length (front at +z), origin = bottom centre.
import * as THREE from 'three/webgpu';
import type { BoxObstacle } from '../../shared/track';

type Model = BoxObstacle['model'];

/** Side profiles as (z, y) fractions of length/height, front at z = +0.5. */
const PROFILES: Record<Model, { body: [number, number][]; glass: [number, number][]; wheelR: number; wheelZ: [number, number]; paint: number }> = {
  model3: {
    body: [[-0.5, 0.2], [-0.5, 0.52], [-0.44, 0.66], [-0.3, 0.7], [-0.16, 1.0], [0.06, 1.0], [0.2, 0.68], [0.44, 0.58], [0.5, 0.42], [0.49, 0.2]],
    glass: [[-0.3, 0.69], [-0.16, 0.985], [0.06, 0.985], [0.2, 0.68]], wheelR: 0.34, wheelZ: [-0.31, 0.31], paint: 0x1d2a44,
  },
  modelS: {
    body: [[-0.5, 0.22], [-0.5, 0.52], [-0.45, 0.64], [-0.32, 0.7], [-0.17, 0.99], [0.05, 1.0], [0.2, 0.68], [0.44, 0.58], [0.5, 0.42], [0.49, 0.22]],
    glass: [[-0.32, 0.69], [-0.17, 0.975], [0.05, 0.985], [0.2, 0.68]], wheelR: 0.35, wheelZ: [-0.3, 0.31], paint: 0x8e0f14,
  },
  modelY: {
    body: [[-0.5, 0.22], [-0.5, 0.55], [-0.46, 0.75], [-0.36, 0.78], [-0.24, 1.0], [0.06, 1.0], [0.22, 0.72], [0.44, 0.6], [0.5, 0.44], [0.49, 0.22]],
    glass: [[-0.36, 0.77], [-0.24, 0.985], [0.06, 0.985], [0.22, 0.71]], wheelR: 0.36, wheelZ: [-0.31, 0.31], paint: 0xe8e8ea,
  },
  cybertruck: {
    body: [[-0.5, 0.22], [-0.5, 0.62], [-0.06, 1.0], [0.5, 0.6], [0.5, 0.38], [0.47, 0.22]],
    glass: [[-0.05, 0.985], [0.24, 0.81], [0.06, 0.8], [-0.12, 0.92]], wheelR: 0.42, wheelZ: [-0.32, 0.33], paint: 0xa9adb3,
  },
  semi: {
    body: [[-0.5, 0.16], [-0.5, 0.97], [0.0, 1.0], [0.2, 0.96], [0.34, 0.66], [0.46, 0.46], [0.5, 0.3], [0.5, 0.16]],
    glass: [[0.17, 0.95], [0.32, 0.67], [0.41, 0.52], [0.25, 0.5], [0.12, 0.75]], wheelR: 0.52, wheelZ: [-0.33, 0.36], paint: 0xf1f2f4,
  },
};

const tireGeo = new THREE.CylinderGeometry(1, 1, 1, 28, 1).rotateZ(Math.PI / 2);
const rimGeo = new THREE.CylinderGeometry(0.66, 0.66, 1.02, 18, 1).rotateZ(Math.PI / 2);

function extrudeProfile(points: [number, number][], L: number, H: number, width: number, bevel: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z * L, y * H)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.05, width - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8,
    bevelSegments: 2, curveSegments: 4,
  });
  g.rotateY(-Math.PI / 2);
  g.translate(-(width - 2 * bevel) / 2 + (width - 2 * bevel), 0, 0);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  g.translate(-(bb.min.x + bb.max.x) / 2, 0, 0);
  return g;
}

export function makePlaceholderVehicle(model: Model, size: { x: number; y: number; z: number }): THREE.Group {
  const p = PROFILES[model];
  const g = new THREE.Group();
  g.name = `placeholder_${model}`;
  const paint = new THREE.MeshPhysicalNodeMaterial({ color: p.paint, roughness: 0.28, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.08 });
  const glass = new THREE.MeshPhysicalNodeMaterial({ color: 0x07090c, roughness: 0.04, metalness: 0.2, clearcoat: 1 });
  const tire = new THREE.MeshStandardNodeMaterial({ color: 0x0b0b0c, roughness: 0.85 });
  const rim = new THREE.MeshStandardNodeMaterial({ color: model === 'semi' ? 0xd0d3d8 : 0x55585e, roughness: 0.3, metalness: 0.9 });
  const lamp = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(6) });
  const tail = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 0.03, 0.02).multiplyScalar(3) });

  const body = new THREE.Mesh(extrudeProfile(p.body, size.z, size.y, size.x, 0.06), paint);
  const gl = new THREE.Mesh(extrudeProfile(p.glass, size.z, size.y, size.x * 0.98, 0.04), glass);
  gl.scale.set(1.012, 1, 1);
  body.castShadow = body.receiveShadow = true;
  g.add(body, gl);

  const r = p.wheelR * (model === 'semi' ? 1 : 1.0);
  const tw = model === 'semi' ? 0.36 : 0.26;
  for (const wz of p.wheelZ) for (const sx of [-1, 1]) {
    const t = new THREE.Mesh(tireGeo, tire);
    t.scale.set(tw, r, r);
    t.position.set(sx * (size.x / 2 - tw / 2 + 0.02), r, wz * size.z);
    const rm = new THREE.Mesh(rimGeo, rim);
    rm.scale.set(tw, r, r);
    rm.position.copy(t.position);
    t.castShadow = true;
    g.add(t, rm);
  }
  // light bars
  const headY = model === 'semi' ? 0.42 * size.y : 0.5 * size.y;
  const head = new THREE.Mesh(new THREE.BoxGeometry(size.x * 0.82, 0.035, 0.03), lamp);
  head.position.set(0, headY, size.z / 2 - 0.02);
  const tl = new THREE.Mesh(new THREE.BoxGeometry(size.x * 0.86, 0.04, 0.03), tail);
  tl.position.set(0, model === 'semi' ? 0.3 : 0.6 * size.y, -size.z / 2 + 0.01);
  g.add(head, tl);
  if (model === 'semi') {
    // chassis rails + fifth wheel behind the cab
    const steel = new THREE.MeshStandardNodeMaterial({ color: 0x1c1d20, roughness: 0.6, metalness: 0.6 });
    const rail = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.35, size.z * 0.5), steel);
    rail.position.set(0, 0.75, -size.z * 0.22);
    g.add(rail);
  }
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

let contactTex: THREE.DataTexture | null = null;
/**
 * Soft contact shadow under a parked vehicle (object frame as above): the floods are high and few,
 * so the ground right under the sills and between the wheels would otherwise stay as bright as the
 * open pad. A rounded-rectangle falloff, darkest under the floor, fading ~0.5 m beyond the body.
 * Classic (non-node) material on purpose: it keeps the G-buffer of the ground below (AO/SSR still
 * apply) and is not tagged as an effect for the fx mask.
 */
export function makeContactShadow(size: { x: number; z: number }): THREE.Mesh {
  if (!contactTex) {
    const N = 64, d = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      // rounded-box distance in a unit square with a 0.18 margin for the falloff
      const u = Math.abs((i + 0.5) / N * 2 - 1), v = Math.abs((j + 0.5) / N * 2 - 1);
      const k = 0.7, r = 0.12;
      const qx = Math.max(u - k + r, 0), qy = Math.max(v - k + r, 0);
      const dist = Math.hypot(qx, qy) - r;
      const a = Math.max(0, Math.min(1, 1 - (dist + 0.08) / 0.38));
      const o = (j * N + i) * 4;
      d[o + 3] = Math.round(255 * a * a * (3 - 2 * a));
    }
    contactTex = new THREE.DataTexture(d, N, N);
    contactTex.magFilter = THREE.LinearFilter; contactTex.minFilter = THREE.LinearFilter;
    contactTex.needsUpdate = true;
  }
  const m = new THREE.MeshBasicMaterial({ color: 0x000000, map: contactTex, transparent: true, opacity: 0.82, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  // the inner 70 % of the texture (full shadow) covers the footprint, the rim fades outside it
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), m);
  mesh.scale.set(size.x / 0.7 + 0.2, 1, size.z / 0.7 + 0.2);
  mesh.position.y = 0.01;
  mesh.renderOrder = 1;
  mesh.name = 'ContactShadow';
  return mesh;
}
