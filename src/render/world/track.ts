// McGregor test pad built from src/shared/track.ts (same source as the physics colliders).
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  uniform, uv, float, vec3, mix, smoothstep, positionWorld, mx_noise_float, normalView, positionView,
  abs, dot, normalize, pow, sin, hash, exp, instanceIndex, floor, fract, clamp, color, positionLocal, normalWorld, sign, attribute,
} from 'three/tsl';
import { TRACK, rampLocalToWorld, type CurvedRamp, type Decor } from '../../shared/track';
import { DEG } from '../../shared/math';
import { TOWER_CD, PHOTOMETRIC } from '../lighting';
import { BeamBatch } from './beams';
import { buildRampGeometry, backsideAt } from './rampMesh';
import { SCENE_TIME, bakeFloodLightmap, bakePadMask, loadTextureSet, type LightMap, makeAsphaltMaterial, makeConcreteMaterial, makePrairieMaterial, makeSteelMaterial, makeLedMaterial, makeDirtMaterial } from './materials';
import { makePlaceholderVehicle } from './vehicles';
import { buildGateCurtain } from './gateFx';
import { cloudVolume } from '../fx/volume/cloudVolume';
import type { QualitySettings } from '../quality';
import type { StuntId } from '../../shared/types';
import type { UFloat } from '../tslTypes';

export interface FloodLight { tower: THREE.Vector3; spot: THREE.SpotLight | null; cone?: THREE.Mesh }

/** Fixed ground-level light (battery, wash) – becomes a real spot only when the FloodRig assigns a slot. */
export interface SiteLight { pos: THREE.Vector3; dir: THREE.Vector3; halfAngleDeg: number; cd: number; keyFor?: (StuntId | 'overview')[] }

export type ReplaceKind = 'lightTower' | 'stage' | 'grandstand' | 'crowd' | 'raptorStand' | 'gate' | 'ledPost' | 'wallScaffold';

/** Floodlight head position in tower-local coordinates (matches light_tower.glb). */
export const TOWER_HEAD_LOCAL = new THREE.Vector3(0, 24.0, 1.7);

export interface TrackWorld {
  group: THREE.Group;
  /** Meshes the camera should not pass through (ramps, obstacles, stage). */
  cameraColliders: THREE.Object3D[];
  /** Obstacle placeholder groups keyed by obstacle id (replaced when props load). */
  obstacles: Map<string, THREE.Group>;
  towerHeads: THREE.Vector3[];
  /** Objects not worth rendering into the car reflection probe. */
  probeExcluded: THREE.Object3D[];
  /** Procedural stand-ins per decor kind, hidden when the model is loaded (see envModels.ts). */
  replaceable: Map<ReplaceKind, THREE.Object3D[]>;
  /** Ground-level batteries and ramp washes (light candidates for the FloodRig). */
  siteLights: SiteLight[];
  /** Baked floodlight illuminance on the ground (also used for vegetation). */
  lightmap: LightMap;
  /** Ramp profile samples (for placing truss modules). */
  rampSamples: Map<string, ReturnType<typeof buildRampGeometry>['samples']>;
  floods: FloodLight[];
  /** Emitter anchor for the Raptor steam plume. */
  raptorSteam: THREE.Vector3;
  update(t: number): void;
  setCrowdCount(n: number): void;
}

const R = (d: Decor) => d.headingDeg * DEG;

export function decorFrame(d: Decor): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(d.pos.x, d.pos.y, d.pos.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), R(d)), new THREE.Vector3(1, 1, 1));
}

/**
 * Additive light-shaft cone (floodlight beam in the haze). Apex at origin, opens along -Y, length 1.
 * `gain` (optional uniform) dims a single beam (moving heads switch on and off with the cues).
 */
export function makeBeamMaterial(strength: number, tint = new THREE.Color(0.85, 0.9, 1.0), gain: UFloat | null = null): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const along = uv().y.oneMinus(); // 0 at apex
  const facing = abs(dot(normalize(normalView), normalize(positionView).negate()));
  const edge = pow(facing, float(2.2));
  const fall = smoothstep(float(0), float(0.04), along).mul(pow(float(1).sub(along), float(1.6)));
  // the haze is not uniform: drifting sheets and streaks break the shaft up (sim time, so a paused
  // replay freezes the haze too); denser near the ground, thinning out with height
  const t = SCENE_TIME;
  const sheets = mx_noise_float(positionWorld.mul(vec3(0.035, 0.06, 0.035)).add(vec3(t.mul(0.07), t.mul(-0.02), t.mul(0.045)))).mul(0.5).add(0.5);
  const fine = mx_noise_float(positionWorld.mul(0.19).add(vec3(t.mul(0.21), 0, t.mul(-0.13)))).mul(0.5).add(0.5);
  const haze = pow(sheets, float(1.6)).mul(1.5).add(fine.mul(0.35)).add(0.12);
  const height = exp(positionWorld.y.max(0).div(-45)).mul(0.75).add(0.25);
  const core = pow(facing, float(6)).mul(0.6);
  let c = edge.add(core).mul(fall).mul(haze).mul(height).mul(strength);
  if (gain) c = c.mul(gain);
  m.colorNode = color(tint).mul(c);
  m.fog = false;
  return m;
}

