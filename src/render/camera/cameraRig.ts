// Camera modes: chase (damped spring + collision, mouse look), orbit (mouse), cockpit, top, broadcast
// (fixed stream cameras with automatic cuts), photo (orbit + DoF).
import * as THREE from 'three/webgpu';
import type { VehicleState } from '../../shared/types';
import { qrot } from '../../shared/math';
import {
  BroadcastDirector, BROADCAST_SHOTS, chaseLook, chaseOffset, chaseYaw, clampAboveGround, dampAngle, limitLag, smoothDamp3, spring3,
  type BroadcastShot, type Spring3,
} from '../cameraMath';

/** Driver's eye in the body frame (m; +X = left, the driver's side). */
export const COCKPIT_EYE = { x: 0.38, y: 0.5, z: -0.4 };
/** Longest the chase camera may trail its spring target (m); the soft follow stays below that at normal speeds. */
const CHASE_MAX_LAG_M = 10;

export type CameraMode = 'chase' | 'orbit' | 'cockpit' | 'top' | 'broadcast' | 'photo';
export const CAMERA_MODES: CameraMode[] = ['chase', 'orbit', 'cockpit', 'top', 'broadcast', 'photo'];

/**
 * Mouse buttons that turn the chase camera: the left one always, the right one only while it is not the
 * attitude stick (Settings → Controls → mouse for attitude; src/game/app.ts keeps this in sync).
 */
export const cameraInput = { rightButton: true };

