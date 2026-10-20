// Under-expanded cold-gas jets with Mach diamonds (TSL). One axial billboard ribbon (side views,
// carries the shock-cell pattern) plus one soft cone shell (end-on views) per nozzle.
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  uniform, uv, float, vec3, vec4, abs, exp, pow, smoothstep, fract, mx_noise_float, normalize, cross,
  positionLocal, cameraPosition, modelWorldMatrixInverse, dot, clamp, mix, max, normalView, positionView,
  modelViewMatrix, modelWorldMatrix, varying,
} from 'three/tsl';
import { mediumLight } from './fxLight';
import type { UFloat } from '../tslTypes';
import { ROADSTER } from '../../shared/roadster';
import type { NozzleState } from '../../shared/types';
import { plumeParams, type PlumeParams } from '../fxParams';

type U = UFloat;

interface JetUniforms { length: U; r0: U; r1: U; intensity: U; spacing: U; diamond: U; cells: U; seed: U; light: U; time: U }

function makeUniforms(seed: number, time: U): JetUniforms {
  return {
    length: uniform(0), r0: uniform(0.04), r1: uniform(0.4), intensity: uniform(0), spacing: uniform(0.12),
    diamond: uniform(0), cells: uniform(5), seed: uniform(seed), light: uniform(1), time,
  };
}

/** Visible plume radius at distance z (m) from the exit: a 4-8° turbulent mixing layer. */
function plumeRadius(u: JetUniforms, z: Node<'float'>): Node<'float'> {
  const spread = max(u.r1.sub(u.r0).div(max(u.length, float(0.05))), float(0.12)); // ≥ tan 7° (stream)
  return u.r0.mul(1.3).add(z.mul(spread)).add(0.015);
}

/** Flood/ambient light scattered by the plume at jet-local z (computed per vertex). */
function plumeLight(z: Node<'float'>) {
  const pw = modelWorldMatrix.mul(vec4(0, 0, z, 1)).xyz;
  const ml = mediumLight(pw as Node<'vec3'>, 0.7);
  return varying(ml.radiance.add(ml.red.mul(0.6)));
}

