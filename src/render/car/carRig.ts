// Drives the car model (GLB or the procedural placeholder) from VehicleState.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { uniform, vec3, color as tslColor } from 'three/tsl';
import type { VehicleState, WheelId } from '../../shared/types';
import { ROADSTER } from '../../shared/roadster';
import { DEG } from '../../shared/math';
import { buildPlaceholderCar } from './placeholderCar';
import { brakeLightOn } from '../fxParams';

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
  private headlight: THREE.SpotLight;
  private brakeSmoothed = 0;

  constructor() {
    this.root.name = 'Car';
    this.headlight = new THREE.SpotLight(0xf2f5ff, 600, 120, 28 * DEG, 0.7, 1.6);
    this.headlight.position.set(0, 0.0, 2.2);
    this.headlight.target.position.set(0, -0.6, 14);
    this.root.add(this.headlight, this.headlight.target);
  }

  async load(url: string): Promise<CarModelInfo> {
    let obj: THREE.Object3D | null = null;
    try {
      const head = await fetch(url, { method: 'HEAD' });
      const type = head.headers.get('content-type') ?? '';
      if (head.ok && !type.includes('text/html')) {
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        const gltf = await loader.loadAsync(url);
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
        return this.ledMaterial(key, m);
      });
      mesh.material = Array.isArray(mesh.material) ? out : out[0];
    });
    for (const k of ['LED_Front', 'LED_Tail', 'LED_Brake']) if (!seen.has(k)) missing.push(k);
    this.info.missing = missing;
    if (missing.length) console.warn('[render] Auto-Modell: fehlende Nodes/Materialien:', missing.join(', '));
  }

  private ledMaterial(key: string, src: THREE.Material): THREE.Material {
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = key;
    const base = (src as THREE.MeshBasicMaterial).color?.clone() ?? new THREE.Color(1, 1, 1);
    const tint = key === 'LED_Front' ? new THREE.Color(1, 1, 1) : new THREE.Color(1, 0.04, 0.02);
    void base;
    const u = key === 'LED_Front' ? this.uFront : key === 'LED_Tail' ? this.uTail : this.uBrake;
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
  }

  get headlightLight(): THREE.SpotLight { return this.headlight; }

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

function ledKey(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes('led_front') || n.includes('light_head')) return 'LED_Front';
  if (n.includes('led_brake') || n.includes('light_brake')) return 'LED_Brake';
  if (n.includes('led_tail') || n.includes('light_tail')) return 'LED_Tail';
  return null;
}
