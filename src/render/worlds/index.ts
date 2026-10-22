// world renderer: loads a Phase-2 site (terrain, sky, light, landmarks, rocks – or the Sun scene) into
// a scene in place of the McGregor track. GameRenderer calls loadWorld() in setup() and world.update() per
// frame; see docs/RENDERING.md for the integration hook.
import * as THREE from 'three/webgpu';
import type { SiteDef } from '../../shared/worlds';
import type { QualityLevel } from '../quality';
import { QUALITY_PRESETS } from '../quality';
import type { ExposureParams } from '../quality';
import { lookParams, sunLightAtGround, skyIrradiance, earthDirForSite, type LookParams } from './skyParams';
import { makeSkyNodes, makeSkyUniforms, type SkyUniforms } from './atmosphere';
import { loadTerrainData, syntheticAssets, TerrainField, type WorldAssets, type SynthKind } from './terrainData';
import { TerrainRenderer, TERRAIN_QUALITY, visibilityTexture, type TerrainTextures } from './terrain';
import { bakeSunVisibilityAsync, stampOccluders } from './terrainShadow';
import { loadTex, loadDetailLayer, DETAIL_FALLBACK } from './textures';
import { RockField, loadRockSet, rockGeometry } from './rocks';
import { PebbleField, pebbleMaterial } from './pebbles';
import { buildGizaExtras } from './giza';
import { buildVisitorPath } from './stonehenge';
import { GrassField } from './grass';
import { applyPropPoses, loadLandmarks, splitDynamicLandmarks, worldTriangles } from './landmarks';
import type { PropPlacement, PropPose } from '../../shared/props';
import { buildTalusMesh } from './talus';
import { fitPyramid, pyramidHeightAt, pyramidHullMesh, pyramidTalus } from '../../shared/pyramid';
import { loadFootprintFile, loadTrampled, Footprints } from './footprints';
import { GroundMarks } from './groundMarks';
import { buildWater } from './water';
import { boxTris } from '../../shared/parts';
import type { BuildArea } from './terrainData';

export type { LookParams } from './skyParams';
export { lookParams } from './skyParams';
export { blackbodyRGB } from './colorScience';
export { loadTerrainData, syntheticAssets, TerrainField } from './terrainData';

export interface WorldOptions {
  quality: QualityLevel;
  /** Base URL for assets ('/' in dev, './' in production). */
  assetBase?: string;
  /** Dev only: directory with Poly Haven detail textures (e.g. '/tools/worlds/downloads/_cc0'). */
  devTextureBase?: string | null;
  /** Use a synthetic heightmap if the site has no terrain assets (default true). */
  synthetic?: boolean;
  /** Render camera (heat shimmer billboard in the Sun scene). */
  camera?: THREE.Camera;
  /**
   * Called with the id of each loading phase. The id is language-neutral and is also the key of the
   * phase timing ('w.<id>' in GameRenderer.timings, read by the perf tools); the display text is
   * t(`loading.phase.<id>`) in src/i18n.
   */
  onProgress?: (phase: LoadPhase) => void;
}

/** Loading phases of loadWorld()/loadSunScene() (stable ids, never translated). */
export type LoadPhase = 'heightmap' | 'textures' | 'landmarks' | 'shadows' | 'terrain' | 'starmap' | 'roadster1' | 'done';

