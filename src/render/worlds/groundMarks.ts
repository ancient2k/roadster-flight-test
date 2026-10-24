// tyre tracks and jet scour on loose ground (regolith, Martian soil, desert sand). Like the Apollo
// boot prints (footprints.ts) the decals reuse the terrain's albedo graph and only re-shade it: a rut is
// a groove of the physics' sinkage depth with the tread imprint and two pushed-up berms (procedural
// normal), the disturbed soil a little darker; a scour spot is the radially swept, smoothed patch a jet
// leaves (brighter on the Moon – Apollo blast zones in LROC images –, darker on Mars where the bright
// dust is blown off the darker soil).
import * as THREE from 'three/webgpu';
import {
  attribute, uniform, float, vec2, vec3, uv, normalMap, smoothstep, abs, cos, sin, exp, mix, length, positionWorld,
  cameraPosition, Fn, max, clamp, atan, fract, select, positionLocal, mx_noise_float, dot,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { SurfaceKind } from '../../shared/environment';
import type { VehicleState } from '../../shared/types';
import { isLooseSoil, wheelSinkM, wheelSpec } from '../fxParams';
import { fxLight } from '../fx/fxLight';
import { SCOUR_STRIDE, SEG_STRIDE, ScourRing, TrackRing } from './trackRing';

type N1 = Node<'float'>;
type N3 = Node<'vec3'>;

/**
 * Decal vertex pulled towards the camera along the view ray (its screen position stays the same): the
 * rendered terrain is a morphing LOD mesh that lies a few cm above or below the height field, so a fixed
 * lift either floats or sinks in. (positionLocal is already instanced here; the marks sit in world space.)
 */
const pullToCamera = (): N3 => {
  const toCam = cameraPosition.sub(positionLocal);
  const d = length(toCam);
  return positionLocal.add(toCam.div(max(d, float(1e-3))).mul(d.mul(0.012).add(0.06))) as unknown as N3;
};

/** Quad width relative to the tyre width (room for the berms). */
const QUAD_W = 1.8;
/** Vertices per side of a draped scour patch. */
const SCOUR_GRID = 20;
/** Half size of a scour grid relative to the spot radius (rays and the downstream lobe reach past it). */
const SCOUR_EXTENT = 1.7;

export interface GroundMarksOpts {
  surface: SurfaceKind;
  /** Bare terrain height (m). */
  height: (x: number, z: number) => number;
  groundColor: N3;
  /** Track segments (all four wheels). */
  capacity?: number;
  scourCapacity?: number;
}

/** Darkening of disturbed soil per soil type (multiplier on the albedo; Mars loses some of its red dust). */
function disturbedTint(kind: SurfaceKind): [number, number, number] {
  if (kind === 'regolith') return [0.86, 0.86, 0.86];
  if (kind === 'mars_soil') return [0.8, 0.74, 0.7];
  return [0.8, 0.77, 0.74];
}

export class GroundMarks {
  readonly group = new THREE.Group();
  readonly ring: TrackRing;
  readonly scours: ScourRing;
  private tracks: THREE.InstancedMesh;
  private tracksRear: THREE.InstancedMesh;
  private readonly M0 = new THREE.Matrix4().makeScale(0, 0, 0);
  private aTrack: THREE.InstancedBufferAttribute;
  private aSeq: THREE.InstancedBufferAttribute;
  private uTotal = uniform(0);
  private scourMesh: THREE.Mesh;
  private scourPos: THREE.BufferAttribute;
  private scourAttr: THREE.BufferAttribute;
  private scourDirAttr: THREE.BufferAttribute;
  /** dose-weighted outflow direction (x, z) and total dose per scour slot. */
  private scourDir: Float32Array;
  private scourDose: Float32Array;
  private carX = 0;
  private carZ = 0;
  readonly loose: boolean;
  /** Erase dose gathered per scour spot (several jets hit different spots in one frame). */
  private eraseAcc = new Map<number, number>();
  /** Optional: blow away other ground marks (Apollo boot prints) inside a scour spot. */
  onScour: ((x: number, z: number, r: number) => void) | null = null;

  constructor(private o: GroundMarksOpts) {
    this.group.name = 'GroundMarks';
    this.loose = isLooseSoil(o.surface);
    const cap = o.capacity ?? 6000;
    this.ring = new TrackRing(cap, 4);
    this.scours = new ScourRing(o.scourCapacity ?? 24);
    this.scourDir = new Float32Array(this.scours.capacity * 2);
    this.scourDose = new Float32Array(this.scours.capacity);

    // ---------------- tracks
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    this.aTrack = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);   // s0, len, depth, strength
    this.aSeq = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);     // seq, tyre width
    for (const a of [this.aTrack, this.aSeq]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aTrack', this.aTrack);
    g.setAttribute('aSeq', this.aSeq);
    const m = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    m.name = 'TyreTrack';
    const tr = attribute<'vec4'>('aTrack', 'vec4'), sq = attribute<'vec2'>('aSeq', 'vec2');
    const tyreW = sq.y, depth = tr.z;
    const quadW = tyreW.mul(QUAD_W);
    // rut cross-section and tread imprint (metres; x across, y along the track)
    const hw = tyreW.mul(0.5);
    const tread = clamp(depth.div(0.012), 0.25, 1);
    const dist = length(positionWorld.sub(cameraPosition));
    // (the tread imprint fades before its 5 cm pitch drops under ~2 px – moiré under TRAA – and the
    // relief before the rut shading turns into flickering lines far away)
    const imprintFade = float(1).sub(smoothstep(float(9), float(26), dist));
    // ("tracks partly look like rails"): the rut is no longer two straight walls
    // with a smooth floor. Shallow walls whose edge wanders at two scales, berms of broken clods instead
    // of a smooth bead, and a tread imprint – chevron blocks with lamellae and three circumferential ribs
    // – that carries the shading of the floor in the low sun, as in the Apollo LRV and Curiosity tracks.
    // (loose dry sand flows aside into a real berm; the cohesive regolith and Martian soil mostly compact)
    const bermK = o.surface === 'sand' ? 0.35 : o.surface === 'mars_soil' ? 0.2 : 0.12;
    const height = Fn(([x, y]: [N1, N1]) => {
      const ax = abs(x);
      const side = x.sign();
      const n1 = mx_noise_float(vec3(y.mul(1.9), side.mul(7), float(0))) as unknown as N1;
      const n2 = mx_noise_float(vec3(y.mul(8.3), side.mul(3), float(1))) as unknown as N1;
      const edge = hw.mul(n1.mul(0.14).add(n2.mul(0.06)).add(1.02));
      // floor → wall: a wide smooth shoulder (≈ 40 % of the half width) instead of a step
      const groove = smoothstep(edge.mul(1.12), edge.mul(0.25), ax).mul(depth).negate();
      // pushed-up soil: a broken ridge of clods (thresholded noise), wider and lower than before
      const clod = smoothstep(float(0.3), float(0.8), (mx_noise_float(vec3(y.mul(13), x.mul(13), float(5))) as unknown as N1).mul(0.5).add(0.5));
      const bermD = ax.sub(edge.mul(1.2)).div(hw.mul(0.3));
      const berm = exp(bermD.mul(bermD).negate()).mul(depth.mul(bermK).add(0.001)).mul(clod.mul(1.2).add(0.05));
      // tread imprint (ridges in the soil where the tyre's grooves were): chevron blocks pointing forward
      // (5.5 cm pitch, 30° arms), fine lamellae across the blocks, three circumferential ribs
      const v = y.add(ax.mul(0.58)).div(0.055);
      const chev = smoothstep(float(0.18), float(0.42), abs(fract(v).sub(0.5)));
      const lam = smoothstep(float(0.75), float(0.95), sin(y.add(ax.mul(0.3)).mul(Math.PI * 2 / 0.016)));
      const ribs = smoothstep(float(0.85), float(0.97), cos(x.mul(Math.PI * 2).div(tyreW.mul(0.32))));
      const inside = smoothstep(hw.mul(0.92), hw.mul(0.7), ax);
      const imprint = chev.mul(0.0028).add(lam.mul(chev).mul(0.0006)).add(ribs.mul(0.0018));
      return groove.add(berm).add(imprint.mul(tread).mul(inside).mul(imprintFade));
    });
    const lx = uv().x.sub(0.5).mul(quadW), ly = tr.x.add(uv().y.mul(tr.y));
    const e = 0.004;
    const h0 = height(lx, ly) as unknown as N1;
    const dhx = (height(lx.add(e), ly) as unknown as N1).sub(h0).div(e);
    const dhy = (height(lx, ly.add(e)) as unknown as N1).sub(h0).div(e);
    const nT = vec3(dhx.negate(), dhy.negate(), float(1)).normalize();
    // (weakened the normal to 0.6 against the rail look; fixes the shape instead and keeps the
    // full relief near the camera, easing it off with distance)
    m.normalNode = normalMap(nT.mul(0.5).add(0.5) as never, float(0.85).sub(smoothstep(float(25), float(90), dist).mul(0.6)) as never) as never;
    const age = clamp(float(cap).sub(this.uTotal.sub(1).sub(sq.x)).div(cap * 0.25), 0, 1);
    const distFade = float(1).sub(smoothstep(float(70), float(140), dist));
    const ax = abs(lx);
    // (opaque only where the rut and its berms change the ground – the flat margin of a newer quad
    // used to paint plain soil over an older rut it crossed: the notches where tracks overlapped)
    const cover = smoothstep(hw.mul(1.6), hw.mul(1.15), ax);
    const inTyre = smoothstep(hw.mul(1.1), hw.mul(0.75), ax);
    const t = disturbedTint(o.surface);
    const dark = mix(float(0.55), float(1), clamp(depth.div(0.02), 0, 1));
    // (the compacted floor is darker in its tread blocks than on the ridges between them; the berm's loose,
    // freshly turned soil a little darker too)
    const tint = mix(vec3(1, 1, 1), vec3(t[0], t[1], t[2]), inTyre.mul(dark).add(smoothstep(hw.mul(1.0), hw.mul(1.35), ax).mul(smoothstep(hw.mul(1.8), hw.mul(1.4), ax)).mul(0.35)).min(1));
    m.colorNode = o.groundColor.mul(tint);
    m.positionNode = pullToCamera();
    m.roughnessNode = float(0.97);
    m.metalnessNode = float(0);
    // (a long segment (> 2 m) bridges a real hop – at 1/6 g the wheels leave the ground. Drawn as
    // one straight quad it cut across curves as a rectangle; now the rut ends softly where the tyre left
    // the ground and starts again where it came down. Short bridges of a flickering contact stay drawn:
    // their chord lies within a few cm of the arc)
    const along = uv().y.mul(tr.y), endD = along.min(tr.y.sub(along));
    const hop = smoothstep(float(1.7), float(2.1), tr.y).mul(smoothstep(float(0.3), float(0.6), endD));
    m.opacityNode = cover.mul(tr.w).mul(age).mul(distFade).mul(float(1).sub(hop));
    // (one mesh per axle – the rear tyres roll over the front ruts and must win the overlap. In one
    // mesh the newer instance won, so front and rear segments alternated along a curve: rectangular notches)
    this.tracks = new THREE.InstancedMesh(g, m, cap);
    this.tracksRear = new THREE.InstancedMesh(g, m, cap);
    for (const [t, name, order] of [[this.tracks, 'TyreTracksFront', -3], [this.tracksRear, 'TyreTracksRear', -2]] as const) {
      t.name = name;
      t.count = 0;
      t.frustumCulled = false;
      t.receiveShadow = true;
      t.castShadow = false;
      t.renderOrder = order;
      t.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(t);
    }

    // ---------------- scour spots: draped grids (one merged geometry)
    const sc = this.scours.capacity, nv = SCOUR_GRID * SCOUR_GRID;
    const sg = new THREE.BufferGeometry();
    this.scourPos = new THREE.BufferAttribute(new Float32Array(sc * nv * 3), 3);
    this.scourAttr = new THREE.BufferAttribute(new Float32Array(sc * nv * 4), 4);   // local x, local z (/R), strength, seed
    this.scourDirAttr = new THREE.BufferAttribute(new Float32Array(sc * nv * 2), 2); // outflow direction × anisotropy
    for (const a of [this.scourPos, this.scourAttr, this.scourDirAttr]) a.setUsage(THREE.DynamicDrawUsage);
    const nrm = new Float32Array(sc * nv * 3), uvs = new Float32Array(sc * nv * 2);
    const idx: number[] = [];
    for (let s = 0; s < sc; s++) {
      for (let j = 0; j < SCOUR_GRID; j++) for (let i = 0; i < SCOUR_GRID; i++) {
        const v = s * nv + j * SCOUR_GRID + i;
        nrm[v * 3 + 1] = 1;
        uvs[v * 2] = i / (SCOUR_GRID - 1); uvs[v * 2 + 1] = j / (SCOUR_GRID - 1);
        if (i < SCOUR_GRID - 1 && j < SCOUR_GRID - 1) idx.push(v, v + SCOUR_GRID, v + 1, v + 1, v + SCOUR_GRID, v + SCOUR_GRID + 1);
      }
    }
    sg.setAttribute('position', this.scourPos);
    sg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    sg.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    sg.setAttribute('aScour', this.scourAttr);
    sg.setAttribute('aScourDir', this.scourDirAttr);
    sg.setIndex(idx);
    sg.setDrawRange(0, 0);
    // ("scour like a round decal"): a multiplicative decal – the frame buffer is
    // multiplied by an albedo/relief factor (src·dst), so the terrain keeps its own texture, rocks and
    // lighting and only gets brighter (Moon: LROC blast zones) or darker (Mars: the bright airfall dust
    // is blown off; sand: slightly). The shape: an irregular core stretched along the outflow (the jet
    // came from the car), a noisy rim, radial rays of different length reaching past it, fine combing
    // streaks inside – all faded out softly, no circle anywhere.
    const sm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    sm.name = 'JetScour';
    sm.fog = false;
    sm.blending = THREE.CustomBlending;
    sm.blendEquation = THREE.AddEquation;
    sm.blendSrc = THREE.DstColorFactor;
    sm.blendDst = THREE.ZeroFactor;
    sm.blendSrcAlpha = THREE.ZeroFactor;
    sm.blendDstAlpha = THREE.OneFactor;
    const sa = attribute<'vec4'>('aScour', 'vec4'), sdir = attribute<'vec2'>('aScourDir', 'vec2');
    const q = vec2(sa.x, sa.y), r = length(q), seed = sa.w;
    // (the visible change saturates early: the loose top layer is gone after a short blast – a few
    // hundredths of dose already show, as under a briefly hovering car; more only widens the spot)
    const str = float(1).sub(exp(sa.z.mul(-12)));
    const ang = atan(q.y, q.x);
    const qn = q.div(max(r, float(1e-4)));
    // angular noise on the unit circle (continuous through ±π)
    const circ = (f: number, k: number) => (mx_noise_float(vec3(cos(ang).mul(f), sin(ang).mul(f), seed.mul(17).add(k))) as unknown as N1);
    const wob = circ(1.6, 0).mul(0.5).add(circ(4.5, 3).mul(0.22));
    const lump = (mx_noise_float(vec3(q.x.mul(3.2), q.y.mul(3.2), seed.mul(29))) as unknown as N1);
    // boundary radius: ragged, longer downstream, shorter upstream
    const b = float(0.82).mul(float(1).add(wob.mul(0.45))).mul(float(1).add(dot(qn, sdir).mul(0.55))).add(lump.mul(0.08)).max(0.15);
    const core = smoothstep(b, b.mul(0.35), r);
    // rays: narrow sectors of high-frequency angular noise, each reaching its own distance past the rim
    const rayN = circ(8, 7).mul(0.6).add(circ(19, 13).mul(0.25)).mul(0.5).add(0.5), rayL = circ(5, 11).mul(0.5).add(0.5);
    const ray = smoothstep(float(0.5), float(0.8), rayN).mul(float(1).add(dot(qn, sdir).mul(0.6)).max(0));
    const reach = b.mul(float(1.25).add(rayL.mul(0.9)));
    const rays = ray.mul(smoothstep(reach, b.mul(0.6), r)).mul(smoothstep(b.mul(0.2), b.mul(0.7), r)).mul(0.8);
    // fine radial combing inside (the wall jet scours grooves outwards)
    const comb = sin(ang.mul(53).add(circ(9, 5).mul(6))).mul(0.5).add(0.5);
    const mottle = (mx_noise_float(vec3(q.x.mul(11), q.y.mul(11), seed.mul(31))) as unknown as N1).mul(0.5).add(0.5);
    const I = str.mul(core.max(rays.mul(0.75))).mul(mix(float(0.75), float(1.15), mottle)).mul(mix(float(0.85), float(1.1), comb.mul(core)));
    // thin deposit just beyond the core (the material that left the core)
    const depR = r.sub(b.mul(1.12)).div(b.mul(0.18));
    const deposit = exp(depR.mul(depR).negate()).mul(str).mul(float(1).sub(ray));
    const sign = o.surface === 'regolith' ? 1 : -1;
    // (Moon: the brightening sits in the tone mapper's shoulder on the bright regolith – a factor of 2.5 in
    // the core reads as the ~30 % brighter blast zone of the LROC images; darkening is not compressed)
    const amp = o.surface === 'regolith' ? 1.5 : o.surface === 'mars_soil' ? 0.34 : 0.22;
    // Mars: the exposed soil under the bright dust is darker and less red (stronger loss in red)
    // (weights on the darkening: red loses most – a review caught the inverted order)
    const chroma = o.surface === 'mars_soil' ? vec3(1.25, 1.1, 1.0) : vec3(1, 1, 1);
    let albedo = vec3(1, 1, 1).add(chroma.mul(I.mul(sign * amp))) as unknown as N3;
    albedo = albedo.mul(float(1).sub(deposit.mul(sign * 0.06))) as unknown as N3;
    // relief: the combing grooves tilt the surface tangentially – relit as a ratio to the flat ground
    // with the sun (fx sun direction, towards the sun), so shadows and texture below stay the terrain's
    // (fxLight.sunDir.xyz is the light's travel direction: towards the sun is its negation)
    const sun = (fxLight.sunDir as unknown as Node<'vec4'>).xyz.negate();
    const tang = vec2(qn.y.negate(), qn.x);
    const slope = cos(ang.mul(53).add(circ(9, 5).mul(6))).mul(0.07).mul(core).mul(str).mul(mottle);
    const nG = vec3(tang.x.mul(slope).negate(), float(1), tang.y.mul(slope).negate()).normalize();
    const flat = max(sun.y, float(0.05));
    const shade = clamp(max(dot(nG, sun), float(0)).add(0.08).div(flat.add(0.08)), 0.8, 1.25);
    const sDist = length(positionWorld.sub(cameraPosition));
    const relief = mix(shade, float(1), smoothstep(float(15), float(40), sDist));
    const far = float(1).sub(smoothstep(float(150), float(300), sDist)).mul(select(sa.z.greaterThan(0.001), float(1), float(0)));
    sm.colorNode = mix(vec3(1, 1, 1), albedo.mul(relief), far);
    sm.opacityNode = float(0);
    sm.positionNode = pullToCamera();
    this.scourMesh = new THREE.Mesh(sg, sm);
    this.scourMesh.name = 'JetScour';
    this.scourMesh.frustumCulled = false;
    this.scourMesh.receiveShadow = false;
    this.scourMesh.renderOrder = -1;
    this.group.add(this.scourMesh);
  }

  /** Statistics for tests/HUD. */
  stats(): { segments: number; total: number; scours: number } {
    return { segments: this.ring.count, total: this.ring.total, scours: this.scours.count };
  }

  /** Is the wheel on the bare loose ground (not on a landmark, a pyramid or a prop)? */
  /** Roads painted onto the soil (level editor): no ruts there. */
  paved: ((x: number, z: number) => boolean) | null = null;

  private onSoil(x: number, y: number, z: number): boolean {
    if (this.paved?.(x, z)) return false;
    const h = this.o.height(x, z);
    return Number.isFinite(h) && y - h < 0.15;
  }

  private readonly M = new THREE.Matrix4();
  private readonly vx = new THREE.Vector3();
  private readonly vy = new THREE.Vector3();
  private readonly vz = new THREE.Vector3();
  private readonly vp = new THREE.Vector3();

  /** Per frame: lay new track segments under the wheels in contact with loose ground. */
  update(s: VehicleState): void {
    if (!this.loose) return;
    this.carX = s.pos.x; this.carZ = s.pos.z;
    for (let w = 0; w < s.wheels.length && w < 4; w++) {
      const ws = s.wheels[w], c = ws.contactPoint;
      const active = ws.contact && this.onSoil(c.x, c.y, c.z);
      const depth = active ? wheelSinkM(ws, w, s.speedMs, this.o.surface) : 0;
      this.ring.step(w, c, active, wheelSpec(w).width, depth);
    }
    this.upload();
  }

  /** Jet hits the loose ground: scour spot of radius r, `dose` = strength gained this frame (0..1). */
  scour(x: number, z: number, r: number, dose: number): void {
    if (!this.loose || dose <= 0) return;
    const y = this.o.height(x, z);
    if (!Number.isFinite(y)) return;
    const total = this.scours.total;
    const i = this.scours.add(x, y, z, r, dose);
    if (this.scours.total !== total) { this.scourDir[i * 2] = this.scourDir[i * 2 + 1] = 0; this.scourDose[i] = 0; }
    // the jet comes from the car – its wall jet runs away from it (a vertical lift jet right under
    // the car spreads all around: no direction)
    const dx = x - this.carX, dz = z - this.carZ, dl = Math.hypot(dx, dz);
    const w = dose * Math.min(1, Math.max(0, (dl - 0.3) / 1.5));
    if (dl > 1e-3) { this.scourDir[i * 2] += dx / dl * w; this.scourDir[i * 2 + 1] += dz / dl * w; }
    this.scourDose[i] += dose;
    this.writeScour(i);
    // the jet sweeps the tracks (and boot prints) away where it blows hardest (batched: an erase
    // re-uploads the touched segments)
    const acc = (this.eraseAcc.get(i) ?? 0) + dose;
    if (acc >= 0.08) { this.ring.erase(x, z, r * 0.8, acc * 1.5); this.eraseAcc.delete(i); } else this.eraseAcc.set(i, acc);
    const k = i * SCOUR_STRIDE;
    if (this.scours.data[k + 4] > 0.5) this.onScour?.(x, z, r * 0.6);
  }

  private writeScour(i: number): void {
    const D = this.scours.data, k = i * SCOUR_STRIDE, nv = SCOUR_GRID * SCOUR_GRID;
    const cx = D[k], cz = D[k + 2], R = D[k + 3], str = D[k + 4], seed = D[k + 5];
    const P = this.scourPos.array as Float32Array, A = this.scourAttr.array as Float32Array, Dr = this.scourDirAttr.array as Float32Array;
    // outflow direction (dose-weighted) and how one-sided it is: 0 = all around, 1 = one direction
    const sum = Math.max(1e-6, this.scourDose[i]);
    const ax = this.scourDir[i * 2] / sum, az = this.scourDir[i * 2 + 1] / sum;
    const E = SCOUR_EXTENT;
    for (let j = 0; j < SCOUR_GRID; j++) for (let ii = 0; ii < SCOUR_GRID; ii++) {
      const v = i * nv + j * SCOUR_GRID + ii;
      const lx = ((ii / (SCOUR_GRID - 1)) * 2 - 1) * E, lz = ((j / (SCOUR_GRID - 1)) * 2 - 1) * E;
      const x = cx + lx * R, z = cz + lz * R;
      P[v * 3] = x; P[v * 3 + 1] = this.o.height(x, z) + 0.03; P[v * 3 + 2] = z;
      A[v * 4] = lx; A[v * 4 + 1] = lz; A[v * 4 + 2] = str; A[v * 4 + 3] = seed;
      Dr[v * 2] = ax; Dr[v * 2 + 1] = az;
    }
    for (const a of [this.scourPos, this.scourAttr, this.scourDirAttr]) {
      // (no clearUpdateRanges: three drops the ranges after the upload; clearing here would lose a range
      // written by an earlier update() of the same rendered frame)
      a.addUpdateRange(i * nv * a.itemSize, nv * a.itemSize);
      a.needsUpdate = true;
    }
    const geo = this.scourMesh.geometry;
    geo.setDrawRange(0, this.scours.count * (SCOUR_GRID - 1) * (SCOUR_GRID - 1) * 6);
  }

  private upload(): void {
    const dirty = this.ring.takeDirty();
    this.uTotal.value = this.ring.total;
    if (!dirty) return;
    const [from, to] = dirty;
    const D = this.ring.data, T = this.aTrack.array as Float32Array, S = this.aSeq.array as Float32Array;
    for (let i = from; i <= to; i++) {
      const k = i * SEG_STRIDE;
      const x0 = D[k], z0 = D[k + 2], x1 = D[k + 3], z1 = D[k + 5];
      const y0 = this.o.height(x0, z0), y1 = this.o.height(x1, z1);
      const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      // local terrain normal at the midpoint
      const e = 0.4, h = this.o.height;
      this.vy.set(h(mx - e, mz) - h(mx + e, mz), 2 * e, h(mx, mz - e) - h(mx, mz + e)).normalize();
      this.vz.set(x1 - x0, y1 - y0, z1 - z0).normalize();
      this.vy.addScaledVector(this.vz, -this.vy.dot(this.vz)).normalize();
      this.vx.crossVectors(this.vy, this.vz).normalize();
      const w = D[k + 6] * QUAD_W, l = len + 0.06;
      this.vp.set(mx, (y0 + y1) / 2 + 0.02, mz);
      this.M.makeBasis(this.vx.multiplyScalar(w), this.vy, this.vz.multiplyScalar(l)).setPosition(this.vp);
      const rear = D[k + 11] >= 2;
      this.tracks.setMatrixAt(i, rear ? this.M0 : this.M);
      this.tracksRear.setMatrixAt(i, rear ? this.M : this.M0);
      T[i * 4] = D[k + 8]; T[i * 4 + 1] = l; T[i * 4 + 2] = D[k + 7]; T[i * 4 + 3] = D[k + 9];
      S[i * 2] = D[k + 10]; S[i * 2 + 1] = D[k + 6];
    }
    const n = to - from + 1;
    // (ranges accumulate until three uploads and clears them)
    for (const t of [this.tracks, this.tracksRear]) { t.instanceMatrix.addUpdateRange(from * 16, n * 16); t.instanceMatrix.needsUpdate = true; t.count = this.ring.count; }
    for (const a of [this.aTrack, this.aSeq]) { a.addUpdateRange(from * a.itemSize, n * a.itemSize); a.needsUpdate = true; }
  }

  /** New session / teleport: do not connect the old contact points to the new ones. */
  breakTracks(): void { this.ring.breakAll(); }

  dispose(): void {
    this.group.removeFromParent();
    this.tracks.geometry.dispose();
    (this.tracks.material as THREE.Material).dispose();
    this.tracks.dispose();
    this.tracksRear.dispose();
    this.scourMesh.geometry.dispose();
    (this.scourMesh.material as THREE.Material).dispose();
  }
}
