// Integration of the environment models (public/assets/env-models, docs/RENDERING.md).
// Every model is placed with decorFrame() (front = local +Z) and drawn instanced (one InstancedMesh
// per primitive for all placements). Missing files keep the procedural stand-ins of track.ts.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { uniform, positionWorld, texture, vec2, float } from 'three/tsl';
import { LIGHTMAP_WEIGHT, pixelFloor } from './materials';
import type { UFloat } from '../tslTypes';
import { TRACK, rampLocalToWorld, type Decor } from '../../shared/track';
import { DEG } from '../../shared/math';
import { decorFrame, makeBeamMaterial, TOWER_HEAD_LOCAL, type ReplaceKind, type TrackWorld } from './track';
import { backsideAt } from './rampMesh';
import type { QualitySettings } from '../quality';
import { replaceTransmission } from '../car/carRig';

export interface EnvModelsHandle {
  loaded: Record<string, boolean>;
  group: THREE.Group;
  /** Steam anchor + direction of the Raptor flame trench (world). */
  raptorSteam: { pos: THREE.Vector3; dir: THREE.Vector3 } | null;
  /** Objects excluded from the car reflection probe. */
  probeExcluded: THREE.Object3D[];
  /** Per light tower (TRACK.decor order): lamp positions/directions from the Light_i empties. */
  towerLamps: { pos: THREE.Vector3; dir: THREE.Vector3 }[][] | null;
  /** Extra camera colliders (cheap meshes only). */
  colliders: THREE.Object3D[];
  update(t: number): void;
  setCrowdFraction(f: number): void;
}

/** Scale of KHR_materials_emissive_strength values relative to our LED/lamp exposure. */
const EMISSIVE_SCALE: [RegExp, number][] = [
  // (tuned for the darker stream exposure: LEDs and lamp cores clip, the stage screens stay a dim
  // graphic in the background instead of grey panels)
  [/^LED_/, 0.5], [/^Lamp_Emissive/, 2.0], [/^Site_Lights/, 0.8], [/^Beam_Emissive/, 0.8], [/^Screen_Emissive/, 0.06],
  [/^Aviation/, 0.6], [/^Crowd/, 0.5],
];

function tuneMaterials(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      replaceTransmission(m);
      const sm = m as THREE.MeshStandardMaterial;
      for (const [re, k] of EMISSIVE_SCALE) if (re.test(m.name) && sm.emissiveIntensity !== undefined) {
        if (!(m.userData.emissiveTuned)) { sm.emissiveIntensity *= k; m.userData.emissiveTuned = true; }
      }
      // galvanised steel reads too dark at night with full metalness (note)
      if (/^Steel_Galv/.test(m.name) && sm.metalness !== undefined) sm.metalness = Math.min(sm.metalness, 0.8);
    }
  });
}

/** One InstancedMesh per mesh/primitive of `root` for all `placements` (world matrices). */
export function instanceModel(root: THREE.Object3D, placements: THREE.Matrix4[], name: string, shadows = true): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  if (!placements.length) return g;
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const m = new THREE.Matrix4(), local = new THREE.Matrix4();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    local.multiplyMatrices(rootInv, mesh.matrixWorld);
    const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, placements.length);
    placements.forEach((p, i) => im.setMatrixAt(i, m.multiplyMatrices(p, local)));
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = shadows;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    im.name = `${name}_${mesh.name}`;
    g.add(im);
  });
  return g;
}

/** World matrix of a named node of `root` when `root` is placed with `F`. */
function nodeWorld(root: THREE.Object3D, node: string, F: THREE.Matrix4): THREE.Matrix4 | null {
  const n = root.getObjectByName(node);
  if (!n) return null;
  root.updateMatrixWorld(true);
  const rel = root.matrixWorld.clone().invert().multiply(n.matrixWorld);
  return F.clone().multiply(rel);
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function tryLoad(loader: GLTFLoader, url: string): Promise<THREE.Object3D | null> {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok || (head.headers.get('content-type') ?? '').includes('text/html')) return null;
    const gltf = await loader.loadAsync(url);
    tuneMaterials(gltf.scene);
    return gltf.scene;
  } catch (e) {
    console.warn(`[render] Umgebungsmodell nicht geladen: ${url}`, e);
    return null;
  }
}

