// Sun scene (space_sun): compressed-scale Sun with animated granulation, limb darkening, faculae, sunspots,
// chromosphere and corona (TSL); Roadster 1 + Starman (GLB, placeholder until delivered) tumbling
// nearby; Earth and Mars as far discs; NASA Deep Star Map sky in the ecliptic frame; heat effects for the
// player's car (heat01 / surfaceTempK from the game logic).
import * as THREE from 'three/webgpu';
import { ROADSTER1_PROP } from '../../shared/props';
import type { Node } from 'three/webgpu';
import {
  Fn, vec2, vec3, float, uniform, texture, positionWorld, positionWorldDirection, cameraPosition, normalWorld, normalize, dot,
  mx_worley_noise_vec2, mx_noise_float, mx_noise_vec3, mx_fractal_noise_float, time, smoothstep, clamp, pow, mix, max, abs, uv, length, atan, asin, exp,
} from 'three/tsl';
import type { SiteDef } from '../../shared/worlds';
import { QUALITY_PRESETS, type QualityLevel } from '../quality';
import { lookParams } from './skyParams';
import { makeSkyUniforms } from './atmosphere';
import { SUN_SCENE, sunDistance } from './sunLayout';
import { HeatEffects } from './heat';
import type { WorldHandle, WorldOptions } from './index';
import { loadTex } from './textures';
import type { UFloat } from './types';

type N3 = Node<'vec3'>;
type NF = Node<'float'>;
const PI = Math.PI;

/** Photosphere radiance at disc centre (scene units). Exposure adapts (see autoExposure). */
export const SUN_SURFACE_RADIANCE = 1800;
const PHOTOSPHERE: [number, number, number] = [1.0, 0.94, 0.88];

function sunMaterial(R: number, center: THREE.Vector3, spots: THREE.Texture | null): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'SunPhotosphere';
  m.colorNode = Fn(() => {
    const p = positionWorld.sub(vec3(center.x, center.y, center.z)).div(R);   // unit sphere coords
    const n = normalize(p);
    const V = normalize(cameraPosition.sub(positionWorld));
    const mu = clamp(dot(n, V), 0, 1);
    // limb darkening (meta: u1 0.47, u2 0.23)
    const om = float(1).sub(mu);
    const limb = float(1).sub(om.mul(0.47)).sub(om.mul(om).mul(0.23));
    // granulation: Worley cells (bright centres, dark intergranular lanes), three scales so it reads from
    // the spawn down to a few hundred metres above the surface; slowly evolving
    const t = time.mul(0.04);
    // F2 − F1 gives polygonal cells with thin dark intergranular lanes; brightness peaks in the cell centre
    const cell = (k: number, w: number, o: number) => {
      // domain warp breaks the Voronoi polygons into rounded, irregular granules
      const q = n.mul(k);
      const wq = q.add(mx_noise_vec3(q.mul(0.5)).mul(0.45));
      const f = mx_worley_noise_vec2(wq.add(vec3(t.mul(o), t.mul(0.7 * o), t.mul(0.3))));
      // narrow, moderately dark lanes (DKIST: ~20 % contrast), domed bright granules
      const lane = smoothstep(float(0.0), float(0.38), f.y.sub(f.x)).mul(0.7).add(0.3);
      const centre = float(1).sub(f.x.mul(f.x).mul(0.35));
      return lane.mul(centre).mul(w);
    };
    const gran = cell(60, 0.88, 1).add(cell(170, 0.12, 1.8));
    // contrast survives the tone curve: hot granule centres vs. cool, darker intergranular lanes
    const granC = pow(gran, float(1.6)).mul(0.95).add(0.3);
    // supergranulation / mottling
    const sg = mx_fractal_noise_float(n.mul(22).add(vec3(t.mul(0.2), 0, 0)), 2, 2, 0.5).mul(0.06).add(1);
    // faculae: bright network patches visible toward the limb
    const fac = smoothstep(float(0.25), float(0.6), mx_noise_float(n.mul(14))).mul(smoothstep(float(0.6), float(0.05), mu)).mul(0.35);
    // sunspots: from the SDO quick-look disc if present, else procedural umbra/penumbra
    let spot: NF;
    if (spots) {
      // project onto the disc as seen from the spawn direction (−Z toward the observer)
      const suv = vec2(n.x.mul(-0.5).add(0.5), n.y.mul(0.5).add(0.5));
      const s = texture(spots, suv);
      // the image has limb darkening baked in: divide it out roughly
      const sl = float(1).sub(float(1).sub(clamp(n.z.negate(), 0, 1)).mul(0.6));
      // only the dark features (spots, pores) are taken over; the granulation stays procedural
      const v = clamp(s.r.div(sl.max(0.3)), 0.2, 1);
      spot = mix(float(1), v, smoothstep(float(0.9), float(0.7), v).mul(smoothstep(float(0.05), float(0.2), n.z.negate()))) as NF;
    } else {
      const sn = mx_noise_float(n.mul(5).add(vec3(3.1, 0, 0)));
      const um = smoothstep(float(0.55), float(0.62), sn), pen = smoothstep(float(0.45), float(0.55), sn);
      spot = float(1).sub(pen.mul(0.35)).sub(um.mul(0.5)) as NF;
    }
    // display colour: white-yellow centre, orange limb (true colour is near white; the tint keeps the surface
    // readable when the eye has adapted to it)
    const temp = mix(vec3(1.0, 0.3, 0.04), vec3(1.0, 0.66, 0.26), limb).mul(mix(vec3(1.0, 0.6, 0.4), vec3(1.0, 1.0, 1.0), clamp(gran, 0, 1)));
    return temp.mul(limb).mul(granC).mul(sg).mul(fac.add(1)).mul(spot).mul(SUN_SURFACE_RADIANCE);
  })();
  return m;
}