export function buildTrack(q: QualitySettings, ENV = 'assets/env/'): TrackWorld {
  const group = new THREE.Group();
  group.name = 'McGregorPad';
  const colliders: THREE.Object3D[] = [];
  const obstacles = new Map<string, THREE.Group>();
  const steel = makeSteelMaterial(0x272b33, 0.5);
  const beams = new BeamBatch();
  const batches = new Map<ReplaceKind, BeamBatch>();
  const B = (k: ReplaceKind) => { let b = batches.get(k); if (!b) { b = new BeamBatch(); batches.set(k, b); } return b; };
  const replaceable = new Map<ReplaceKind, THREE.Object3D[]>();
  const reg = (k: ReplaceKind, o: THREE.Object3D) => { const l = replaceable.get(k) ?? []; l.push(o); replaceable.set(k, l); };
  const rampSamples = new Map<string, ReturnType<typeof buildRampGeometry>['samples']>();
  const updaters: ((t: number) => void)[] = [];

  // ------------------------------------------------------------------ ground
  const asphaltTex = loadTextureSet(ENV, 'asphalt');
  const concreteTex = loadTextureSet(ENV, 'concrete');
  const prairieTex = loadTextureSet(ENV, 'prairie', 4);
  const { min, max } = TRACK.pad;
  const padW = max.x - min.x, padL = max.z - min.z;
  const kick = TRACK.ramps.find((rr) => rr.kind === 'kicker')!, wallR = TRACK.ramps.find((rr) => rr.kind === 'wallRamp')!;
  const padMask = bakePadMask(min, max, [
    { x: kick.origin.x, z0: kick.origin.z - 110, z1: kick.origin.z + 70 },
    { x: wallR.origin.x, z0: wallR.origin.z - 150, z1: wallR.origin.z },
    { x: 0, z0: -122, z1: 90 },
  ], [{ x: 0, z: -119, r: 6 }, { x: 20, z: 41, r: 7 }, { x: kick.origin.x, z: 15, r: 9 }, { x: 35, z: -60, r: 11 }]);
  // floodlight towers (same placement as the decor below) -> baked ground illuminance
  const floodSources = TRACK.decor.filter((d) => d.kind === 'lightTower').map((d) => {
    const head = TOWER_HEAD_LOCAL.clone().applyMatrix4(decorFrame(d));
    return { pos: head, aim: { x: head.x * 0.3, y: 0, z: head.z * 0.92 }, intensityCd: TOWER_CD * PHOTOMETRIC, halfAngleDeg: 26 };
  });
  const lightmap = bakeFloodLightmap(floodSources, { x: min.x - 80, z: min.z - 80 }, { x: max.x + 80, z: max.z + 80 });
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(padW, padL, 1, 1).rotateX(-Math.PI / 2), makeAsphaltMaterial(asphaltTex, padMask, lightmap));
  pad.position.set((min.x + max.x) / 2, 0, (min.z + max.z) / 2);
  pad.receiveShadow = true;
  pad.name = 'Pad';
  group.add(pad);

  const prairie = new THREE.Mesh(new THREE.CircleGeometry(4200, 64).rotateX(-Math.PI / 2), makePrairieMaterial(prairieTex, lightmap));
  prairie.position.y = -0.04;
  prairie.receiveShadow = true;
  group.add(prairie);

  // pad edge curb
  const curbMat = new THREE.MeshStandardNodeMaterial({ color: 0x3a3a3c, roughness: 0.9 });
  for (const [cx, cz, sx, sz] of [[min.x, 0, 0.4, padL], [max.x, 0, 0.4, padL], [0, min.z, padW, 0.4], [0, max.z, padW, 0.4]] as const) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.08, sz), curbMat);
    c.position.set(cx === 0 ? (min.x + max.x) / 2 : cx, 0.0, cz === 0 ? (min.z + max.z) / 2 : cz);
    group.add(c);
  }

  // painted lines (drag lanes as in the stream: white lines on dark asphalt)
  const paint = new THREE.MeshStandardNodeMaterial({ color: 0xd8d8d4, roughness: 0.55 });
  paint.polygonOffset = true; paint.polygonOffsetFactor = -2; paint.polygonOffsetUnits = -2;
  const lines: [number, number, number, number, number][] = [
    // x, z0, z1, width, dash
    [-45, -200, -42, 0.14, 0], [60, -200, 58, 0.14, 0], [-3.5, -180, 180, 0.12, 0], [3.5, -180, 180, 0.12, 0], [0, -120, 120, 0.12, 6],
  ];
  for (const [x, z0, z1, w, dash] of lines) {
    if (dash > 0) {
      for (let z = z0; z < z1; z += dash * 2) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, dash).rotateX(-Math.PI / 2), paint);
        m.position.set(x, 0.004, z + dash / 2);
        m.receiveShadow = true;
        group.add(m);
      }
    } else {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, z1 - z0).rotateX(-Math.PI / 2), paint);
      m.position.set(x, 0.004, (z0 + z1) / 2);
      m.receiveShadow = true;
      group.add(m);
    }
  }
  // 0-60 measuring lane (stream 1262-1268 s): ruler ticks on the outer side of both lane lines from
  // behind the start to the gate, a long tick every 2.5 m
  {
    const gate = TRACK.decor.find((d) => d.kind === 'gate');
    const start = TRACK.decor.find((d) => d.kind === 'startLine');
    if (gate && start) {
      const z0 = start.pos.z - 22, z1 = gate.pos.z - 0.3, step = 0.5;
      const n = Math.floor((z1 - z0) / step) + 1;
      const ticks = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 0.07).rotateX(-Math.PI / 2), paint, n * 2);
      const m = new THREE.Matrix4();
      let k = 0;
      for (let i = 0; i < n; i++) {
        const len = i % 5 === 0 ? 0.75 : 0.32;
        for (const sx of [-1, 1]) {
          m.makeScale(len, 1, 1).setPosition(sx * (3.56 + len / 2), 0.004, z0 + i * step);
          ticks.setMatrixAt(k++, m);
        }
      }
      ticks.receiveShadow = true;
      ticks.name = 'Z60Ruler';
      group.add(ticks);
    }
  }
  // diagonal lines through the flip area (finale drone shots show crossing lines)
  for (const a of [-35, 35]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 120).rotateX(-Math.PI / 2), paint);
    m.rotation.y = a * DEG;
    m.position.set(20, 0.004, 40);
    group.add(m);
  }

  // ------------------------------------------------------------------ ramps
  // wall ramp: light neutral cast concrete as in the stream rear view (stream reference frames),
  // faint formwork seams, little grime at the foot (the foot is the brightest zone in the stream)
  const concrete = makeConcreteMaterial(concreteTex, { wheelTrack: 3.5, tint: 0xffffff, albedo: 0.34, grime: 0.1, seams: 0.2, calm: true });
  const darkRamp = makeConcreteMaterial(concreteTex, { tint: 0x55585c, wheelTrack: 2.1 });
  const ledRed = makeLedMaterial(0xff0e08, 26);
  const ledRedDim = makeLedMaterial(0xff0e08, 9);
  // wall-ramp edge: in the long-lens rear view the stream shows a thin red line with little halo
  const ledWallEdge = makeLedMaterial(0xff0a08, 2.5);
  // red light the LED bars throw onto the asphalt: a soft band with an exponential falloff
  const ledGlowMat = (() => {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const d = abs(uv().x.sub(0.5)).mul(2);
    m.colorNode = vec3(1.0, 0.035, 0.02).mul(exp(d.mul(-5.5)).sub(0.004).max(0).mul(0.32));
    m.polygonOffset = true; m.polygonOffsetFactor = -4;
    return m;
  })();
  const stripeMat = new THREE.MeshStandardNodeMaterial({ color: 0xe8e8e6, roughness: 0.6 });
  stripeMat.polygonOffset = true; stripeMat.polygonOffsetFactor = -2;

  for (const ramp of TRACK.ramps) {
    const rm = buildRampGeometry(ramp, ramp.kind === 'wallRamp' ? 0.2 : 0.15, ramp.kind === 'wallRamp' ? 10 : 6);
    const mesh = new THREE.Mesh(rm.surface, ramp.kind === 'wallRamp' ? concrete : darkRamp);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = `Ramp_${ramp.id}`;
    group.add(mesh);
    colliders.push(mesh);
    for (const curve of rm.edgeCurves) {
      const kick = ramp.kind === 'kicker';
      // the wall ramp's edge tube 0.045 → 0.028 m; in the stream rear view (long lens) it is a thin line
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.ceil(curve.getLength() * 2), kick ? 0.03 : 0.028, 6, false), kick ? ledRedDim : ledWallEdge);
      group.add(tube);
    }
    const stripe = new THREE.Mesh(rm.stripe, stripeMat);
    stripe.receiveShadow = true;
    group.add(stripe);
    rampSamples.set(ramp.id, rm.samples);
    if (ramp.kind === 'wallRamp') group.add(buildRampCurtains(ramp));
    buildRampScaffold(ramp, rm.samples, ramp.kind === 'wallRamp' ? B('wallScaffold') : beams, beams);
  }

  // ------------------------------------------------------------------ obstacles (placeholders)
  for (const o of TRACK.obstacles) {
    const g = makePlaceholderVehicle(o.model, o.size);
    g.position.set(o.center.x, o.center.y, o.center.z);
    g.rotation.y = o.headingDeg * DEG;
    g.name = `Obstacle_${o.id}`;
    group.add(g);
    obstacles.set(o.id, g);
    colliders.push(g);
  }
  // low platform the vehicle row stands on (stream: dark deck with red LED edge)
  {
    const zs = TRACK.obstacles.map((o) => o.center.z), x = TRACK.obstacles[0].center.x;
    const z0 = Math.min(...zs) - 3, z1 = Math.max(...zs) + 3;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.12, z1 - z0), new THREE.MeshStandardNodeMaterial({ color: 0x18191b, roughness: 0.7 }));
    deck.position.set(x, 0.06, (z0 + z1) / 2);
    deck.receiveShadow = true;
    group.add(deck);
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, z1 - z0), ledRed);
      e.position.set(x + sx * 3.75, 0.1, (z0 + z1) / 2);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.4, z1 - z0).rotateX(-Math.PI / 2), ledGlowMat);
      glow.position.set(x + sx * (3.75 + 1.2), 0.008, (z0 + z1) / 2);
      group.add(e, glow);
    }
  }

  // ------------------------------------------------------------------ decor
  const towerHeads: THREE.Vector3[] = [];
  const floods: FloodLight[] = [];
  const lampMat = makeLedMaterial(0xf4f8ff, 60);
  const lampHousing = new THREE.MeshStandardNodeMaterial({ color: 0x1a1b1e, roughness: 0.5, metalness: 0.7 });
  const beamMeshes: THREE.Mesh[] = [];
  let raptorSteam = new THREE.Vector3(-700, 40, 1100);

  for (const d of TRACK.decor) {
    const F = decorFrame(d);
    switch (d.kind) {
      case 'lightTower': {
        const beams = B('lightTower');
        const h = TOWER_HEAD_LOCAL.y - 1.2;
        const mk = beams.mark();
        beams.latticeMast({ x: 0, y: 0, z: 0 }, h, 1.4);
        beams.beam({ x: -2.6, y: h, z: 0.6 }, { x: 2.6, y: h, z: 0.6 }, 0.16);
        beams.beam({ x: -2.6, y: h + 2.4, z: 0.6 }, { x: 2.6, y: h + 2.4, z: 0.6 }, 0.16);
        beams.transformSince(mk, F);
        // lamp head: 2 x 4 floodlights facing the pad (local +Z)
        const head = new THREE.Group();
        head.applyMatrix4(F);
        for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {
          const hous = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.5), lampHousing);
          hous.position.set(-1.95 + c * 1.3, h + 0.6 + r * 1.2, 0.9);
          hous.rotation.x = 0.35;
          const lens = new THREE.Mesh(new THREE.CircleGeometry(0.36, 16), lampMat);
          lens.position.set(0, 0, 0.26);
          hous.add(lens);
          head.add(hous);
        }
        group.add(head);
        reg('lightTower', head);
        const headW = TOWER_HEAD_LOCAL.clone().applyMatrix4(F);
        towerHeads.push(headW);
        floods.push({ tower: headW, spot: null });
        break;
      }
      case 'ledStrip': {
        const L = d.length ?? 10;
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, L), ledRed);
        bar.position.set(0, 0.06, L / 2);
        const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.2, L).rotateX(-Math.PI / 2), ledGlowMat);
        glow.position.set(0, 0.006, L / 2);
        const holder = new THREE.Group();
        holder.applyMatrix4(F);
        holder.add(bar, glow);
        // vertical red light posts every 20 m (seen along the stream's runways)
        for (let z = 0; z <= L; z += 20) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.4, 0.12), ledRed);
          reg('ledPost', post);
          post.position.set(0, 0.7, z);
          holder.add(post);
        }
        group.add(holder);
        break;
      }
      case 'gate': {
        group.add(buildGate(d, F, ledRed, colliders));
        break;
      }
      case 'startLine': {
        const L = d.length ?? 10;
        const holder = new THREE.Group();
        holder.applyMatrix4(F);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(L, 0.4).rotateX(-Math.PI / 2), paint);
        m.rotation.y = Math.PI / 2;
        m.position.y = 0.005;
        holder.add(m);
        group.add(holder);
        break;
      }
      case 'stage': {
        const beams = B('stage');
        const s = d.size ?? { x: 40, y: 1.2, z: 14 };
        const holder = new THREE.Group();
        holder.applyMatrix4(F);
        const deck = new THREE.Mesh(new THREE.BoxGeometry(s.x, s.y, s.z), new THREE.MeshStandardNodeMaterial({ color: 0x101012, roughness: 0.35, metalness: 0.2 }));
        deck.position.y = s.y / 2;
        deck.receiveShadow = deck.castShadow = true;
        holder.add(deck);
        colliders.push(deck);
        const edge = new THREE.Mesh(new THREE.BoxGeometry(s.x, 0.06, 0.06), ledRed);
        edge.position.set(0, s.y + 0.02, s.z / 2);
        holder.add(edge);
        // two LED walls with an abstract "four white beams over a red bar" graphic (no logos)
        for (const sx of [-1, 1]) {
          const screen = new THREE.Mesh(new THREE.PlaneGeometry(14, 7.5), makeStageScreenMaterial());
          screen.position.set(sx * 11, s.y + 4.2, -s.z / 2 + 0.6);
          holder.add(screen);
        }
        const back = new THREE.Mesh(new THREE.BoxGeometry(s.x + 4, 12, 0.4), new THREE.MeshStandardNodeMaterial({ color: 0x050506, roughness: 0.9 }));
        back.position.set(0, 6, -s.z / 2 - 0.2);
        holder.add(back);
        group.add(holder);
        reg('stage', holder);
        const mk = beams.mark();
        beams.truss({ x: -s.x / 2 - 1, y: 0, z: s.z / 2 - 1 }, { x: -s.x / 2 - 1, y: 12, z: s.z / 2 - 1 }, 0.5);
        beams.truss({ x: s.x / 2 + 1, y: 0, z: s.z / 2 - 1 }, { x: s.x / 2 + 1, y: 12, z: s.z / 2 - 1 }, 0.5);
        beams.truss({ x: -s.x / 2 - 1, y: 12, z: s.z / 2 - 1 }, { x: s.x / 2 + 1, y: 12, z: s.z / 2 - 1 }, 0.5);
        beams.transformSince(mk, F);
        break;
      }
      case 'grandstand': {
        const beams = B('grandstand');
        const s = d.size ?? { x: 50, y: 8, z: 20 };
        const holder = new THREE.Group();
        holder.applyMatrix4(F);
        const rows = 10, rowD = s.z / rows, rowH = s.y / rows;
        const stand = new THREE.MeshStandardNodeMaterial({ color: 0x2b2d31, roughness: 0.55, metalness: 0.6 });
        for (let i = 0; i < rows; i++) {
          const step = new THREE.Mesh(new THREE.BoxGeometry(s.x, 0.12, rowD), stand);
          // row 0 nearest to the pad (local +Z), rising away from it
          step.position.set(0, (i + 1) * rowH, s.z / 2 - (i + 0.5) * rowD);
          step.receiveShadow = true;
          holder.add(step);
        }
        group.add(holder);
        reg('grandstand', holder);
        const mk = beams.mark();
        for (let x = -s.x / 2; x <= s.x / 2; x += 5) for (let i = 0; i < rows; i += 2) {
          beams.beam({ x, y: 0, z: s.z / 2 - (i + 0.5) * rowD }, { x, y: (i + 1) * rowH, z: s.z / 2 - (i + 0.5) * rowD }, 0.1);
        }
        // front railing
        beams.beam({ x: -s.x / 2, y: rowH + 1.0, z: s.z / 2 }, { x: s.x / 2, y: rowH + 1.0, z: s.z / 2 }, 0.05);
        beams.transformSince(mk, F);
        crowdStands.push({ F, s, rows, rowD, rowH });
        break;
      }
      case 'raptorStand': {
        const beams = B('raptorStand');
        const s = d.size ?? { x: 30, y: 60, z: 30 };
        const mk = beams.mark();
        beams.latticeMast({ x: 0, y: 0, z: 0 }, s.y, 10, 0.9, 0.4, 6);
        beams.latticeMast({ x: 16, y: 0, z: 4 }, s.y * 0.55, 6, 0.6, 0.3, 5);
        beams.box({ x: 0, y: s.y * 0.45, z: 0 }, { x: 14, y: 3, z: 14 });
        beams.transformSince(mk, F);
        const holder = new THREE.Group();
        holder.applyMatrix4(F);
        const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.9, 6, 4), makeLedMaterial(0xffd7a0, 30), 40);
        const m = new THREE.Matrix4();
        for (let i = 0; i < 40; i++) {
          m.makeTranslation((Math.random() - 0.5) * 12, 2 + Math.random() * s.y, (Math.random() - 0.5) * 12);
          lights.setMatrixAt(i, m);
        }
        holder.add(lights);
        // glowing base (lit steam deflector)
        const base = new THREE.Mesh(new THREE.SphereGeometry(18, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), (() => {
          const bm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
          const f = abs(dot(normalize(normalView), normalize(positionView).negate()));
          bm.colorNode = vec3(1.0, 0.72, 0.42).mul(pow(f, float(2)).mul(1.4));
          return bm;
        })());
        base.scale.set(1.6, 0.6, 1.6);
        holder.add(base);
        group.add(holder);
        reg('raptorStand', holder);
        raptorSteam = new THREE.Vector3(18, 6, 0).applyMatrix4(F);
        break;
      }
    }
  }

  // floodlight beams (volumetric look); the real spotlights live in lighting.ts (FloodRig)
  const siteLights: SiteLight[] = [];
  // ground-level light batteries at the stunt sites (the stream shows bright side/back lights right
  // next to the obstacles); fixed, shadowless, ~35 kcd each
  {
    const batteries: [THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(-29, 1.4, -14), new THREE.Vector3(-45, 4, -24)],   // kickflip, east side of the row
      [new THREE.Vector3(-60, 1.4, -38), new THREE.Vector3(-45, 3, -26)],   // kickflip, kicker side
      // 0-60: a low battery behind the start lights the car's tail and the jet (the big light wall in
      // front of the gate is built below)
      [new THREE.Vector3(6, 1.2, -141), new THREE.Vector3(0, 0.8, -116)],
      // finale flip (aimed at the car's flight, not the pad – the stream pad is dark)
      [new THREE.Vector3(6, 1.4, 54), new THREE.Vector3(20, 6, 40)],
    ];
    for (const [p, tgt] of batteries) {
      // ≈ 100-300 lx at 10-18 m; the real light is assigned by the FloodRig slot system
      // the stream's light walls (6-8 lamps each) are the brightest sources at the stunts: they
      // carve the vehicles out of the dark and throw tight pools onto the asphalt
      siteLights.push({ pos: p.clone(), dir: tgt.clone().sub(p).normalize(), halfAngleDeg: 24, cd: 140_000 });
      const stand = new THREE.Group();
      stand.position.set(p.x, 0, p.z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, p.y, 8), lampHousing);
      pole.position.y = p.y / 2;
      stand.add(pole);
      for (const dx of [-0.35, 0.35]) {
        const housing = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.45, 0.35), lampHousing);
        housing.position.set(dx, p.y, 0);
        housing.lookAt(new THREE.Vector3(tgt.x - p.x + dx, tgt.y, tgt.z - p.z));
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.18, 12), lampMat);
        lens.position.z = 0.18;
        housing.add(lens);
        stand.add(housing);
      }
      group.add(stand);
    }
  }
  // 0-60 light battery and the dirt beside the lane (stream 1262-1268 s). Position from the 1267 s
  // still: seen from z60_gate ≈ 3.4° right of and ≈ 9.3° above the image centre, ≈ 6 m wide at ≈ 33 m.
  {
    const pos = new THREE.Vector3(-12.9, 6.0, -109.6), aim = new THREE.Vector3(0.5, 0.3, -116.5);
    group.add(buildLightBattery(pos, aim, lampHousing, beams));
    siteLights.push({ pos: pos.clone(), dir: aim.clone().sub(pos).normalize(), halfAngleDeg: 32, cd: 160_000, keyFor: ['zero60'] });
    // compacted earth on both sides of the lane from behind the start up to the gate front; a dark
    // asphalt shoulder of ≈ 0.6 m stays outside the ruler ticks as in the stream. The inner edge is cut
    // in the shader (irregular crumb edge, no polygon zigzag)
    const gate = TRACK.decor.find((dd) => dd.kind === 'gate');
    const zEnd = gate ? gate.pos.z : -110.5, z0 = -150, x0 = 4.9, x1 = 15;
    const dirt = makeDirtMaterial(prairieTex, x0);
    for (const sx of [-1, 1]) {
      const geo = new THREE.PlaneGeometry(x1 - x0 + 0.6, zEnd - z0, 48, 40).rotateX(-Math.PI / 2);
      // a slight crown (the earth is heaped a little towards the middle of the strip)
      const pa = geo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pa.count; i++) {
        const f = (pa.getX(i) + (x1 - x0 + 0.6) / 2) / (x1 - x0 + 0.6);
        pa.setY(i, 0.012 + 0.05 * Math.sin(f * Math.PI));
      }
      geo.computeVertexNormals();
      const strip = new THREE.Mesh(geo, dirt);
      strip.position.set(sx * (x0 + x1 - 0.6) / 2, 0, (z0 + zEnd) / 2);
      strip.receiveShadow = true;
      strip.name = 'Z60Dirt';
      group.add(strip);
    }
  }
  // wall ramp light (stream rear view 656–672 s, stream reference frames): the concrete
  // is washed evenly from low lamps at the foot – brightest at the bottom, fading up the wall, no pool –
  // and a soft light from above, in front of the car, greys its roof and flanks and the apron around it
  // while the tail stays in shade. The two foot washes come first (keys survive even with 3 slots).
  {
    const w = TRACK.ramps.find((rr) => rr.kind === 'wallRamp')!;
    const o = w.origin;
    const lamps: { p: THREE.Vector3; tgt: THREE.Vector3; half: number; cd: number; visible: boolean }[] = [
      // −x is image right in the rear view: as in the stream the right side is the brighter one
      { p: new THREE.Vector3(o.x - 3.6, 0.45, o.z - 3.2), tgt: new THREE.Vector3(o.x + 0.6, 3.0, o.z + 4.5), half: 50, cd: 7_500, visible: true },
      { p: new THREE.Vector3(o.x + 3.6, 0.45, o.z - 3.2), tgt: new THREE.Vector3(o.x - 0.6, 3.0, o.z + 4.5), half: 50, cd: 3_800, visible: true },
      { p: new THREE.Vector3(o.x, 9, o.z + 2.5), tgt: new THREE.Vector3(o.x, 0, o.z - 2.5), half: 24, cd: 14_000, visible: false },
    ];
    for (const l of lamps) {
      siteLights.push({ pos: l.p.clone(), dir: l.tgt.clone().sub(l.p).normalize(), halfAngleDeg: l.half, cd: l.cd, keyFor: ['ramp_hang', 'ramp_launch'] });
      if (!l.visible) continue;
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.38, 0.42), lampHousing);
      housing.position.copy(l.p);
      housing.lookAt(l.tgt);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.16, 12), lampMat);
      lens.position.z = 0.215;
      housing.add(lens);
      group.add(housing);
    }
    // concrete apron in front of the ramp foot (the stream floor there is light cast concrete)
    const AW = 7.5, AL = 7;
    const ag = new THREE.PlaneGeometry(AW, AL).rotateX(-Math.PI / 2);
    const auv = ag.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < auv.count; i++) auv.setXY(i, auv.getX(i) * AW, auv.getY(i) * AL);
    const apronMat = makeConcreteMaterial(concreteTex, { tint: 0xd8d8d6, albedo: 0.27, grime: 0.5, seams: 0.6 });
    apronMat.polygonOffset = true; apronMat.polygonOffsetFactor = -1; apronMat.polygonOffsetUnits = -1;
    const apron = new THREE.Mesh(ag, apronMat);
    apron.position.set(o.x, 0.003, o.z - AL / 2);
    apron.receiveShadow = true;
    apron.name = 'RampApron';
    group.add(apron);
  }
  // up-tilted stunt floods next to the flight paths: they light the airborne car (and backlight its
  // condensation plumes) while their beams leave into the night sky instead of greying the pad
  {
    const keyBeamGeo = new THREE.ConeGeometry(1, 1, 20, 1, true).translate(0, -0.5, 0);
    const keyBeamMat = makeBeamMaterial(0.012, new THREE.Color(0.86, 0.92, 1.0));
    const airKeys: [THREE.Vector3, THREE.Vector3, StuntId][] = [
      [new THREE.Vector3(-29, 2.2, -37), new THREE.Vector3(-45, 8, -18), 'kickflip'],   // camera side, low front key
      [new THREE.Vector3(-63, 2.2, -7), new THREE.Vector3(-45, 8, -21), 'kickflip'],    // far side, backlight into the lens
      [new THREE.Vector3(36, 2.0, 52), new THREE.Vector3(20, 5, 40), 'ground_flip'],
    ];
    for (const [p, tgt, site] of airKeys) {
      const dir = tgt.clone().sub(p).normalize();
      siteLights.push({ pos: p.clone(), dir, halfAngleDeg: 12, cd: 260_000, keyFor: [site] });
      const stand = new THREE.Group();
      stand.position.set(p.x, 0, p.z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, p.y, 8), lampHousing);
      pole.position.y = p.y / 2;
      stand.add(pole);
      for (const [dx, dy] of [[-0.42, 0.25], [0.42, 0.25], [-0.42, -0.25], [0.42, -0.25]]) {
        const housing = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.45, 0.4), lampHousing);
        housing.position.set(dx, p.y + dy, 0);
        housing.lookAt(new THREE.Vector3(tgt.x - p.x + dx, tgt.y + dy, tgt.z - p.z));
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.2, 14), lampMat);
        lens.position.z = 0.205;
        housing.add(lens);
        stand.add(housing);
      }
      group.add(stand);
      if (q.volumetricBeams) {
        const len = 70;
        const cone = new THREE.Mesh(keyBeamGeo, keyBeamMat);
        cone.position.copy(p);
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
        const rad = len * Math.tan(9 * DEG);
        cone.scale.set(rad, len, rad);
        cone.renderOrder = 5;
        cone.frustumCulled = false;
        group.add(cone);
      }
    }
  }
  // finale stage (stream 1600–1612 s, fin_front 65 m ahead of the pad, 15° lens): a tall red
  // light column right behind the car, two fans of narrow white beams low on both sides of it, and
  // red floods next to the column base that turn the near-column half of the blast cloud deep red
  // while the white side stays white (the finale light read too grey). Positions from the
  // 1603 s still: column ≈ +1.6° right of the car, ≈ 1.6° wide; fans at −4.8…−0.3° and +2.8…+5.6°.
  {
    const fin = new THREE.Vector3(20, 0, 40);
    // column: dark slab with red LED edges and a dim red face (seen face-on from the camera)
    const colX = fin.x + 0.9, colZ = -25, colW = 3.2, colH = 52;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(colW, colH, 0.8), lampHousing);
    slab.position.set(colX, colH / 2, colZ);
    group.add(slab);
    const faceMat = new THREE.MeshBasicNodeMaterial({ fog: true });
    {
      // face glow: brighter low down and towards the edges (lit by the edge LEDs through the haze)
      const ux = uv().x.sub(0.5).abs().mul(2), uy = uv().y;
      // (after the edges alone read as two hard graphic lines – a wide soft falloff from
      // the edges into the face instead)
      const glow = mix(float(0.4), float(1), pow(ux, float(1.6))).mul(exp(uy.mul(-1.6)).mul(0.8).add(0.2));
      faceMat.colorNode = color(0xff1408).mul(glow).mul(3.2);
    }
    const face = new THREE.Mesh(new THREE.PlaneGeometry(colW - 0.1, colH), faceMat);
    face.position.set(colX, colH / 2, colZ + 0.46);
    group.add(face);
    const edgeMat = makeLedMaterial(0xff1008, 16);
    for (const sx of [-1, 1]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.1, colH, 0.1), edgeMat);
      edge.position.set(colX + sx * (colW / 2 - 0.02), colH / 2, colZ + 0.5);
      group.add(edge);
    }
    // white beam fans (moving heads on the ground): thin additive shafts, fanned in the image plane
    const fanGeo = new THREE.ConeGeometry(1, 1, 10, 1, true).translate(0, -0.5, 0);
    const fanMat = makeBeamMaterial(0.32, new THREE.Color(0.9, 0.94, 1.0));
    const headMat = makeLedMaterial(0xf4f8ff, 40);
    const fans: [number, number[]][] = [
      // [x, beam angles from vertical, + = towards +x (image right)]
      [fin.x - 7.4, [-58]], [fin.x - 5.6, [-46, -24]], [fin.x - 3.8, [-34]], [fin.x - 2.2, [-20, 10]], [fin.x - 0.8, [-8]],
      [fin.x + 4.4, [4]], [fin.x + 5.8, [-14, 22]], [fin.x + 7.2, [34]], [fin.x + 8.7, [52]],
    ];
    const fanZ = 12;
    for (const [x, angles] of fans) {
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), headMat);
      head.position.set(x, 0.45, fanZ);
      group.add(head);
      if (!q.volumetricBeams) continue;
      for (const a of angles) {
        const dir = new THREE.Vector3(Math.sin(a * DEG), Math.cos(a * DEG), 0.12).normalize();
        const len = 7, shaft = new THREE.Mesh(fanGeo, fanMat);
        shaft.position.set(x, 0.45, fanZ);
        shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
        shaft.scale.set(0.16, len, 0.16);
        shaft.renderOrder = 5;
        shaft.frustumCulled = false;
        group.add(shaft);
      }
    }
    // red floods beside the column base (low housings, red lenses) aimed back at the pad
    const redLens = makeLedMaterial(0xff1008, 30);
    const reds: [THREE.Vector3, THREE.Vector3, number][] = [
      // at the column foot behind the pad (backlight: the glowing red rims next to the column) and
      // front right, low (the camera-facing side of the right half turns deep red; mirrors the white
      // wash front left)
      [new THREE.Vector3(fin.x + 3.2, 1.2, 24), new THREE.Vector3(fin.x + 1.5, 3.5, 40), 120_000],
      [new THREE.Vector3(fin.x + 11, 1.5, 53), new THREE.Vector3(fin.x + 3.5, 3, 40), 550_000],
    ];
    for (const [p, tgt] of reds) {
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.36, 0.36), lampHousing);
      housing.position.copy(p);
      housing.lookAt(tgt);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.15, 12), redLens);
      lens.position.z = 0.185;
      housing.add(lens);
      group.add(housing);
    }
    cloudVolume.setStageZones([{
      x: fin.x, z: fin.z, r: 30, fill: 0.3,
      lights: [
        ...reds.map(([p, tgt, cd]) => ({ pos: p.clone(), dir: tgt.clone().sub(p).normalize(), halfAngleDeg: 40, cd, colour: 'red' as const })),
        // white stage wash from the front left (the stream's white half is lit from the camera side)
        { pos: new THREE.Vector3(fin.x - 12, 2.5, 52), dir: new THREE.Vector3(fin.x - 4, 3, 40).sub(new THREE.Vector3(fin.x - 12, 2.5, 52)).normalize(), halfAngleDeg: 30, cd: 600_000, colour: 'white' as const },
      ],
    }]);
  }
  if (q.volumetricBeams) {
    const beamGeo = new THREE.ConeGeometry(1, 1, 24, 1, true).translate(0, -0.5, 0);
    const beamMat = makeBeamMaterial(0.006);
    for (const f of floods) {
      const tgt = new THREE.Vector3(f.tower.x * 0.3, 0, f.tower.z * 0.92);
      const dir = tgt.clone().sub(f.tower);
      const len = dir.length() * 1.05;
      const cone = new THREE.Mesh(beamGeo, beamMat);
      cone.position.copy(f.tower);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
      const rad = len * Math.tan(20 * DEG);
      cone.scale.set(rad, len, rad);
      cone.renderOrder = 5;
      cone.frustumCulled = false;
      beamMeshes.push(cone);
      f.cone = cone;
      group.add(cone);
    }
  }

  // ------------------------------------------------------------------ crowd (instanced silhouettes)
  const crowdGeo = (() => {
    const pts = [[0, 0], [0.2, 0], [0.24, 0.35], [0.22, 0.75], [0.17, 0.9], [0.08, 0.95], [0.1, 1.05], [0.11, 1.17], [0.06, 1.27], [0, 1.29]]
      .map(([x, y]) => new THREE.Vector2(x, y));
    return new THREE.LatheGeometry(pts, 7);
  })();
  const crowdMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });
  {
    const h = hash(instanceIndex.toFloat().add(3.1));
    crowdMat.colorNode = mix(vec3(0.03, 0.03, 0.035), vec3(0.16, 0.15, 0.15), h.mul(h));
    // the occasional phone screen
    const phone = step01(hash(instanceIndex.toFloat().mul(1.7)), float(0.965));
    // phone held at chest height: a small band of the silhouette lights up
    const band = smoothstep(float(0.93), float(0.96), positionLocal.y).mul(smoothstep(float(1.02), float(0.99), positionLocal.y)).mul(step01(positionLocal.z, float(0.12)));
    crowdMat.emissiveNode = vec3(0.6, 0.75, 1.0).mul(phone).mul(band).mul(mx_noise_float(vec3(instanceIndex.toFloat(), SCENE_TIME.mul(0.3), 0)).mul(0.5).add(0.5)).mul(6);
  }
  const crowdCap = 4000;
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, crowdCap);
  crowd.name = 'Crowd';
  {
    const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    let n = 0;
    const rnd = mulberry32(7);
    outer: for (const st of crowdStands) {
      for (let i = 0; i < st.rows; i++) {
        const y = (i + 1) * st.rowH + 0.06, z = st.s.z / 2 - (i + 0.5) * st.rowD;
        for (let x = -st.s.x / 2 + 0.4; x < st.s.x / 2 - 0.4; x += 0.62) {
          if (rnd() < 0.18) continue;
          if (n >= crowdCap) break outer;
          p.set(x + (rnd() - 0.5) * 0.25, y, z + (rnd() - 0.5) * 0.3).applyMatrix4(st.F);
          qq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (rnd() - 0.5) * 0.8);
          const s = 0.92 + rnd() * 0.18;
          sc.set(s, s * (0.95 + rnd() * 0.1), s);
          m.compose(p, qq, sc);
          crowd.setMatrixAt(n++, m);
        }
      }
      // standing crowd in front of the stage
    }
    const stage = TRACK.decor.find((x) => x.kind === 'stage');
    if (stage) {
      const F = decorFrame(stage);
      for (let k = 0; k < 900 && n < crowdCap; k++) {
        p.set((rnd() - 0.5) * 36, 0, 9 + rnd() * 14).applyMatrix4(F);
        qq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (rnd() - 0.5) * 0.9 + R(stage) + Math.PI);
        const s = 0.95 + rnd() * 0.15;
        m.compose(p, qq, sc.set(s, s, s));
        crowd.setMatrixAt(n++, m);
      }
    }
    crowd.count = Math.min(n, q.crowdCount);
    (crowd as unknown as { maxCount: number }).maxCount = n;
    crowd.instanceMatrix.needsUpdate = true;
    crowd.frustumCulled = false;
  }
  group.add(crowd);
  reg('crowd', crowd);
  const probeExcluded: THREE.Object3D[] = [crowd];

  // ------------------------------------------------------------------ utility poles with sagging cables
  // (characteristic silhouette behind the vehicle row in the stream, t_963)
  {
    const wood = new THREE.MeshStandardNodeMaterial({ color: 0x3a2e24, roughness: 0.9 });
    const wireMat = new THREE.MeshStandardNodeMaterial({ color: 0x0c0c0d, roughness: 0.6, metalness: 0.4 });
    const poles = new THREE.Group();
    poles.name = 'UtilityPoles';
    const tops: THREE.Vector3[][] = [];
    for (let z = -150; z <= 60; z += 42) {
      const x = -84 + Math.sin(z * 0.05) * 1.5;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.17, 11.5, 10), wood);
      pole.position.set(x, 5.75, z);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.14, 0.12), wood);
      arm.position.set(x, 10.6, z);
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.2, 0.06), wood);
      brace.position.set(x + 0.55, 10.1, z);
      brace.rotation.z = 0.7;
      poles.add(pole, arm, brace);
      tops.push([-1.15, 0, 1.15].map((dx) => new THREE.Vector3(x + dx, 10.78, z)));
      for (const dx of [-1.15, 0, 1.15]) {
        const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.2, 8), wireMat);
        ins.position.set(x + dx, 10.72, z);
        poles.add(ins);
      }
    }
    for (let i = 0; i < tops.length - 1; i++) for (let k = 0; k < 3; k++) {
      const a = tops[i][k], b = tops[i + 1][k];
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= 16; j++) {
        const t = j / 16;
        const p = a.clone().lerp(b, t);
        p.y -= 0.9 * 4 * t * (1 - t); // catenary-like sag
        pts.push(p);
      }
      poles.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.018, 4), wireMat));
    }
    poles.traverse((o) => { (o as THREE.Mesh).castShadow = true; });
    group.add(poles);
  }

  // ------------------------------------------------------------------ horizon lights (distant town / facilities)
  {
    const N = 900;
    const pts = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 4, 3), makeLedMaterial(0xffc890, 8), N);
    const m = new THREE.Matrix4();
    const rnd = mulberry32(42);
    for (let i = 0; i < N; i++) {
      // clustered along the far horizon, densest behind the Raptor stand
      const cluster = rnd() < 0.5 ? Math.atan2(-700, 1100) + (rnd() - 0.5) * 0.5 : rnd() * Math.PI * 2;
      const r = 2600 + rnd() * 1400;
      const s = 1.2 + rnd() * 2.5;
      m.compose(new THREE.Vector3(Math.sin(cluster) * r, 1 + rnd() * 6, Math.cos(cluster) * r), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
      pts.setMatrixAt(i, m);
    }
    pts.frustumCulled = false;
    group.add(pts);
    probeExcluded.push(pts);
  }

  // ------------------------------------------------------------------ steel batch
  const steelMesh = beams.build(steel);
  steelMesh.name = 'Steel';
  group.add(steelMesh);
  for (const [k, b] of batches) {
    if (!b.count) continue;
    const m = b.build(steel);
    m.name = `Steel_${k}`;
    group.add(m);
    reg(k, m);
  }

  // flickering haze uniform for beams
  const haze = uniform(1);
  void haze;

  return {
    group,
    cameraColliders: colliders,
    obstacles,
    towerHeads,
    probeExcluded,
    replaceable,
    rampSamples,
    lightmap,
    siteLights,
    floods,
    raptorSteam,
    update(t: number) { for (const u of updaters) u(t); },
    setCrowdCount(n: number) { crowd.count = Math.min(n, (crowd as unknown as { maxCount: number }).maxCount); },
  };
}