export async function loadEnvModels(track: TrackWorld, base: string, q: QualitySettings): Promise<EnvModelsHandle> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const lod1 = q.particleBudget <= 6000; // low/medium use the LOD1 meshes
  const names = ['light_tower', 'stage', 'grandstand', 'crowd_person', 'raptor_stand', 'led_fixture', 'ramp_truss', 'ramp_truss_cap', 'grass_clump', 'shrub', 'crowd_fence'];
  const lodName = (n: string) => (lod1 && ['light_tower', 'stage', 'grandstand', 'raptor_stand'].includes(n) ? `${n}_lod1` : n);
  const models = new Map<string, THREE.Object3D | null>();
  await Promise.all(names.map(async (n) => {
    let m = await tryLoad(loader, `${base}${lodName(n)}.glb`);
    if (!m && lodName(n) !== n) m = await tryLoad(loader, `${base}${n}.glb`);
    models.set(n, m);
  }));
  const group = new THREE.Group();
  group.name = 'EnvModels';
  const loaded: Record<string, boolean> = {};
  const probeExcluded: THREE.Object3D[] = [];
  const colliders: THREE.Object3D[] = [];
  const updaters: ((t: number) => void)[] = [];
  const hide = (k: ReplaceKind) => { for (const o of track.replaceable.get(k) ?? []) o.visible = false; };
  const decor = (kind: Decor['kind']) => TRACK.decor.filter((d) => d.kind === kind);
  for (const [n, m] of models) loaded[n] = !!m;

  // ---------------------------------------------------------------- light towers
  const tower = models.get('light_tower');
  let towerLamps: EnvModelsHandle['towerLamps'] = null;
  if (tower) {
    // far from every stunt: no shadow casting (keeps the two shadow maps cheap)
    group.add(instanceModel(tower, decor('lightTower').map(decorFrame), 'LightTowers', false));
    hide('lightTower');
    towerLamps = decor('lightTower').map((d) => {
      const F = decorFrame(d), lamps: { pos: THREE.Vector3; dir: THREE.Vector3 }[] = [];
      for (let i = 0; i < 16; i++) {
        const W = nodeWorld(tower, `Light_${i}`, F);
        if (!W) continue;
        const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
        W.decompose(pos, quat, new THREE.Vector3());
        lamps.push({ pos, dir: new THREE.Vector3(0, 0, -1).applyQuaternion(quat).normalize() });
      }
      return lamps;
    });
  }

  // ---------------------------------------------------------------- stage (+ moving-head beams)
  const stage = models.get('stage');
  const stageDecor = decor('stage')[0];
  if (stage && stageDecor) {
    const F = decorFrame(stageDecor);
    group.add(instanceModel(stage, [F], 'Stage', false));
    hide('stage'); // the procedural deck stays an (invisible) camera collider
    if (q.volumetricBeams) {
      const beamGeo = new THREE.ConeGeometry(1, 1, 20, 1, true).translate(0, -0.5, 0);
      const rnd = mulberry(77);
      const beams: MovingHead[] = [];
      // only every third fixture throws a visible shaft (stream: a few beams in local haze, no laser fan)
      for (let i = 0; i < 12; i += 3) {
        const W = nodeWorld(stage, `Beam_${i}`, F);
        if (!W) continue;
        const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
        W.decompose(pos, quat, new THREE.Vector3());
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
        const gain = uniform(1);
        // slightly different colour temperatures per fixture (real moving heads never match)
        const tint = new THREE.Color().setHSL(0.58 + (rnd() - 0.5) * 0.04, 0.35 + rnd() * 0.25, 0.8);
        const cone = new THREE.Mesh(beamGeo, makeBeamMaterial(0.011, tint, gain));
        cone.position.copy(pos);
        const base = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
        cone.quaternion.copy(base);
        const len = 55 + rnd() * 30, rad = len * Math.tan((2.4 + rnd() * 1.8) * DEG);
        cone.scale.set(rad, len, rad);
        cone.frustumCulled = false;
        cone.renderOrder = 5;
        group.add(cone);
        beams.push(new MovingHead(cone, base, gain, (i / 3) % 3, rnd));
      }
      // cue-driven moves: each fixture holds a position, then eases to a new random pan/tilt; the
      // three groups take their cues at different times with per-fixture lag, some heads go dark
      let lastT = -1;
      updaters.push((t) => {
        const dt = lastT < 0 ? 0 : t - lastT;
        lastT = t;
        for (const b of beams) b.update(t, dt);
      });
    }
  }

  // ---------------------------------------------------------------- grandstands + crowd
  const stand = models.get('grandstand');
  const standDecor = decor('grandstand');
  if (stand) {
    group.add(instanceModel(stand, standDecor.map(decorFrame), 'Grandstands', false));
    hide('grandstand');
  }
  const person = models.get('crowd_person');
  const crowdMeshes: THREE.InstancedMesh[] = [];
  if (person) {
    const rnd = mulberry(11);
    const seated: THREE.Matrix4[] = [];
    const standing: THREE.Matrix4[][] = [[], [], []];
    const sections: [number, number][] = [[-24.7, -13.15], [-11.85, -0.65], [0.65, 11.85], [13.15, 24.7]];
    const yaw = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    for (const d of standDecor) {
      const F = decorFrame(d);
      for (let i = 0; i < 18; i++) {
        for (const [x0, x1] of sections) for (let x = x0 + 0.3; x < x1 - 0.25; x += 0.56) {
          if (rnd() < 0.5) continue; // half-full stands (the stream audience mostly stood at the stage)
          const s = 0.94 + rnd() * 0.12;
          yaw.setFromAxisAngle(up, (rnd() - 0.5) * 0.5);
          const local = new THREE.Matrix4().compose(new THREE.Vector3(x + (rnd() - 0.5) * 0.08, 0.30 + 0.42 * i, 7.18 - 0.95 * i + 0.04), yaw, new THREE.Vector3(s, s, s));
          seated.push(F.clone().multiply(local));
        }
      }
    }
    if (stageDecor) {
      const F = decorFrame(stageDecor);
      for (let k = 0; k < 650; k++) {
        const x = (rnd() - 0.5) * 38, z = 9 + rnd() * 15;
        yaw.setFromAxisAngle(up, Math.PI + (rnd() - 0.5) * 0.9 + Math.atan2(-x, z) * 0.3);
        const s = 0.93 + rnd() * 0.14;
        standing[Math.floor(rnd() * 3)].push(F.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), yaw, new THREE.Vector3(s, s, s))));
      }
    }
    const variants: [string, THREE.Matrix4[]][] = [['Person_S', seated], ['Person_A', standing[0]], ['Person_B', standing[1]], ['Person_C', standing[2]]];
    const clothing = [0x1b1d22, 0x2a2f3a, 0x3b3f46, 0x5a2a2a, 0x223344, 0x6b6f75, 0x8a8f96, 0x2f3b2f, 0x111111, 0x40352a];
    for (const [nodeName, mats] of variants) {
      const node = person.getObjectByName(nodeName);
      if (!node || !mats.length) continue;
      const g = instanceModel(node, mats, `Crowd_${nodeName}`, false);
      g.traverse((o) => {
        const im = o as THREE.InstancedMesh;
        if (!im.isInstancedMesh) return;
        const c = new THREE.Color();
        for (let i = 0; i < im.count; i++) im.setColorAt(i, c.set(clothing[Math.floor(rnd() * clothing.length)]).multiplyScalar(0.8 + rnd() * 0.5));
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        (im as unknown as { maxCount: number }).maxCount = im.count;
        crowdMeshes.push(im);
      });
      group.add(g);
      probeExcluded.push(g);
    }
    hide('crowd');
  }

  // ---------------------------------------------------------------- Raptor test stand
  let raptorSteam: EnvModelsHandle['raptorSteam'] = null;
  const raptor = models.get('raptor_stand');
  const raptorDecor = decor('raptorStand')[0];
  if (raptor && raptorDecor) {
    const F = decorFrame(raptorDecor);
    const g = instanceModel(raptor, [F], 'RaptorStand', false);
    group.add(g);
    probeExcluded.push(g);
    hide('raptorStand');
    const W = nodeWorld(raptor, 'Flame_Exit', F);
    if (W) {
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
      W.decompose(pos, quat, new THREE.Vector3());
      raptorSteam = { pos, dir: new THREE.Vector3(0, 0, -1).applyQuaternion(quat).setY(0).normalize() };
    }
  }

  // 0-60 gate: the gate60.glb portal is closed at the back (the car started in front of it and
  // drove away). In the stream the car drives through the opening, so the open procedural housing
  // of track.ts stays.

  // ---------------------------------------------------------------- LED posts along the strips
  const fixture = models.get('led_fixture');
  if (fixture) {
    const mats: THREE.Matrix4[] = [];
    for (const d of decor('ledStrip')) {
      const F = decorFrame(d), L = d.length ?? 10;
      for (let z = 0; z <= L; z += 20) mats.push(F.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, z)));
    }
    group.add(instanceModel(fixture, mats, 'LedPosts', false));
    hide('ledPost');
  }

  // ---------------------------------------------------------------- wall-ramp truss tower (2.5 m modules)
  const truss = models.get('ramp_truss');
  const wall = TRACK.ramps.find((r) => r.kind === 'wallRamp');
  const S = wall ? track.rampSamples.get(wall.id) : undefined;
  if (truss && wall && S) {
    const mod = 2.5, t = wall.thickness;
    const first = S.filter((s) => s.thetaRad <= Math.PI / 2 + 1e-3);
    const zMaxArc = Math.max(...first.map((s) => s.z));
    const topY = S[S.length - 1].y;
    const R = new THREE.Matrix4().makeRotationY(wall.headingDeg * DEG);
    const place = (x: number, y: number, z: number) => {
      const p = rampLocalToWorld(wall, { x, y, z });
      return new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(R);
    };
    const modules: THREE.Matrix4[] = [], caps: THREE.Matrix4[] = [];
    const xs = [-mod, 0, mod];
    // under the concave sweep: stack modules while the module top stays below the ramp back side
    for (let zc = mod / 2 + 0.6; zc + mod / 2 < zMaxArc; zc += mod) {
      const a = backsideAt(first, t, zc - mod / 2), b = backsideAt(first, t, zc + mod / 2);
      if (!a || !b) continue;
      const layers = Math.floor((Math.min(a.y, b.y) - 0.05) / mod);
      for (const x of xs) {
        for (let l = 0; l < layers; l++) modules.push(place(x, l * mod, zc));
        if (layers > 0) caps.push(place(x, layers * mod, zc));
      }
    }
    // tower behind the vertical section and the overhang: one module deep (in the stream the
    // structure behind the ramp is a slim, dark frame that hardly shows against the night)
    const zBack = zMaxArc + t + 0.05;
    const layers = Math.ceil((topY + 1.5) / mod);
    for (let k = 0; k < 1; k++) for (const x of xs) {
      const zc = zBack + mod / 2 + k * mod;
      for (let l = 0; l < layers; l++) modules.push(place(x, l * mod, zc));
      caps.push(place(x, layers * mod, zc));
    }
    // dark, dull steel instead of bright galvanised members (stream: the scaffold stays in the dark)
    const darken = (root: THREE.Object3D) => root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const dk = (m: THREE.Material) => {
        const c = m.clone() as THREE.MeshStandardMaterial;
        if (c.color) c.color.multiplyScalar(0.12);
        if (c.metalness !== undefined) c.metalness = Math.min(c.metalness, 0.45);
        if (c.roughness !== undefined) c.roughness = Math.max(c.roughness, 0.6);
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(dk) : dk(mesh.material);
    });
    darken(truss);
    group.add(instanceModel(truss, modules, 'RampTruss'));
    const cap = models.get('ramp_truss_cap');
    if (cap) { darken(cap); group.add(instanceModel(cap, caps, 'RampTrussCap')); }
    hide('wallScaffold');
  }

  // ---------------------------------------------------------------- crowd fences in front of the stage area
  const fence = models.get('crowd_fence');
  if (fence && stageDecor) {
    const F = decorFrame(stageDecor);
    const mats: THREE.Matrix4[] = [];
    for (let x = -19.5; x <= 19.5; x += 2.35) mats.push(F.clone().multiply(new THREE.Matrix4().makeTranslation(x, 0, 25)));
    group.add(instanceModel(fence, mats, 'CrowdFence'));
  }

  // ---------------------------------------------------------------- prairie vegetation (lit by the floodlight bake)
  const grass = models.get('grass_clump'), shrub = models.get('shrub');
  const nGrass = Math.round(q.particleBudget * 0.8), nShrub = Math.round(nGrass / 9);
  const { min, max } = TRACK.pad;
  const scatter = (n: number, seed: number, minS: number, maxS: number, margin: number, reach: number) => {
    const rnd = mulberry(seed);
    const out: THREE.Matrix4[] = [];
    const q4 = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    let guard = 0;
    while (out.length < n && guard++ < n * 20) {
      const x = min.x - reach + rnd() * (max.x - min.x + 2 * reach), z = min.z - reach + rnd() * (max.z - min.z + 2 * reach);
      const dx = Math.max(min.x - margin - x, 0, x - max.x - margin), dz = Math.max(min.z - margin - z, 0, z - max.z - margin);
      const d = Math.hypot(dx, dz);
      if (d <= 0) continue;
      if (rnd() > Math.exp(-d / (reach * 0.45)) * 0.9 + 0.1) continue; // denser near the pad (cleared verge)
      const s = minS + rnd() * (maxS - minS);
      q4.setFromAxisAngle(up, rnd() * Math.PI * 2);
      out.push(new THREE.Matrix4().compose(new THREE.Vector3(x, -0.04, z), q4, new THREE.Vector3(s, s * (0.85 + rnd() * 0.3), s)));
    }
    return out;
  };
  const lm = track.lightmap;
  const litByBake = (root: THREE.Object3D) => root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    const m = new THREE.MeshStandardNodeMaterial({ map: src.map, alphaTest: Math.max(0.35, src.alphaTest), side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
    m.name = src.name;
    const luv = positionWorld.xz.sub(vec2(lm.min.x, lm.min.z)).div(vec2(lm.max.x - lm.min.x, lm.max.z - lm.min.z));
    const e = texture(lm.tex, luv).r;
    const albedo = src.map ? texture(src.map).rgb : float(0.4);
    // same (indirect-only) share of the bake as the ground, otherwise the prairie glows grey
    m.emissiveNode = (albedo as unknown as { mul(x: unknown): unknown }).mul(e.mul(e).mul(lm.maxLux / Math.PI).mul(LIGHTMAP_WEIGHT)) as never;
    mesh.material = m;
  });
  if (grass && nGrass > 0) {
    litByBake(grass);
    const g = instanceModel(grass, scatter(nGrass, 21, 0.75, 1.25, 4, 190), 'Grass', false);
    group.add(g);
    probeExcluded.push(g);
  }
  if (shrub && nShrub > 0) {
    litByBake(shrub);
    const g = instanceModel(shrub, scatter(nShrub, 37, 0.7, 1.3, 10, 260), 'Shrubs', false);
    group.add(g);
    probeExcluded.push(g);
  }

  // LED posts and bars, tower lamp lenses, site/aviation lights: at least 2 px wide (no TRAA blinking
  // from the long-lens cameras, see materials.ts)
  pixelFloor(group, (m) => /^(LED_|Lamp_Emissive|Site_Lights|Aviation)/.test(m.name));

  void uniform; void TOWER_HEAD_LOCAL;
  return {
    loaded,
    group,
    raptorSteam,
    probeExcluded,
    towerLamps,
    colliders,
    update(t: number) { for (const u of updaters) u(t); },
    setCrowdFraction(f: number) {
      for (const im of crowdMeshes) im.count = Math.round((im as unknown as { maxCount: number }).maxCount * Math.min(1, Math.max(0, f)));
    },
  };
}