/** Corona + chromosphere billboard (additive). Radial power law with streamers and slow evolution. */
function coronaMaterial(R: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  m.name = 'SunCorona';
  const SIZE = 7; // billboard half-size in sun radii
  m.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2 * SIZE);           // in sun radii
    const r = length(q);
    const ang = atan(q.y, q.x);
    const outside = smoothstep(float(0.995), float(1.01), r);
    const h = r.sub(1).max(0.002);
    // K-corona ~ r^-2.5…-3, streamers modulate the angle, slowly drifting
    const streams = mx_fractal_noise_float(vec3(ang.mul(2.5), h.mul(0.6).sub(time.mul(0.02)), time.mul(0.01)), 4, 2, 0.55).mul(0.5).add(0.5);
    const helmet = pow(abs(ang.sin()), float(0.6)).mul(0.6).add(0.4);     // equatorial streamers stronger
    // steeper outer fall-off – the far corona must not light up as a grey wall when the eye adapts to space
    const k = pow(r, float(-3)).mul(exp(r.sub(1).div(-1.6))).mul(streams.mul(1.4).add(0.3)).mul(helmet);
    // chromosphere: thin pinkish ring just above the limb, spicule texture
    const spic = mx_noise_float(vec3(ang.mul(180), h.mul(40), time.mul(0.5))).mul(0.5).add(0.5);
    const chromo = exp(h.mul(-90)).mul(spic.mul(0.6).add(0.4));
    // prominences: occasional loops along the limb
    // prominences – arches of plasma above the limb: a site mask along the limb, loop threads from
    // stretched noise (field-aligned), heights up to ~0,15 R, a few bright knots
    const site = smoothstep(float(0.45), float(0.75), mx_noise_float(vec3(ang.mul(4), 0.5, time.mul(0.004))));
    const loopH = mx_noise_float(vec3(ang.mul(9), 2.0, time.mul(0.01))).mul(0.5).add(0.5).mul(0.14).add(0.03);
    const arch = smoothstep(loopH, loopH.mul(0.55), h).mul(smoothstep(float(0.0), float(0.012), h));
    const threads = pow(mx_noise_float(vec3(ang.mul(70), h.mul(9), time.mul(0.05))).mul(0.5).add(0.5), float(2.2)).mul(1.6);
    const prom = site.mul(arch).mul(threads.add(0.15));
    const col = vec3(1.0, 0.93, 0.84).mul(k).mul(9)
      .add(vec3(1.0, 0.35, 0.3).mul(chromo).mul(40))
      .add(vec3(1.0, 0.36, 0.3).mul(prom).mul(110));
    const edge = smoothstep(float(SIZE), float(SIZE * 0.7), r);
    return col.mul(outside).mul(edge);
  })();
  void R;
  return m;
}

