// Procedural interior of the Roadster for the vehicle damage (Visual / Full): what shows once body panels are
// torn off – carbon tub with sills, bulkheads, crash rails and roll hoop, the skateboard battery pack, the front
// motor and the two rear motors with their half shafts, the two COPVs across the car behind the seats, the feed
// piping from the regulator to the nozzle groups and the orange HV cables. Body frame of the car model
// (metres, +Y up, nose +Z, left +X). Built from three.js primitives, merged per material (8 draw calls); the
// group stays hidden while the body is intact (CarDamageView shows it once a covering part is gone).
//
// Packaging [EST]: the GLB has no interior. Tanks: ROADSTER.tank.pos (behind the seats); two type IV COPVs
// r 0.19 m × 1.24 m fit between the seat backs (z −0.76), the rear wheels (inner tyre face |x| 0.69) and the
// rear glass – ≈ 250 L, less than the 600 L of the spec, which would not fit this body.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROADSTER } from '../../shared/roadster';

type V3 = [number, number, number];

/** Twill (2×2) carbon weave or the helical winding of a COPV as a small tiling texture (no canvas needed). */
function weaveTexture(kind: 'twill' | 'helix'): THREE.DataTexture {
  const n = 64, data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let v: number;
      if (kind === 'twill') {
        // tows 8 px wide, over two / under two, shifted by one tow per row: diagonal steps
        const tx = x >> 3, ty = y >> 3, warp = ((tx + ty) & 3) < 2;
        const along = warp ? (y & 7) / 7 : (x & 7) / 7;
        v = 70 + 70 * Math.sin(along * Math.PI) * (warp ? 1 : 0.8);
      } else {
        // ±55° helical windings crossing (the hoop layers lie under them)
        const a = ((x + y) & 15) / 16, b = ((x - y + 256) & 15) / 16;
        v = 80 + 60 * Math.max(Math.sin(a * Math.PI) * (((x + y) >> 4) & 1 ? 1 : 0.7), Math.sin(b * Math.PI) * 0.85);
      }
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.min(255, v); data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Box-projected UVs in metres × density (the same weave size on every part, whatever its shape). */
function boxUV(geo: THREE.BufferGeometry, density: number): void {
  const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const [u, v] = ax >= ay && ax >= az ? [z, y] : ay >= az ? [x, z] : [x, y];
    uv[i * 2] = u * density; uv[i * 2 + 1] = v * density;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

const box = (w: number, h: number, d: number, at: V3): THREE.BufferGeometry =>
  new THREE.BoxGeometry(w, h, d).translate(...at);
/** Cylinder along X. */
const cylX = (r: number, len: number, at: V3, seg = 20): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2).translate(...at);
/** Tube through points (smooth corners). */
const tube = (pts: V3[], r: number): THREE.BufferGeometry => {
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), false, 'catmullrom', 0.15);
  return new THREE.TubeGeometry(curve, Math.max(8, pts.length * 10), r, 6, false);
};

