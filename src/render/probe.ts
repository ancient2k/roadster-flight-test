// Reflection probe for the car: a cube map of the scene around the car, refreshed one face per
// frame (full refresh every 6 frames). The car, its jets and the particles are hidden while
// capturing. Node materials convert it to a PMREM automatically.
import * as THREE from 'three/webgpu';

export class ReflectionProbe {
  readonly target: THREE.CubeRenderTarget;
  readonly cubeCamera: THREE.CubeCamera;
  private face = 0;
  constructor(size = 128) {
    this.target = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter });
    this.cubeCamera = new THREE.CubeCamera(0.4, 3000, this.target);
  }

  get texture(): THREE.Texture { return this.target.texture; }

  /** Render one face, all six (`full`), or the given faces. */
  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, pos: THREE.Vector3, hide: THREE.Object3D[], full: boolean | number[] = false): void {
    const cc = this.cubeCamera;
    if (cc.coordinateSystem !== renderer.coordinateSystem) {
      cc.coordinateSystem = renderer.coordinateSystem;
      cc.updateCoordinateSystem();
    }
    cc.position.copy(pos);
    cc.updateMatrixWorld(true);
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => { o.visible = false; });
    // keep this frame's shadow maps: shadows update once per camera and frame, so every cube face
    // would otherwise re-render them (the main cost of the probe)
    const shadows: THREE.LightShadow[] = [];
    scene.traverse((o) => { const l = o as THREE.SpotLight; if (l.isLight && l.castShadow && l.shadow?.autoUpdate) shadows.push(l.shadow); });
    shadows.forEach((sh) => { sh.autoUpdate = false; });
    const prevRT = renderer.getRenderTarget();
    const prevMRT = renderer.getMRT();
    renderer.setMRT(null);
    const cams = cc.children as THREE.PerspectiveCamera[];
    const faces = Array.isArray(full) ? full : full ? [0, 1, 2, 3, 4, 5] : [this.face];
    for (const f of faces) {
      renderer.setRenderTarget(this.target, f);
      renderer.render(scene, cams[f]);
    }
    this.face = (this.face + 1) % 6;
    renderer.setRenderTarget(prevRT);
    renderer.setMRT(prevMRT);
    shadows.forEach((sh) => { sh.autoUpdate = true; });
    hide.forEach((o, i) => { o.visible = vis[i]; });
    this.target.texture.needsPMREMUpdate = true;
  }

  dispose(): void { this.target.dispose(); }
}