/** Planet disc (Earth/Mars) lit from the sun direction, procedural surface. */
function planetMaterial(kind: 'earth' | 'mars', sunPos: THREE.Vector3): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = kind === 'earth' ? 'FarEarth' : 'FarMars';
  m.colorNode = Fn(() => {
    const n = normalize(normalWorld);
    const L = normalize(vec3(sunPos.x, sunPos.y, sunPos.z).sub(positionWorld));
    const lit = max(dot(n, L), float(0));
    const p = n.mul(3);
    let alb: N3;
    if (kind === 'earth') {
      const land = smoothstep(float(0.05), float(0.15), mx_fractal_noise_float(p, 4, 2, 0.5));
      const cloud = smoothstep(float(0.0), float(0.5), mx_fractal_noise_float(p.mul(2).add(vec3(time.mul(0.002), 0, 0)), 4, 2, 0.5));
      alb = mix(mix(vec3(0.02, 0.05, 0.12), vec3(0.15, 0.13, 0.07), land), vec3(0.75, 0.77, 0.8), cloud.mul(0.8)) as N3;
    } else {
      const v = mx_fractal_noise_float(p.mul(1.5), 4, 2, 0.5).mul(0.5).add(0.5);
      alb = mix(vec3(0.16, 0.07, 0.035), vec3(0.32, 0.16, 0.08), v) as N3;
    }
    return alb.mul(lit).mul(5.1 / PI).mul(14);
  })();
  return m;
}

/** Placeholder Roadster 1 + Starman until delivers roadster1_starman.glb. */
function placeholderRoadster1(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Roadster1_Placeholder';
  const paint = new THREE.MeshPhysicalMaterial({ color: 0x9a0d0d, roughness: 0.35, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.5 });
  const suit = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.7 });
  const visor = new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.05, metalness: 1 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 2.8, 8, 24), paint);
  body.rotation.x = Math.PI / 2; body.scale.set(1.45, 1, 0.62); body.position.y = 0.45;
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 12), paint);
  nose.scale.set(1.3, 0.45, 1.1); nose.position.set(0, 0.45, 1.6);
  const screen = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.04, 0.55), black);
  screen.position.set(0, 0.95, 0.35); screen.rotation.x = -0.9;
  const wheels: THREE.Mesh[] = [];
  for (const [x, z] of [[0.75, 1.15], [-0.75, 1.15], [0.75, -1.2], [-0.75, -1.2]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.22, 24), black);
    w.rotation.z = Math.PI / 2; w.position.set(x, 0.3, z);
    wheels.push(w);
  }
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.42, 6, 12), suit);
  torso.position.set(0.32, 1.05, -0.15); torso.rotation.x = -0.25;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 12), suit);
  head.position.set(0.32, 1.48, -0.25);
  const vis = new THREE.Mesh(new THREE.SphereGeometry(0.135, 20, 12, 0, Math.PI), visor);
  vis.position.set(0.32, 1.49, -0.17);
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.45, 4, 8), suit);
  arm.position.set(-0.05 + 0.32, 1.08, 0.18); arm.rotation.set(1.2, 0, 0.6);
  g.add(body, nose, screen, ...wheels, torso, head, vis, arm);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