// ---------------------------------------------------------------------------------------------
const crowdStands: { F: THREE.Matrix4; s: { x: number; y: number; z: number }; rows: number; rowD: number; rowH: number }[] = [];

function step01(x: Node<'float'>, edge: Node<'float'>) {
  return clamp(x.sub(edge).mul(1e4), 0, 1);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeStageScreenMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const u = uv();
  // four soft white beams fanning up from a red bar, on a black starfield
  const barY = float(0.32);
  const bar = smoothstep(float(0.035), float(0.0), abs(u.y.sub(barY))).mul(smoothstep(float(0.36), float(0.3), abs(u.x.sub(0.5))));
  let beamsAcc = float(0) as unknown as ReturnType<typeof float>;
  for (let i = 0; i < 4; i++) {
    const cx = 0.5 + (i - 1.5) * 0.06;
    const spread = u.y.sub(barY).max(0).mul(0.25).add(0.012);
    const b = smoothstep(spread, float(0), abs(u.x.sub(cx))).mul(smoothstep(float(0.95), float(0.36), u.y)).mul(smoothstep(barY, barY.add(0.04), u.y));
    beamsAcc = beamsAcc.add(b) as typeof beamsAcc;
  }
  const stars = step01(hash(floor(u.mul(180)).dot(vec3(1, 57, 0).xy)), float(0.992)).mul(0.6);
  const flick = sin(SCENE_TIME.mul(0.7)).mul(0.08).add(0.92);
  m.colorNode = vec3(1, 0.05, 0.03).mul(bar).mul(5).add(vec3(0.9, 0.95, 1).mul(beamsAcc).mul(3.5)).add(stars).mul(flick);
  void fract;
  return m;
}

