# Rendering, worlds and asset pipeline

## Renderer

- **three.js 0.186 with WebGPU and TSL** node materials (`src/render/`). Without WebGPU (or with `?webgl`) the same
  scene runs on the WebGL2 backend with reduced effects.
- **Quality levels** `low | medium | high | ultra` (`quality.ts`): resolution scale, shadow and probe sizes,
  particle budgets, volume-cloud steps, SSR and TRAA. Exposure targets per scene, AgX tone mapping.
- **Post chain** (`post.ts`): screen-space reflections, temporal anti-aliasing, bloom, the ground-cloud volume
  composited at half resolution before TRAA.
- **Cameras** (`cameraMath.ts`, `camera/`): chase, orbit and photo cameras plus fixed broadcast cameras modelled on
  the framing of the live stream for each stunt. The chase camera can be turned and zoomed with the mouse (drag,
  wheel) and swings back behind the car after `LOOK_RECENTER_S` of driving. On a wall or overhang (car on the
  ground with its roof tilted past ≈ 40°) it follows in the car's own frame, behind along the surface and out
  over the roof, so the ramp no longer hides the car (`tests/perf/_occlusion.mjs`: ramp hang 38 % → 0 % of
  the time hidden, ramp launch 10 % → 0 %).

## Temporal stability (ghosting, flicker)

- **Painted ground** (`worlds/pavedGround.ts`): the Starbase roads and paved slabs are a concrete/asphalt mask in the
  terrain shader (from OpenStreetMap, `tools/worlds/starbase_ground.py`, `LandmarkDef.ground`), not geometry. As boxes
  on the ungraded terrain they were steps the car caught on, jagged at the segment joints, and they flickered or
  vanished against the coarser terrain LODs; painted, they follow the ground at every distance and the car drives
  on the terrain. No grass grows on them.
- **Ground-level surfaces** (roads and pads of the editor tracks, tyre marks): pulled
  towards the camera with `polygonOffset`. The worlds render with a reversed depth buffer, for which three.js does
  not flip the offset; `flipDepthBias()` in `GameRenderer.ts` negates the depth bias of every pipeline (WebGL
  fallback: every `gl.polygonOffset`), otherwise these surfaces lost against the terrain (flicker, roads hidden
  from above).
- **Camera cuts** (`post.ts`): three keeps the previous view matrix per camera object, so the velocity
  buffer of the first frame after a broadcast cut still holds the motion from the old shot. TRAA then
  reprojected the re-seeded history by a whole-screen offset and the motion blur smeared the cut frame
  along those vectors. `PostChain.resetHistory()` now shows the cut frame straight from the beauty buffer
  (no TRAA, no motion blur) and re-seeds the history on that frame and the next.
- **Motion blur** (`post.ts`): 180° shutter (`motionAmount` 0.25) and a gather that only takes samples
  moving like the centre pixel. The previous 360° average of every tap let the static background show
  through the leading and trailing parts of a launching car (a "ghost car").
- **Sub-pixel emitters** (`world/materials.ts` `pixelFloor()`): LED posts and bars, tower lamp lenses and
  site lights are a few centimetres thick and cover less than a pixel from the long-lens cameras. TRAA's
  variance clipping drops them whenever the jitter misses them, so they blinked. Their thin axes are
  widened to at least 2 px in the vertex shader and their emission is scaled by the same ratio
  (`PIXEL_ANGLE` is set per frame by `GameRenderer`). Instanced emitters are merged into one static mesh
  for this.
- **Grass** (`worlds/grass.ts`): three takes an instance's previous-frame matrix by index. The camera-centred
  lattice was re-written in lattice order on every re-scatter (≈ every 0.6 m of travel), so every slot held
  another clump and every blade got a bogus motion vector; with the old motion blur the lawn flashed white
  while driving at Stonehenge. Each lattice cell now keeps its instance slot. Related: three's
  `positionPrevious` ignores `material.positionNode`, so materials that move vertices there (worlds:
  rocks, terrain geomorphing) also carry motion vectors without that offset.
