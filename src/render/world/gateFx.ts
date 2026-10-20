// 0-60 gate smoke curtain. In the stream (1266-1268 s, out/renders/r8_stream_z60_plume.jpg)
// a row of nozzles under the gate lintel blows dense white smoke straight down the moment the car
// launches; before the launch the opening only shows the LED screen. The curtain is world geometry of
// the gate (src/render/fx belongs to the particle/volume effects), driven by one uniform: the scene
// time of the launch. The trigger watches the car on the 0-60 lane (FloodRig.update calls it every
// frame with the car position).
import * as THREE from 'three/webgpu';
import {
  uniform, uv, float, vec3, mix, smoothstep, exp, mx_noise_float, clamp, hash,
} from 'three/tsl';
import { siteFor } from '../../shared/track';
import { SCENE_TIME } from './materials';

/** Scene time (SCENE_TIME) at which the gate nozzles opened; far in the past = curtain off. */
export const GATE_JET_T0 = uniform(-1e4);

const spawn = siteFor('zero60').spawn.pos;
let armed = true;

/**
 * Called once per frame with the car position. Opens the nozzles when the car leaves the 0-60 start
 * (≥ 0.15 m along the lane, ≈ 0.1 s after the launch at 3.4 g) and re-arms when a new run puts the
 * car back on the start.
 */
export function updateGateFx(car: THREE.Vector3): void {
  const onLane = Math.abs(car.x - spawn.x) < 4 && car.z > spawn.z - 3 && car.z < spawn.z + 30;
  const moved = car.z - spawn.z;
  if (!onLane) { armed = true; return; }
  if (moved < 0.05) {
    armed = true;
    GATE_JET_T0.value = -1e4;
    return;
  }
  if (armed && moved >= 0.15) {
    armed = false;
    GATE_JET_T0.value = SCENE_TIME.value - 0.1;
  }
}

/** Nozzle activity over time since opening: on within 0.15 s, full for ~1.8 s, gone after ~4.5 s. */
function activity() {
  const t = SCENE_TIME.sub(GATE_JET_T0);
  return smoothstep(float(0), float(0.15), t).mul(smoothstep(float(4.5), float(1.8), t));
}

/**
 * Three layered planes across the passage (OW × OH, local gate frame: front face z = 0, passage
 * towards -z). Each layer: N downward jets from the lintel, narrow at the nozzle, widening and
 * merging towards the floor, a turbulent texture streaming downwards and a billow along the floor.
 * Normal alpha blending (smoke occludes, it does not glow); soft fades at the jambs, so no straight
 * rectangular edges.
 */
export function buildGateCurtain(OW: number, OH: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'GateSmokeCurtain';
  const N = 8, pitch = (OW - 0.6) / N;
  const act = activity();
  const layers = [-0.55, -1.3, -2.05];
  layers.forEach((z, li) => {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const u = uv();
    const x = u.x.sub(0.5).mul(OW), y = u.y.mul(OH);              // local metres, y = 0 at the floor
    const fall = float(1).sub(u.y);                                 // 0 at the nozzles, 1 at the floor
    const t = SCENE_TIME;
    // turbulence streaming down at ~6 m/s, slower and broader near the floor
    const n1 = mx_noise_float(vec3(x.mul(2.2), y.mul(1.4).add(t.mul(6.0)), float(li * 3.1).add(t.mul(0.4)))).mul(0.5).add(0.5);
    const n2 = mx_noise_float(vec3(x.mul(5.5), y.mul(3.5).add(t.mul(7.5)), float(li * 1.7))).mul(0.5).add(0.5);
    const wob = mx_noise_float(vec3(y.mul(0.6).add(t.mul(2.0)), float(li), 0)).mul(0.18);
    // jets: the nozzle row is staggered per layer so the layers do not line up
    const off = (li * 0.37) % 1;
    const cell = x.div(pitch).add(N / 2 - 0.5 + off);
    const dx = cell.sub(cell.round()).mul(pitch).add(wob.mul(fall));
    const w = fall.mul(0.42).add(0.07);
    // nozzles differ (flow, slight lean): irregular comb instead of identical cones
    const jet = cell.round().add(li * 13);
    const gain = hash(jet).mul(0.7).add(0.5);
    let dens = exp(dx.sub(hash(jet.add(5)).sub(0.5).mul(0.35).mul(fall)).div(w).pow(2).negate()).mul(fall.mul(0.6).add(0.55)).mul(gain) as unknown as ReturnType<typeof float>;
    // the jets merge into a wall below ~1.2 m and billow along the floor
    const merge = smoothstep(float(0.45), float(0.95), fall);
    dens = dens.max(merge.mul(n1.mul(0.7).add(0.45))) as unknown as ReturnType<typeof float>;
    dens = dens.mul(n1.mul(0.6).add(0.55)).mul(n2.mul(0.35).add(0.75)) as unknown as ReturnType<typeof float>;
    // soft jambs and a ragged top under the lintel (the lintel covers the nozzles)
    const edge = smoothstep(float(0), float(0.07), u.x).mul(smoothstep(float(1), float(0.93), u.x));
    const top = smoothstep(float(1.0), float(0.94), u.y.add(n2.mul(0.03)));
    const alpha = clamp(float(1).sub(exp(dens.mul(act).mul(edge).mul(top).mul(4.0).negate())), 0, 0.97);
    // lit by the battery in front of the gate: bright crowns, a little darker deep inside / low
    const shade = mix(float(0.62), float(1.0), n1).mul(mix(float(1.0), float(0.82), float(li / 2)));
    m.colorNode = vec3(0.85, 0.87, 0.9).mul(shade);
    m.opacityNode = alpha;
    m.fog = true;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(OW, OH, 1, 1), m);
    p.position.set(0, OH / 2, z);
    p.renderOrder = 3;
    p.frustumCulled = true;
    g.add(p);
  });
  return g;
}