/** Ribbon: PlaneGeometry(1,1,1,N) re-positioned in the vertex stage to face the camera around the jet axis (+Z). */
function makeRibbon(u: JetUniforms): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(1, 1, 1, 48);
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const W = 1.75; // ribbon half-width in plume radii (room for the soft, turbulent edge)
  const along = uv().y;                     // 0 at the nozzle exit
  const across = uv().x.sub(0.5).mul(2);    // -1..1
  const z = along.mul(u.length);
  // camera position in jet-local space. One facing plane per jet, turned towards the camera as seen
  // from the plume's middle: billboarding every segment separately twisted the ribbon into a wide fan
  // whenever the camera was close to the jet's axis (chase camera behind a rolling car).
  const camLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
  const toCam = normalize(camLocal.sub(vec3(0, 0, u.length.mul(0.5))));
  const side = normalize(cross(vec3(0, 0, 1), toCam));
  // grazing view (looking along the jet): narrow the ribbon down to the core; the end-on shell takes over
  const grazing = smoothstep(float(0.5), float(0.92), abs(toCam.z));
  mat.positionNode = vec3(0, 0, z).add(side.mul(across).mul(plumeRadius(u, z).mul(W).mul(mix(float(1), float(0.5), grazing))));
  const light = plumeLight(z);

  // --- fragment: column density of a turbulent, entraining jet seen side-on
  const zf = uv().y.mul(u.length);
  const L = max(u.length, float(0.05));
  const r = plumeRadius(u, zf);
  const xs = uv().x.sub(0.5).mul(2 * W);   // signed radial coordinate in plume radii
  const T = u.time;
  // eddies are carried downstream (~15 m/s visual convection) and grow with the mixing layer
  // large eddies at the edge (scale ~ local radius) and fine filaments stretched along the flow
  const n1 = mx_noise_float(vec3(xs.mul(0.7), zf.mul(1.4).sub(T.mul(14)), u.seed)).mul(0.5).add(0.5);
  const n2 = mx_noise_float(vec3(xs.mul(3.2), zf.mul(0.9).sub(T.mul(22)), u.seed.add(7))).mul(0.5).add(0.5);
  const developed = smoothstep(float(0.0), float(0.8), zf);
  // the developed plume meanders only slightly: the momentum-dominated jet stays a straight cone
  // (stream t_963). A stronger meander bent the side plumes into wide, snaking fans in the chase
  // camera (R7 open item: not TRAA – the fan stays with TRAA off and in a paused frame).
  const wander = mx_noise_float(vec3(zf.mul(0.7).sub(T.mul(6)), u.seed.mul(0.37), 3.1)).mul(0.3).mul(developed);
  const rho = abs(xs.sub(wander)).mul(float(1).add(n1.sub(0.5).mul(0.8).mul(developed)));
  const profile = exp(rho.mul(rho).mul(-1.6)).mul(mix(float(1), n2.mul(0.35).add(0.78), developed));
  // the gas is clear right at the exit (condensation needs a few cm), thins as it entrains air and
  // breaks into lumps towards the end
  const build = smoothstep(float(0.0), float(0.12), zf).mul(smoothstep(float(0), L.mul(0.3), zf).mul(0.55).add(0.45));
  const thin = pow(clamp(u.r0.mul(1.3).add(0.06).div(r), 0.12, 1), float(0.55));
  const tail = pow(clamp(float(1).sub(zf.div(L)), 0, 1), float(1.4));
  const lumps = mix(float(1), smoothstep(float(0.2), float(0.75), n1.mul(0.6).add(n2.mul(0.4))), smoothstep(float(0.45), float(1.0), zf.div(L)));
  // a dense, narrow condensation core in the first third (stream: bright cyan-white root, then a
  // widening, fraying plume)
  const coreR = exp(rho.mul(rho).mul(-7)).mul(pow(clamp(float(1).sub(zf.div(L.mul(0.55))), 0, 1), float(1.3))).mul(build);
  const density = profile.mul(build).mul(thin.mul(0.75).add(0.25)).mul(tail).mul(lumps).add(coreR.mul(0.55));
  // shock cells close to the exit: a faint periodic brightening of the core, gone after a few cells
  const sp = max(u.spacing, float(0.01));
  const tri = abs(fract(zf.div(sp)).sub(0.5)).mul(2);
  const coreFade = exp(zf.div(sp.mul(max(u.cells, float(1)))).negate().mul(1.4));
  const diamond = pow(tri, float(4)).mul(exp(xs.mul(xs).mul(-6))).mul(coreFade).mul(u.diamond).mul(0.3);
  // view-angle crossfade: ribbon fades when looking down the jet axis
  const axisView = normalize(modelViewMatrix.mul(vec4(0, 0, 1, 0)).xyz);
  const viewDir = normalize(positionView);
  // (fades from ~35° off the axis instead of ~17°, the oblique side jets in the chase camera
  // were the remaining fan)
  const sideOn = smoothstep(float(0.08), float(0.5), float(1).sub(abs(dot(axisView, viewDir))));
  // lit condensation (no glowing core): bluish white, denser parts slightly self-shadowed
  // the stream's floods are cool LEDs; the droplets scatter them cyan-white
  const tint = vec3(0.66, 0.86, 1.0);
  // the condensed core is far denser than the trailing smoke: it scatters more light per area
  const dense = mix(float(1.0), float(2.4), thin);
  mat.colorNode = tint.mul(light).mul(dense).mul(mix(float(1.15), float(0.85), density)).mul(u.light).add(tint.mul(light).mul(diamond));
  mat.opacityNode = clamp(density.mul(u.intensity).mul(1.5).mul(sideOn), 0, 1);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return mesh;
}

/** Soft cone seen end-on (chase cam behind the main nozzles). */
function makeShell(u: JetUniforms): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 24, 16, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
  // after rotateX the cylinder axis is +Z from 0..1
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const t = positionLocal.z; // 0..1
  const zl = t.mul(u.length);
  const r = plumeRadius(u, zl);
  mat.positionNode = vec3(positionLocal.x.mul(r), positionLocal.y.mul(r), zl);
  const light = plumeLight(zl);
  const facing = abs(dot(normalize(normalView), normalize(positionView).negate()));
  const axisView = normalize(modelViewMatrix.mul(vec4(0, 0, 1, 0)).xyz);
  const endOn = smoothstep(float(0.55), float(0.95), abs(dot(axisView, normalize(positionView))));
  const n = mx_noise_float(vec3(positionLocal.x.mul(2.5), positionLocal.y.mul(2.5), t.mul(6).sub(u.time.mul(9)).add(u.seed))).mul(0.5).add(0.5);
  const fade = pow(float(1).sub(t), float(1.6)).mul(smoothstep(float(0), float(0.04), t));
  mat.colorNode = vec3(0.66, 0.86, 1.0).mul(light).mul(u.light);
  mat.opacityNode = clamp(pow(facing, float(1.5)).mul(fade).mul(n).mul(endOn).mul(u.intensity).mul(0.32), 0, 1);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 9;
  return mesh;
}