// ------------------------------------------------------------------ wall-ramp curtains
/**
 * Red stage drapes beside the wall ramp (stream rear view, stream reference frames and
 * sheets/sheet_05.jpg): one tall pleated panel per side, facing the run-up, its inner edge just outside
 * the LED edge of the vertical section. From behind they frame the ramp and hide the tower beside it,
 * while the lower curve runs in front of them; from the side they stay behind the ramp silhouette.
 */
function buildRampCurtains(ramp: CurvedRamp): THREE.Group {
  const g = new THREE.Group();
  g.name = 'RampCurtains';
  // zc: at the foot of the vertical section, between the last under-sweep truss module (≤ 8.1 m) and
  // the tower behind the ramp (≥ 10.4 m), so the whole lower curve stays in front of the drapes
  const hw = ramp.width / 2, W = 4.8, H = 14, zc = 9.0, gap = 0.18;
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
  {
    // velvet: deep red, brighter at grazing angles; a faint self-glow keeps it red in the dark
    const facing = abs(dot(normalize(normalView), normalize(positionView).negate()));
    const nap = mx_noise_float(positionWorld.mul(vec3(0.6, 0.08, 0.6))).mul(0.15).add(0.92);
    mat.colorNode = vec3(0.09, 0.004, 0.005).mul(pow(float(1).sub(facing), float(2)).mul(0.9).add(0.55)).mul(nap);
    // no flat self-glow (it looked artificially lit). The only extra light is the red spill
    // of the LED edge tube right next to the inner edge (u = 0): it fades within ~1.5 m and catches the
    // pleat flanks that face the ramp, so the drape reads lit from the edge and dark further out
    const u = uv().x.mul(W);
    const pleatSide = normalWorld.x.mul(sign(positionWorld.x.sub(ramp.origin.x)).negate()).max(0).mul(0.8).add(0.2);
    mat.emissiveNode = vec3(0.014, 0.00035, 0.0004).mul(exp(u.mul(-2.2))).mul(pleatSide).mul(nap).add(vec3(0.0035, 0.0001, 0.0001).mul(nap));
  }
  const header = new THREE.MeshStandardNodeMaterial({ color: 0x141518, roughness: 0.7, metalness: 0.4 });
  const nx = 150, ny = 10;
  const rnd = mulberry32(31);
  // pleats: two superposed waves with a slowly drifting period, irregular amplitude
  const ph = Array.from({ length: 6 }, () => rnd() * Math.PI * 2);
  const pleat = (u: number) => 0.13 * Math.sin(u * 2 * Math.PI / 0.62 + ph[0] + 0.6 * Math.sin(u * 0.7 + ph[1]))
    + 0.05 * Math.sin(u * 2 * Math.PI / 0.27 + ph[2]) + 0.04 * Math.sin(u * 1.3 + ph[3]);
  for (const sx of [-1, 1]) {
    const geo = new THREE.PlaneGeometry(W, H, nx, ny);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) + W / 2, v = pos.getY(i) + H / 2;   // u: 0 at the ramp edge, outwards
      const x = sx * (hw + gap + u);
      // the drape hangs slightly fuller at the floor and swings out a little at the outer edge
      const z = zc + pleat(u + (sx > 0 ? 11 : 0)) * (1 + 0.25 * (1 - v / H)) - 0.06 * u;
      const p = rampLocalToWorld(ramp, { x, y: v, z });
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    m.castShadow = false;
    g.add(m);
    // dark header pipe the drape hangs from
    const a = rampLocalToWorld(ramp, { x: sx * (hw + gap), y: H + 0.1, z: zc }), b = rampLocalToWorld(ramp, { x: sx * (hw + gap + W), y: H + 0.1, z: zc });
    const pipe = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(b.x - a.x, b.z - a.z) + 0.3, 0.22, 0.22), header);
    pipe.position.set((a.x + b.x) / 2, H + 0.1, (a.z + b.z) / 2);
    pipe.rotation.y = ramp.headingDeg * DEG;
    g.add(pipe);
  }
  return g;
}

