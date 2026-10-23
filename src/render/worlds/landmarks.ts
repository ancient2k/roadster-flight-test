// Landmarks from the site's meta (GLBs: Meter, +Y up, origin bottom centre, front = local +Z).
// headingDeg rotates the front about +Y from +Z toward +X (Sphinx headingDeg 90 → faces east = +X).
import * as THREE from 'three/webgpu';
import { texture, uv, float, max, smoothstep, length, positionWorld, cameraPosition, mix } from 'three/tsl';
import type { LandmarkDef } from './terrainData';
import { partRegions, type PropPlacement, type PropPose } from '../../shared/props';

export interface LoadedLandmark { def: LandmarkDef; object: THREE.Object3D }

export function landmarkMatrix(def: LandmarkDef, groundY: number | null): THREE.Matrix4 {
  const y = Number.isFinite(def.y) ? def.y : groundY ?? 0;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (def.headingDeg ?? 0) * Math.PI / 180);
  const s = def.scale ?? 1;
  return new THREE.Matrix4().compose(new THREE.Vector3(def.x, y, def.z), q, new THREE.Vector3(s, s, s));
}

/**
 * specular anti-aliasing for crinkled metal foil (LM Kapton/Mylar): close up the facet normals make
 * individual glints; farther away the mip-mapped normal map flattens into a mirror that throws the low sun
 * straight into the lens (the "glowing LM"). Roughness rises with distance like a Toksvig factor would.
 */
function foilAA(mt: THREE.Material): THREE.Material {
  const sm = mt as THREE.MeshStandardMaterial;
  if (!sm.isMeshStandardMaterial || sm.metalness < 0.9 || !sm.normalMap) return mt;
  const nm = new THREE.MeshStandardNodeMaterial({
    name: sm.name, color: sm.color, map: sm.map, normalMap: sm.normalMap, normalScale: sm.normalScale,
    roughness: sm.roughness, roughnessMap: sm.roughnessMap, metalness: sm.metalness, metalnessMap: sm.metalnessMap,
    aoMap: sm.aoMap, emissive: sm.emissive, emissiveMap: sm.emissiveMap, side: sm.side, vertexColors: sm.vertexColors,
    transparent: sm.transparent, opacity: sm.opacity, alphaTest: sm.alphaTest,
  });
  const base = sm.roughnessMap ? texture(sm.roughnessMap, uv()).g.mul(sm.roughness) : float(sm.roughness);
  const far = smoothstep(float(6), float(45), length(positionWorld.sub(cameraPosition)));
  nm.roughnessNode = max(base, mix(float(0), float(0.72), far));
  sm.dispose();
  return nm;
}

export async function loadLandmarks(dir: string, defs: LandmarkDef[], heightAt: (x: number, z: number) => number): Promise<{ group: THREE.Group; items: LoadedLandmark[]; missing: string[] }> {
  const group = new THREE.Group();
  group.name = 'Landmarks';
  const items: LoadedLandmark[] = [];
  const missing: string[] = [];
  if (!defs.length) return { group, items, missing };
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  await Promise.all(defs.map(async (def) => {
    const url = `${dir}/${def.file}`;
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (!head.ok || (head.headers.get('content-type') ?? '').includes('text/html')) { missing.push(def.file); return; }
      const gltf = await loader.loadAsync(url);
      const obj = gltf.scene;
      obj.name = def.file.replace(/\.glb$/, '');
      obj.matrixAutoUpdate = false;
      obj.matrix.copy(landmarkMatrix(def, heightAt(def.x, def.z)));
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true; m.receiveShadow = true;
        // no transmission on landmark glass (NASA rover lenses): it would switch on the framebuffer-copy
        // pass for the whole frame (cost, and "Destroyed texture" errors with the post chain on resize)
        // and no clearcoat/specular/IOR lobes either: plain PBR is enough at landmark distances and cheaper
        const plain = (mt: THREE.Material): THREE.Material => {
          const pm = mt as THREE.MeshPhysicalMaterial;
          if (!pm.isMeshPhysicalMaterial) return mt;
          const sm = new THREE.MeshStandardMaterial({
            name: pm.name, color: pm.color, map: pm.map, normalMap: pm.normalMap, normalScale: pm.normalScale,
            roughness: pm.roughness, roughnessMap: pm.roughnessMap, metalness: pm.metalness, metalnessMap: pm.metalnessMap,
            aoMap: pm.aoMap, emissive: pm.emissive, emissiveMap: pm.emissiveMap, emissiveIntensity: pm.emissiveIntensity,
            alphaTest: pm.alphaTest, side: pm.side, vertexColors: pm.vertexColors,
            transparent: pm.transparent || pm.transmission > 0, opacity: pm.transmission > 0 ? Math.min(pm.opacity, 0.35) : pm.opacity,
          });
          pm.dispose();
          return sm;
        };
        m.material = Array.isArray(m.material) ? m.material.map(plain) : plain(m.material);
        m.material = Array.isArray(m.material) ? m.material.map(foilAA) : foilAA(m.material);
        for (const mt of Array.isArray(m.material) ? m.material : [m.material]) groundBias(mt);
      });
      if (def.ground) dropPavedGeometry(obj);
      group.add(obj);
      items.push({ def, object: obj });
    } catch (e) {
      console.warn('[worlds] Wahrzeichen nicht ladbar:', url, e);
      missing.push(def.file);
    }
  }));
  group.updateMatrixWorld(true);
  return { group, items, missing };
}