async function loadRoadster1(base: string): Promise<{ obj: THREE.Object3D; placeholder: boolean }> {
  const url = `${base}assets/car/roadster1_starman.glb`;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (head.ok && !(head.headers.get('content-type') ?? '').includes('text/html')) {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
      const l = new GLTFLoader(); l.setMeshoptDecoder(MeshoptDecoder);
      const gl = await l.loadAsync(url);
      gl.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      return { obj: gl.scene, placeholder: false };
    }
  } catch (e) { console.warn('[worlds] roadster1_starman.glb nicht ladbar:', e); }
  return { obj: placeholderRoadster1(), placeholder: true };
}

/** Star map background in the ecliptic scene frame (equirectangular, ICRF/J2000, RA increasing to the left). */
function starBackground(stars: THREE.Texture | null, gain: UFloat) {
  return Fn(() => {
    const d = positionWorldDirection.normalize();
    // scene → ecliptic (x, y, z)_ecl = (X, −Z, Y) → equatorial (rotate by −ε about x)
    const c = 0.917482062, s = 0.397777156;
    const ex = d.x, ey = d.z.negate(), ez = d.y;
    const qx = ex, qy = ey.mul(c).sub(ez.mul(s)), qz = ey.mul(s).add(ez.mul(c));
    if (!stars) return vec3(0, 0, 0);
    const ra = atan(qy, qx);
    const dec = asin(clamp(qz, -1, 1));
    const u = float(0.5).sub(ra.div(2 * PI));
    const v = float(0.5).add(dec.div(PI));
    return texture(stars, vec2(u, v)).rgb.mul(gain);
  })();
}