/** One stage moving head: hold-and-move cues, independent pan/tilt, dimmer fades. */
class MovingHead {
  private from = new THREE.Vector2();
  private to = new THREE.Vector2();
  private moveT = 1;
  private moveDur = 1;
  private hold: number;
  private on = 1;
  private level = 1;
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  constructor(private mesh: THREE.Mesh, private base: THREE.Quaternion, private gain: UFloat, private group: number, private rnd: () => number) {
    this.hold = 0.5 + rnd() * 3;
    this.to.set((rnd() - 0.5) * 0.7, (rnd() - 0.5) * 0.35);
    this.from.copy(this.to);
  }

  update(t: number, dt: number): void {
    if (dt > 0) {
      if (this.moveT < 1) this.moveT = Math.min(1, this.moveT + dt / this.moveDur);
      else if ((this.hold -= dt) <= 0) {
        // new cue: groups move together but every fixture lags a little and picks its own target
        const r = this.rnd;
        this.from.copy(this.cur());
        this.to.set((r() - 0.5) * 0.9, (r() - 0.5) * 0.45 - this.group * 0.05);
        this.moveT = 0;
        this.moveDur = 0.9 + r() * 2.2;
        this.hold = 1.2 + r() * 4.5 + this.group * 0.4;
        this.on = r() < 0.35 ? 0 : 0.45 + r() * 0.45;
      }
      this.level += (this.on - this.level) * (1 - Math.exp(-dt * 3));
    }
    const p = this.cur();
    // slow breathing of the pan around the target (operator hand, mechanical play)
    const wob = Math.sin(t * (0.23 + this.group * 0.07) + this.group * 2.1) * 0.025;
    this.e.set(p.y, 0, p.x + wob, 'YXZ');
    this.q.setFromEuler(this.e);
    this.mesh.quaternion.multiplyQuaternions(this.q, this.base);
    this.gain.value = this.level;
    this.mesh.visible = this.level > 0.02;
  }

  private cur(): THREE.Vector2 {
    const k = this.moveT * this.moveT * (3 - 2 * this.moveT);
    return new THREE.Vector2().lerpVectors(this.from, this.to, k);
  }
}