/** Where vegetation must not grow: the build field (+ 6 m for its fence), water and the noScatter polygons. */
function scatterExcluded(a: WorldAssets, field: TerrainField): ((x: number, z: number) => boolean) | undefined {
  const b = a.buildArea, w = a.water, polys = a.noScatter ?? [];
  if (!b && !w && !polys.length) return undefined;
  const inPoly = (p: [number, number][], x: number, z: number) => {
    let inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      if ((p[i][1] > z) !== (p[j][1] > z) && x < (p[j][0] - p[i][0]) * (z - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside;
    }
    return inside;
  };
  return (x, z) => {
    if (b && x > b.minX - 6 && x < b.minX + b.nx * b.tileM + 6 && z > b.minZ - 6 && z < b.minZ + b.nz * b.tileM + 6) return true;
    if (w && field.height(x, z) < w.levelY + 0.15) return true;
    return polys.some((p) => inPoly(p, x, z));
  };
}

export interface WorldHandle {
  readonly site: SiteDef;
  readonly look: LookParams;
  readonly group: THREE.Group;
  /** Direction TO the sun (world, unit). */
  readonly sunDirection: THREE.Vector3;
  readonly sunLight: THREE.DirectionalLight | THREE.PointLight;
  environmentMap?: THREE.Texture;
  /** Auto-exposure range for this look, and a fixed exposure for still cameras. */
  readonly exposure: ExposureParams;
  readonly exposureFixed: number;
  /** Suggested camera far plane (m). */
  readonly cameraFar: number;
  /** Ground height (m) at world x/z; NaN/0 in space. */
  heightAt(x: number, z: number): number;
  /** Terrain height including the drivable pyramids (camera and jet ground); heightAt is the bare terrain. */
  surfaceAt(x: number, z: number): number;
  /** World-space triangles (x,y,z × 3 per triangle) of all landmarks; empty in space. */
  collisionTriangles(): Float32Array;
  /** Per-landmark collision shapes for the physics: pyramids ('pyramid' in meta.json) as smooth rounded frustum plus
   *  talus mesh, everything else (Sphinx, stones, rovers, landers) as exact triangle mesh. */
  collisionShapes(): { id: string; kind: 'hull' | 'mesh'; data: Float32Array; outward?: boolean }[];
  /** movable, breakable landmarks (LM, LRV, rovers, Roadster 1) for the physics (src/sim/core/props.ts);
   *  their triangles are not part of collisionShapes(). */
  dynamicProps?(): PropPlacement[];
  /** part poses from the physics, in PropSystem.poses() order. */
  setPropPoses?(poses: readonly PropPose[]): void;
  /** tyre tracks and jet scour on loose ground (regolith, Martian soil, sand); absent elsewhere. */
  readonly marks?: GroundMarks;
  /** Spawn from the asset meta if present, else SiteDef.spawn. */
  readonly spawn: { x: number; y: number; z: number; headingDeg: number };
  /** Graded build field of the level editor (Boca Chica), null elsewhere. */
  readonly buildArea: BuildArea | null;
  /** Height of the sea/lagoon plane, null without water. */
  readonly waterLevelY: number | null;
  /** Terrain heights exactly as rendered (feed to buildTerrainColliders); null in space. */
  readonly terrain: { heights: Float32Array; size: number; extentM: number; format: WorldAssets['format'] } | null;
  readonly credits: string[];
  /** Resolves when deferred load work (horizon shadow bake) is in; wait for it before the first visible frame. */
  readonly ready?: Promise<void>;
  /** Per-frame: LOD, shadow camera, rock visibility, animated sky/sun. */
  update(cameraPos: THREE.Vector3, dt: number): void;
  setQuality(q: QualityLevel): void;
  /** Look-comparison knobs (sky/fog gain, detail on/off). */
  readonly tuning: { sky: SkyUniforms; setDetail(on: boolean): void };
  /** Sun scene only: heat effects for the player's car. */
  heat?: import('./heat').HeatEffects;
  /** Sun scene only: analytic exposure for the current view (the Sun's disc dominates the luminance). */
  autoExposure?(camera: THREE.PerspectiveCamera): number;
  stats(): Record<string, number | string>;
  dispose(): void;
}

const bodyKind = (s: SiteDef): SynthKind => (s.body === 'moon' ? 'moon' : s.body === 'mars' ? 'mars' : 'earth');

function detailNames(site: SiteDef, a: WorldAssets): { fine: string; rock: string; fineScale: number; rockScale: number } {
  const n = a.detailTextures;
  if (site.body === 'moon') return { fine: n.fine ?? 'regolith', rock: n.rock ?? 'regolith_rocky', fineScale: 4, rockScale: 3 };
  if (site.body === 'mars') return { fine: n.fine ?? 'mars_soil', rock: n.rock ?? 'mars_rock', fineScale: 4, rockScale: 6 };
  if (site.id === 'earth_giza') return { fine: n.fine ?? 'sand', rock: n.rock ?? 'limestone', fineScale: 6, rockScale: 5 };
  // Boca Chica: the splat's rock channel marks the graded build field and the launch site -> McGregor concrete
  if (site.id === 'earth_bocachica') return { fine: n.fine ?? 'sand', rock: 'concrete', fineScale: 6, rockScale: 4 };
  return { fine: n.fine ?? 'grass_chalk', rock: n.rock ?? 'limestone', fineScale: 3, rockScale: 5 };
}

interface WorldQ { shadowExt: number; shadowDepth: number; mapSize: number; rocks: number; rockDist: number; bakeRes: number; skySteps: number; grassRadius: number; grassMax: number }
function worldQuality(q: QualityLevel, look: LookParams): WorldQ {
  const p = QUALITY_PRESETS[q];
  const low = look.look === 'lunar_low_sun';
  return {
    shadowExt: q === 'low' ? 70 : q === 'medium' ? 100 : q === 'high' ? 130 : 180,
    shadowDepth: low ? 16000 : 6000,
    mapSize: p.shadowMapSize,
    rocks: q === 'low' ? 4000 : q === 'medium' ? 9000 : q === 'high' ? 16000 : 26000,
    rockDist: q === 'low' ? 250 : q === 'medium' ? 400 : 600,
    bakeRes: q === 'low' ? 512 : q === 'ultra' ? 1536 : 1024,
    skySteps: q === 'low' ? 8 : 12,
    grassRadius: q === 'low' ? 16 : q === 'medium' ? 22 : q === 'high' ? 27 : 40,
    grassMax: q === 'low' ? 8000 : q === 'medium' ? 16000 : q === 'high' ? 28000 : 48000,
  };
}

/** Horizon-shadow bakes of this session (≈ 2.6 MB per site at ultra). */
const BAKE_CACHE = new Map<string, Promise<[Uint8Array, Uint8Array | null]>>();

export async function loadWorld(scene: THREE.Scene, renderer: THREE.WebGPURenderer, site: SiteDef, opts: WorldOptions): Promise<WorldHandle> {
  if (site.ground === 'space') {
    const { loadSunScene } = await import('./sunScene');
    return loadSunScene(scene, renderer, site, opts);
  }
  const progress = opts.onProgress ?? (() => {});
  const tLoad0 = performance.now();
  const base = (opts.assetBase ?? '/').replace(/\/?$/, '/');
  const dir = base + site.assetDir.replace(/^\/+/, '');
  const look = lookParams(site.look, site.id);
  progress('heightmap');
  let assets = await loadTerrainData(dir).catch((e) => { console.warn('[worlds] terrain:', e); return null; });
  if (!assets) {
    if (opts.synthetic === false) throw new Error(`no terrain data for ${site.id}`);
    assets = syntheticAssets(bodyKind(site), site.id.length * 7 + 3);
  }
  const field = new TerrainField(assets.near, assets.far);
  const q = worldQuality(opts.quality, look);

  // ---- sun & sky
  const sd = assets.sunDir ?? site.sunDir;
  const sunDirection = new THREE.Vector3(sd.x, sd.y, sd.z).normalize();
  if (look.earth) look.earth.dir = earthDirForSite(site.id);
  const sky = makeSkyUniforms();
  sky.sunDir.value.copy(sunDirection);
  sky.sunTop.value.setRGB(look.sunColorTop[0] * look.sunIrradiance, look.sunColorTop[1] * look.sunIrradiance, look.sunColorTop[2] * look.sunIrradiance);
  const sunG = sunLightAtGround(look, sunDirection.y);
  sky.sunGround.value.setRGB(sunG.color[0] * sunG.intensity, sunG.color[1] * sunG.intensity, sunG.color[2] * sunG.intensity);
  if (look.earth) sky.earthDir.value.set(...look.earth.dir).normalize();
  sky.starGain.value = look.starBrightness;
  // morning ground mist at Stonehenge (radiation fog in the Avon valley and over the downland)
  const mist = site.id === 'earth_stonehenge' ? { sigma0: 0.0009, heightM: 9, y0: -4 } : null;
  const skyNodes = makeSkyNodes(look, sky, { steps: q.skySteps, mist });
  const prev = { bg: scene.backgroundNode, fog: scene.fogNode, env: scene.environment, envI: scene.environmentIntensity, bgTex: scene.background };
  scene.backgroundNode = skyNodes.background;
  scene.fogNode = skyNodes.fog as never;

  const group = new THREE.Group();
  group.name = `World:${site.id}`;
  scene.add(group);

  // environment (IBL) from the sky without the sun disc
  let envRT: THREE.RenderTarget | null = null;
  try {
    const envScene = new THREE.Scene();
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    mat.colorNode = skyNodes.environment as never;
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), mat);
    envScene.add(sphere);
    const pm = new THREE.PMREMGenerator(renderer);
    envRT = pm.fromScene(envScene, 0, 0.1, 200, { size: 128 }) as unknown as THREE.RenderTarget;
    pm.dispose();
    sphere.geometry.dispose(); mat.dispose();
    scene.environment = envRT.texture;
    scene.environmentIntensity = 1;
  } catch (e) {
    console.warn('[worlds] PMREM aus Himmel fehlgeschlagen, Hemisphärenlicht als Ersatz:', e);
  }
  const irr = skyIrradiance(look, [sunDirection.x, sunDirection.y, sunDirection.z]);
  const hemi = new THREE.HemisphereLight(
    envRT ? 0x000000 : new THREE.Color(irr.sky[0], irr.sky[1], irr.sky[2]).multiplyScalar(1 / Math.max(1e-3, Math.max(...irr.sky))),
    new THREE.Color(irr.ground[0], irr.ground[1], irr.ground[2]).multiplyScalar(1 / Math.max(1e-4, Math.max(...irr.ground))),
    1,
  );
  // HemisphereLight intensity scales both colours: carry the absolute level in the intensity. With the
  // PMREM environment the bounce from below is already in it (the sky node renders lit ground below the horizon).
  const groundLevel = Math.max(...irr.ground);
  hemi.intensity = envRT ? 0 : Math.max(Math.max(...irr.sky), groundLevel) * Math.PI;
  hemi.visible = !envRT;
  group.add(hemi);

  const sun = new THREE.DirectionalLight(new THREE.Color(sunG.color[0], sunG.color[1], sunG.color[2]), sunG.intensity);
  sun.name = 'Sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(q.mapSize, q.mapSize);
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = look.shadowRadius;
  const setShadowCam = (ext: number, depth: number) => {
    const c = sun.shadow.camera;
    c.left = -ext; c.right = ext; c.top = ext; c.bottom = -ext; c.near = 1; c.far = depth * 2;
    c.updateProjectionMatrix();
  };
  setShadowCam(q.shadowExt, q.shadowDepth);
  group.add(sun, sun.target);

  // ---- textures
  progress('textures');
  const dn = detailNames(site, assets);
  const fb = (name: string) => opts.devTextureBase && DETAIL_FALLBACK[name] ? { base: opts.devTextureBase, folder: DETAIL_FALLBACK[name] } : null;
  const aniso = opts.quality === 'low' ? 4 : 8;
  const shared = `${base}assets/worlds/_shared/detail`;
  // landmarks and the boulder GLB load alongside the textures (the shadow bake waits for the landmarks)
  const lmP = loadLandmarks(dir, assets.landmarks, (x, z) => field.height(x, z));
  const rockSetP = loadRockSet(assets.rocksUrl);
  const fpFile = site.body === 'moon' ? await loadFootprintFile(dir) : null;
  const [albedo, splat, fine, rock, trampled] = await Promise.all([
    loadTex(assets.albedoUrl, { srgb: true, flipY: false, anisotropy: aniso }),
    loadTex(assets.splatUrl, { srgb: false, flipY: false, anisotropy: 2 }),
    loadDetailLayer(dir, dn.fine, dn.fineScale, fb(dn.fine), aniso, shared),
    // 'concrete' is the McGregor pad texture (assets/env, already cached from the start)
    loadDetailLayer(dir, dn.rock, dn.rockScale, fb(dn.rock), aniso, dn.rock === 'concrete' ? `${base}assets/env` : shared),
    fpFile ? loadTrampled(dir, fpFile) : Promise.resolve(null),
  ]);

  // ---- landmarks (before the shadow bake: they cast baked shadows too)
  progress('landmarks');
  const lm = await lmP;
  group.add(lm.group);
  // movable parts leave the static landmark before its collider and baked shadow are taken
  const propVis = splitDynamicLandmarks(lm.items, lm.group);

  progress('shadows');
  const pen = Math.max(look.sunAngularRadius, 0.004);
  // only large landmarks throw shadows beyond the real-time shadow map: stamp those (rovers, LM, single
  // stones: skip – they cost seconds in the bake, R5 load budget)
  const bigRoots = new Set(lm.items.filter((it) => {
    if (it.def.bake === false) return false;
    const sz = new THREE.Box3().setFromObject(it.object).getSize(new THREE.Vector3());
    return Math.max(sz.x, sz.y, sz.z) > 15;
  }).map((it) => it.object));
  const occTriArr = bigRoots.size ? worldTriangles(lm.group, 400_000, (o) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (bigRoots.has(p)) return true;
    return false;
  }) : new Float32Array(0);
  const occNear = occTriArr.length ? stampOccluders(field.near, occTriArr) : field.near;
  const t0 = performance.now();
  const sunV = { x: sunDirection.x, y: sunDirection.y, z: sunDirection.z };
  // spread the bake over the cores (near tile ≈ 4× the far tile's work)
  const cores = Math.max(2, Math.min(10, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) || 4) - 1);
  const farW = field.far ? Math.max(1, Math.round(cores / 5)) : 0;
  // a revisit (same site, resolution, sun and occluders) re-uses the bake of this session
  const bakeKey = `${site.id}|${q.bakeRes}|${sunV.x},${sunV.y},${sunV.z}|${pen}|${occTriArr.length}|${field.far ? 1 : 0}`;
  const bake = BAKE_CACHE.get(bakeKey) ?? Promise.all([
    bakeSunVisibilityAsync(occNear, { res: q.bakeRes, sun: sunV, penumbra: pen, maxDist: 20000 },
      field.far ? { near: field.near, far: field.far, blendM: field.blendM, height: (x, z) => field.height(x, z) } : null, cores - farW),
    field.far ? bakeSunVisibilityAsync(field.far, { res: 512, sun: sunV, penumbra: pen * 2, maxDist: 30000 }, null, farW) : Promise.resolve(null),
  ]);
  BAKE_CACHE.set(bakeKey, bake);
  // the bake runs in the workers while the world is built and its shaders compile; the visibility
  // textures exist from the start (same size/format: no pipeline change) and are filled in when it is done
  // – `ready` resolves then and the caller waits for it before the first visible frame.
  const visNear0 = new Uint8Array(q.bakeRes * q.bakeRes), visFar0 = field.far ? new Uint8Array(512 * 512) : null;
  let bakeMs = 0, litPct = 0;
  const occTris = occTriArr.length / 9;
  const textures: TerrainTextures = {
    albedo, splat, fine, rock,
    shadowNear: visibilityTexture(visNear0, q.bakeRes), shadowFar: visFar0 ? visibilityTexture(visFar0, 512) : null,
    // grassland: grass_chalk (Poly Haven grass_ground) – detail and some of its hue on top of the macro albedo
    ...(site.body === 'earth' && site.id !== 'earth_giza' ? { fineStrength: 0.85, fineChroma: 0.35 } : {}),
    trampled,
    craters: site.body === 'moon' ? 'moon' : site.body === 'mars' ? 'mars' : null,
    strata: site.body === 'mars',
    albedoTint: site.id === 'earth_giza' ? [1.0, 0.93, 0.78] : undefined,
  };

  const ready = bake.then(([visNear, visFar]) => {
    bakeMs = performance.now() - t0;
    let lit = 0;
    for (let i = 0; i < visNear.length; i++) lit += visNear[i] > 127 ? 1 : 0;
    litPct = Math.round((lit / visNear.length) * 1000) / 10;
    visNear0.set(visNear);
    textures.shadowNear!.needsUpdate = true;
    if (visFar && visFar0) { visFar0.set(visFar); textures.shadowFar!.needsUpdate = true; }
  });

  progress('terrain');
  const terrain = new TerrainRenderer(field, look, textures, TERRAIN_QUALITY[opts.quality]);
  terrain.uniforms.sunDir.value.copy(sunDirection);
  terrain.uniforms.rtShadowRadius.value = q.shadowExt;
  group.add(terrain.group);
  const water = assets.water ? buildWater(assets.water.levelY, field.halfExtent * 2, (x, z) => field.height(x, z)) : null;
  if (water) group.add(water.mesh);
  const footprints = fpFile ? await Footprints.create(dir, fpFile, field, terrain.surfaceColor) : null;
  if (footprints) group.add(footprints.mesh);
  // tyre tracks and jet scour (only where the ground is loose: Moon, Mars, Giza sand)
  const marks = site.surface === 'regolith' || site.surface === 'mars_soil' || site.surface === 'sand'
    ? new GroundMarks({ surface: site.surface, height: (x, z) => field.height(x, z), groundColor: terrain.surfaceColor, capacity: opts.quality === 'low' ? 3000 : 6000 })
    : null;
  if (marks) { group.add(marks.group); if (footprints) marks.onScour = (x, z, r) => footprints.scour(x, z, r); }

  // boulders: rock set where the meta names one, procedural on Moon/Mars, none on grassland
  const rockSet = await rockSetP;
  const wantRocks = !!rockSet || site.body === 'moon' || site.body === 'mars';
  const mkRocks = (n: number, dist: number) => new RockField(field, look, terrain.uniforms.sunDir, { count: n, viewDist: dist, cellM: 256, seed: site.id.length * 31 }, rockSet);
  // Mars: boulder fields as in the Mastcam-Z/Navcam pans (Jezero floor, Bradbury) – twice the base density
  const rockK = site.body === 'mars' ? 2 : 1;
  let rocks: RockField | null = wantRocks ? mkRocks(q.rocks * rockK, q.rockDist) : null;
  if (rocks) group.add(rocks.group);
  // Giza mastaba fields + city edge
  const giza = site.id === 'earth_giza' ? buildGizaExtras(field, rock, opts.quality) : null;
  if (giza) group.add(giza.group);
  const visitorPath = site.id === 'earth_stonehenge' ? buildVisitorPath(field) : null;
  if (visitorPath) group.add(visitorPath);
  // drivable pyramids: smooth frustum hull + sand/rubble talus at the foot (shared with the physics)
  const pyramids = lm.items.map((it) => {
    if (it.def.collider !== 'pyramid') return null;
    const fit = fitPyramid(worldTriangles(it.object, 400_000), it.def.x, it.def.z, (it.def.headingDeg ?? 0) * Math.PI / 180);
    return { fit, talus: pyramidTalus(fit, (x, z) => field.height(x, z)) };
  });
  const talusTris = pyramids.filter((p) => p).map((p) => p!.talus);
  const talusAll = new Float32Array(talusTris.reduce((n, t) => n + t.length, 0));
  talusTris.reduce((o, t) => { talusAll.set(t, o); return o + t.length; }, 0);
  const talusMesh = buildTalusMesh(talusAll, fine, rock);
  if (talusMesh) group.add(talusMesh);
  // pebbles/cobbles at the camera (Moon, Mars, Giza desert pavement)
  // stones per 0,7-m lattice cell (≈ 2 × per m²)
  const pebbleDensity = site.body === 'mars' ? 0.6 : site.body === 'moon' ? 0.3 : site.id === 'earth_giza' ? 0.18 : 0;
  let pebbleGeoms: THREE.BufferGeometry[] | null = null, pebbleMat: THREE.Material | null = null;
  const mkPebbles = (ql: QualityLevel) => {
    if (!pebbleDensity || ql === 'low') return null;
    // low-poly fractured stones (80 tris; the boulder GLBs carry ~600 – too many for thousands of pebbles)
    pebbleGeoms ??= [0, 1, 2, 3, 4].map((i) => rockGeometry(site.id.length * 13 + i, 1));
    pebbleMat ??= pebbleMaterial(look, site.body === 'moon' ? 'moon' : site.body === 'mars' ? 'mars' : 'earth', terrain.uniforms.sunDir);
    const r = ql === 'medium' ? 26 : ql === 'high' ? 36 : 50;
    const cellM = 0.7;
    return new PebbleField(field, pebbleGeoms, pebbleMat, { radius: r, density: pebbleDensity, cellM, dMin: 0.05, dMax: 0.6, maxInstances: Math.ceil(Math.PI * r * r / (cellM * cellM) * pebbleDensity * 1.1), seed: site.id.length });
  };
  let pebbles = mkPebbles(opts.quality);
  if (pebbles) group.add(pebbles.group);
  // grass on Earth grassland (Stonehenge)
  let grass: GrassField | null = null;
  if (site.body === 'earth' && site.id !== 'earth_giza') {
    grass = new GrassField(field, { radius: q.grassRadius, spacing: 0.3, maxInstances: q.grassMax, exclude: scatterExcluded(assets, field) });
    if (await grass.load(`${base}assets/env-models/grass_clump.glb`)) {
      group.add(grass.group);
      grass.sunDir.value.copy(sunDirection);
      grass.sunColor.value.setRGB(sunG.color[0] * sunG.intensity, sunG.color[1] * sunG.intensity, sunG.color[2] * sunG.intensity);
    } else grass = null;
  }

  const sp = assets.spawn ?? { x: site.spawn.pos.x, y: site.spawn.pos.y, z: site.spawn.pos.z, headingDeg: site.spawn.headingDeg };
  const spawn = { ...sp, y: field.height(sp.x, sp.z) };
  const snap = new THREE.Vector3();
  let level = opts.quality;

  const handle: WorldHandle = {
    site, look, group, sunDirection, sunLight: sun, ready,
    buildArea: assets.buildArea ?? null, waterLevelY: assets.water?.levelY ?? null,
    environmentMap: envRT?.texture,
    exposure: look.exposure, exposureFixed: look.exposureFixed,
    cameraFar: Math.max(30000, field.halfExtent * 2.2),
    heightAt: (x, z) => field.height(x, z),
    surfaceAt: (x, z) => {
      let h = field.height(x, z);
      for (const p of pyramids) if (p) h = Math.max(h, pyramidHeightAt(p.fit, x, z));
      return h;
    },
    collisionTriangles: () => worldTriangles(lm.group, 250_000),
    collisionShapes: () => lm.items.flatMap((it, i) => {
      const id = `${it.def.file.replace(/\.glb$/, '')}#${i}`;
      const pyr = pyramids[i];
      if (pyr) return [{ id, kind: 'mesh' as const, data: pyramidHullMesh(pyr.fit), outward: true }, { id: `${id}_talus`, kind: 'mesh' as const, data: pyr.talus }];
      if (it.def.collider === 'box') {
        const b = new THREE.Box3().setFromObject(it.object);
        return [{ id, kind: 'mesh' as const, data: boxTris([b.min.x, b.min.y, b.min.z], [b.max.x, b.max.y, b.max.z]), outward: true }];
      }
      return [{ id, kind: 'mesh' as const, data: worldTriangles(it.object, 250_000) }];
    }),
    marks: marks ?? undefined,
    dynamicProps: () => propVis.placements,
    setPropPoses: (poses) => applyPropPoses(propVis, poses),
    spawn,
    terrain: { heights: assets.near.h, size: assets.near.size, extentM: assets.near.extentM, format: assets.format },
    credits: assets.credits,
    tuning: { sky, setDetail: (on) => { terrain.uniforms.detailStrength.value = on ? 1 : 0; } },
    update(cam: THREE.Vector3) {
      terrain.update(cam);
      rocks?.update(cam);
      pebbles?.update(cam);
      grass?.update(cam);
      // shadow camera centred on the camera, snapped to shadow texels (no shimmering)
      const ext = sun.shadow.camera.right;
      const texel = (2 * ext) / sun.shadow.mapSize.x;
      const ground = field.height(cam.x, cam.z);
      snap.set(cam.x, Number.isFinite(ground) ? ground : cam.y, cam.z);
      // snap in light space
      const lz = sunDirection.clone().negate();
      const lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), lz);
      if (lx.lengthSq() < 1e-6) lx.set(1, 0, 0);
      lx.normalize();
      const ly = new THREE.Vector3().crossVectors(lz, lx);
      const a = Math.round(snap.dot(lx) / texel) * texel, b = Math.round(snap.dot(ly) / texel) * texel, c = snap.dot(lz);
      snap.copy(lx).multiplyScalar(a).addScaledVector(ly, b).addScaledVector(lz, c);
      const depth = sun.shadow.camera.far / 2;
      sun.target.position.copy(snap);
      sun.position.copy(snap).addScaledVector(sunDirection, depth);
      sun.target.updateMatrixWorld();
      sun.updateMatrixWorld();
      terrain.uniforms.rtShadowCenter.value.copy(snap);
    },
    setQuality(ql: QualityLevel) {
      if (ql === level) return;
      level = ql;
      const nq = worldQuality(ql, look);
      terrain.setQuality(TERRAIN_QUALITY[ql]);
      sun.shadow.mapSize.set(nq.mapSize, nq.mapSize);
      setShadowCam(nq.shadowExt, nq.shadowDepth);
      terrain.uniforms.rtShadowRadius.value = nq.shadowExt;
      pebbles?.dispose();
      pebbles = mkPebbles(ql);
      if (pebbles) group.add(pebbles.group);
      if (rocks && rocks.instances.length !== nq.rocks * rockK) {
        rocks.dispose();
        rocks = mkRocks(nq.rocks * rockK, nq.rockDist);
        group.add(rocks.group);
      }
    },
    stats: () => ({
      format: assets!.format, nodes: terrain.stats.nodes, terrainTris: terrain.stats.triangles, built: terrain.stats.built,
      prints: footprints?.mesh.count ?? 0, pebbles: pebbles?.count ?? 0, mastabas: giza?.mastabas ?? 0, buildings: giza?.buildings ?? 0, rocks: rocks?.instances.length ?? 0, grass: grass?.count ?? 0, rockGlb: rockSet ? 1 : 0, landmarks: lm.items.length, missingLandmarks: lm.missing.join(',') || '-',
      bakeMs: Math.round(bakeMs), litPct, occTris, albedo: albedo ? 1 : 0, detail: (fine ? 1 : 0) + (rock ? 1 : 0),
    }),
    dispose() {
      group.removeFromParent();
      terrain.dispose();
      water?.dispose();
      footprints?.dispose();
      marks?.dispose();
      trampled?.tex.dispose();
      rocks?.dispose();
      pebbles?.dispose();
      giza?.dispose();
      if (talusMesh) { talusMesh.geometry.dispose(); (talusMesh.material as THREE.Material).dispose(); }
      if (visitorPath) { visitorPath.geometry.dispose(); (visitorPath.material as THREE.Material).dispose(); }
      for (const g of pebbleGeoms ?? []) g.dispose();
      pebbleMat?.dispose();
      grass?.dispose();
      if (rockSet) { for (const g of rockSet.geoms) g.dispose(); rockSet.material.dispose(); }
      lm.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { m.geometry.dispose(); for (const mt of Array.isArray(m.material) ? m.material : [m.material]) mt.dispose(); }
      });
      for (const t of [albedo, splat, fine?.diff, fine?.nor, fine?.arm, rock?.diff, rock?.nor, rock?.arm, textures.shadowNear, textures.shadowFar]) t?.dispose();
      envRT?.dispose();
      sun.dispose();
      scene.backgroundNode = prev.bg; scene.fogNode = prev.fog; scene.environment = prev.env; scene.environmentIntensity = prev.envI;
    },
  };
  handle.update(new THREE.Vector3(spawn.x, spawn.y + 2, spawn.z), 0);
  // load time of the world itself (read by tools/worlds/world_probe.mjs next to the game's phase timings)
  try { performance.measure(`r5:loadWorld:${site.id}`, { start: tLoad0, end: performance.now() }); } catch { /* old browsers */ }
  progress('done');
  return handle;
}