export async function loadSunScene(scene: THREE.Scene, renderer: THREE.WebGPURenderer, site: SiteDef, opts: WorldOptions): Promise<WorldHandle> {
  const progress = opts.onProgress ?? (() => {});
  const base = (opts.assetBase ?? '/').replace(/\/?$/, '/');
  const dir = base + site.assetDir.replace(/^\/+/, '');
  const look = lookParams('deep_space', site.id);
  const L = SUN_SCENE;
  const center = new THREE.Vector3(L.sunCenter.x, L.sunCenter.y, L.sunCenter.z);
  const R = L.sunRadius;
  const group = new THREE.Group();
  group.name = `World:${site.id}`;
  scene.add(group);

  progress('Sternenkarte laden …');
  const big = opts.quality === 'ultra' || opts.quality === 'high';
  const [stars, spots] = await Promise.all([
    loadTex(`${dir}/${big ? 'stars_8k.jpg' : 'stars_4k.jpg'}`, { srgb: true, flipY: true, anisotropy: 4 }),
    loadTex(`${dir}/sun_disk_1024.png`, { srgb: false, flipY: true, anisotropy: 1 }),
  ]);
  if (stars) { stars.wrapS = THREE.RepeatWrapping; stars.minFilter = THREE.LinearMipmapLinearFilter; }
  const starGain = uniform(0.25);
  const prev = { bg: scene.backgroundNode, fog: scene.fogNode, env: scene.environment, envI: scene.environmentIntensity };
  scene.backgroundNode = starBackground(stars, starGain);
  scene.fogNode = null;

  // --- Sun
  const sun = new THREE.Mesh(new THREE.SphereGeometry(R, 160, 80), sunMaterial(R, center, spots));
  sun.name = 'Sun';
  sun.position.copy(center);
  const corona = new THREE.Mesh(new THREE.PlaneGeometry(14 * R, 14 * R), coronaMaterial(R));
  corona.name = 'SunCorona';
  corona.position.copy(center);
  corona.renderOrder = -1;
  group.add(sun, corona);

  // --- far planets
  const sunPos = center.clone();
  const mkPlanet = (k: 'earth' | 'mars') => {
    const d = L[k];
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(d.radius, 48, 24), planetMaterial(k, sunPos));
    mesh.name = k === 'earth' ? 'Earth' : 'Mars';
    mesh.position.set(d.dir.x, d.dir.y, d.dir.z).normalize().multiplyScalar(d.dist);
    return mesh;
  };
  const earth = mkPlanet('earth'), mars = mkPlanet('mars');
  group.add(earth, mars);

  // --- light: directional from the sun centre toward the focus, 1/r² falloff
  const d0 = sunDistance({ x: 0, y: 0, z: 0 });
  const light = new THREE.DirectionalLight(new THREE.Color(PHOTOSPHERE[0], PHOTOSPHERE[1], PHOTOSPHERE[2]), look.sunIrradiance);
  light.name = 'SunLight';
  light.castShadow = true;
  const ms = QUALITY_PRESETS[opts.quality].shadowMapSize;
  light.shadow.mapSize.set(ms, ms);
  light.shadow.bias = -0.0003; light.shadow.normalBias = 0.02;
  const sc = light.shadow.camera;
  sc.left = -25; sc.right = 25; sc.top = 25; sc.bottom = -25; sc.near = 1; sc.far = 200; sc.updateProjectionMatrix();
  group.add(light, light.target);
  const ambient = new THREE.HemisphereLight(0x8090a0, 0x050505, 0.02);
  group.add(ambient);

  // environment: dim stars + the sun as a bright (clamped) disc so paint reflects it
  let envRT: THREE.RenderTarget | null = null;
  try {
    const envScene = new THREE.Scene();
    envScene.backgroundNode = starBackground(stars, uniform(0.3));
    const disc = new THREE.Mesh(new THREE.SphereGeometry(R * 0.0055, 24, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(60, 56, 52) }));
    disc.position.copy(center).multiplyScalar(0.0055);
    envScene.add(disc);
    const pm = new THREE.PMREMGenerator(renderer);
    envRT = pm.fromScene(envScene, 0, 0.1, 200, { size: 128 }) as unknown as THREE.RenderTarget;
    pm.dispose();
    scene.environment = envRT.texture;
    scene.environmentIntensity = 1;
  } catch (e) { console.warn('[worlds] Weltraum-PMREM fehlgeschlagen:', e); }

  progress('Roadster 1 laden …');
  const r1 = await loadRoadster1(base);
  const r1Holder = new THREE.Group();
  r1Holder.name = 'Roadster1';
  r1Holder.position.set(L.roadster1.pos.x, L.roadster1.pos.y, L.roadster1.pos.z);
  r1Holder.add(r1.obj);
  group.add(r1Holder);
  const spin = new THREE.Vector3(L.roadster1.spin.x, L.roadster1.spin.y, L.roadster1.spin.z);
  const dq = new THREE.Quaternion();
  // Roadster 1 is a rigid body in the physics (it can be rammed); once poses arrive they drive the holder
  let r1SimDriven = false;

  const heat = new HeatEffects(opts.quality === 'low' ? 600 : 1800);
  group.add(heat.group);

  const camRef = opts.camera ?? null;
  const focus = new THREE.Vector3();
  const sunDirection = new THREE.Vector3(0, 0, 1);
  const tmp = new THREE.Vector3();

  const handle: WorldHandle = {
    site, look, group, sunDirection, sunLight: light,
    environmentMap: envRT?.texture,
    exposure: look.exposure, exposureFixed: look.exposureFixed,
    cameraFar: 120000,
    heightAt: () => Number.NaN,
    collisionTriangles: () => new Float32Array(0),
    collisionShapes: () => [],
    dynamicProps: () => [{
      landmarkId: 'roadster1', pos: { ...L.roadster1.pos }, headingDeg: 0, def: ROADSTER1_PROP,
      linVel: { ...L.roadster1.drift }, angVel: { ...L.roadster1.spin },
    }],
    setPropPoses(poses) {
      const e = poses[0];
      if (!e) return;
      r1SimDriven = true;
      r1Holder.position.set(e.pos.x, e.pos.y, e.pos.z);
      r1Holder.quaternion.set(e.quat.x, e.quat.y, e.quat.z, e.quat.w);
    },
    surfaceAt: () => -Infinity,
    spawn: { x: 0, y: 0, z: 0, headingDeg: 0 },
    terrain: null,
    credits: ['Sterne: NASA/GSFC SVS Deep Star Maps 2020 (Gaia DR2: ESA/Gaia/DPAC)', 'Sonnenscheibe: NASA/SDO HMI', ...(r1.placeholder ? ['Roadster 1: Platzhalter'] : [])],
    tuning: { sky: makeSkyUniforms(), setDetail: () => {} },
    heat,
    update(cameraPos: THREE.Vector3, dt: number) {
      // focus: the player's car if attached, else the camera
      const target = heat.target;
      if (target) focus.setFromMatrixPosition(target.matrixWorld); else focus.copy(cameraPos);
      sunDirection.copy(center).sub(focus).normalize();
      const d = Math.max(R * 1.001, focus.distanceTo(center));
      light.intensity = look.sunIrradiance * Math.min(400, (d0 / d) ** 2);
      light.target.position.copy(focus);
      light.position.copy(focus).addScaledVector(sunDirection, 100);
      light.target.updateMatrixWorld(); light.updateMatrixWorld();
      corona.lookAt(cameraPos);
      // Roadster 1 tumbles and drifts
      const w = r1SimDriven ? 0 : spin.length();
      if (w > 0) { dq.setFromAxisAngle(tmp.copy(spin).divideScalar(w), w * dt); r1Holder.quaternion.premultiply(dq); }
      if (!r1SimDriven) { r1Holder.position.x += L.roadster1.drift.x * dt; r1Holder.position.z += L.roadster1.drift.z * dt; }
      const cam = camRef ?? ({ matrixWorld: new THREE.Matrix4().setPosition(cameraPos), quaternion: new THREE.Quaternion() } as unknown as THREE.Camera);
      heat.update(dt, cam, center);
    },
    setQuality(q: QualityLevel) {
      const s = QUALITY_PRESETS[q].shadowMapSize;
      light.shadow.mapSize.set(s, s);
    },
    stats: () => ({ roadster1: r1.placeholder ? 'Platzhalter' : 'GLB', stars: stars ? 1 : 0, sdo: spots ? 1 : 0, heatK: Math.round(heat.tempK.value), sunDist: Math.round(focus.distanceTo(center)) }),
    autoExposure(camera: THREE.PerspectiveCamera) {
      // analytic eye adaptation: share of the view covered by the photosphere (and corona) sets the key
      const dist = camera.position.distanceTo(center);
      const angR = Math.asin(Math.min(1, R / Math.max(dist, R)));
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const toSun = tmp.copy(center).sub(camera.position).normalize();
      const off = Math.acos(Math.min(1, Math.max(-1, fwd.dot(toSun))));
      const halfFov = (camera.fov * Math.PI / 180) * 0.6;
      const vis = Math.min(1, Math.max(0, (halfFov + angR - off) / (2 * angR + 1e-6)));
      const cover = Math.min(1, (angR * angR) / (halfFov * halfFov)) * vis;
      const avg = cover * SUN_SURFACE_RADIANCE * 0.8 + 0.06 * (light.intensity / look.sunIrradiance) ** 0.5 + 0.02;
      // a view filled by the photosphere should read brilliant, not mid-grey
      // a filled frame of photosphere is bright (the granules glow yellow, lanes stay orange-red)
      const key = look.exposure.key + (0.42 - look.exposure.key) * Math.min(1, cover * 1.5);
      return Math.min(look.exposure.max, Math.max(1e-4, key / avg));
    },
    dispose() {
      group.removeFromParent();
      heat.dispose();
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { m.geometry.dispose(); for (const mt of Array.isArray(m.material) ? m.material : [m.material]) mt.dispose(); }
      });
      stars?.dispose(); spots?.dispose(); envRT?.dispose(); light.dispose();
      scene.backgroundNode = prev.bg; scene.fogNode = prev.fog; scene.environment = prev.env; scene.environmentIntensity = prev.envI;
    },
  };
  void starGain; void mix;
  return handle;
}
