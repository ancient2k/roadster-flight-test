// Ramp meshes swept from the SAME profile the physics uses (src/shared/track.ts).
import * as THREE from 'three/webgpu';
import { sampleRamp, rampLocalToWorld, type CurvedRamp, type ProfileSample } from '../../shared/track';

/** Surface normal (driving side) in ramp-local coordinates for tangent angle θ. */
export function rampNormal(theta: number): { y: number; z: number } {
  return { y: Math.cos(theta), z: -Math.sin(theta) };
}

function toWorld(r: CurvedRamp, x: number, y: number, z: number): THREE.Vector3 {
  const p = rampLocalToWorld(r, { x, y, z });
  return new THREE.Vector3(p.x, p.y, p.z);
}

export interface RampMeshes {
  surface: THREE.BufferGeometry;   // concrete driving surface + back + sides (uv in metres)
  samples: ProfileSample[];
  edgeCurves: THREE.CatmullRomCurve3[]; // left/right LED edge lines (world)
  stripe: THREE.BufferGeometry;    // painted white centre line
}

/**
 * Builds a closed slab: top (driving) surface, back surface offset by `thickness` along −normal,
 * two side walls and a lip cap. For the kicker the sides are extended down to the ground
 * (solid wedge) like the real one.
 */
export function buildRampGeometry(r: CurvedRamp, step = 0.2, acrossSegs = 6): RampMeshes {
  const S = sampleRamp(r, step);
  const w = r.width, t = r.thickness, hw = w / 2;
  const pos: number[] = [], nor: number[] = [], uvs: number[] = [], idx: number[] = [];
  let v = 0;
  const pushV = (p: THREE.Vector3, n: THREE.Vector3, u: number, vv: number) => {
    pos.push(p.x, p.y, p.z); nor.push(n.x, n.y, n.z); uvs.push(u, vv); return v++;
  };
  const rot = new THREE.Matrix4().makeRotationY(r.headingDeg * Math.PI / 180);
  const nW = (ny: number, nz: number, nx = 0) => new THREE.Vector3(nx, ny, nz).applyMatrix4(rot).normalize();

  // --- top surface
  const top0 = v;
  for (let i = 0; i < S.length; i++) {
    const s = S[i], n = rampNormal(s.thetaRad);
    for (let j = 0; j <= acrossSegs; j++) {
      const x = -hw + (w * j) / acrossSegs;
      pushV(toWorld(r, x, s.y, s.z), nW(n.y, n.z), x + hw, s.s);
    }
  }
  const row = acrossSegs + 1;
  for (let i = 0; i < S.length - 1; i++) for (let j = 0; j < acrossSegs; j++) {
    const a = top0 + i * row + j, b = a + 1, c = a + row, d = c + 1;
    // winding so the normal faces the driving side
    idx.push(a, c, b, b, c, d);
  }
  // --- back surface (offset along -normal)
  const back0 = v;
  for (let i = 0; i < S.length; i++) {
    const s = S[i], n = rampNormal(s.thetaRad);
    for (let j = 0; j <= acrossSegs; j++) {
      const x = -hw + (w * j) / acrossSegs;
      pushV(toWorld(r, x, s.y - n.y * t, s.z - n.z * t), nW(-n.y, -n.z), x + hw, s.s);
    }
  }
  for (let i = 0; i < S.length - 1; i++) for (let j = 0; j < acrossSegs; j++) {
    const a = back0 + i * row + j, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  // --- side walls
  const solid = r.kind === 'kicker';
  for (const side of [-1, 1]) {
    const x = side * hw;
    const s0 = v;
    for (let i = 0; i < S.length; i++) {
      const s = S[i], n = rampNormal(s.thetaRad);
      const nn = nW(0, 0, side);
      pushV(toWorld(r, x, s.y, s.z), nn, s.s, 0);
      const lowY = solid ? 0 : s.y - n.y * t;
      const lowZ = solid ? s.z : s.z - n.z * t;
      pushV(toWorld(r, x, lowY, lowZ), nn, s.s, solid ? s.y : t);
    }
    for (let i = 0; i < S.length - 1; i++) {
      const a = s0 + i * 2, b = a + 1, c = a + 2, d = a + 3;
      if (side > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
  }
  // --- lip cap (end face) / kicker back wall
  {
    const s = S[S.length - 1], n = rampNormal(s.thetaRad);
    const tang = new THREE.Vector3(0, Math.sin(s.thetaRad), Math.cos(s.thetaRad));
    const nn = nW(tang.y, tang.z);
    const lowY = solid ? 0 : s.y - n.y * t, lowZ = solid ? s.z : s.z - n.z * t;
    const a = pushV(toWorld(r, -hw, s.y, s.z), nn, 0, 0);
    const b = pushV(toWorld(r, hw, s.y, s.z), nn, w, 0);
    const c = pushV(toWorld(r, -hw, lowY, lowZ), nn, 0, 1);
    const d = pushV(toWorld(r, hw, lowY, lowZ), nn, w, 1);
    idx.push(a, b, c, b, d, c, a, c, b, b, c, d); // double-sided cap
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();

  // LED edges sit on the surface edge, slightly raised.
  const edgeCurves = [-1, 1].map((side) => new THREE.CatmullRomCurve3(S.filter((_, i) => i % 2 === 0 || i === S.length - 1).map((s) => {
    const n = rampNormal(s.thetaRad);
    return toWorld(r, side * (hw - 0.06), s.y + n.y * 0.05, s.z + n.z * 0.05);
  })));

  // painted guide stripe: one white centre line like the real ramp (stream rear view,
  // stream reference frames: ≈ 2 % of the 5 m width)
  const sp: number[] = [], sn: number[] = [], si: number[] = [];
  let sv = 0;
  for (const cx of [0]) {
    const base = sv;
    for (const s of S) {
      const n = rampNormal(s.thetaRad);
      for (const dx of [-0.065, 0.065]) {
        const p = toWorld(r, cx + dx, s.y + n.y * 0.012, s.z + n.z * 0.012);
        const nn = nW(n.y, n.z);
        sp.push(p.x, p.y, p.z); sn.push(nn.x, nn.y, nn.z); sv++;
      }
    }
    for (let i = 0; i < S.length - 1; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      si.push(a, c, b, b, c, d);
    }
  }
  const stripe = new THREE.BufferGeometry();
  stripe.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  stripe.setAttribute('normal', new THREE.Float32BufferAttribute(sn, 3));
  stripe.setIndex(si);
  return { surface: g, samples: S, edgeCurves, stripe };
}

/** Ramp-local back-side height at ramp-local z (for scaffolding below the first arc). */
export function backsideAt(S: ProfileSample[], thickness: number, zLocal: number): { y: number; z: number } | null {
  for (let i = 0; i < S.length - 1; i++) {
    const a = S[i], b = S[i + 1];
    const az = a.z + Math.sin(a.thetaRad) * thickness, bz = b.z + Math.sin(b.thetaRad) * thickness;
    if ((az - zLocal) * (bz - zLocal) <= 0 && Math.abs(bz - az) > 1e-6) {
      const f = (zLocal - az) / (bz - az);
      const ay = a.y - Math.cos(a.thetaRad) * thickness, by = b.y - Math.cos(b.thetaRad) * thickness;
      return { y: ay + (by - ay) * f, z: zLocal };
    }
  }
  return null;
}
