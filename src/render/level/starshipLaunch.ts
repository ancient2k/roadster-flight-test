// Starship launch in the Boca Chica world (docs/EDITOR.md): moves the Super Heavy and Starship nodes of the stack
// landmark along the scripted flight (src/shared/starshipFlight.ts), draws the Raptor plumes, the water deluge and the
// steam/dust cloud of the liftoff, opens and closes the catch arms of both towers, and marks the exclusion zone and a
// viewpoint on the ground. Built only when a launch is armed (no load cost); everything it moved goes back on dispose().
import * as THREE from 'three/webgpu';
import { abs, cameraPosition, dot, float, mix, mx_noise_float, normalView, normalize, positionView, positionLocal, pow, smoothstep, uniform, uv, vec2, vec3, length, sin } from 'three/tsl';
import { ParticleSystem, PKind } from '../fx/particles';
import type { QualityLevel } from '../quality';
import type { UFloat } from '../tslTypes';
import {
  AZIMUTH_DEG, BLAST_RADIUS_M, BOOSTER_CATCH_T, BOOSTER_PIN_Y, SHIP_CATCH_T, SHIP_PIN_Y, armsAt, toWorld,
  type StageState, type V3,
} from '../../shared/starshipFlight';

const STACK = 'starship_stack_lod1', TOWER_A = 'tower_a_lod1', TOWER_B = 'tower_b_lod1';
/** Arm swing when open (rad) and the tower B carriage height for the ship catch (m above the tower base). */
const ARM_OPEN = 0.42, CARRIAGE_B_Y = 56.5;

interface TowerRig { root: THREE.Object3D; carriage: THREE.Object3D; armL: THREE.Object3D; armR: THREE.Object3D; catchPt: THREE.Object3D; carriageY: number; armY: [number, number]; headingDeg: number }
interface Saved { node: THREE.Object3D; parent: THREE.Object3D; pos: THREE.Vector3; quat: THREE.Quaternion }

export interface LaunchFrame { met: number; booster: StageState; ship: StageState & { fromB: boolean } }

const headingOf = (o: THREE.Object3D) => { const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(o.matrixWorld), 'YXZ'); return e.y * 180 / Math.PI; };

function tower(root: THREE.Object3D | undefined): TowerRig | null {
  if (!root) return null;
  const carriage = root.getObjectByName('Carriage'), armL = root.getObjectByName('Arm_L'), armR = root.getObjectByName('Arm_R'), catchPt = root.getObjectByName('CatchPoint');
  if (!carriage || !armL || !armR || !catchPt) return null;
  return { root, carriage, armL, armR, catchPt, carriageY: carriage.position.y, armY: [armL.rotation.y, armR.rotation.y], headingDeg: headingOf(root) };
}

// ------------------------------------------------------------------ plumes
/** Additive plume: hot core at the nozzle (uv.y = 0) fading along the length, soft at the silhouette, flickering. */
function plumeMaterial(gain: UFloat, tint: [number, number, number], diamonds: boolean, t: UFloat): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  m.name = 'RaptorPlume';
  const u = uv().y;
  const facing = abs(dot(normalize(normalView), normalize(positionView).negate()));
  const flick = mx_noise_float(vec3(positionLocal.x.mul(0.8), positionLocal.y.mul(0.35).add(t.mul(9)), positionLocal.z.mul(0.8))).mul(0.35).add(0.85);
  const core = mix(vec3(1.0, 0.95, 0.86), vec3(...tint), smoothstep(float(0.01), float(0.28), u));
  // shock diamonds near the nozzle of the single-engine cones
  const shock = diamonds ? sin(u.mul(46)).mul(0.5).add(0.5).pow(6).mul(smoothstep(float(0.45), float(0.05), u)).mul(0.8).add(1) : float(1);
  const along = pow(float(1).sub(u), float(1.6)).mul(smoothstep(float(0), float(0.03), u).mul(0.6).add(0.4));
  m.colorNode = core.mul(gain).mul(flick).mul(shock).mul(along).mul(pow(facing, float(1.4)));
  return m;
}

/** Lathe from the nozzle (y = 0, radius 1) down to y = −1, widening to `spread`. */
function plumeGeometry(spread: number, seg = 20): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 12; i++) { const s = i / 12; pts.push(new THREE.Vector2(1 + (spread - 1) * Math.sqrt(s), -s)); }
  return new THREE.LatheGeometry(pts, seg);
}

