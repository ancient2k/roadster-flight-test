// Drives the car model (GLB or the procedural placeholder) from VehicleState.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { bootBytes } from '../../ui/bootProgress';
import { uniform, vec3, color as tslColor } from 'three/tsl';
import type { VehicleState, WheelId } from '../../shared/types';
import { ROADSTER } from '../../shared/roadster';
import { DEG } from '../../shared/math';
import { buildPlaceholderCar } from './placeholderCar';
import { brakeLightOn } from '../fxParams';
import { CarDamageView } from './carDamage';

export interface CarModelInfo { source: 'glb' | 'placeholder'; url: string; missing: string[] }

export class CarRig {
  readonly root = new THREE.Group();
  model: THREE.Object3D | null = null;
  info: CarModelInfo = { source: 'placeholder', url: '', missing: [] };
  private wheels = new Map<WheelId, { node: THREE.Object3D; base: THREE.Vector3; spin: number }>();
  private wing: THREE.Object3D | null = null;
  private wingBase = new THREE.Quaternion();
  readonly uFront = uniform(18);
  readonly uTail = uniform(5);
  readonly uBrake = uniform(0);
  /** Left and right head lamp (body +X = left): one spot per lamp, aimed slightly outwards. */
  private headlights: THREE.SpotLight[];
  private brakeSmoothed = 0;
  /** Dents and torn-off parts (vehicle damage setting "Realistic"). */
  readonly damage = new CarDamageView();

  constructor() {
    this.root.name = 'Car';
    // (was one spot on the centre line: a single cone in the middle of the road)
    this.headlights = [1, -1].map((side) => {
      const l = new THREE.SpotLight(0xf2f5ff, 450, 120, 24 * DEG, 0.7, 1.6);
      l.name = side > 0 ? 'HeadlightL' : 'HeadlightR';
      this.root.add(l, l.target);
      return l;
    });
    this.placeHeadlights(0.72, 0.0, 2.2);
  }

  /** Spots at the lamps (|x|, y, z in the car frame), each aimed straight ahead and a little outwards. */
  private placeHeadlights(x: number, y: number, z: number): void {
    this.headlights.forEach((l, i) => {
      const side = i === 0 ? 1 : -1;
      l.position.set(side * x, y, z);
      l.target.position.set(side * (x + 0.9), y - 0.6, z + 12);
    });
  }

  async load(url: string): Promise<CarModelInfo> {
    // GameRenderer.setup() already loaded it and compiled its pipelines; App.init asks again
    if (this.info?.source === 'glb' && this.info.url === url) return this.info;
    let obj: THREE.Object3D | null = null;
    try {
      const head = await fetch(url, { method: 'HEAD' });
      const type = head.headers.get('content-type') ?? '';
      if (head.ok && !type.includes('text/html')) {
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        const gltf = await loader.loadAsync(url, bootBytes(url));
        obj = gltf.scene;
        this.info = { source: 'glb', url, missing: [] };
      }
    } catch (e) {
      console.warn('[render] Auto-GLB konnte nicht geladen werden, nutze Platzhalter:', e);
    }
    if (!obj) {
      obj = buildPlaceholderCar();
      this.info = { source: 'placeholder', url, missing: [] };
    }
    this.attach(obj);
    return this.info;
  }

