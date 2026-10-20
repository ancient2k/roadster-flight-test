# Rendering, worlds and asset pipeline

## Renderer

- **three.js 0.186 with WebGPU and TSL** node materials (`src/render/`). Without WebGPU (or with `?webgl`) the same
  scene runs on the WebGL2 backend with reduced effects.
- **Quality levels** `low | medium | high | ultra` (`quality.ts`): resolution scale, shadow and probe sizes,
  particle budgets, volume-cloud steps, SSR and TRAA. Exposure targets per scene, AgX tone mapping.
- **Post chain** (`post.ts`): screen-space reflections, temporal anti-aliasing, bloom, the ground-cloud volume
  composited at half resolution before TRAA.
- **Cameras** (`cameraMath.ts`, `camera/`): chase, orbit and photo cameras plus fixed broadcast cameras modelled on
  the framing of the live stream for each stunt.

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
sources, landmarks), 16-bit heightmap tiles (near and far), albedo, normal and splat maps and landmark models.

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

The car body was fitted to stills of the live stream by silhouette overlap (`tools/blender/v3/iou.py`,
`fit.py`); the binary silhouette masks are in `tools/blender/v3/masks/`. The stream stills themselves are not
part of this repository, so the fitting tools need your own reference images (`refs.json`).

Blender 5.2 runs headless for all build scripts. Raw downloads go to `tools/worlds/downloads/` (not versioned);
rendered previews go to `out/renders/`.