class StagePlume {
  readonly group = new THREE.Group();
  readonly gain: UFloat = uniform(0);
  private big: THREE.Mesh;
  private small: THREE.InstancedMesh | null = null;
  private glow: THREE.Sprite;
  private level = 0;
  constructor(engines: THREE.Vector3[], private baseR: number, private len: number, nozzleR: number, tint: [number, number, number], detailed: boolean, t: UFloat) {
    this.group.name = 'Plume';
    this.big = new THREE.Mesh(plumeGeometry(2.4, detailed ? 28 : 16), plumeMaterial(this.gain, tint, false, t));
    this.big.frustumCulled = false;
    this.group.add(this.big);
    if (detailed && engines.length) {
      const g = plumeGeometry(1.8, 10);
      this.small = new THREE.InstancedMesh(g, plumeMaterial(this.gain, tint, true, t), engines.length);
      const m = new THREE.Matrix4();
      engines.forEach((p, i) => this.small!.setMatrixAt(i, m.compose(p, new THREE.Quaternion(), new THREE.Vector3(nozzleR, 10, nozzleR))));
      this.small.frustumCulled = false;
      this.group.add(this.small);
    }
    const gm = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const r = length(uv().sub(0.5).mul(2));
    gm.colorNode = vec3(1.0, 0.78, 0.5).mul(this.gain).mul(smoothstep(float(1), float(0), r).pow(3)).mul(0.6);
    this.glow = new THREE.Sprite(gm);
    this.glow.frustumCulled = false;
    this.group.add(this.glow);
  }
  /** engines: number burning (the inner ones first); h: altitude (the plume balloons as the air thins); distM: from the camera. */
  update(engines: number, total: number, h: number, distM: number, dt: number): void {
    const on = engines > 0 ? 1 : 0;
    this.level += (on - this.level) * Math.min(1, dt * (on ? 6 : 3));
    const frac = total ? Math.sqrt(engines / total) : 1;
    // thinner air: the plume balloons into a wide, faint glow (the same light spread over a larger body)
    const hk = Math.max(0, h) / 1000;
    this.gain.value = this.level * 14 / (1 + hk / 6);
    this.group.visible = this.level > 0.01;
    const widen = 1 + 0.08 * hk ** 1.25, lengthen = 1 + 0.04 * hk;
    const r = this.baseR * Math.max(0.35, frac) * widen;
    this.big.scale.set(r, this.len * Math.max(0.5, frac) * lengthen * (0.6 + 0.4 * this.level), r);
    if (this.small) { this.small.count = engines; this.small.visible = engines > 0 && distM < 4000; }
    // a few pixels at least: the plume stays a bright point at 100 km (scale undoes the far clamp of the group)
    const px = Math.max(r * 3, distM * 0.007);
    this.glow.scale.setScalar(px * Math.max(0.2, this.level));
    this.glow.position.y = -r * 0.5;
  }
  dispose(): void {
    // (sprites share one quad geometry across the whole scene: only their materials go)
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry && !(o as THREE.Sprite).isSprite) m.geometry.dispose(); (m.material as THREE.Material | undefined)?.dispose(); });
    this.small?.dispose();
  }
}

// ------------------------------------------------------------------ ground marks
/**
 * Glowing curtain on the ground along a circle (follows the terrain). fadeNear > 0: fades out when the camera comes
 * closer to the centre than fadeNear·r (a marker for orientation from afar; up close its dashes would litter the view).
 */