  private attach(obj: THREE.Object3D): void {
    if (this.model) this.root.remove(this.model);
    this.model = obj;
    this.root.add(obj);
    this.wheels.clear();
    const missing: string[] = [];
    for (const w of ROADSTER.wheels) {
      const node = obj.getObjectByName(`Wheel_${w.id}`);
      if (!node) { missing.push(`Wheel_${w.id}`); continue; }
      this.wheels.set(w.id, { node, base: node.position.clone(), spin: 0 });
    }
    this.wing = obj.getObjectByName('Wing') ?? null;
    if (!this.wing) missing.push('Wing');
    else this.wingBase.copy(this.wing.quaternion);
    // emissive LED materials (by name). Light_* nodes of the GLB contract are accepted as well.
    const seen = new Set<string>();
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) { replaceTransmission(m); tuneCarMaterial(m); }
      const out = mats.map((m) => {
        const key = ledKey(m.name) ?? ledKey(o.name) ?? ledKey(o.parent?.name ?? '');
        if (!key) return m;
        seen.add(key);
        // the plate lamps share the head lamps' LED_Front material: lit like head lamps (18) they were two
        // blinking white dots on the tail; they only light the plate
        return this.ledMaterial(key === 'LED_Front' && /light_plate/i.test(`${o.name} ${o.parent?.name ?? ''}`) ? 'LED_Plate' : key, m);
      });
      mesh.material = Array.isArray(mesh.material) ? out : out[0];
      widenThinLamp(mesh);
    });
    // the spots sit at the head lamps of this model: the centroids of the LED_Front vertices on the left and the right
    // of the nose (one mirrored mesh spans both lamps; the plate lamps at the tail share the material)
    const acc = [{ x: 0, y: 0, z: 0, n: 0 }, { x: 0, y: 0, z: 0, n: 0 }], v = new THREE.Vector3();
    this.root.updateMatrixWorld(true);
    const toRoot = this.root.matrixWorld.clone().invert();
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((m) => m.name === 'LED_Front')) return;
      const pos = mesh.geometry.getAttribute('position');
      const m = toRoot.clone().multiply(mesh.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        if (v.z <= 0 || Math.abs(v.x) < 0.2) continue;
        const a = acc[v.x > 0 ? 0 : 1];
        a.x += Math.abs(v.x); a.y += v.y; a.z += v.z; a.n++;
      }
    });
    if (acc[0].n && acc[1].n) {
      const n = acc[0].n + acc[1].n;
      this.placeHeadlights((acc[0].x + acc[1].x) / n, (acc[0].y + acc[1].y) / n, (acc[0].z + acc[1].z) / n);
    }
    for (const k of ['LED_Front', 'LED_Tail', 'LED_Brake']) if (!seen.has(k)) missing.push(k);
    this.info.missing = missing;
    if (missing.length) console.warn('[render] Auto-Modell: fehlende Nodes/Materialien:', missing.join(', '));
    this.damage.attach(obj);
  }

  private ledMaterial(key: string, src: THREE.Material): THREE.Material {
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = key;
    // the mirrored half of the head lamps is exported with flipped winding; LEDs are thin emitters, so both sides render
    m.side = THREE.DoubleSide;
    const base = (src as THREE.MeshBasicMaterial).color?.clone() ?? new THREE.Color(1, 1, 1);
    const tint = key === 'LED_Front' || key === 'LED_Plate' ? new THREE.Color(1, 1, 1) : new THREE.Color(1, 0.04, 0.02);
    void base;
    const u = key === 'LED_Front' ? this.uFront : key === 'LED_Plate' ? PLATE_LAMP : key === 'LED_Tail' ? this.uTail : this.uBrake;
    m.colorNode = tslColor(tint).mul(u).add(vec3(0.015, 0.005, 0.005));
    return m;
  }

  update(s: VehicleState, dt: number): void {
    this.root.position.set(s.pos.x, s.pos.y, s.pos.z);
    this.root.quaternion.set(s.quat.x, s.quat.y, s.quat.z, s.quat.w);
    for (const ws of s.wheels) {
      const w = this.wheels.get(ws.id);
      if (!w) continue;
      const spec = ROADSTER.wheels.find((x) => x.id === ws.id)!;
      w.spin = (w.spin + ws.angularVel * dt) % (Math.PI * 2);
      w.node.position.set(w.base.x, spec.pos.y + (ws.compression - ROADSTER.suspension.restCompressionM) + (w.base.y - spec.pos.y), w.base.z);
      // steer about body +Y (positive = towards +X = left), then roll about the axle (+X)
      w.node.rotation.set(w.spin, ws.steerRad, 0, 'YXZ');
    }
    if (this.wing) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), s.aero.wingAngleDeg * DEG);
      this.wing.quaternion.copy(this.wingBase).multiply(q);
    }
    // contract flag (brakeInput 0..1); the old deceleration heuristic stays as fallback
    const braking = typeof s.brakeInput === 'number' ? Math.min(1, s.brakeInput * 1.5) : (brakeLightOn(s.specificForce.z, s.groundContact, s.speedMs) ? 1 : 0);
    this.brakeSmoothed += (braking - this.brakeSmoothed) * Math.min(1, dt * 25);
    this.uBrake.value = 0.4 + this.brakeSmoothed * 22;
    this.damage.update(s.damage, this.root, dt);
  }

  get headlightLights(): readonly THREE.SpotLight[] { return this.headlights; }

  /**
   * Heat glow of the body paint (re-entry / Sun scene): emissive colour (linear RGB, e.g. from
   * blackbodyRGB) times intensity in scene units; 0 switches it off. Only paint materials glow.
   */
  setHeatGlow(color: THREE.ColorRepresentation, intensity: number): void {
    this.model?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const sm = m as THREE.MeshStandardMaterial;
        if (!sm.isMeshStandardMaterial || !/paint|lack|body/i.test(m.name)) continue;
        sm.emissive.set(color);
        sm.emissiveIntensity = intensity;
      }
    });
  }

  /** Use a dynamic reflection probe (cube map of the surroundings) for every car material. */
  setEnvMap(tex: THREE.Texture | null, intensity = 1): void {
    this.model?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const sm = m as THREE.MeshStandardMaterial;
        if (!('envMap' in sm) || (m as THREE.MeshBasicMaterial).isMeshBasicMaterial) continue;
        sm.envMap = tex;
        sm.envMapIntensity = intensity;
        sm.needsUpdate = true;
      }
    });
  }
}

/**
 * Physically sensible responses for car materials by name (GLBs and props): white paint
 * with clear coat and no metal, dark dielectric glass, matte rubber.
 */
