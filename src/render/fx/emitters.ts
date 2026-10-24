// Turns vehicle state into particle emission: jet condensation, ground blast where a jet hits the
// ground, tyre smoke from slip, fan intake dust.
import * as THREE from 'three/webgpu';
import type { VehicleState } from '../../shared/types';
import { ROADSTER } from '../../shared/roadster';
import { tireSmokeRate, wheelDustRate, wheelSpeeds, isLooseSoil, terrainGrain, roosterVelocity, wheelSpec, dustTint, grainSizes, type DustMedium } from '../fxParams';
import type { SurfaceKind } from '../../shared/environment';
import { PKind, type ParticleSystem } from './particles';
import type { JetSystem } from './jets';
import { CloudField } from './fxLight';
import { cloudVolume } from './volume/cloudVolume';

const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _d = new THREE.Vector3(), _v = new THREE.Vector3();
const _hit = new THREE.Vector3(), _vel = new THREE.Vector3();
const dustTintOf = (k: SurfaceKind | null): [number, number, number] => dustTint(k);

export class Emitters {
  private acc = new Float32Array(80);
  private steamAcc = 0;
  /** Sim time of the total loss (wreck smoke), −1 = intact. */
  private wreckT0 = -1;
  /** Exhaust direction of the Raptor flame trench (world, unit). */
  raptorDir = new THREE.Vector3(1, 0, 0);
  /** Cloud-scale density of the ground blast (self-shadowing of the billows, see cloudDepth). */
  readonly clouds = new CloudField();
  constructor(private ps: ParticleSystem, private jets: JetSystem, public raptorSteam: THREE.Vector3 | null) {
    cloudVolume.site = true;
    cloudVolume.clear();
  }

  private steamVel(): { x: number; y: number; z: number } {
    const d = this.raptorDir, sp = 14 + Math.random() * 6;
    return { x: d.x * sp + (Math.random() - 0.5) * 6, y: 4 + Math.random() * 5, z: d.z * sp + (Math.random() - 0.5) * 6 };
  }

  /** `rate` particles/s, accumulated fractionally per channel. */
  private count(ch: number, rate: number, dt: number): number {
    this.acc[ch] += rate * dt;
    const n = Math.floor(this.acc[ch]);
    this.acc[ch] -= n;
    return n;
  }

  /**
   * Ambient medium: `air` 0..1 (sqrt of the pressure ratio to Earth, clamped) scales condensation,
   * tyre smoke and fan dust; without air the jet blast throws regolith on ballistic arcs.
   */
  air = 1;
  gravity = 9.81;
  groundAt: ((x: number, z: number) => number) | null = null;
  setEnvironment(pressurePa: number, gravity: number, groundAt: ((x: number, z: number) => number) | null): void {
    this.air = Math.min(1, Math.sqrt(Math.max(0, pressurePa) / 101_325 * 5));
    this.gravity = gravity;
    this.groundAt = groundAt;
    // (on terrain the pad clamp to y = 0 would lift sprites off – or bury them under – the ground)
    this.ps.flatGround.value = groundAt ? 0 : 1;
    // the ground-cloud volume covers the McGregor pad (flat ground, dense air) only
    cloudVolume.site = !groundAt && this.air > 0.5;
  }

  /**
   * loose ground under the wheels and jets. `soil` = site surface, `looseAt` tells whether a world
   * point is on the bare soil (not on a landmark, pyramid or prop), `rho` = air density (kg/m³).
   */
  soil: SurfaceKind | null = null;
  looseAt: ((x: number, y: number, z: number) => boolean) | null = null;
  medium: DustMedium = { g: 9.81, rho: 1.2 };
  /** Jet scour on loose ground: spot centre, radius (m) and the strength gained this frame. */
  onScour: ((x: number, z: number, r: number, dose: number) => void) | null = null;
  /** Particles emitted since the world was set (tests/HUD): wheel dust (grains + veil) and jet ejecta. */
  readonly soilStats = { wheelGrains: 0, wheelVeil: 0, jetGrains: 0, jetVeil: 0 };
  setSoil(kind: SurfaceKind | null, looseAt: ((x: number, y: number, z: number) => boolean) | null, rho: number): void {
    this.soil = kind;
    this.looseAt = looseAt;
    this.medium = { g: this.gravity, rho };
    this.ps.dustTint.value.set(...dustTintOf(kind));
    const gs = grainSizes(kind, rho);
    this.ps.grainD.value.set(gs.dMin, gs.dMax);
    this.ps.grainSky.value = gs.sky;
    for (const k of Object.keys(this.soilStats) as (keyof Emitters['soilStats'])[]) this.soilStats[k] = 0;
  }
  private looseHere(x: number, y: number, z: number): boolean {
    return isLooseSoil(this.soil) && !this.underWater(y) && (!this.looseAt || this.looseAt(x, y, z));
  }