// ------------------------------------------------------------------ 0-60 gate housing
/**
 * Stream 0-60 (r8_stream_z60_plume.jpg): a dark charcoal box with a lit opening the car drives
 * through – white LED line along the top of the opening, red LED bars on both jambs, a faint LED
 * screen / smoke gauze inside. Local frame: front face at z = 0 facing +Z (towards the start), the
 * housing runs to z = -depth and is open at both ends. Seen from the camera side (+x in the world
 * for heading 180) the housing runs far past the opening, on the other side only a short pillar.
 */
function buildGate(d: Decor, F: THREE.Matrix4, ledRed: THREE.Material, colliders: THREE.Object3D[]): THREE.Group {
  // proportions from the stream still at 1267 s (car height ≈ 1.15 m as scale, the lane lines at
  // ±3.5 m run to the jambs): opening ≈ 6.4 × 3.8 m, housing ≈ 4.6 m high, a ≈ 2.4 m pillar on the far
  // side. An earlier version had 8 × 5 m in a 6.8 m wall, ≈ 1.4 × too tall.
  const s = d.size ?? { x: 16, y: 4.6, z: 6 };
  const W = s.x, H = s.y, D = s.z, OW = 6.4, OH = 3.8, short = 2.4, FR = 0.34;
  const xr = OW / 2 + short, xl = xr - W;   // local x range (local -x = the long side)
  const holder = new THREE.Group();
  holder.applyMatrix4(F);
  holder.name = 'Gate60';
  const panelMat = (base: number) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0 });
    // charcoal sheet panels with faint vertical joints every 1.25 m
    const p = positionWorld;
    const joint = smoothstep(float(0.975), float(1), abs(fract(p.x.add(p.z).div(1.25)).sub(0.5)).mul(2));
    const grime = mx_noise_float(p.mul(0.7)).mul(0.5).add(0.5);
    const streak = mx_noise_float(p.mul(vec3(2.5, 0.25, 2.5))).mul(0.5).add(0.5);
    m.colorNode = vec3(base, base * 1.04, base * 1.1).mul(mix(float(1), float(0.6), joint)).mul(grime.mul(0.25).add(0.82)).mul(streak.mul(0.18).add(0.91));
    return m;
  };
  const panel = panelMat(0.05);
  const frameMat = panelMat(0.075);   // the portal frame around the opening is a shade lighter
  const solid = (x0: number, x1: number, y0: number, y1: number, z0 = -D, z1 = 0, mat = panel, collide = true) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    m.castShadow = m.receiveShadow = true;
    holder.add(m);
    if (collide) colliders.push(m);
  };
  solid(xl, -OW / 2 - FR, 0, H);           // long side
  solid(OW / 2 + FR, xr, 0, H);            // short pillar
  solid(-OW / 2 - FR, OW / 2 + FR, OH + FR, H);   // lintel / roof over the passage
  // portal frame: jambs and header 0.34 m wide, standing 6 cm proud of the face
  solid(-OW / 2 - FR, -OW / 2, 0, OH + FR, -D, 0.06, frameMat);
  solid(OW / 2, OW / 2 + FR, 0, OH + FR, -D, 0.06, frameMat);
  solid(-OW / 2, OW / 2, OH, OH + FR, -D, 0.06, frameMat);
  // LED trim: white line along the top of the opening, red bars on the frame beside the jambs
  const white = makeLedMaterial(0xf2f6ff, 14);
  const top = new THREE.Mesh(new THREE.BoxGeometry(OW, 0.06, 0.06), white);
  top.position.set(0, OH - 0.04, 0.05);
  holder.add(top);
  for (const sx of [-1, 1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.07, OH - 0.1, 0.05), ledRed);
    bar.position.set(sx * (OW / 2 + FR + 0.12), (OH - 0.1) / 2 + 0.05, 0.03);
    holder.add(bar);
  }
  // LED screen at the back of the passage (stream: a dark blue-grey screen with a grid and drifting
  // clouds fills the opening, nothing of the venue shows through). Normal blending, nearly opaque;
  // the car drives through it after the 0-60 mark
  const gauze = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  {
    const u = uv();
    const grid = step01(abs(fract(u.x.mul(14)).sub(0.5)), float(0.47)).max(step01(abs(fract(u.y.mul(7)).sub(0.5)), float(0.46)));
    const streaks = mx_noise_float(vec3(u.x.mul(26), u.y.mul(1.4), SCENE_TIME.mul(0.15))).mul(0.5).add(0.5);
    const neb = mx_noise_float(vec3(u.x.mul(3), u.y.mul(2), SCENE_TIME.mul(0.05))).mul(0.5).add(0.5);
    gauze.colorNode = vec3(0.012, 0.016, 0.026).add(vec3(0.35, 0.5, 0.75).mul(neb.mul(0.07).add(grid.mul(0.02)))).add(vec3(0.6, 0.65, 0.7).mul(pow(streaks, float(3)).mul(0.05)));
    gauze.opacityNode = float(0.93);
  }
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(OW, OH), gauze);
  screen.position.set(0, OH / 2, -2.9);
  screen.renderOrder = 2;
  holder.add(screen);
  // nozzle row under the lintel and the downward smoke curtain (world/gateFx.ts)
  const noz = new THREE.Mesh(new THREE.BoxGeometry(OW - 0.2, 0.16, 0.3), new THREE.MeshStandardNodeMaterial({ color: 0x0d0e10, roughness: 0.6, metalness: 0.5 }));
  noz.position.set(0, OH - 0.1, -1.3);
  holder.add(noz);
  holder.add(buildGateCurtain(OW - 0.1, OH - 0.05));
  // dark passage floor so the lit pad does not run through the housing
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(OW, D).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color: 0x0b0b0c, roughness: 0.8 }));
  floor.position.set(0, 0.006, -D / 2);
  floor.receiveShadow = true;
  holder.add(floor);
  return holder;
}

