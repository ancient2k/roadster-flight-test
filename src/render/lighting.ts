// Floodlight rig with a fixed budget of real spotlights ("slots"). Light candidates are the tower
// heads (aimed like their lamp fan) and the ground-level batteries/washes of the stunt sites.
// When the car moves to another stunt site, the slots are re-assigned to the candidates that light
// that site best (first slots cast shadows). The light count never changes -> no shader recompiles,
// and every fragment only evaluates a handful of lights. The rest of the venue is carried by the
// baked floodlight lightmap.
import * as THREE from 'three/webgpu';
import { nearestSite } from './cameraMath';
import type { StuntId } from '../shared/types';
import { DEG } from '../shared/math';
import { updateGateFx } from './world/gateFx';

/** Scene units per candela (photometric -> scene). Lights are specified in physical cd. */
export const PHOTOMETRIC = 0.05;
/**
 * One tower head: 16 narrow LED floods. The stream's towers stand far from the stunts and throw
 * tight pools (no even wash): ~90 kcd on axis for the head, beam half-angle ≤ 26°.
 */
export const TOWER_CD = 90_000;
export const TOWER_MAX_HALF_ANGLE = 26;

export interface TowerLight { pos: THREE.Vector3; dir: THREE.Vector3; halfAngleDeg: number; cone?: THREE.Object3D | null }
export interface LightCandidate {
  pos: THREE.Vector3; dir: THREE.Vector3; halfAngleDeg: number; cd: number;
  /** Stunt sites for which this fixture is a key light (always gets a slot there). */
  keyFor?: (StuntId | 'overview')[];
}

/** Where each stunt happens (light focus). */
export const SITE_FOCUS: Record<StuntId | 'overview', THREE.Vector3> = {
  ramp_hang: new THREE.Vector3(60, 9, 58),
  ramp_launch: new THREE.Vector3(60, 9, 58),
  kickflip: new THREE.Vector3(-45, 4, -24),
  zero60: new THREE.Vector3(0, 1, -108),
  ground_flip: new THREE.Vector3(20, 3, 40),
  overview: new THREE.Vector3(0, 0, -20),
};

export interface FloodRigOptions { shadows: boolean; shadowSlots: number; slots: number; mapSizeA: number; mapSizeB: number }

/** Illuminance-like ranking of a candidate at a point (cone falloff · cd / d²). */
export function candidateScore(c: LightCandidate, p: THREE.Vector3): number {
  const d = p.clone().sub(c.pos);
  const dist = Math.max(1, d.length());
  const cos = d.normalize().dot(c.dir);
  const inCone = THREE.MathUtils.smoothstep(cos, Math.cos(c.halfAngleDeg * DEG), Math.cos(c.halfAngleDeg * 0.5 * DEG));
  return (c.cd * (inCone + 0.02)) / (dist * dist);
}

export class FloodRig {
  readonly group = new THREE.Group();
  readonly slots: THREE.SpotLight[] = [];
  readonly candidates: LightCandidate[];
  private site: StuntId | 'overview' | null = null;
  private shadowSlots: number;

  constructor(towers: TowerLight[], extra: LightCandidate[], opts: FloodRigOptions) {
    this.group.name = 'FloodRig';
    this.shadowSlots = opts.shadows ? opts.shadowSlots : 0;
    this.candidates = [
      ...towers.map((t) => ({ pos: t.pos, dir: t.dir, halfAngleDeg: t.halfAngleDeg, cd: TOWER_CD })),
      ...extra,
    ];
    // align the volumetric cones of the towers with their beams
    for (const t of towers) if (t.cone) {
      const len = t.cone.scale.y;
      t.cone.position.copy(t.pos);
      t.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), t.dir);
      const rad = len * Math.tan(t.halfAngleDeg * 0.75 * DEG);
      t.cone.scale.set(rad, len, rad);
    }
    for (let i = 0; i < opts.slots; i++) {
      const s = new THREE.SpotLight(0xeef2ff, 0, 0, 30 * DEG, 0.5, 2);
      s.name = `FloodSlot${i}`;
      if (i < opts.shadowSlots) {
        s.castShadow = opts.shadows;
        const size = i === 0 ? opts.mapSizeA : opts.mapSizeB;
        s.shadow.mapSize.set(size, size);
        s.shadow.bias = -0.0001;
        s.shadow.normalBias = 0.012;
      }
      this.slots.push(s);
      this.group.add(s, s.target);
    }
  }

  /** Re-assign the slots when the car arrives at another stunt site. */
  update(carPos: THREE.Vector3, force = false): void {
    // the 0-60 gate nozzles open with the launch (world/gateFx.ts); the rig is the per-frame hook that
    // sees the car on the McGregor pad
    updateGateFx(carPos);
    const site = nearestSite(carPos);
    if (site === this.site && !force) return;
    this.site = site;
    const focus = SITE_FOCUS[site];
    const ranked = this.candidates.map((c) => ({ c, e: candidateScore(c, focus) })).sort((a, b) => b.e - a.e).map((r) => r.c);
    // the site's key fixtures (up-tilted stunt floods aimed at the flight path) always get a slot,
    // right after the shadow slots (their light goes past the car into the sky, not onto the pad)
    const keys = this.candidates.filter((c) => c.keyFor?.includes(site)).slice(0, Math.max(0, this.slots.length - this.shadowSlots));
    const order = ranked.filter((c) => !keys.includes(c)).slice(0, this.slots.length - keys.length);
    order.splice(Math.min(this.shadowSlots, order.length), 0, ...keys);
    this.slots.forEach((s, i) => {
      const c = order[i];
      if (!c) { s.intensity = 0; return; }
      s.position.copy(c.pos);
      s.target.position.copy(c.pos).addScaledVector(c.dir, 60);
      s.angle = c.halfAngleDeg * DEG;
      s.penumbra = c.keyFor ? 0.55 : 0.45;
      s.intensity = c.cd * PHOTOMETRIC;
      if (s.castShadow) {
        const dist = c.pos.distanceTo(focus);
        s.shadow.camera.near = Math.max(0.5, dist - 70);
        s.shadow.camera.far = dist + 70;
        s.shadow.camera.updateProjectionMatrix();
      }
      s.target.updateMatrixWorld();
    });
  }

  /** Main (shadowed) light for effects that approximate a single light (smoke). */
  get mainLight(): THREE.SpotLight { return this.slots[0]; }
}

/** Tower lights from the `Light_0..15` empties (average position and direction). */
export function towerLightFromEmpties(lamps: { pos: THREE.Vector3; dir: THREE.Vector3 }[], lampHalfAngleDeg = 22): TowerLight {
  const pos = new THREE.Vector3(), dir = new THREE.Vector3();
  for (const l of lamps) { pos.add(l.pos); dir.add(l.dir); }
  pos.divideScalar(lamps.length);
  dir.normalize();
  let spread = 0;
  for (const l of lamps) spread = Math.max(spread, Math.acos(Math.min(1, l.dir.dot(dir))) / DEG);
  // the head's floods overlap into one beam; a tighter cone keeps a pool with dark surroundings
  return { pos, dir, halfAngleDeg: Math.min(TOWER_MAX_HALF_ANGLE, spread * 0.5 + lampHalfAngleDeg * 0.75) };
}