export class JetSystem {
  readonly group = new THREE.Group();
  readonly params: PlumeParams[] = [];
  private uniforms: JetUniforms[] = [];
  private holders: THREE.Object3D[] = [];
  /** Exhaust directions in body frame (unit). */
  readonly exhaustBody: THREE.Vector3[] = [];
  readonly exitBody: THREE.Vector3[] = [];
  /** Simulation time of the plume turbulence (frozen in pause, slowed in slow motion). */
  readonly uTime = uniform(0);

  constructor() {
    this.group.name = 'Jets';
    ROADSTER.nozzles.forEach((nz, i) => {
      const u = makeUniforms(i * 13.7, this.uTime);
      const holder = new THREE.Group();
      holder.name = `Jet_${i}`;
      const ex = new THREE.Vector3(-nz.dir.x, -nz.dir.y, -nz.dir.z).normalize();
      holder.position.set(nz.pos.x, nz.pos.y, nz.pos.z).addScaledVector(ex, nz.group === 'main' ? 0.06 : 0.03);
      holder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ex);
      holder.add(makeRibbon(u), makeShell(u));
      holder.visible = false;
      this.group.add(holder);
      this.uniforms.push(u);
      this.holders.push(holder);
      this.exhaustBody.push(ex);
      this.exitBody.push(holder.position.clone());
      this.params.push({ intensity: 0, length: 0, radius0: 0.04, radius1: 0.2, cellSpacing: 0, diamondStrength: 0, cellCount: 3 });
    });
  }

  /** `light` = scene light level around the car (floodlights), drives the plume brightness. */
  /** Ambient medium 0..1 (see Emitters.setEnvironment). */
  air = 1;

  /**
   * `duty` (optional, telemetry.thrusterDuty): open fraction of each valve over the last frame.
   * PWM pulses (min-on 15 ms) can fall between two rendered states; the duty catches them.
   */
  update(nozzles: readonly NozzleState[], dt: number, light: number, duty?: readonly number[] | null): void {
    this.uTime.value += Math.max(0, dt);
    ROADSTER.nozzles.forEach((spec, i) => {
      let n = nozzles[i];
      const d = duty?.[i] ?? 0;
      if (n && d > 0.02 && n.thrustN < d * spec.nominalThrustN) {
        n = { ...n, open: true, thrustN: d * spec.nominalThrustN, massFlowKgS: (d * spec.nominalThrustN) / 650, exitPressureRatio: Math.max(n.exitPressureRatio, 1 + 2.2 * d) };
      }
      const target = n ? plumeParams(spec, n) : this.params[i];
      const p = this.params[i];
      // valves open in ~10 ms, the condensation cloud builds in ~50 ms and lingers ~170 ms
      const k = dt <= 0 ? 1 : 1 - Math.exp(-dt * (target.intensity > p.intensity ? 20 : 6));
      p.intensity += (target.intensity - p.intensity) * k;
      // a closing valve leaves the plume in place while it dissolves (it does not retract)
      if (target.intensity > 0.01) p.length += (target.length - p.length) * (dt <= 0 ? 1 : 1 - Math.exp(-dt * 20));
      if (target.intensity > 0.01) {
        p.radius0 = target.radius0; p.radius1 = target.radius1; p.cellSpacing = target.cellSpacing;
        p.diamondStrength = target.diamondStrength; p.cellCount = target.cellCount;
      } else p.diamondStrength *= 1 - k;
      const u = this.uniforms[i];
      // in vacuum the gas expands into a wide, faint fan: no condensation core, no shock cells
      u.intensity.value = p.intensity * (0.35 + 0.65 * this.air);
      // the stream's plumes stay visible over roughly a car length: the condensed core outlives the
      // shock train by a good margin in the cold, dry night air
      u.length.value = Math.max(0.05, p.length * 1.35);
      u.r0.value = p.radius0;
      u.r1.value = p.radius1;
      u.spacing.value = Math.max(0.04, p.cellSpacing * 1.6); // slight visual exaggeration of the cell period
      u.diamond.value = p.diamondStrength * this.air;
      u.cells.value = p.cellCount;
      u.light.value = 0.85 + 0.15 * light;
      this.holders[i].visible = p.intensity > 0.01;
    });
  }
}