function ringCurtain(cx: number, cz: number, r: number, height: number, color: THREE.ColorRepresentation, heightAt: (x: number, z: number) => number, gainV = 3, fadeNear = 0): THREE.Mesh {
  const n = Math.max(48, Math.round(r * 0.6));
  const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const g = heightAt(x, z);
    const y = Number.isFinite(g) ? g : 0;
    pos.push(x, y - 0.3, z, x, y + height, z);
    uvs.push(i / n, 0, i / n, 1);
    if (i < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  const c = new THREE.Color(color);
  // dashes along the ring, bright at the foot, fading upwards
  const dash = smoothstep(float(0.35), float(0.5), sin(uv().x.mul(n * 0.5 * Math.PI * 2 / 8)).mul(0.5).add(0.5)).mul(0.6).add(0.4);
  const glow = vec3(c.r, c.g, c.b).mul(gainV).mul(pow(float(1).sub(uv().y), float(1.8))).mul(dash);
  m.colorNode = fadeNear > 0 ? glow.mul(smoothstep(float(fadeNear * r), float(fadeNear * r * 2), length(cameraPosition.xz.sub(vec2(cx, cz))))) : glow;
  const mesh = new THREE.Mesh(geo, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return mesh;
}

// ------------------------------------------------------------------ the launch
export class StarshipLaunchVisuals {
  readonly root = new THREE.Group();
  /** Stack base on mount A, catch bases (hull base when caught) at tower A and B (world). */
  readonly padA: V3; readonly catchA: V3; catchB: V3;
  readonly headingA: number; readonly headingB: number;
  /** Current world positions of the stages (unclamped), for the HUD. */
  readonly boosterPos = new THREE.Vector3(); readonly shipPos = new THREE.Vector3();
  readonly viewpoint: V3;
  private booster: THREE.Group; private ship: THREE.Group;
  private saved: Saved[] = [];
  private towerA: TowerRig; private towerB: TowerRig;
  private boosterPlume: StagePlume; private shipPlume: StagePlume;
  private steam: ParticleSystem;
  private zone: THREE.Mesh; private view: THREE.Mesh;
  private uT: UFloat = uniform(0);
  private time = 0;
  private emitAcc = 0;
  private detailed: boolean;
  private stackCollider = true;

  private constructor(private world: THREE.Object3D, stack: THREE.Object3D, a: TowerRig, b: TowerRig, private heightAt: (x: number, z: number) => number, quality: QualityLevel, webgl: boolean, viewpoint: V3, sunIntensity: number) {
    this.root.name = 'StarshipLaunch';
    this.towerA = a; this.towerB = b;
    this.headingA = a.headingDeg; this.headingB = b.headingDeg;
    this.detailed = !webgl && quality !== 'low';
    this.viewpoint = viewpoint;
    stack.updateWorldMatrix(true, true);
    const sp = new THREE.Vector3().setFromMatrixPosition(stack.matrixWorld);
    this.padA = { x: sp.x, y: sp.y, z: sp.z };
    // the stages leave the stack landmark for holders in world space (base point = hull bottom, +Y = nose)
    const sh = stack.getObjectByName('SuperHeavy')!, ss = stack.getObjectByName('Starship')!;
    this.booster = this.holder(sh, 'Booster'); this.ship = this.holder(ss, 'Ship');
    const eng = (holder: THREE.Object3D, re: RegExp) => {
      const out: THREE.Vector3[] = [];
      holder.traverse((o) => { if (re.test(o.name)) out.push(o.position.clone().setY(0)); });
      return out.sort((p, q) => p.length() - q.length());   // inner engines first (13 = inner ring, 3 = centre)
    };
    this.boosterPlume = new StagePlume(eng(sh, /^Engine_\d+$/), 4.6, 95, 0.5, [1.0, 0.5, 0.16], this.detailed, this.uT);
    const shipEng = [...eng(ss, /^Engine_SL_\d$/), ...eng(ss, /^Engine_RVac_\d$/)];
    this.shipPlume = new StagePlume(shipEng, 2.6, 40, 0.7, [1.0, 0.55, 0.2], this.detailed, this.uT);
    this.booster.add(this.boosterPlume.group); this.ship.add(this.shipPlume.group);
    // tower B lowers its carriage for the ship (hull base a few metres above mount B)
    b.carriage.position.y = CARRIAGE_B_Y;
    this.setArms(a, 1); this.setArms(b, 1);
    world.updateWorldMatrix(true, true);
    this.catchA = this.catchBase(a, BOOSTER_PIN_Y);
    this.catchB = this.catchBase(b, SHIP_PIN_Y);
    const cap = webgl || quality === 'low' ? 900 : quality === 'medium' ? 1800 : 3000;
    this.steam = new ParticleSystem(cap, false);
    this.steam.flatGround.value = 0;
    this.steam.dustTint.value.set(0.86, 0.85, 0.83);
    // white steam in daylight: the sun and the sky through many scatterings (three.js Lambert: E·cos/π ≈ 0.24·E here)
    this.steam.fill.value.set(0.4, 0.41, 0.43).multiplyScalar(sunIntensity);
    this.steam.sprite.name = 'LaunchCloud';
    this.zone = ringCurtain(this.padA.x, this.padA.z, BLAST_RADIUS_M, 4, 0xff1208, heightAt, 4);
    this.zone.name = 'ExclusionZone';
    this.view = ringCurtain(viewpoint.x, viewpoint.z, 14, 5, 0x30ff70, heightAt, 3, 3);
    this.view.name = 'Viewpoint';
    this.root.add(this.booster, this.ship, this.steam.sprite, this.zone, this.view);
    world.add(this.root);
  }

  /** The launch rig of a loaded Boca Chica world, or null when its stack or towers are missing. */
  static create(world: THREE.Object3D, heightAt: (x: number, z: number) => number, quality: QualityLevel, webgl: boolean, viewpoint: V3, sunIntensity = 4.4): StarshipLaunchVisuals | null {
    const stack = world.getObjectByName(STACK);
    const a = tower(world.getObjectByName(TOWER_A)), b = tower(world.getObjectByName(TOWER_B));
    if (!stack || !a || !b || !stack.getObjectByName('SuperHeavy') || !stack.getObjectByName('Starship')) return null;
    return new StarshipLaunchVisuals(world, stack, a, b, heightAt, quality, webgl, viewpoint, sunIntensity);
  }

  private holder(node: THREE.Object3D, name: string): THREE.Group {
    this.saved.push({ node, parent: node.parent!, pos: node.position.clone(), quat: node.quaternion.clone() });
    const g = new THREE.Group();
    g.name = name;
    node.removeFromParent();
    node.position.set(0, 0, 0); node.quaternion.identity();
    g.add(node);
    return g;
  }

  private setArms(t: TowerRig, open: number): void {
    // (the GLB pose holds a 9 m hull between the arms; Arm_L swings towards −Z, Arm_R towards +Z)
    t.armL.rotation.y = t.armY[0] + ARM_OPEN * open; t.armR.rotation.y = t.armY[1] - ARM_OPEN * open;
  }

  private catchBase(t: TowerRig, pinY: number): V3 {
    t.catchPt.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(t.catchPt.matrixWorld);
    return { x: p.x, y: p.y - pinY, z: p.z };
  }

  /** Whether the stack's box collider should still stand on the mount (false from liftoff until the booster is back). */
  get stackSolid(): boolean { return this.stackCollider; }

  private place(g: THREE.Group, out: THREE.Vector3, origin: V3, s: StageState, headingDeg: number, cam: THREE.Vector3, far: number): number {
    const p = toWorld(origin, s.d, s.h);
    out.set(p.x, p.y, p.z);
    const az = AZIMUTH_DEG * Math.PI / 180;
    const k = new THREE.Vector3(-Math.cos(az), 0, -Math.sin(az));
    const qTilt = new THREE.Quaternion().setFromAxisAngle(k, s.tilt * Math.PI / 180);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), headingDeg * Math.PI / 180);
    g.quaternion.copy(qTilt).multiply(qYaw);
    // beyond the far plane: pulled in along the view ray and shrunk by the same factor (same angular size)
    const dist = out.distanceTo(cam), lim = far * 0.85;
    const sc = dist > lim ? lim / dist : 1;
    g.position.copy(cam).addScaledVector(out.clone().sub(cam), sc);
    g.scale.setScalar(sc);
    g.visible = !s.hidden;
    return dist;
  }

  /** Per frame: stage poses, plumes, arms, cloud. dt in game seconds (0 when paused). */
  update(f: LaunchFrame, camera: THREE.PerspectiveCamera, dt: number): void {
    this.time += dt;
    this.uT.value = this.time;
    this.steam.setTime(this.time);
    const cam = camera.position, far = camera.far;
    const { met, booster: b, ship: s } = f;
    // arms: open for the flight, closing on the pins at the catch; the carriage gives under the load
    const ca = armsAt(met, BOOSTER_CATCH_T), cb = armsAt(met, SHIP_CATCH_T);
    this.setArms(this.towerA, met < 0 ? 1 : ca.open); this.setArms(this.towerB, cb.open);
    this.towerA.carriage.position.y = this.towerA.carriageY + ca.dy;
    this.towerB.carriage.position.y = CARRIAGE_B_Y + cb.dy;
    const ascent = met < 164;
    const bo = ascent ? this.padA : { ...this.catchA, y: this.catchA.y + (b.caught ? ca.dy : 0) };
    const db = this.place(this.booster, this.boosterPos, bo, b, this.headingA, cam, far);
    const so = s.fromB ? { ...this.catchB, y: this.catchB.y + (s.caught ? cb.dy : 0) } : this.padA;
    const ds = this.place(this.ship, this.shipPos, so, s, s.fromB ? this.headingB : this.headingA, cam, far);
    this.boosterPlume.update(b.engines, 33, b.h, db, dt);
    this.shipPlume.update(s.engines, 6, s.h, ds, dt);
    this.stackCollider = met < 2 || b.caught;
    this.zone.visible = met < 30;
    this.view.visible = met < BOOSTER_CATCH_T + 20;
    if (dt > 0) this.emit(met, b, dt);
    this.steam.flush();
  }

  private emit(met: number, b: StageState, dt: number): void {
    const ps = this.steam, P = this.padA;
    const gy = this.heightAt(P.x, P.z);
    const g = Number.isFinite(gy) ? gy : 0;
    const rate = (this.steam.capacity / 3000);
    const r = Math.random;
    let n = 0;
    // water deluge: spray from the mount plate, upwards and out
    if (met > -10 && met < 14) {
      n = 60 * rate * dt;
      for (this.emitAcc += n; this.emitAcc >= 1; this.emitAcc--) {
        const a = r() * Math.PI * 2, rr = 6 + r() * 4;
        ps.emit({ kind: PKind.Dust, pos: { x: P.x + Math.cos(a) * rr, y: P.y - 1, z: P.z + Math.sin(a) * rr }, vel: { x: Math.cos(a) * (6 + r() * 10), y: 8 + r() * 22, z: Math.sin(a) * (6 + r() * 10) },
          life: 2.5 + r() * 2.5, size0: 1.5, size1: 9 + r() * 6, drag: 0.6, buoyancy: -4, opacity: 0.55 });
      }
    }
    // ignition and liftoff: the exhaust hits the deluge and the ground and rolls out as a cloud of steam and sand
    const low = met > -3 && b.h < 900 && !b.caught && met < 60;
    if (low) {
      const k = Math.max(0, 1 - b.h / 900) * (met < 0 ? 0.35 + 0.65 * (met + 3) / 3 : 1);
      n = 70 * rate * k * dt;
      for (this.emitAcc += n; this.emitAcc >= 1; this.emitAcc--) {
        const a = r() * Math.PI * 2, sp = 35 + r() * 55;
        const up = r() < 0.3;
        ps.emit({ kind: PKind.Dust, pos: { x: P.x + Math.cos(a) * 8, y: g + 4 + r() * 6, z: P.z + Math.sin(a) * 8 },
          vel: { x: Math.cos(a) * sp, y: up ? 10 + r() * 25 : 2 + r() * 6, z: Math.sin(a) * sp },
          life: 35 + r() * 40, size0: 14 + r() * 10, size1: 90 + r() * 80, drag: 0.22 + r() * 0.1, buoyancy: 0.15 + r() * 0.3, opacity: 0.7 });
      }
    }
    // the climbing stack leaves a trail of exhaust condensation in the lower air
    if (met > 2 && met < 75 && !b.caught) {
      n = 18 * rate * dt;
      const p = this.boosterPos;
      for (this.emitAcc += n; this.emitAcc >= 1; this.emitAcc--) {
        ps.emit({ kind: PKind.Dust, pos: { x: p.x + (r() - 0.5) * 10, y: p.y - 40 - r() * 60, z: p.z + (r() - 0.5) * 10 }, vel: { x: (r() - 0.5) * 4, y: 0, z: (r() - 0.5) * 4 },
          life: 40 + r() * 30, size0: 20, size1: 120 + r() * 80, drag: 0.4, buoyancy: 0, opacity: 0.35 });
      }
    }
    // landing burns kick up a little steam from the mounts
    const landing = (met > 400 && met < BOOSTER_CATCH_T) || (met > 5905 && met < SHIP_CATCH_T);
    if (landing) {
      const at = met < 1000 ? P : this.catchB;
      n = 25 * rate * dt;
      for (this.emitAcc += n; this.emitAcc >= 1; this.emitAcc--) {
        const a = r() * Math.PI * 2, sp = 10 + r() * 20;
        ps.emit({ kind: PKind.Dust, pos: { x: at.x + Math.cos(a) * 6, y: g + 3, z: at.z + Math.sin(a) * 6 }, vel: { x: Math.cos(a) * sp, y: 3 + r() * 8, z: Math.sin(a) * sp },
          life: 10 + r() * 10, size0: 6, size1: 35, drag: 0.4, buoyancy: 0.3, opacity: 0.6 });
      }
    }
  }

  dispose(): void {
    // the stages back into the stack landmark, arms and carriages as loaded
    for (const s of this.saved) {
      s.node.removeFromParent();
      s.node.position.copy(s.pos); s.node.quaternion.copy(s.quat);
      s.parent.add(s.node);
    }
    this.saved = [];
    for (const t of [this.towerA, this.towerB]) { this.setArms(t, 0); t.carriage.position.y = t.carriageY; }
    this.root.removeFromParent();
    this.boosterPlume.dispose(); this.shipPlume.dispose();
    for (const m of [this.zone, this.view]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    (this.steam.sprite.material as THREE.Material).dispose();
    this.world.updateWorldMatrix(true, true);
  }
}
