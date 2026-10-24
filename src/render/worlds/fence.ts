// Wire fences as shaded panels (Starbase: tools/worlds/blender/build_starbase.py, material "Fence", uv in metres:
// u along the fence, v = height). As geometry the 4.5 cm rails and 9 cm posts were thinner than a pixel beyond
// ~30 m and broke into flickering dashes while driving; here every post and rail is box-filtered over the
// pixel footprint (fwidth), so far away the fence fades into the faint haze it really is instead of aliasing.
import * as THREE from 'three/webgpu';
import { uv, fwidth, abs, fract, max, min, float, smoothstep, mix } from 'three/tsl';

type Node = ReturnType<typeof float>;

const POST_SPACING = 3;
const POST_W = 0.09;
const RAIL_W = 0.045;
/** Rail centres (m above the panel's foot): OSM fences carry no height, the builder uses 2.5 m. */
const RAILS = [0.25, 1.3, 2.5 - RAIL_W / 2];

/** Share of the pixel footprint [x ± fw/2] covered by a line of width w centred at distance d (d ≥ 0). */
function lineCoverage(d: Node, w: number, fw: Node): Node {
  const lo = max(d.sub(fw.mul(0.5)), float(-w / 2));
  const hi = min(d.add(fw.mul(0.5)), float(w / 2));
  return max(hi.sub(lo), float(0)).div(fw) as unknown as Node;
}

export function isFenceMaterial(mt: THREE.Material): boolean {
  return mt.name === 'Fence';
}

export function fenceMaterial(src: THREE.Material): THREE.Material {
  const sm = src as THREE.MeshStandardMaterial;
  const m = new THREE.MeshStandardNodeMaterial({
    name: 'Fence', color: sm.color ?? new THREE.Color(0.55, 0.55, 0.53),
    metalness: sm.metalness ?? 0.6, roughness: sm.roughness ?? 0.5,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  // glTF stores v flipped (1 − height in metres)
  const u = uv().x, v = float(1).sub(uv().y);
  const fu = max(fwidth(u), float(1e-4)), fv = max(fwidth(v), float(1e-4));
  // posts: nearest multiple of the spacing; once the footprint spans whole bays only the average remains
  const p = u.div(POST_SPACING);
  const dPost = abs(fract(p.add(0.5)).sub(0.5)).mul(POST_SPACING);
  const post = mix(lineCoverage(dPost as unknown as Node, POST_W, fu as unknown as Node), float(POST_W / POST_SPACING), smoothstep(float(POST_SPACING * 0.5), float(POST_SPACING), fu));
  let rails = float(0) as unknown as Node;
  for (const c of RAILS) rails = rails.add(lineCoverage(abs(v.sub(c)) as unknown as Node, RAIL_W, fv as unknown as Node)) as unknown as Node;
  m.opacityNode = float(1).sub(float(1).sub(post.clamp(0, 1)).mul(float(1).sub(rails.clamp(0, 1))));
  sm.dispose();
  return m;
}