  /** Sea / lagoon plane (Boca Chica), null without water: under it there is no dust or tyre smoke, the car and the
   *  jets throw spray instead. */
  waterLevel: number | null = null;
  private underWater(y: number): boolean { return this.waterLevel !== null && y < this.waterLevel; }
  /** Hull under the water surface in the last frame (entry splash). */
  private wasInWater = false;

  /** water droplets on a ballistic arc (falling back onto the sea) */
  private spray(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, opacity: number, dt: number): void {
    this.ps.emit({ kind: PKind.Spray, pos: { x, y, z }, vel: { x: vx, y: vy, z: vz }, life: 0.6 + Math.random() * 0.7,
      size0: size * 0.35, size1: size * (1.1 + Math.random() * 0.6), drag: 0.9, buoyancy: -this.gravity * 0.85, opacity, age0: Math.random() * dt });
  }

  /**
   * The car in the sea: spray where the hull and the wheels cut the surface (bow wave to the sides, rooster tails
   * behind, growing with speed) and a burst when it drops into the water.
   */
  private emitWaterSpray(s: VehicleState, dt: number, scale: number, carVel: THREE.Vector3): void {
    const L = this.waterLevel;
    if (L === null) { this.wasInWater = false; return; }
    const inWater = s.pos.y - 0.45 < L && s.pos.y + 0.9 > L - 0.3;
    // entry: falling into the water from a jump or a flight
    if (inWater && !this.wasInWater && carVel.y < -2) {
      const k = Math.min(1, -carVel.y / 8);
      const n = Math.round(160 * k * scale);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = 1.2 + Math.random() * 1.6, sp = 2 + Math.random() * 6;
        this.spray(s.pos.x + Math.cos(a) * r, L + 0.05, s.pos.z + Math.sin(a) * r, Math.cos(a) * sp + carVel.x * 0.3, 3 + Math.random() * 8 * k, Math.sin(a) * sp + carVel.z * 0.3, 0.5 + Math.random() * 0.5, 0.5, 0);
      }
    }
    this.wasInWater = inWater;
    const vh = Math.hypot(carVel.x, carVel.z);
    if (!inWater || vh < 1.2) return;
    const f = Math.min(1, vh / 18);
    const fw = _p.set(0, 0, 1).applyQuaternion(_q).setY(0);
    if (fw.lengthSq() < 1e-6) return;
    fw.normalize();
    const ux = carVel.x / vh, uz = carVel.z / vh;                // travel direction
    // four corners of the hull (body frame: ±x left/right, +z front): wheels and bow where they cut the surface
    for (let c = 0; c < 4; c++) {
      const side = c & 1 ? -1 : 1, front = c < 2;
      _d.set(side * 0.95, -0.25, front ? 1.45 : -1.35).applyQuaternion(_q).add(_v.set(s.pos.x, s.pos.y, s.pos.z));
      if (Math.abs(_d.y - L) > 0.7) continue;
      const n = this.count(64 + c, (front ? 110 : 90) * f * scale, dt);
      // sideways normal of the travel direction for this side of the car
      const sx = -uz * side, sz = ux * side;
      for (let k = 0; k < n; k++) {
        if (front) {
          // bow wave: a fan out to the side and a little forward
          const out = 1.5 + vh * (0.18 + Math.random() * 0.18), up = 1 + vh * (0.1 + Math.random() * 0.15);
          this.spray(_d.x, L + 0.1, _d.z, sx * out + ux * vh * 0.35, Math.min(9, up), sz * out + uz * vh * 0.35, 0.45 + f * 0.7, 0.6, dt);
        } else {
          // rooster tail behind the wheels: thrown up and back, left behind by the car
          const back = vh * (0.05 + Math.random() * 0.25), up = 1.5 + vh * (0.12 + Math.random() * 0.22);
          this.spray(_d.x, L + 0.1, _d.z, carVel.x * 0.55 - ux * back + sx * (Math.random() - 0.3) * 2, Math.min(11, up), carVel.z * 0.55 - uz * back + sz * (Math.random() - 0.3) * 2, 0.5 + f * 0.8, 0.6, dt);
        }
      }
    }
  }

  update(s: VehicleState, dt: number, scale = 1): void {
    if (dt <= 0) return;
    this.clouds.update(dt);
    // with the volume drawn the blast sprites only add fine wisps around it
    const vol = cloudVolume.active;
    _q.set(s.quat.x, s.quat.y, s.quat.z, s.quat.w);
    const carPos = _v.set(s.pos.x, s.pos.y, s.pos.z).clone();
    const carVel = new THREE.Vector3(s.linVel.x, s.linVel.y, s.linVel.z);

    // ---------------- jets: condensation + ground interaction
    ROADSTER.nozzles.forEach((spec, i) => {
      const p = this.jets.params[i];
      if (p.intensity < 0.03) return;
      const main = spec.group === 'main';
      const exitW = _p.copy(this.jets.exitBody[i]).applyQuaternion(_q).add(carPos);
      const dirW = _d.copy(this.jets.exhaustBody[i]).applyQuaternion(_q);
      const L = Math.max(0.5, p.length);
      // condensation continues the ribbon: emitted along the visible plume (not beyond it), sized
      // like the local mixing layer, inheriting the car's velocity and then decelerating in the
      // still air (world space) -> a coherent trail instead of a chain of puffs
      const rate = (main ? 120 : spec.group === 'lift' ? 90 : 40) * p.intensity * scale * this.air;
      const n = this.count(i, rate, dt);
      for (let k = 0; k < n; k++) {
        const t = 0.2 + Math.random() * 0.8;
        const z = L * t;
        const r = p.radius0 * 1.3 + z * 0.09 + 0.015;
        const pos = exitW.clone().addScaledVector(dirW, z);
        pos.x += (Math.random() - 0.5) * r * 1.2; pos.y += (Math.random() - 0.5) * r * 1.2; pos.z += (Math.random() - 0.5) * r * 1.2;
        const sp = (main ? 20 : 15) * (0.5 + Math.random() * 0.6) * Math.min(1, p.intensity);
        _vel.copy(dirW).multiplyScalar(sp).add(carVel);
        _vel.x += (Math.random() - 0.5) * 2; _vel.y += (Math.random() - 0.5) * 2; _vel.z += (Math.random() - 0.5) * 2;
        // the dry desert air re-evaporates the droplets within about a second (no long popcorn trail)
        // (faint and soon wide: individual puffs must not read as a string of discs behind a fast car)
        this.ps.emit({ kind: PKind.Condensation, pos, vel: _vel, life: 0.3 + Math.random() * 0.5, size0: Math.max(0.25, r * 2.6),
          size1: (main ? 1.0 : 1.2) + Math.random() * 0.7, drag: 2.6, buoyancy: 0.25, opacity: main ? 0.014 : 0.012 });
      }
      // wall jet: a near-horizontal main jet close to the ground (0-60 launch) scours the pad and
      // drags a ground-hugging cloud far behind the car (stream 1267 s: a 20 m wall of vapour)
      // (over the sea: a rooster tail of spray along the jet instead, see below)
      const seaBelow = this.waterLevel !== null && this.groundAt !== null && this.groundAt(exitW.x, exitW.z) < this.waterLevel;
      if (main && dirW.y >= -0.15 && seaBelow) {
        const h = exitW.y - this.waterLevel!;
        if (h < 1.4) {
          const w = p.intensity * (1 - Math.max(0, h) / 1.4);
          const ns = this.count(68 + i, 70 * w * scale, dt);
          for (let k = 0; k < ns; k++) {
            _hit.copy(exitW).addScaledVector(dirW, L * (0.3 + Math.random() * 1.4));
            const sp = 6 + Math.random() * 12;
            this.spray(_hit.x, this.waterLevel! + 0.05, _hit.z, dirW.x * sp + carVel.x * 0.3 + (Math.random() - 0.5) * 3, 2 + Math.random() * 6 * w,
              dirW.z * sp + carVel.z * 0.3 + (Math.random() - 0.5) * 3, 0.35 + Math.random() * 0.4, 0.5, dt);
          }
        }
      }
      if (main && dirW.y >= -0.15 && this.air > 0.5 && !seaBelow) {
        const gy0 = this.groundAt ? this.groundAt(exitW.x, exitW.z) : 0;
        const h = exitW.y - gy0;
        if (h < 1.4) {
          const w = p.intensity * (1 - Math.max(0, h) / 1.4);
          const nw = this.count(28 + (i & 3), 260 * w * scale * (vol ? 0.3 : 1), dt);
          for (let k = 0; k < nw; k++) {
            const z = L * (0.3 + Math.random() * 1.4);
            const pos = exitW.clone().addScaledVector(dirW, z);
            const sp = 6 + Math.random() * 10;
            // (cold, dense vapour hugs the pad: no upward launch, hardly any buoyancy)
            const vel = { x: dirW.x * sp + (Math.random() - 0.5) * 9, y: 0.2 + Math.random() * 0.8, z: dirW.z * sp + (Math.random() - 0.5) * 9 };
            this.ps.emit({ kind: PKind.Blast, pos: { x: pos.x, y: gy0 + 0.5, z: pos.z }, vel, life: 2.5 + Math.random() * 2.5,
              // (smaller and fainter with the volume – single 4 m puffs floated over the tail as balls)
              size0: vol ? 0.9 : 1.6, size1: vol ? 1.4 + Math.random() * 1.4 : 3.5 + Math.random() * 4.0, drag: 1.2, buoyancy: 0.05, opacity: vol ? 0.08 : 0.22 });
          }
          if (vol && w > 0.02) {
            // the volume: a ground-hugging sheet blown far back along the jet (stream 1267 s)
            // (reaches further back, flatter and faster, dense right behind the tail – the
            // stream's tail is a long, low sheet at car height, not a heap behind the car)
            // (flat splats – wide and low, the height growing only slowly downstream; the
            // balls of up to 3 m radius made the tail a row of hills)
            for (const f of [0.5, 1.2, 2.1, 3.2]) {
              _hit.copy(exitW).addScaledVector(dirW, L * f);
              cloudVolume.addSource({ x: _hit.x, y: gy0 + 0.4, z: _hit.z, r: 1.4 + f * 0.8, ry: 0.55 + f * 0.12, rate: 34 * w / f ** 0.45,
                vx: dirW.x * 17 / Math.sqrt(f), vy: 0.02, vz: dirW.z * 17 / Math.sqrt(f), radial: 1.5 });
            }
          }
          if (nw > 0) { _hit.copy(exitW).addScaledVector(dirW, L * 1.4); this.clouds.add(_hit.x, gy0, _hit.z, nw / Math.max(scale, 0.25)); }
        }
      }
      // a near-horizontal main jet just above loose soil (launch, hold) blows a furrow of grains
      // along the jet and sweeps the soil behind the car
      if (main && dirW.y >= -0.15 && dirW.y <= 0.35 && this.groundAt && isLooseSoil(this.soil)) {
        const gy0 = this.groundAt(exitW.x, exitW.z);
        const h = exitW.y - gy0;
        if (h < 1.4) {
          const w = p.intensity * (1 - Math.max(0, h) / 1.4);
          _hit.copy(exitW).addScaledVector(dirW, L * 0.9);
          const gh = this.groundAt(_hit.x, _hit.z);
          if (w > 0.02 && this.looseHere(_hit.x, gh, _hit.z)) {
            _hit.y = gh;
            _d.set(dirW.x, 0, dirW.z).normalize();
            this.jetEjecta(_hit, gh, _d, w * 0.6, 1.0 + L * 0.2, dt, scale, i);
            _d.copy(this.jets.exhaustBody[i]).applyQuaternion(_q);
          }
        }
      }
      // ground blast: jet axis vs the ground (plane y = 0 or the world terrain)
      if (dirW.y < -0.15) {
        let gy = this.groundAt ? this.groundAt(exitW.x, exitW.z) : 0;
        let tHit = (gy - exitW.y) / dirW.y;
        if (this.groundAt && tHit > 0) { gy = this.groundAt(exitW.x + dirW.x * tHit, exitW.z + dirW.z * tHit); tHit = (gy - exitW.y) / dirW.y; }
        // over the sea the jet hits the water surface, not the sea floor (it blasted sand up through the water); a
        // nozzle already under the surface (car afloat) boils the water right above it
        const onWater = this.waterLevel !== null && gy < this.waterLevel;
        if (onWater) { gy = this.waterLevel!; tHit = exitW.y > gy ? (gy - exitW.y) / dirW.y : 0.01; }
        // (the under-expanded jets stay coherent well past the visible condensation: in the stream a
        // landing from 3-6 m altitude already throws a wall of vapour, t_964.5 / 729.5)
        const reach = L * 2.6 + 3.0;
        if (tHit > 0 && tHit < reach) {
          _hit.copy(exitW).addScaledVector(dirW, tHit);
          const loose = !onWater && this.looseHere(_hit.x, gy, _hit.z);
          const strength = p.intensity * (1 - tHit / reach) * (-dirW.y);
          if (onWater) {
            // a crater of spray: a ring of droplets thrown out and up around the impact point
            // (a few, fast-falling droplets: hundreds per second from four jets hung over the sea as a grey fog)
            const ns = this.count(68 + i, 40 * strength * scale, dt);
            for (let k = 0; k < ns; k++) {
              const a = Math.random() * Math.PI * 2, rr = 0.3 + Math.random() * (0.6 + tHit * 0.15), sp = 3 + Math.random() * 9 * Math.min(1, strength * 2);
              this.spray(_hit.x + Math.cos(a) * rr, gy + 0.05, _hit.z + Math.sin(a) * rr, Math.cos(a) * sp + dirW.x * 4, 2 + Math.random() * 7 * Math.min(1, strength * 2.5), Math.sin(a) * sp + dirW.z * 4, 0.3 + Math.random() * 0.35, 0.45, dt);
            }
          }
          // (over water the jet throws spray, not a billowing ground cloud: the blast puffs became a dark wall around
          // a car hovering over the sea, and a grey fog layer after it had landed)
          const nb = onWater ? 0 : this.count(10 + i, 150 * strength * scale * (this.air > 0.5 ? (vol ? 0.35 : 1) : 3), dt);
          if (this.air > 0.5 && nb > 0) this.clouds.add(_hit.x, gy, _hit.z, nb / Math.max(scale, 0.25) / (vol ? 0.35 : 1));
          if (vol && strength > 0.01 && !onWater) {
            // the volume: the jet spreads radially along the pad and rolls up at the front
            // (a steep, energetic jet throws the billows higher than a grazing one)
            const steep = -dirW.y;
            cloudVolume.addSource({ x: _hit.x, y: gy + 0.5, z: _hit.z, r: 1.8 + 1.0 * strength, rate: 40 * strength,
              vx: dirW.x * 6, vy: 0.9 * steep, vz: dirW.z * 6, radial: 10 + 14 * strength });
          }
          for (let k = 0; k < nb; k++) {
            const a = Math.random() * Math.PI * 2;
            // (stream t_964: dense rising billows around the touchdown spot rather than a wide flat wall)
            const sp = 5 + Math.random() * 13 * strength;
            const up = Math.random();
            // (only a steep, energetic jet – a landing – throws vapour upwards; a grazing jet of a
            // car standing on the pad makes a flat wall: the pre-launch hold at the 0–60 gate
            // otherwise sent puffs 5–8 m up behind the gate)
            const lift = Math.min(1, Math.max(0, (-dirW.y - 0.35) / 0.5)) * Math.min(1, strength * 2.5);
            const vel = { x: Math.cos(a) * sp + dirW.x * 8, y: 0.4 + up * up * 7.0 * lift, z: Math.sin(a) * sp + dirW.z * 8 };
            if (this.air > 0.5) {
              // ground cloud: rolls out radially, lingers 2-5 s, grows to several metres
              // (large, faint sprites: many overlap into one billowing cloud instead of separate balls)
              this.ps.emit({ kind: PKind.Blast, pos: { x: _hit.x, y: gy + 0.4, z: _hit.z }, vel, life: 2.5 + Math.random() * 3,
                size0: vol ? 1.0 : 1.6, size1: vol ? 2.0 + Math.random() * 2.5 : 3.5 + Math.random() * 4.0, drag: 1.5, buoyancy: 0.6 * lift, opacity: vol ? 0.12 : 0.19 });
            } else if (!loose) {
              // thin/no atmosphere on rigid ground: a few grains on ballistic arcs, no billowing
              vel.y = 2 + Math.random() * 6 * strength;
              this.emitGrain({ x: _hit.x, y: gy + 0.1, z: _hit.z }, vel, 0.6, dt);
            }
          }
          // plume-surface interaction on loose soil – the radial wall jet erodes the surface and
          // throws grains out at shallow angles (a few to ~20°, PSI tests and Apollo landing films),
          // at speeds that grow with the jet strength; they fly on clean parabolas without air. The
          // spot under the jet is swept bare (scour). Mars adds a fine veil, Giza a sand cloud.
          if (loose) this.jetEjecta(_hit, gy, dirW, strength, Math.max(0.6, Math.min(4.5, 0.5 + tHit * 0.3)), dt, scale, i);
        }
      }
    });

    // ---------------- tyre smoke
    for (let w = 0; w < s.wheels.length; w++) {
      const ws = s.wheels[w];
      // (no rubber smoke on loose soil – the tyre digs and throws dust instead, emitWheelDust)
      if (this.looseHere(ws.contactPoint.x, ws.contactPoint.y, ws.contactPoint.z) || this.underWater(ws.contactPoint.y)) continue;
      const rate = tireSmokeRate(ws, s.speedMs) * scale * this.air;
      const n = this.count(20 + w, rate, dt);
      for (let k = 0; k < n; k++) {
        const vel = { x: carVel.x * 0.25 + (Math.random() - 0.5) * 1.5, y: 0.4 + Math.random() * 0.8, z: carVel.z * 0.25 + (Math.random() - 0.5) * 1.5 };
        this.ps.emit({ kind: PKind.TireSmoke, pos: { x: ws.contactPoint.x, y: ws.contactPoint.y + 0.2, z: ws.contactPoint.z }, vel,
          life: 3.5 + Math.random() * 3.5, size0: 0.8, size1: 5 + Math.random() * 4, drag: 1.2, buoyancy: 0.22, opacity: 0.22 });
      }
    }

    // ---------------- total loss (vehicle damage "Full"): smoke from the wrecked end, thinning out over ≈ 30 s
    const dmg = s.damage;
    if (dmg?.totalLoss) {
      if (this.wreckT0 < 0 || s.t < this.wreckT0) this.wreckT0 = s.t;
      const fade = Math.max(0.25, 1 - (s.t - this.wreckT0) / 30);
      const zb = dmg.zones.rear > dmg.zones.front ? -1.7 : dmg.zones.front > 0.05 ? 1.7 : 0;
      _q.set(s.quat.x, s.quat.y, s.quat.z, s.quat.w);
      _p.set(0, 0.35, zb).applyQuaternion(_q).add(_d.set(s.pos.x, s.pos.y, s.pos.z));
      const n = this.count(30, 26 * fade * scale * this.air, dt);
      for (let k = 0; k < n; k++) {
        const vel = { x: carVel.x * 0.3 + (Math.random() - 0.5) * 0.8, y: 1.2 + Math.random() * 1.2, z: carVel.z * 0.3 + (Math.random() - 0.5) * 0.8 };
        this.ps.emit({ kind: PKind.TireSmoke, pos: { x: _p.x + (Math.random() - 0.5) * 0.6, y: _p.y, z: _p.z + (Math.random() - 0.5) * 0.6 }, vel,
          life: 5 + Math.random() * 4, size0: 0.6, size1: 4 + Math.random() * 3, drag: 0.8, buoyancy: 0.5, opacity: 0.3 });
      }
    } else this.wreckT0 = -1;

    // ---------------- fan intake dust (suction pulls dust from around the skirts)
    const fan = s.fans.rpmNorm;
    if (fan > 0.15 && s.heightAboveGroundM < 1.2 && this.air > 0.2) {
      const n = this.count(26, 60 * fan * scale * Math.min(1, 0.3 + s.speedMs / 20), dt);
      for (let k = 0; k < n; k++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const local = new THREE.Vector3(side * (1.1 + Math.random() * 0.8), -0.4, (Math.random() - 0.5) * 4).applyQuaternion(_q).add(carPos);
        const inward = carPos.clone().sub(local).setY(0).normalize().multiplyScalar(1.5 + Math.random() * 2);
        // the fans exhaust at the rear: dust then trails behind
        this.ps.emit({ kind: PKind.Dust, pos: { x: local.x, y: 0.08, z: local.z }, vel: { x: inward.x + carVel.x * 0.4, y: 0.3, z: inward.z + carVel.z * 0.4 },
          life: 1.5 + Math.random() * 1.5, size0: 0.15, size1: 1.2, drag: 2.0, buoyancy: 0.1, opacity: 0.25 });
      }
    }

    this.emitWheelDust(s, dt, scale, carVel);
    this.emitWaterSpray(s, dt, scale, carVel);
    this.emitHaze(dt);
    cloudVolume.update(dt, carPos.x, carPos.z);

    // ---------------- Raptor test stand steam (far background, continuous)
    if (this.raptorSteam) {
      this.steamAcc += dt * 1.2;
      while (this.steamAcc > 1) {
        this.steamAcc -= 1;
        const r = this.raptorSteam;
        this.ps.emit({ kind: PKind.Steam, pos: { x: r.x + (Math.random() - 0.5) * 10, y: r.y, z: r.z + (Math.random() - 0.5) * 10 },
          vel: this.steamVel(),
          life: 34 + Math.random() * 10, size0: 25, size1: 110 + Math.random() * 40, drag: 0.08, buoyancy: 0.18, opacity: 0.09 });
      }
    }
  }

  /**
   * one packet of soil grains on its parabola, dying where it meets the real terrain (fxParams.terrainGrain).
   * The packet starts a few cm wide and disperses with ~7–16 % of its speed (velocity scatter of the grains).
   */
  private emitGrain(pos: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }, opacity: number, dt: number, age0 = Math.random() * dt): void {
    const gr = terrainGrain(v, pos, this.medium, this.groundAt);
    const sp = Math.hypot(v.x, v.y, v.z);
    const size0 = 0.02 + Math.random() * 0.03;
    this.ps.emit({ kind: PKind.Grain, pos, vel: gr.vel, life: gr.life, size0, size1: Math.min(0.5, size0 + sp * (0.07 + Math.random() * 0.09) * gr.life),
      drag: gr.drag, buoyancy: gr.buoyancy, opacity, age0: Math.min(age0, gr.life * 0.5) });
  }

  /** ejecta and scour where a jet hits loose soil at `hit` (ground height gy), jet direction `dir`. */
  private jetEjecta(hit: THREE.Vector3, gy: number, dir: THREE.Vector3, strength: number, r: number, dt: number, scale: number, ch: number): void {
    this.onScour?.(hit.x, hit.z, r, strength * dt * 0.8);
    const m = this.medium, kind = this.soil;
    const n = this.count(40 + ch, 260 * strength * scale, dt);
    const hx = dir.x, hz = dir.z, hl = Math.hypot(hx, hz);
    for (let k = 0; k < n; k++) {
      // radial outflow, biased along the jet's horizontal direction
      const a = Math.random() * Math.PI * 2;
      let ux = Math.cos(a) + (hl > 1e-3 ? (hx / hl) * hl * 1.5 : 0), uz = Math.sin(a) + (hl > 1e-3 ? (hz / hl) * hl * 1.5 : 0);
      const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
      const sp = (5 + 22 * Math.min(1, strength)) * (0.4 + Math.random() * 0.8);
      const elev = (3 + 17 * Math.random() * Math.random()) * Math.PI / 180;
      const v = { x: ux * sp * Math.cos(elev), y: sp * Math.sin(elev), z: uz * sp * Math.cos(elev) };
      const rr = r * Math.sqrt(Math.random()) * 0.8;
      const gx = hit.x + ux * rr, gz = hit.z + uz * rr;
      this.emitGrain({ x: gx, y: (this.groundAt ? this.groundAt(gx, gz) : gy) + 0.04, z: gz }, v, 0.8, dt);
      this.soilStats.jetGrains++;
      // the gas carries the fine fraction: a thin drifting veil on Mars, a sand cloud on Earth
      if (m.rho > 0 && Math.random() < (kind === 'sand' ? 0.5 : 0.3)) {
        const earth = m.rho > 0.5;
        this.ps.emit({ kind: PKind.Dust, pos: { x: hit.x + ux * rr, y: gy + 0.2, z: hit.z + uz * rr },
          vel: { x: ux * sp * 0.5, y: 0.3 + Math.random() * (earth ? 1.5 : 0.6), z: uz * sp * 0.5 },
          life: earth ? 2.5 + Math.random() * 2.5 : 6 + Math.random() * 6, size0: 0.4, size1: earth ? 2.5 + Math.random() * 2.5 : 2 + Math.random() * 3,
          drag: earth ? 1.6 : 0.7, buoyancy: earth ? 0.15 : -0.04, opacity: earth ? 0.12 : 0.06 });
        this.soilStats.jetVeil++;
      }
    }
  }

  /**
   * rooster tails. On loose soil every rolling wheel lifts grains off the rear of its contact patch
   * at a fraction of the rim speed; slip throws more. Moon: grains only, pure parabolas under 1.62 m/s²
   * (no air to carry dust: Apollo 15–17 LRV films). Mars: short arcs (thin CO₂ hardly slows them) and a
   * fine fraction that drifts as a thin veil and settles slowly. Giza: sand with a dust cloud in air.
   */
  private emitWheelDust(s: VehicleState, dt: number, scale: number, carVel: THREE.Vector3): void {
    if (!isLooseSoil(this.soil)) return;
    const m = this.medium, kind = this.soil;
    // travel direction: car forward (+Z body), flipped when reversing
    const fw = _p.set(0, 0, 1).applyQuaternion(_q).setY(0);
    if (fw.lengthSq() < 1e-6) return;
    fw.normalize();
    if (carVel.x * fw.x + carVel.z * fw.z < -0.3) fw.negate();
    const fwd = { x: fw.x, z: fw.z };
    for (let w = 0; w < s.wheels.length; w++) {
      const ws = s.wheels[w];
      const c = ws.contactPoint;
      // (a quarter more packets than before – each now a few fine grains instead of one blob; more
      // would starve the shared particle budget: the Giza jet cloud vanished at twice the rate)
      const rate = wheelDustRate(ws, w, s.speedMs, kind) * scale * 1.25;
      if (rate <= 0 || !this.looseHere(c.x, c.y, c.z)) { this.acc[36 + (w & 3)] = 0; continue; }
      const n = this.count(36 + (w & 3), rate, dt);
      if (!n) continue;
      const { rim } = wheelSpeeds(ws, w, s.speedMs);
      const vGround = Math.max(0, carVel.x * fwd.x + carVel.z * fwd.z);
      const back = wheelSpec(w).radius * 0.35;
      const gy = this.groundAt ? this.groundAt(c.x, c.z) : c.y;
      for (let k = 0; k < n; k++) {
        const v = roosterVelocity(rim, vGround, fwd, Math.random(), Math.random(), Math.random());
        const h0 = 0.03 + Math.random() * 0.08;
        // (launched across the tread width, at a random instant of the frame: the wheel was a little
        // further back then – continuous streams instead of one clump per frame)
        const age0 = Math.random() * dt;
        const across = (Math.random() - 0.5) * wheelSpec(w).width;
        const px = c.x - fwd.x * back - carVel.x * age0 + fwd.z * across, pz = c.z - fwd.z * back - carVel.z * age0 - fwd.x * across;
        // (height at the actual launch point – on a slope the contact-point height buried packets)
        const pos = { x: px, y: (this.groundAt ? this.groundAt(px, pz) : gy) + h0, z: pz };
        this.emitGrain(pos, v, 0.95, 0, age0);
        this.soilStats.wheelGrains++;
        if (m.rho > 0 && Math.random() < (kind === 'sand' ? 0.28 : 0.24)) {
          const earth = m.rho > 0.5;
          this.ps.emit({ kind: PKind.Dust, pos: { x: pos.x, y: gy + 0.25, z: pos.z },
            vel: { x: v.x * 0.35 + carVel.x * 0.1, y: 0.2 + Math.random() * (earth ? 0.8 : 0.4), z: v.z * 0.35 + carVel.z * 0.1 },
            life: earth ? 2.5 + Math.random() * 2.5 : 5 + Math.random() * 6, size0: 0.3, size1: earth ? 2.5 + Math.random() * 2.5 : 1.8 + Math.random() * 2.5,
            drag: earth ? 1.4 : 0.8, buoyancy: earth ? 0.12 : -0.04, opacity: earth ? 0.2 : 0.11 });
          this.soilStats.wheelVeil++;
        }
      }
    }
  }

  /**
   * Low-lying stage haze around a stunt set (the stream shows lingering smoke from fog machines and
   * earlier runs around the semi): a few large, faint, slowly drifting puffs lit by the floods.
   */
  hazeBox: { min: THREE.Vector3; max: THREE.Vector3 } | null = null;
  private hazeAcc = 0;
  private emitHaze(dt: number): void {
    const b = this.hazeBox;
    if (!b || this.air < 0.5) return;
    this.hazeAcc += dt * 1.4;
    while (this.hazeAcc > 1) {
      this.hazeAcc -= 1;
      const r = Math.random;
      // ground-hugging pockets around the row (fog machines at the deck ends), not a uniform veil:
      // most puffs sit low near the two ends and the semi, few drift higher
      const z = r() < 0.7 ? (r() < 0.5 ? b.min.z + r() * 9 : b.max.z - r() * 9) : b.min.z + r() * (b.max.z - b.min.z);
      const y = Math.max(0.3, b.min.y - 0.5 + r() * r() * (b.max.y - b.min.y));
      this.ps.emit({ kind: PKind.Haze, pos: { x: b.min.x + r() * (b.max.x - b.min.x), y, z },
        vel: { x: (r() - 0.5) * 0.6, y: 0.03, z: (r() - 0.5) * 0.6 }, life: 14 + r() * 10, size0: 3, size1: 6 + r() * 5, drag: 0.3, buoyancy: 0.005, opacity: 0.045 });
    }
  }

  /** Pre-fill the steam cloud and the stage haze so they are fully developed on the first frame. */
  warmup(simulateSeconds: number, setTime: (t: number) => void, t0: number): void {
    this.clouds.clear();
    cloudVolume.clear();
    if (this.hazeBox) for (let t = t0 - 24; t < t0; t += 1 / 1.4) { setTime(t); this.hazeAcc = 1.01; this.emitHaze(0); }
    if (!this.raptorSteam) { setTime(t0); return; }
    for (let t = t0 - simulateSeconds; t < t0; t += 1 / 1.2) {
      setTime(t);
      this.steamAcc = 1.01;
      const r = this.raptorSteam;
      this.ps.emit({ kind: PKind.Steam, pos: { x: r.x + (Math.random() - 0.5) * 10, y: r.y, z: r.z + (Math.random() - 0.5) * 10 },
        vel: this.steamVel(),
        life: 34 + Math.random() * 10, size0: 25, size1: 110 + Math.random() * 40, drag: 0.08, buoyancy: 0.18, opacity: 0.09 });
    }
    this.steamAcc = 0;
    setTime(t0);
  }
}