/**
 * 0-60 light battery (stream 1262-1268 s): a tilted panel of ≈ 50 round lamps in a truss frame on a
 * lift mast, high beside the lane in front of the gate – the dominant light of the shot and the
 * flare top right in the 1267 s still. Lamp discs face the aim point; each glows strongly only when
 * seen near its axis, so from the broadcast camera a few lamps blaze and the rest read as grey discs.
 */
function buildLightBattery(pos: THREE.Vector3, aim: THREE.Vector3, lampHousing: THREE.Material, beams: BeamBatch): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Z60LightBattery';
  const cols = 9, rows = 5, sp = 0.58;
  const Wp = cols * sp + 0.3, Hp = rows * sp + 0.3;
  const panel = new THREE.Group();
  panel.position.copy(pos);
  panel.lookAt(aim);   // local +z towards the aim point
  panel.rotateZ(0.1);  // the panel hangs rolled on its lift head (stream: grid rising to the right)
  g.add(panel);
  const back = new THREE.Mesh(new THREE.BoxGeometry(Wp, Hp, 0.25), lampHousing);
  back.position.z = -0.2;
  panel.add(back);
  // which lamps blaze towards the broadcast cameras (stream: the top outer corner, ≈ 6 of ≈ 50)
  const glow = new Float32Array(rows * cols);
  const lens = new THREE.MeshBasicNodeMaterial();
  {
    const gl = attribute('glow', 'float');
    const flick = hash(instanceIndex.toFloat().mul(3.7)).mul(0.4).add(0.8);
    lens.colorNode = vec3(0.95, 0.97, 1.0).mul(gl.mul(40).add(0.45)).mul(flick);
  }
  const lampGeo = new THREE.CircleGeometry(0.2, 16);
  const lamps = new THREE.InstancedMesh(lampGeo, lens, rows * cols);
  const m = new THREE.Matrix4();
  let k = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    // every lamp is aimed a little differently across the pool (fan), as on the real panel
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((r - rows / 2) * 0.035, (c - cols / 2) * 0.03, 0));
    m.compose(new THREE.Vector3((c - (cols - 1) / 2) * sp + (r % 2) * sp * 0.5 - sp * 0.25, (r - (rows - 1) / 2) * sp, 0.0), q, new THREE.Vector3(1, 1, 1));
    // the top corner on the camera side (local +x) blazes, as in the stream
    glow[k] = r >= rows - 3 && c >= cols - 2 && (r + c) % 2 === 0 ? 1 : (r >= rows - 2 && c === cols - 3 ? 0.6 : 0);
    lamps.setMatrixAt(k++, m);
  }
  lampGeo.setAttribute('glow', new THREE.InstancedBufferAttribute(glow, 1));
  lamps.instanceMatrix.needsUpdate = true;
  panel.add(lamps);
  // truss frame around the panel and a lift mast down to the ground
  panel.updateMatrixWorld(true);
  const mk = beams.mark();
  const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new THREE.Vector3(x * (Wp / 2 + 0.15), y * (Hp / 2 + 0.15), -0.1));
  for (let i = 0; i < 4; i++) beams.truss(c[i], c[(i + 1) % 4], 0.35);
  beams.transformSince(mk, panel.matrixWorld);
  beams.truss({ x: pos.x, y: 0, z: pos.z - 1.2 }, { x: pos.x, y: pos.y - Hp / 2, z: pos.z - 0.6 }, 0.6);
  beams.box({ x: pos.x, y: 0.4, z: pos.z - 1.2 }, { x: 2.6, y: 0.8, z: 3.2 });
  return g;
}