export function tuneCarMaterial(m: THREE.Material): void {
  const pm = m as THREE.MeshPhysicalMaterial;
  if (!(pm as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
  const n = m.name.toLowerCase();
  if (/paint|lack|body/.test(n)) {
    // solid white (roadster) is a pure dielectric under the clear coat; flake paints (metallic blue,
    // multicoat red) keep part of their metalness and the brushed stainless Cybertruck stays metal
    if (pm.metalness >= 0.9) {
      pm.roughness = THREE.MathUtils.clamp(pm.roughness, 0.28, 0.42);
      if (pm.isMeshPhysicalMaterial) pm.clearcoat = 0;
    } else {
      pm.metalness = Math.min(pm.metalness, 0.45);
      pm.roughness = THREE.MathUtils.clamp(pm.roughness, 0.22, 0.32);
      if (pm.isMeshPhysicalMaterial) { pm.clearcoat = 1; pm.clearcoatRoughness = 0.06; }
    }
  } else if (/glass|glas|window/.test(n)) {
    pm.metalness = 0;
    pm.roughness = 0.05;
    if (pm.isMeshPhysicalMaterial) pm.ior = 1.5;
  } else if (/tire|tyre|reifen|rubber/.test(n)) {
    pm.metalness = 0;
    pm.roughness = THREE.MathUtils.clamp(pm.roughness, 0.7, 0.9);
  }
  pm.needsUpdate = true;
}

/**
 * Paint must have a clear coat (sharp reflections over the softer base): Standard paint materials of
 * the GLBs are upgraded to a physical copy. Returns the material to use (the input if unchanged).
 */
export function upgradePaint(m: THREE.Material): THREE.Material {
  const sm = m as THREE.MeshStandardMaterial;
  if (!sm.isMeshStandardMaterial || (m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial || !/paint|lack/i.test(m.name)) return m;
  if (sm.metalness >= 0.9) return m; // bare stainless needs no clear coat
  const p = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(p, sm);
  p.clearcoat = 1;
  p.clearcoatRoughness = 0.08;
  return p;
}

/**
 * Transmission needs a copy of the opaque framebuffer per render (ViewportTextureNode); that copy is
 * re-created whenever the target size changes (probe faces vs. screen) and costs a full-screen copy.
 * Tinted alpha glass is close enough for car glazing. Used for every loaded GLB.
 */
export function replaceTransmission(m: THREE.Material): void {
  const pm = m as THREE.MeshPhysicalMaterial;
  if (pm.transmission > 0) {
    pm.transmission = 0;
    pm.transparent = true;
    pm.opacity = Math.min(pm.opacity, 0.86);
    pm.depthWrite = true;
    pm.needsUpdate = true;
  }
}

/**
 * Minimum lit height (m) of the thin rear lamps. In the model the tail-light bar is 2.3 cm tall, the brake
 * bar above it 8 mm and the plate lamps 9 mm: from the chase camera 1–2 px or less, so TRAA could not hold
 * them and the bright HDR lines broke into flickering dashes while driving. Widened along the body's up
 * axis (tail bar downwards over the black trim, brake bar upwards, plate lamps about their centre).
 */
/** Plate lamp intensity (a soft glow at the plate, not a head lamp). */
const PLATE_LAMP = uniform(1.5);

const LAMP_MIN_HEIGHT: Record<string, { h: number; anchor: 'top' | 'bottom' | 'centre' }> = {
  light_tail: { h: 0.04, anchor: 'top' },
  light_brake: { h: 0.016, anchor: 'bottom' },
  light_plate: { h: 0.018, anchor: 'centre' },
};

function widenThinLamp(mesh: THREE.Mesh): void {
  const name = `${mesh.name} ${mesh.parent?.name ?? ''}`.toLowerCase();
  const spec = Object.entries(LAMP_MIN_HEIGHT).find(([k]) => name.includes(k))?.[1];
  if (!spec || !mesh.geometry.attributes.position) return;
  const g = mesh.geometry.clone();
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  // positions may be quantised (meshopt): attribute units × node scale = metres
  const h = (bb.max.y - bb.min.y) * Math.abs(mesh.scale.y);
  if (!(h > 0) || h >= spec.h) return;
  const pivot = spec.anchor === 'top' ? bb.max.y : spec.anchor === 'bottom' ? bb.min.y : (bb.min.y + bb.max.y) / 2;
  const k = spec.h / h, pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, pivot + (pos.getY(i) - pivot) * k);
  pos.needsUpdate = true;
  g.computeBoundingBox(); g.computeBoundingSphere();
  mesh.geometry = g;
}

function ledKey(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes('led_front') || n.includes('light_head')) return 'LED_Front';
  if (n.includes('led_brake') || n.includes('light_brake')) return 'LED_Brake';
  if (n.includes('led_tail') || n.includes('light_tail')) return 'LED_Tail';
  return null;
}