/** Mouse look of the chase camera: seconds without a drag before it swings back behind the car (when moving). */
export const LOOK_RECENTER_S = 1.8;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  readonly director = new BroadcastDirector();
  /** Called whenever the image jumps (mode switch, broadcast cut). */
  onCut: (() => void) | null = null;
  colliders: THREE.Object3D[] = [];
  /** Terrain height under a point (worlds); McGregor pad = 0, space = -Infinity (no ground). */
  groundAt: (x: number, z: number) => number = () => 0;
  /** Focus distance for DoF (photo mode), metres. */
  focusDistance = 8;

  private yaw = 0;
  private air = 0;
  private lastCar: THREE.Vector3 | null = null;
  private chasePos: Spring3 | null = null;
  private lookPos: Spring3 | null = null;
  private orbit = { yaw: Math.PI * 0.8, pitch: 0.18, dist: 9 };
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  /** Chase mouse look: yaw/pitch offsets (rad) around the car, distance factor, time since the last drag (s). */
  private look = { yaw: 0, pitch: 0, zoom: 1, idle: Infinity };
  /** 0 = level chase behind the car, 1 = chase in the car's own frame (on a wall or overhang). */
  private wall = 0;
  private ray = new THREE.Raycaster();
  private shot: BroadcastShot | null = null;
  private shotLook: Spring3 | null = null;
  private baseFov = 55;
  private cleanup: (() => void) | null = null;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.1, 9000);
    this.camera.position.set(0, 3, -10);
  }

  setMode(m: CameraMode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.look.yaw = this.look.pitch = 0;
    this.chasePos = null;
    this.lookPos = null;
    this.shot = null;
    this.director.current = null;
    this.onCut?.();
  }

  /** Forget damped camera state (next update snaps to the target). */
  resetSmoothing(): void {
    this.chasePos = null;
    this.lookPos = null;
    this.shot = null;
    this.director.current = null;
  }

  cycle(): CameraMode {
    const order: CameraMode[] = ['chase', 'broadcast', 'orbit', 'cockpit', 'top'];
    const i = order.indexOf(this.mode);
    this.setMode(order[(i + 1) % order.length]);
    return this.mode;
  }

  setBroadcastShot(id: string | 'auto'): void {
    this.director.forced = id === 'auto' ? null : id;
  }

  get broadcastShots(): readonly BroadcastShot[] { return BROADCAST_SHOTS; }
  get currentShot(): BroadcastShot | null { return this.shot; }

  /** Mouse orbit / zoom for orbit and photo modes; drag-to-look and zoom for the chase camera. */
  attachInput(el: HTMLElement): void {
    this.cleanup?.();
    const orbiting = () => this.mode === 'orbit' || this.mode === 'photo';
    const down = (e: PointerEvent) => {
      const button = e.pointerType !== 'mouse' || e.button === 0 || (e.button === 2 && cameraInput.rightButton);
      if (!button || !(orbiting() || this.mode === 'chase')) return;
      this.dragging = true; this.lastPointer = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastPointer.x, dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      if (this.mode === 'chase') {
        this.look.yaw -= dx * 0.006;
        this.look.pitch = THREE.MathUtils.clamp(this.look.pitch + dy * 0.004, -0.35, 1.1);
        this.look.idle = 0;
        return;
      }
      this.orbit.yaw -= dx * 0.006;
      this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch + dy * 0.004, -0.15, 1.45);
    };
    const up = () => { this.dragging = false; };
    const wheel = (e: WheelEvent) => {
      if (this.mode === 'chase') this.look.zoom = THREE.MathUtils.clamp(this.look.zoom * Math.exp(e.deltaY * 0.001), 0.55, 3);
      else if (orbiting()) this.orbit.dist = THREE.MathUtils.clamp(this.orbit.dist * Math.exp(e.deltaY * 0.001), 2.5, 80);
      else return;
      e.preventDefault();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    this.cleanup = () => {
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.removeEventListener('wheel', wheel);
    };
  }

  dispose(): void { this.cleanup?.(); }

  update(s: VehicleState, dt: number): void {
    const cam = this.camera;
    const car = new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z);
    // the car jumped (seek, replay scrub, fast-forward without rendered frames): snap the damped
    // camera state instead of letting it chase across the venue
    const jumped = this.lastCar !== null && this.lastCar.distanceTo(car) > Math.max(8, s.speedMs * Math.max(dt, 1 / 30) * 3);
    if (jumped) {
      this.resetSmoothing();
      this.air = !s.groundContact && s.heightAboveGroundM > 0.6 ? 1 : 0;
    }
    this.lastCar = (this.lastCar ?? new THREE.Vector3()).copy(car);
    const fwd = qrot(s.quat, { x: 0, y: 0, z: 1 });
    let fov = this.baseFov;
    switch (this.mode) {
      case 'chase': {
        const y = chaseYaw(fwd, s.linVel);
        if (this.chasePos === null) this.yaw = y ?? this.yaw;
        else if (y !== null) this.yaw = dampAngle(this.yaw, y, this.air > 0.5 ? 1.2 : 3.0, dt);
        // airborne blend (smoothed so the camera glides out after take-off and back after landing)
        const airborne = !s.groundContact && s.heightAboveGroundM > 0.6 ? 1 : 0;
        this.air += (airborne - this.air) * (1 - Math.exp(-dt * (airborne ? 2.2 : 1.2)));
        // On a wall or overhang (ramp hang, launch, pyramid faces) "behind and above" in world terms lies
        // behind the ramp: there the camera follows in the car's own frame, behind it along the surface and
        // out over its roof, i.e. on the open inside of the curve.
        const up = qrot(s.quat, { x: 0, y: 1, z: 0 });
        const onWall = s.groundContact ? THREE.MathUtils.clamp((0.75 - up.y) / 0.5, 0, 1) : 0;
        this.wall += (onWall - this.wall) * (1 - Math.exp(-dt * (onWall > this.wall ? 3 : 0.9)));
        if (this.chasePos === null) this.wall = onWall;
        const target = { x: car.x, y: car.y + 0.6 * (1 - this.air), z: car.z };
        // height above the ground for the low airborne camera (no ground below: space, the sim reports NO_GROUND_M)
        const hag = s.heightAboveGroundM < 1e4 ? Math.max(0, s.heightAboveGroundM) : 0;
        const dRaw = chaseOffset(target, this.yaw, s.speedMs, undefined, this.air, hag);
        const look = chaseLook(target, s.linVel, this.air);
        if (this.wall > 0.001) {
          const w = this.wall;
          const h = 3.2 + 2.8 * THREE.MathUtils.clamp(-up.y, 0, 1); // upside down: further out, so the ground shows
          const bx = car.x - fwd.x * 6 + up.x * h, by = car.y - fwd.y * 6 + up.y * h, bz = car.z - fwd.z * 6 + up.z * h;
          dRaw.x += (bx - dRaw.x) * w; dRaw.y += (by - dRaw.y) * w; dRaw.z += (bz - dRaw.z) * w;
          look.x += (car.x + up.x * 0.6 - look.x) * w; look.y += (car.y + up.y * 0.6 - look.y) * w; look.z += (car.z + up.z * 0.6 - look.z) * w;
        }
        const desired = clampAboveGround(dRaw, 0.6, this.groundAt(dRaw.x, dRaw.z));
        if (!this.chasePos || !this.lookPos) { this.chasePos = spring3(desired); this.lookPos = spring3(look); }
        smoothDamp3(this.chasePos, desired, 0.22 + 0.25 * this.air, dt);
        smoothDamp3(this.lookPos, look, 0.06 + 0.12 * this.air, dt);
        const p = limitLag(this.chasePos, desired, CHASE_MAX_LAG_M);
        const l = limitLag(this.lookPos, look, CHASE_MAX_LAG_M / 2);
        const lv = new THREE.Vector3(l.x, l.y, l.z);
        const pv = this.applyLook(lv, new THREE.Vector3(p.x, p.y, p.z), s.speedMs, dt);
        const pos = this.avoidCollision(lv, clampAboveGround(pv, 0.4, this.groundAt(pv.x, pv.z)) as THREE.Vector3, this.wall > 0.3 ? up : null);
        cam.position.copy(pos);
        // looking (almost) straight up or down the wall: world up would be degenerate, take the car's heading
        const vd = lv.clone().sub(pos).normalize();
        if (Math.abs(vd.y) > 0.97) cam.up.set(fwd.x, fwd.y, fwd.z); else cam.up.set(0, 1, 0);
        cam.lookAt(l.x, l.y, l.z);
        fov = 55 + Math.min(12, s.speedMs * 0.12) - 13 * this.air;
        this.focusDistance = cam.position.distanceTo(car);
        break;
      }
      case 'orbit':
      case 'photo': {
        const o = this.orbit;
        const off = new THREE.Vector3(Math.sin(o.yaw) * Math.cos(o.pitch), Math.sin(o.pitch), Math.cos(o.yaw) * Math.cos(o.pitch)).multiplyScalar(o.dist);
        const target = car.clone().add(new THREE.Vector3(0, 0.3, 0));
        const pRaw = target.clone().add(off);
        const pos = clampAboveGround(pRaw, 0.25, this.groundAt(pRaw.x, pRaw.z)) as THREE.Vector3;
        cam.position.copy(this.avoidCollision(target, pos));
        cam.up.set(0, 1, 0);
        cam.lookAt(target);
        fov = this.mode === 'photo' ? 35 : 50;
        this.focusDistance = cam.position.distanceTo(target);
        break;
      }
      case 'cockpit': {
        const q = new THREE.Quaternion(s.quat.x, s.quat.y, s.quat.z, s.quat.w);
        // driver's eye on the left seat behind the yoke (model: yoke at x 0.38, y 0.23; roof at y 0.64): the old eye
        // in the middle at 0.33 m looked into the console and the dashboard, nothing of the road
        const eye = new THREE.Vector3(COCKPIT_EYE.x, COCKPIT_EYE.y, COCKPIT_EYE.z).applyQuaternion(q).add(car);
        cam.position.copy(eye);
        cam.up.set(0, 1, 0).applyQuaternion(q);
        cam.lookAt(new THREE.Vector3(COCKPIT_EYE.x, COCKPIT_EYE.y - 0.45, 10).applyQuaternion(q).add(car));
        fov = 72;
        this.focusDistance = 20;
        break;
      }
      case 'top': {
        if (!this.lookPos) this.lookPos = spring3({ x: car.x, y: car.y, z: car.z });
        const l = smoothDamp3(this.lookPos, { x: car.x, y: car.y, z: car.z }, 0.15, dt);
        cam.position.set(l.x, l.y + 42, l.z - 0.01);
        cam.up.set(0, 0, 1);
        cam.lookAt(l.x, l.y, l.z);
        fov = 45;
        this.focusDistance = 42;
        break;
      }
      case 'broadcast': {
        const { shot, cut } = this.director.update(s.pos, dt, s.linVel);
        if (cut || this.shot !== shot) {
          this.shot = shot;
          this.shotLook = spring3(shot.lookAt ?? s.pos);
          this.onCut?.();
        }
        let pos = new THREE.Vector3(shot.pos.x, shot.pos.y, shot.pos.z);
        if (shot.dolly) {
          const ax = new THREE.Vector3(shot.dolly.axis.x, shot.dolly.axis.y, shot.dolly.axis.z);
          const along = THREE.MathUtils.clamp(car.dot(ax), shot.dolly.min, shot.dolly.max);
          pos = pos.add(ax.multiplyScalar(along - pos.dot(ax) - 4));
        }
        const want = shot.trackCar ? (shot.lookAt ? lerpV(shot.lookAt, s.pos, 0.65) : s.pos) : shot.lookAt!;
        const l = smoothDamp3(this.shotLook!, want, shot.trackCar ? 0.12 : 0.6, dt);
        cam.position.copy(pos);
        cam.up.set(0, 1, 0);
        cam.lookAt(l.x, l.y, l.z);
        fov = shot.fovDeg;
        this.focusDistance = pos.distanceTo(car);
        break;
      }
    }
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 4);
      if (this.mode === 'broadcast' || this.mode === 'cockpit' || this.mode === 'top') cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  /** Chase mouse look: turn the camera around the look point, zoom, and swing back once idle and moving. */
  private applyLook(target: THREE.Vector3, p: THREE.Vector3, speedMs: number, dt: number): THREE.Vector3 {
    const L = this.look;
    if (!this.dragging) L.idle += dt;
    if (L.idle > LOOK_RECENTER_S && speedMs > 2) {
      const k = 1 - Math.exp(-dt / 0.9);
      L.yaw = Math.atan2(Math.sin(L.yaw), Math.cos(L.yaw)) * (1 - k);
      L.pitch *= 1 - k;
    }
    if (Math.abs(L.yaw) < 1e-4 && Math.abs(L.pitch) < 1e-4 && L.zoom === 1) return p;
    const off = p.clone().sub(target);
    const r = off.length() * L.zoom;
    if (r < 1e-3) return p;
    const az = Math.atan2(off.x, off.z) + L.yaw;
    const el = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(off.y / off.length(), -1, 1)) + L.pitch, -0.45, 1.45);
    return target.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(r));
  }

  private avoidCollision(target: THREE.Vector3, desired: THREE.Vector3, carUp: { x: number; y: number; z: number } | null = null): THREE.Vector3 {
    if (!this.colliders.length) return desired;
    // three rays (centre + 1.5 m either side at the camera end) keep a margin to walls
    const blocked = (p: THREE.Vector3): number | null => {
      const dir = p.clone().sub(target);
      const len = dir.length();
      if (len < 1e-3) return null;
      const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(1.5);
      let nearest: number | null = null;
      for (const s of [0, 1, -1]) {
        const end = p.clone().addScaledVector(side, s);
        const d = end.sub(target);
        const l = d.length();
        this.ray.set(target, d.divideScalar(l));
        this.ray.far = l;
        const hits = this.ray.intersectObjects(this.colliders, true);
        if (hits.length && (nearest === null || hits[0].distance < nearest)) nearest = hits[0].distance;
      }
      return nearest;
    };
    if (blocked(desired) === null) return desired;
    // on a wall: first move out over the car's roof (the open side of the ramp)
    if (carUp) {
      for (const k of [3, 6, 9]) {
        const p = desired.clone().addScaledVector(new THREE.Vector3(carUp.x, carUp.y, carUp.z), k);
        if (blocked(p) === null) return p;
      }
    }
    // first swing around the car (keeps distance and height), then crane up, only then pull in
    const off = new THREE.Vector3().subVectors(desired, target);
    for (const a of [25, -25, 50, -50, 80, -80, 110, -110]) {
      const p = target.clone().add(off.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a * Math.PI / 180));
      const gy = this.groundAt(p.x, p.z);
      if (p.y < gy + 0.6) p.y = gy + 0.6;
      if (blocked(p) === null) return p;
    }
    for (const lift of [1.5, 3, 5, 8, 12]) {
      const up = desired.clone(); up.y += lift;
      if (blocked(up) === null) return up;
    }
    const d = blocked(desired)!;
    const dir = desired.clone().sub(target).normalize();
    return d > 0.8 ? target.clone().addScaledVector(dir, d - 0.35) : desired;
  }
}

function lerpV(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, t: number) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}