- **Measuring** (`tests/render/flickerGhost.mjs`, metrics in `frameMetrics.ts`): fixed-step capture of the
  title demo and the auto stunts (loop stopped, 1/60 s per frame, seeded `Math.random`, dynamic resolution
  held), per frame a 192×108 luma grid of 10×10-pixel box means, a trace of shot/cut/exposure/light slots,
  and optionally a reference run without temporal history (`--ref`) for the ghosting trail, `--freeze N`
  (static scene, pure render flicker), `--video` and `--seq world:<site>` (free drive in a world). Block metrics must use box means: a scaled
  `drawImage` samples single pixels and aliases thin lights in the measurement itself. The sign-reversal
  energy penalises a steady ±15 % shimmer more than a light that slowly builds up and drops out, so the
  blink of thin lights is judged per pixel (share of frames below half the pixel's maximum).
- Not changed: the ground-cloud volume is simulated at 24 Hz in a worker and swapped as a whole, so it
  moves in steps at 60 fps; dynamic-resolution steps restart the TRAA history (one soft frame).
- Flicker while driving (Oct 2026): without GPU timestamps dynamic resolution only sees the frame interval,
  pinned to the refresh rate; it could step down but never back up (stuck at 70 % on "high" after one heavy
  stretch). In that mode a scene holding the refresh rate now probes the next step up after a quiet spell
  (`DynamicResolution`, failed probes back off ×2). Thin bright car lamps are widened at load (`widenThinLamp`:
  tail bar 4 cm, brake bar 1.6 cm, plate lamps 1.8 cm and dimmed), the Starbase wire fences are panels with a
  box-filtered post/rail shader (`worlds/fence.ts`) instead of sub-pixel beams. The motion vectors were
  checked against the projected motion of the car mesh and are correct. Capture aid:
  `tests/perf/_flicker.mjs` (consecutive frames via the CDP screencast).

## Effects

- **Cold-gas jets** (`fx/jets.ts`): under-expanded supersonic plumes with Mach diamonds whose spacing and
  brightness follow the nozzle exit state from the physics (pressure ratio, ambient pressure).
- **Condensation clouds** (`fx/volume/`): a 3D density grid simulated on the CPU in a worker (sources from the jets'
  wall jets, advection, curl-noise eddies, cold gravity current along the ground) and ray-marched in the fragment
  shader with self-shadowing and coloured stage lights (white floodlights, red LED bars and floods).
- **Particles** (`fx/particles.ts`, `fx/emitters.ts`): tyre smoke, jet ejecta and soil. Soil grains are ballistic
  (pure parabolas in vacuum), drawn as packets of small discs with a power-law size distribution and a Lambert
  phase function; each grain dies where its trajectory meets the real terrain.
- **Ground marks** (`worlds/groundMarks.ts`): tyre tracks with tread imprint and berms (depth from the Bekker
  sinkage of the physics) and directional jet-scour decals that brighten lunar and darken Martian soil.

## Worlds

Each site is a folder in `public/assets/worlds/<site>/` with `meta.json` (extent, height range, spawn, sun,
sources, landmarks), 16-bit heightmap tiles (near and far), albedo and splat maps and landmark models; the detail
textures are shared by all sites (`_shared/detail/`).

- **Terrain** (`worlds/terrain.ts`, `chunk.ts`, `lod.ts`): near and far tiles with geomorphing LOD, detail
  textures, procedural small craters below the DEM resolution (Moon, Mars), sedimentary layering on Martian slopes.
- **Lighting:** the sun position per site and date, a terrain shadow map baked in web workers out to the horizon
  (`terrainShadow.ts`, `shadowWorker.ts`), atmospheric scattering per planet (`atmosphere.ts`, `skyParams.ts`).
- **Scatter:** rocks, pebbles and grass with per-site rules (`scatter.ts`, `rocks.ts`, `pebbles.ts`, `grass.ts`).
- **Landmarks:** Apollo descent stages (Kapton foil, landing gear, ladder, plaque), the LRV, Curiosity and
  Perseverance (NASA models), Stonehenge, the Giza pyramids with the Sphinx and mastaba fields.
- **Sun scene** (`sunScene.ts`): SDO sun disk with limb darkening, granulation and prominences, a star map and
  Roadster 1 with Starman.
- **Load time:** two persistent renderers (McGregor and the worlds), so returning to McGregor is instant and
  between worlds only the world is rebuilt; shader pipelines are pre-compiled while the loading screen shows.
  Measured on an Apple M1 Pro: every site smooth within 0.4–6.3 s (`tests/e2e/loadtime.spec.ts`).

## Asset pipeline

All models are generated reproducibly by scripts — nothing is hand-modelled or bought.

| What | Script | Output |
|---|---|---|
| Roadster Gen 2 | `tools/blender/v3/build_v3.py` (body surfaces from a spec, wheel, lamps, nozzles) | `public/assets/car/roadster.glb`, `roadster_lod1.glb` |
| Roadster 1 + Starman | `tools/blender/build_starman.py` | `public/assets/car/roadster1_starman.glb` |
| Obstacle vehicles | `tools/blender/build_props.py` with `carkit.py` | `public/assets/props/*.glb` |
| McGregor environment | `tools/blender/env/build_all.sh` (light towers, stage, grandstand, crowd, vegetation, ramp truss) | `public/assets/env-models/*.glb` |
| Terrain | `tools/worlds/terrain.py`, `sites.py` (download, reprojection, tiling) | `public/assets/worlds/<site>/` |
| Landmarks | `tools/worlds/blender/build_*.py` (Apollo, Stonehenge, Giza) | world GLBs |
| HUD font "RFT Display" | `src/ui/fonts/build_font.py` | `public/assets/fonts/*.woff` |
| Web compression | `npm run compress-assets` (`tools/compress-assets.mjs`, `tools/share-textures.mjs`) | the GLBs above, in place |

The car body was fitted to stills of the live stream by silhouette overlap (`tools/blender/v3/iou.py`,
`fit.py`); the binary silhouette masks are in `tools/blender/v3/masks/`. The stream stills themselves are not
part of this repository, so the fitting tools need your own reference images (`refs.json`).

**Compression** (run after rebuilding a model): geometry is stored with `EXT_meshopt_compression` without filters,
so the decoded vertices are bit-identical to the Blender export; PNG textures become WebP (colour maps lossy q90,
normal and metal/rough maps lossless), JPEG textures stay as they are. Names, empty nodes and extras are kept.
Images that several GLBs of a folder embed identically (the Giza pyramids) are moved to `<folder>/tex/` and loaded
once. Every `GLTFLoader` needs `setMeshoptDecoder`; tests read compressed GLBs through `tests/assets/glbFile.ts`.

Download size (GitHub Pages, gzip; `tests/perf/_bootsize.mjs`; files already loaded are cached):

| | before | after |
|---|---|---|
| Start (McGregor, car, props) | 26.5 MB | 21.3 MB |
| Giza | 25.5 MB | 15.9 MB |
| Stonehenge | 15.8 MB | 15.6 MB |
| Jezero | 15.0 MB | 13.3 MB |
| Tranquility Base | 12.9 MB | 12.9 MB |
| Sun | 9.1 MB | 8.7 MB |

The rest is mostly the 16-bit heightmaps (`terrain_h16.png`, ≈ 5–6 MB per site; a delta-coded format would save
only ≈ 18 %) and the JPEG textures. The deployed site shrank from 336 MB to 182 MB: the old contract files
(`height.bin`, per-site detail copies, `normal.png`) were never loaded by the game and are no longer shipped.

Blender 5.2 runs headless for all build scripts. Raw downloads go to `tools/worlds/downloads/` (not versioned);
rendered previews go to `out/renders/`.