// ------------------------------------------------------------------ scaffolding below/behind ramps
function buildRampScaffold(ramp: CurvedRamp, S: ReturnType<typeof buildRampGeometry>['samples'], beams: BeamBatch, arms: BeamBatch): void {
  const mk = beams.mark();
  const mkArms = arms.mark();
  const hw = ramp.width / 2 + 0.25;
  const t = ramp.thickness;
  if (ramp.kind === 'wallRamp') {
    // columns under the concave sweep
    const zMaxArc = Math.max(...S.map((s) => s.z));
    for (let z = 2; z < zMaxArc; z += 1.6) {
      const b = backsideAt(S.filter((s) => s.thetaRad <= Math.PI / 2 + 1e-3), t, z);
      if (!b || b.y < 0.6) continue;
      for (const x of [-hw, 0, hw]) beams.beam({ x, y: 0, z }, { x, y: b.y, z }, 0.16);
      beams.beam({ x: -hw, y: b.y, z }, { x: hw, y: b.y, z }, 0.12);
      for (let y = 2; y < b.y - 0.5; y += 2.4) beams.beam({ x: -hw, y, z }, { x: hw, y, z }, 0.07);
      if (z + 1.6 < zMaxArc) {
        const b2 = backsideAt(S.filter((s) => s.thetaRad <= Math.PI / 2 + 1e-3), t, z + 1.6);
        if (b2) for (const x of [-hw, hw]) beams.beam({ x, y: 0, z }, { x, y: Math.min(b.y, b2.y), z: z + 1.6 }, 0.07);
      }
    }
    // tower behind the vertical section and the overhang, as tall as the lip
    const top = S[S.length - 1];
    const zBack = zMaxArc + t + 0.2, depth = 2.5, H = top.y + 1.5;
    for (const z of [zBack, zBack + depth / 2, zBack + depth]) for (const x of [-hw - 0.6, 0, hw + 0.6]) beams.beam({ x, y: 0, z }, { x, y: H, z }, 0.16);
    for (let y = 0.4; y <= H; y += 2.2) {
      for (const z of [zBack, zBack + depth / 2, zBack + depth]) beams.beam({ x: -hw - 0.6, y, z }, { x: hw + 0.6, y, z }, 0.09);
      for (const x of [-hw - 0.6, 0, hw + 0.6]) beams.beam({ x, y, z: zBack }, { x, y, z: zBack + depth }, 0.09);
      for (const x of [-hw - 0.6, hw + 0.6]) beams.beam({ x, y, z: zBack }, { x, y: Math.min(H, y + 2.2), z: zBack + depth / 2 }, 0.06);
    }
    // overhang support arms reaching over the lip
    for (const x of [-hw, hw]) {
      for (const s of S.filter((x2) => x2.thetaRad > Math.PI / 2 + 0.1)) {
        if (Math.round(s.s * 2) % 3 !== 0) continue;
        const n = { y: Math.cos(s.thetaRad), z: -Math.sin(s.thetaRad) };
        arms.beam({ x, y: s.y - n.y * t, z: s.z - n.z * t }, { x, y: H, z: zBack }, 0.08);
      }
    }
  } else {
    // kicker: light frame on the lip end
    const lip = S[S.length - 1];
    for (const x of [-hw, hw]) beams.beam({ x, y: 0, z: lip.z + 0.2 }, { x, y: lip.y + 0.4, z: lip.z + 0.2 }, 0.14);
  }
  const F = new THREE.Matrix4().compose(new THREE.Vector3(ramp.origin.x, ramp.origin.y, ramp.origin.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ramp.headingDeg * DEG), new THREE.Vector3(1, 1, 1));
  beams.transformSince(mk, F);
  arms.transformSince(mkArms, F);
}