export function buildCarInterior(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'CarInterior';
  g.visible = false;

  const twill = weaveTexture('twill'), helix = weaveTexture('helix');
  helix.repeat.set(10, 4);
  const mat = {
    carbon: new THREE.MeshStandardMaterial({ name: 'Interior_Carbon', color: 0x6a6e78, map: twill, roughness: 0.36, metalness: 0.2 }),
    dark: new THREE.MeshStandardMaterial({ name: 'Interior_Bay', color: 0x34363c, roughness: 0.7, metalness: 0.05 }),
    alu: new THREE.MeshStandardMaterial({ name: 'Interior_Alu', color: 0xc9ced4, roughness: 0.38, metalness: 0.85 }),
    cast: new THREE.MeshStandardMaterial({ name: 'Interior_Cast', color: 0x8c9198, roughness: 0.5, metalness: 0.7 }),
    copv: new THREE.MeshStandardMaterial({ name: 'Interior_COPV', color: 0x7a7e86, map: helix, roughness: 0.3, metalness: 0.25 }),
    steel: new THREE.MeshStandardMaterial({ name: 'Interior_Steel', color: 0xc9cdd2, roughness: 0.24, metalness: 1 }),
    pipe: new THREE.MeshStandardMaterial({ name: 'Interior_Pipe', color: 0xb7bbc0, roughness: 0.34, metalness: 0.9 }),
    hv: new THREE.MeshStandardMaterial({ name: 'Interior_HV', color: 0xe8661c, roughness: 0.5, metalness: 0 }),
  };
  const parts: Record<keyof typeof mat, THREE.BufferGeometry[]> = { carbon: [], dark: [], alu: [], cast: [], copv: [], steel: [], pipe: [], hv: [] };

  // ---------------------------------------------------------------- tub and frame (carbon)
  const floorY = -0.29;   // top of the tub floor, just above the body's inner floor shell (≈ −0.32)
  parts.carbon.push(
    box(1.48, 0.025, 3.95, [0, floorY - 0.0125, 0.12]),                    // floor pan z −1.85 … 2.1
    box(0.1, 0.27, 1.62, [0.75, floorY + 0.135, 0.15]), box(0.1, 0.27, 1.62, [-0.75, floorY + 0.135, 0.15]),   // sills
    box(1.5, 0.62, 0.025, [0, floorY + 0.31, 1.0]),                       // front bulkhead (firewall)
    box(1.5, 0.74, 0.025, [0, floorY + 0.37, -0.772]),                    // rear bulkhead behind the seats
    box(0.07, 0.11, 1.12, [0.42, -0.1, 1.56]), box(0.07, 0.11, 1.12, [-0.42, -0.1, 1.56]),   // front crash rails
    box(1.24, 0.09, 0.06, [0, -0.1, 2.13]),                               // front bumper beam
    box(0.07, 0.11, 1.08, [0.45, -0.13, -1.32]), box(0.07, 0.11, 1.08, [-0.45, -0.13, -1.32]),   // rear rails
    box(1.2, 0.09, 0.06, [0, -0.1, -1.87]),                               // rear beam
  );
  // roll hoop over the seat backs
  const hoop: V3[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI;
    hoop.push([0.6 * Math.cos(a), floorY + 0.25 + 0.5 * Math.sin(a) * (0.85 + 0.15 * Math.sin(a)), -0.8]);
  }
  parts.alu.push(tube(hoop, 0.026));
  // frunk tub (open top) between the front rails
  parts.dark.push(
    box(0.76, 0.015, 0.4, [0, -0.02, 1.86]),
    box(0.76, 0.12, 0.015, [0, 0.04, 1.66]), box(0.76, 0.1, 0.015, [0, 0.03, 2.06]),
    box(0.015, 0.11, 0.4, [0.38, 0.035, 1.86]), box(0.015, 0.11, 0.4, [-0.38, 0.035, 1.86]),
  );

  // ---------------------------------------------------------------- battery pack (skateboard, floor of the cabin)
  const packTop = -0.205;
  parts.alu.push(box(1.2, packTop - floorY, 1.6, [0, (packTop + floorY) / 2, 0.18]));
  for (let i = 0; i < 6; i++) parts.cast.push(box(1.16, 0.01, 0.035, [0, packTop + 0.005, -0.5 + i * 0.27]));   // module ribs
  parts.cast.push(box(0.36, 0.06, 0.1, [0, packTop + 0.03, 0.93]));       // pack junction box

  // ---------------------------------------------------------------- motors and half shafts
  const wf = ROADSTER.wheels[0].pos, wr = ROADSTER.wheels[2].pos;
  // front: motor + reduction gear + inverter on top, straight shafts to the hubs
  parts.cast.push(cylX(0.12, 0.3, [0.06, -0.13, wf.z]), box(0.16, 0.22, 0.2, [-0.15, -0.13, wf.z]));
  parts.alu.push(box(0.32, 0.07, 0.22, [0, 0.03, wf.z + 0.02]));
  parts.steel.push(cylX(0.02, 1.36, [0, wf.y - 0.01, wf.z], 10));
  // rear: two motors with the gearbox between them, behind the COPVs
  const zr = -1.42;
  parts.cast.push(cylX(0.12, 0.25, [0.2, -0.12, zr]), cylX(0.12, 0.25, [-0.2, -0.12, zr]), box(0.15, 0.2, 0.22, [0, -0.12, zr]));
  parts.alu.push(box(0.28, 0.06, 0.2, [0.2, 0.03, zr - 0.02]), box(0.28, 0.06, 0.2, [-0.2, 0.03, zr - 0.02]));
  for (const s of [1, -1]) parts.steel.push(tube([[s * 0.32, -0.12, zr], [s * 0.55, -0.1, (zr + wr.z) / 2], [s * 0.78, wr.y, wr.z]], 0.02));

  // ---------------------------------------------------------------- COPVs across the car, stacked behind the seats
  const tankR = 0.19, tankCyl = 0.86, tanks: V3[] = [[0, -0.09, -0.99], [0, 0.27, -0.975]];
  const endX = tankCyl / 2 + tankR;
  for (const c of tanks) {
    parts.copv.push(new THREE.CapsuleGeometry(tankR, tankCyl, 10, 28).rotateZ(Math.PI / 2).translate(...c));
    parts.steel.push(cylX(0.045, 0.05, [endX + 0.015, c[1], c[2]], 14), cylX(0.045, 0.05, [-endX - 0.015, c[1], c[2]], 14));   // bosses
    for (const s of [0.28, -0.28]) parts.alu.push(cylX(tankR + 0.006, 0.04, [s, c[1], c[2]], 28));      // straps
    parts.dark.push(box(0.05, 0.04, 0.3, [0.28, c[1] - tankR - 0.02, c[2]]), box(0.05, 0.04, 0.3, [-0.28, c[1] - tankR - 0.02, c[2]]));
  }
  // manifold on both ends joins the bosses; the regulator sits above the rear motors
  const reg: V3 = [0.42, 0.13, -1.27];
  parts.steel.push(box(0.11, 0.1, 0.1, reg), cylX(0.03, 0.06, [reg[0] - 0.08, reg[1], reg[2]], 12));
  for (const s of [1, -1]) {
    const ex = s * (endX + 0.045);
    parts.pipe.push(tube([[ex, tanks[0][1], tanks[0][2]], [ex + s * 0.01, (tanks[0][1] + tanks[1][1]) / 2, -0.99], [ex, tanks[1][1], tanks[1][2]]], 0.014));
  }
  parts.pipe.push(tube([[endX + 0.05, 0.09, -0.99], [0.6, 0.12, -1.12], [reg[0] + 0.05, reg[1], reg[2]]], 0.014));

  // ---------------------------------------------------------------- feed lines regulator → nozzle groups
  const pr = 0.011;
  parts.pipe.push(tube([[reg[0], reg[1], reg[2]], [0.2, 0.11, -1.27], [0, 0.1, -1.27], [-0.2, 0.11, -1.27], [-0.42, 0.1, -1.27]], pr));
  // rear main nozzles: a manifold across the tail, one drop to each bell
  const manZ = -1.74, manY = -0.04;
  parts.pipe.push(tube([[0, 0.1, -1.27], [0, 0.07, -1.5], [0, manY, manZ]], pr));
  parts.pipe.push(tube([[0.62, manY, manZ], [0.3, manY, manZ], [0, manY, manZ], [-0.3, manY, manZ], [-0.62, manY, manZ]], pr));
  for (const n of ROADSTER.nozzles) {
    const p = n.pos;
    if (p.z < -1.9) parts.pipe.push(tube([[p.x, manY, manZ], [p.x, (manY + p.y) / 2, (manZ + p.z) / 2 + 0.05], [p.x, p.y + 0.03, p.z + 0.1]], pr));
  }
  for (const s of [1, -1]) {
    // rear lift nozzles at the corners of the tail
    parts.pipe.push(tube([[s * 0.62, manY, manZ], [s * 0.72, -0.18, -1.77], [s * 0.76, -0.26, -1.8]], pr));
    // forward along the inside of the sill to the front lift and yaw nozzles
    parts.pipe.push(tube([[s * 0.42, 0.1, -1.27], [s * 0.6, -0.05, -1.05], [s * 0.66, -0.2, -0.8], [s * 0.66, -0.2, 0.2],
      [s * 0.64, -0.2, 0.96], [s * 0.6, -0.2, 1.4], [s * 0.62, -0.22, 1.76], [s * 0.74, -0.27, 1.84]], pr));
    parts.pipe.push(tube([[s * 0.61, -0.21, 1.6], [s * 0.62, -0.06, 1.9], [s * 0.8, 0, 1.98]], pr * 0.8));
    // HV cables: pack → front motor, pack → rear motors
    parts.hv.push(tube([[s * 0.12, packTop + 0.02, 0.98], [s * 0.12, -0.15, 1.12], [s * 0.1, -0.1, wf.z - 0.13]], 0.016));
    parts.hv.push(tube([[s * 0.5, packTop - 0.02, -0.6], [s * 0.68, -0.24, -0.75], [s * 0.68, -0.24, -1.15], [s * 0.36, -0.16, zr + 0.06]], 0.016));
  }

  // ---------------------------------------------------------------- merge per material
  for (const key of Object.keys(parts) as (keyof typeof mat)[]) {
    const list = parts[key];
    for (const geo of list) {
      if (key !== 'copv') boxUV(geo, key === 'carbon' ? 9 : 1);
      // the merge needs the same attribute set and indexing everywhere
      for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    }
    const merged = mergeGeometries(list, false);
    list.forEach((geo) => geo.dispose());
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, mat[key]);
    mesh.name = `Interior_${key}`;
    mesh.castShadow = false;      // the body's shadow covers it; the opened panels let the light in
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}