/** World-space triangles of all meshes (for baking landmark shadows into the heightfield shadow). */
export function worldTriangles(root: THREE.Object3D, maxTris = 400_000, filter?: (o: THREE.Object3D) => boolean): Float32Array {
  root.updateMatrixWorld(true);
  const out: number[] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || out.length / 9 > maxTris || (filter && !filter(o))) return;
    const g = m.geometry;
    const p = g.getAttribute('position');
    if (!p) return;
    const idx = g.getIndex();
    const n = idx ? idx.count : p.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(p as THREE.BufferAttribute, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  });
  return new Float32Array(out);
}

// ------------------------------------------------------------------ movable, breakable landmark parts

/** Graphics of the movable parts of a world (one group per physics part, in PropSystem order). */
export interface PropVisuals { placements: PropPlacement[]; parts: THREE.Object3D[]; scales: number[] }

/**
 * Splits the GLB triangles of every `dynamic` object (meta.json) into one group per part (src/shared/props.ts):
 * a triangle belongs to the first part (after the main body) whose region contains its centroid in the object
 * frame, else to the main body – if the main body has a region of its own (Stonehenge stones) only triangles
 * inside it; triangles nobody claims stay in the static landmark (and in its collider and baked shadow). One pass
 * over the triangles for all objects of a GLB (88 stones share one mesh). Materials and vertex buffers are shared,
 * only the index lists are new. The groups sit at the world level of `parent` and get their pose from the physics
 * (applyPropPoses).
 */
