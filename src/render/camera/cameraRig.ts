// Camera modes: chase (damped spring + collision), orbit (mouse), cockpit, top, broadcast
// (fixed stream cameras with automatic cuts), photo (orbit + DoF).
import * as THREE from 'three/webgpu';
import type { VehicleState } from '../../shared/types';
import { qrot } from '../../shared/math';
import {
  BroadcastDirector, BROADCAST_SHOTS, chaseLook, chaseOffset, chaseYaw, clampAboveGround, dampAngle, smoothDamp3, spring3,
  type BroadcastShot, type Spring3,
} from '../cameraMath';

export type CameraMode = 'chase' | 'orbit' | 'cockpit' | 'top' | 'broadcast' | 'photo';
export const CAMERA_MODES: CameraMode[] = ['chase', 'orbit', 'cockpit', 'top', 'broadcast', 'photo'];

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

  /** Mouse orbit / zoom for orbit and photo modes. */
  attachInput(el: HTMLElement): void {
    this.cleanup?.();
    const down = (e: PointerEvent) => { if (this.mode !== 'orbit' && this.mode !== 'photo') return; this.dragging = true; this.lastPointer = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastPointer.x, dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.orbit.yaw -= dx * 0.006;
      this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch + dy * 0.004, -0.15, 1.45);
    };
    const up = () => { this.dragging = false; };
    const wheel = (e: WheelEvent) => {
      if (this.mode !== 'orbit' && this.mode !== 'photo') return;
      this.orbit.dist = THREE.MathUtils.clamp(this.orbit.dist * Math.exp(e.deltaY * 0.001), 2.5, 80);
      e.preventDefault();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    this.cleanup = () => {
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up); el.removeEventListener('wheel', wheel);
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
        const target = { x: car.x, y: car.y + 0.6 * (1 - this.air), z: car.z };
        const dRaw = chaseOffset(target, this.yaw, s.speedMs, undefined, this.air);
        const desired = clampAboveGround(dRaw, 0.6, this.groundAt(dRaw.x, dRaw.z));
        const look = chaseLook(target, s.linVel, this.air);
        if (!this.chasePos || !this.lookPos) { this.chasePos = spring3(desired); this.lookPos = spring3(look); }
        const p = smoothDamp3(this.chasePos, desired, 0.22 + 0.25 * this.air, dt);
        const l = smoothDamp3(this.lookPos, look, 0.06 + 0.12 * this.air, dt);
        const pos = this.avoidCollision(new THREE.Vector3(l.x, l.y, l.z), new THREE.Vector3(p.x, p.y, p.z));
        cam.position.copy(pos);
        cam.up.set(0, 1, 0);
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
        const eye = new THREE.Vector3(0, 0.33, -0.3).applyQuaternion(q).add(car);
        cam.position.copy(eye);
        cam.up.set(0, 1, 0).applyQuaternion(q);
        cam.lookAt(new THREE.Vector3(0, 0.2, 10).applyQuaternion(q).add(car));
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

  private avoidCollision(target: THREE.Vector3, desired: THREE.Vector3): THREE.Vector3 {
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