export function splitDynamicLandmarks(items: LoadedLandmark[], parent: THREE.Object3D): PropVisuals {
  const out: PropVisuals = { placements: [], parts: [], scales: [] };
  items.forEach((it, li) => {
    const defs = it.def.dynamic ?? [];
    if (!defs.length) return;
    const root = it.object;
    root.updateMatrixWorld(true);
    const rootInv = root.matrixWorld.clone().invert();
    const scale = it.def.scale ?? 1;
    const pos = new THREE.Vector3().setFromMatrixPosition(root.matrix);
    const objs = defs.map((def) => {
      const O = new THREE.Matrix4().compose(new THREE.Vector3(...def.origin), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), def.yawDeg * Math.PI / 180), new THREE.Vector3(1, 1, 1));
      const regions = def.parts.map((p, i) => (i === 0 && !p.region?.length ? [] : partRegions(p)).map((r) => new THREE.Box3(new THREE.Vector3(...r.min), new THREE.Vector3(...r.max))));
      const claimRest = !def.parts[0].region?.length;
      // quick reject: radius around the object origin that holds all its regions
      let radius = 0;
      for (const rs of regions) for (const b of rs) {
        radius = Math.max(radius, Math.hypot(Math.max(-b.min.x, b.max.x), Math.max(-b.min.y, b.max.y), Math.max(-b.min.z, b.max.z)));
      }
      const groups = def.parts.map((p) => {
        const g = new THREE.Group();
        g.name = `${def.id}:${p.id}`;
        g.matrixAutoUpdate = false;
        g.matrix.copy(root.matrix).multiply(O);
        return g;
      });
      return { def, O, Oinv: O.clone().invert(), regions, claimRest, radius: claimRest ? Infinity : radius, origin: new THREE.Vector3(...def.origin), groups };
    });
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (let a: THREE.Object3D | null = m; a && a !== root; a = a.parent) if (defs.some((d) => d.meshes.includes(a!.name))) { meshes.push(m); return; }
    });
    const c = new THREE.Vector3(), v = new THREE.Vector3(), co = new THREE.Vector3();
    for (const m of meshes) {
      const g = m.geometry, p = g.getAttribute('position') as THREE.BufferAttribute;
      const idx = g.getIndex();
      const n = idx ? idx.count : p.count;
      const toRoot = rootInv.clone().multiply(m.matrixWorld);
      const mine = objs.filter((o) => {
        for (let a: THREE.Object3D | null = m; a && a !== root; a = a.parent) if (o.def.meshes.includes(a.name)) return true;
        return false;
      });
      const lists = mine.map((o) => o.def.parts.map(() => [] as number[]));
      const keep: number[] = [];
      for (let t = 0; t + 2 < n; t += 3) {
        c.set(0, 0, 0);
        for (let k = 0; k < 3; k++) c.add(v.fromBufferAttribute(p, idx ? idx.getX(t + k) : t + k));
        c.divideScalar(3).applyMatrix4(toRoot);
        const tri = [0, 1, 2].map((k) => (idx ? idx.getX(t + k) : t + k));
        let claimed = false;
        for (let oi = 0; oi < mine.length && !claimed; oi++) {
          const o = mine[oi];
          if (c.distanceTo(o.origin) > o.radius) continue;
          co.copy(c).applyMatrix4(o.Oinv);
          let part = -1;
          for (let pi = 1; pi < o.regions.length && part < 0; pi++) if (o.regions[pi].some((b) => b.containsPoint(co))) part = pi;
          if (part < 0 && (o.claimRest || o.regions[0].some((b) => b.containsPoint(co)))) part = 0;
          if (part >= 0) { lists[oi][part].push(...tri); claimed = true; }
        }
        if (!claimed) keep.push(...tri);
      }
      mine.forEach((o, oi) => lists[oi].forEach((l, pi) => {
        if (!l.length) return;
        const ng = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(g.attributes)) ng.setAttribute(name, attr);
        ng.setIndex(l);
        ng.computeBoundingSphere();
        const pm = new THREE.Mesh(ng, m.material);
        pm.name = `${m.name}:${o.def.id}:${o.def.parts[pi].id}`;
        pm.castShadow = m.castShadow; pm.receiveShadow = m.receiveShadow;
        pm.matrixAutoUpdate = false;
        pm.matrix.copy(o.Oinv).multiply(toRoot);
        o.groups[pi].add(pm);
      }));
      // the objects' triangles leave the static landmark (its buffers live on in the part meshes)
      if (keep.length) { g.setIndex(keep); g.computeBoundingSphere(); } else m.removeFromParent();
    }
    for (const o of objs) {
      for (const g of o.groups) { parent.add(g); out.parts.push(g); out.scales.push(scale); }
      out.placements.push({ landmarkId: `${it.def.file.replace(/\.glb$/, '')}#${li}`, pos: { x: pos.x, y: pos.y, z: pos.z }, headingDeg: it.def.headingDeg ?? 0, scale, def: o.def });
    }
  });
  parent.updateMatrixWorld(true);
  return out;
}

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
/** Poses from the physics (PropSystem.poses order). */
export function applyPropPoses(v: PropVisuals, poses: readonly PropPose[]): void {
  const n = Math.min(v.parts.length, poses.length);
  for (let i = 0; i < n; i++) {
    const o = v.parts[i], e = poses[i];
    o.matrix.compose(_p.set(e.pos.x, e.pos.y, e.pos.z), _q.set(e.quat.x, e.quat.y, e.quat.z, e.quat.w), _s.setScalar(v.scales[i]));
    o.matrixWorldNeedsUpdate = true;
  }
}

/** Roads, pads and aprons lie within centimetres of the terrain: pull them towards the camera in the depth test so
 *  they do not flicker against the ground (the sign is handled for the reversed depth buffer in GameRenderer). */
const PAVED = /asphalt|concrete|road|pad|apron/i;
function groundBias(mt: THREE.Material): void {
  if (!PAVED.test(mt.name)) return;
  mt.polygonOffset = true; mt.polygonOffsetFactor = -1; mt.polygonOffsetUnits = -2;
}

/** Removes the roads and slabs a landmark carries as geometry when they are painted into the terrain instead
 *  (LandmarkDef.ground): all Asphalt, and Concrete triangles lying entirely below 12 cm in the model frame. */
function dropPavedGeometry(root: THREE.Object3D): void {
  const drop: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    const name = m.material.name.toLowerCase();
    if (name.includes('asphalt')) { drop.push(m); return; }
    if (!name.includes('concrete')) return;
    const g = m.geometry, p = g.getAttribute('position') as THREE.BufferAttribute, idx = g.getIndex();
    const n = idx ? idx.count : p.count, keep: number[] = [];
    const y = (k: number) => p.getY(idx ? idx.getX(k) : k);
    for (let t = 0; t + 2 < n; t += 3) {
      if (Math.max(y(t), y(t + 1), y(t + 2)) < 0.12) continue;
      for (let k = 0; k < 3; k++) keep.push(idx ? idx.getX(t + k) : t + k);
    }
    if (keep.length !== n) { g.setIndex(keep); g.computeBoundingSphere(); }
  });
  for (const m of drop) m.removeFromParent();
}
