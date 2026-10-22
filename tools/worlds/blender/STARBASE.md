# Starbase procedural asset draft

## Status — 2026-10-22

**Incomplete; not ready to merge as a working asset package.** Generator sources and the
OSM-derived layout JSON exist. No GLB or preview PNG was successfully produced in this
session. Blender 5.2.1 exits with signal 11 / exit 139 during native Metal device detection,
before it runs Python. A factory-startup probe with only `print()` fails identically;
`--debug-gpu-force-workarounds` does not fix it. The installed build only supports Metal.
The connected Blender tool was also unavailable: `MCP tool call requires approval, but
approval policy is never`. No open Blender scene was changed. Git staging also failed because the worktree's shared Git metadata
is outside the writable roots: creation of
`roadster-flight-test-repo/.git/worktrees/rft-codex-assets/index.lock` returned
`Operation not permitted`. No files were staged, no commit was created, and nothing was pushed.
Once the assets are built and reviewed in a writable session, commit only the listed new
sources and the `earth_bocachica` asset directory, retaining the user's requested trailer:
`Co-Authored-By: Codex (GPT-6-Astra) <noreply@openai.com>`.

Python AST parsing and Node syntax checking passed. The layout function was evaluated
independently of Blender against the supplied OSM JSON. Geometry export, compression,
measured triangle/texture counts, LOD quality, node validation and visual acceptance remain
**unverified**. Do not interpret the implementation's dimensions as measured GLB results.

## Rebuild and review

Run from the repository root with Blender's normal Metal initialization available:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/worlds/blender/build_starship.py -- --renders
/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/worlds/blender/build_starbase.py -- --renders
node tools/compress-assets.mjs public/assets/worlds/earth_bocachica
node tools/worlds/blender/check_starbase.mjs
```

The order matters: the site preview imports the uncompressed stack and tower GLBs.
Blender's importer is not assumed to decode the subsequent meshopt compression.
Omit `--renders` for geometry-only builds. Regeneration replaces generated GLBs and layout;
compression rewrites GLBs in place. No animation, loader, physics, collision, build zones,
or runtime integration is supplied. The scripts use factory-reset **inside their headless
process**; do not run them against an unsaved interactive scene.

`starbase_common.py` provides deterministic mesh batching, generated images, export, LOD
and daylight Cycles previews. It follows the existing `common.py` / `env_common.py` pattern
of explicit geometry, Principled materials, UVs and GLB export with `export_yup=True`.
No meshes or images are downloaded. `check_starbase.mjs` uses the existing glTF Transform
and meshoptimizer dependencies, decodes the compressed assets, checks node parentage,
origins/scales, stage separation, bounds, budgets and LOD ratio, then writes
`asset_metrics.json`. That metrics file is deliberately absent until a successful check.

## Coordinates and layout

Authoring coordinates are Blender `(east,north,up)` in metres; glTF export maps these to
`(east,up,-north)`. Root locations and rotations are identity. Child geometry is baked in
local coordinates, scales are identity, and translations retain the required hinges.
Heading is degrees about game +Y, used as `rotation.y = headingDeg * Math.PI / 180`.
The tower's local +X points towards its mount. Place each GLB exactly once using the JSON;
`starbase.glb` does not contain either tower or the flight stack.

Reference: 25.997 N, 97.157 W, ground fill Y=0. Tower centres are the mean of the four unique
OSM footprint vertices (the repeated closing vertex is excluded). Their structural posts
follow the measured quadrilateral, transformed into the mount-facing local frame.

| Object | World X | World Z | World Y | Heading degrees |
|---|---:|---:|---:|---:|
| Tower A | 226.5325 | 96.5525 | 0 | 3.9843882033 |
| Tower B | -106.715 | -5.1 | 0 | -84.8855532751 |
| Mount A / stack origin | 256 | 94.5 | 20 | 3.9843882033 |
| Mount B / optional stack origin | -104.2 | 23 | 20 | -84.8855532751 |

Mount centres are **inferred** from the OSM catch-arm footprints, not explicitly surveyed
mount coordinates. The tower square orientation and arm direction are independent: arms
face the mount while the posts preserve the OSM footprint. `starbase_layout.json` includes
source OSM IDs, footprints and source-file SHA-256 for reproducibility.

## Required node contract

Additional geometry children sit under these named nodes. No scene animation is exported.

```text
Starbase                         (single static-site root)
  SiteStructures                (batched geometry, multiple material primitives)

Tower                           (single root in each tower GLB)
  TowerStructure
  Carriage                      (initial game Y = 84 m)
    CarriageFrame
    Arm_L                       (hinge: Blender [7, +5.3, 0])
    Arm_R                       (hinge: Blender [7, -5.3, 0])
    QD_Arm                      (hinge: Blender [4, -6, 22])
    CatchPoint                  (empty; mount-axis distance, local game Y = 0.5)
    Hinge_L                     (empty; same transform as Arm_L)
    Hinge_R                     (empty; same transform as Arm_R)

Stack                           (booster engine skirt bottom centre)
  SuperHeavy                    (identity)
    BoosterHull
    GridFin_0 .. GridFin_3       (hinge origins, separate geometry children)
    Engine_00 .. Engine_32      (gimbal-point origins, separate geometry children)
    CatchPins                   (local game Y = 64.5 m)
    HotStageRing                (local game Y = 70 m; 2 m high)
    PlumeOrigin_SH              (empty; local [0,0,0])
  Starship                      (local game [0,72,0])
    ShipHull
    Flap_FL, Flap_FR            (forward hinge bottoms at stage Y = 36 m)
    Flap_AL, Flap_AR            (aft hinge bottoms at stage Y = 4 m)
    Engine_SL_0 .. Engine_SL_2
    Engine_RVac_0 .. Engine_RVac_2
    PlumeOrigin_SS              (empty; stage-local [0,0,0])
```

Carriage motion uses local game +Y. Catch arms use local game +Y rotation: closed = 0;
open = Arm_L +32 degrees, Arm_R -32 degrees. QD uses the same axis. The requested hierarchy
means QD follows Carriage; its 22 m vertical offset is an animation-friendly approximation,
not a claim about the real mechanism. CatchPoint follows Carriage and stays between the
closed arms. At the initial pose, CatchPoint is at world Y=84.5 and the mounted booster pins
are also Y=20+64.5=84.5. The pins extend to ±5.5 m across the stack; rail centres are ±5.3 m.
CatchPoint is a single centre marker, not an actual two-pin contact solver.

Flap hinge axes are local game Y, and geometry extends outwards from each hinge. L/R labels
refer to negative/positive local X. Booster grid-fin radial headings are 45/135/225/315
in Blender ENU; the frame's local game X is radial, so local game Z is its tangential hinge
axis. Engine bell origins are at the throat/gimbal, 2.2 m above the booster plane and 2.3 m
above the ship plane. Rotate engine local X/Z for gimbal motion. Separation moves `Starship`
and `SuperHeavy` independently; mesh datablocks are constructed separately for every part.
Shared PBR materials/images are allowed. LOD exports preserve the same node hierarchy.

## Dimensions and provenance

This is the user's **124 m / six-upper-engine reference configuration**, not an assertion
that it matches every historical or current vehicle revision.

| Component | Model dimensions | Source / status |
|---|---|---|
| Booster including interstage | 72 m high, 9 m diameter | Task reference; 70 m hull + 2 m vent ring |
| Ship | 52 m high, 9 m diameter | Task reference; official design page also lists 52 m |
| Full stack | 124 m bottom to tip | Sum of the chosen reference stages |
| Booster engines | 33: 3 at r=.75, 10 at r=2.25, 20 at r=3.55 m | Count/rings from task; exact radii and bells approximate |
| Ship engines | 3 SL + 3 vacuum, radii 1.1 / 2.9 m | Task reference; bell radii .65 / 1.15 m approximate |
| Tower A / B | 143 / 144.5 m | OSM IDs 968227813 / 1207227015, `height` tags |
| Tower lattice | measured OSM quadrilateral, approximately 12 m across | Four corner posts; 10 braced bays, house top 6 m |
| Catch arms | 40 m each, truss 3 m deep | Task length; cross-section/hinges approximate |
| Launch tables | top Y=20, outer radius 10, hole radius 5.1 m | Task height; six-leg structure approximate |
| Tank farm | footprints/axes from OSM; explicit 7.1 / 6 m tags where present | Capsule sections for long polygons; vertical vessels for circular polygons |
| Other tanks | vertical default 8 m; horizontal radius from footprint width | Inferred, not surveyed |
| Bunkers/buildings | tagged heights; otherwise 4 m / containers 2.6 m | OSM + plausible defaults |
| Fences / walls | 2.5 / 3 m defaults; tagged heights override | Approximate construction |
| Light poles | 20 m, seven explicitly inferred positions | Artistic fill; no OSM coordinates claimed |

Public dimension reference: [SpaceX Starship design](https://www.spacex.com/vehicles/starship/design),
consulted 2026-10-22. All detailed cross-sections, pipes, nozzles, railings, flap profiles,
materials and panel patterns are generated interpretations, not engineering drawings.

OSM input: `tools/worlds/data/starbase_osm.json`, extract dated 2026-10-22, 258 features.
Source attribution: © OpenStreetMap contributors, [ODbL 1.0](https://www.openstreetmap.org/copyright).
The supplied extract was left untouched and is not included in this change's staged files.
Its provenance/license remains distinct from the project's MIT-licensed procedural code.

## Approximation and data handling

- Building and slab footprints are extruded without bounding-box replacement. Long tank
  polygons determine capsule orientation and extent; circular tanks use a fitted centre/radius.
- Roads use OSM polylines and nominal widths, without markings. Walls/fences and pipelines
  follow the supplied polylines. Tank supports, lighting and rooftop equipment are inferred.
- Tower catch gantry footprints (`man_made=gantry` with catch/stack description) are represented
  by the dynamic arm rigs, not duplicated in the static mesh. The remaining gantry is static.
- OSM building-part features are omitted to avoid duplicating the tower house and prototype
  rocket. The prototype's tagged building footprint is only a plain generic extrusion.
- Natural features and the construction boundary are omitted; terrain/coast/vegetation are
  outside this structure package. OSM paths outside the launch pad remain in the static asset.
- Underground features become dark ground-level linings. The `height=146` on OSM 1549519359
  (`Flame Trench`, `layer=-1`) is rejected as implausible and is not extruded 146 m high.
- Mount A is the requested open table; Mount B gets a simplified exposed water-cooled trench,
  sidewalls and cooling ribs. The OSM snapshot includes trench-related geometry near both
  pads; this deliberately mixed reference arrangement needs reviewer confirmation. No
  terrain excavation, water simulation or engineering-accurate diverter is supplied.
- Fence mesh is simplified to posts and three rails. Lattice/catwalk members are merged,
  not left as thousands of draw calls. QD plumbing, stairs and tiny service hardware are
  simplified. Tower top houses are nominal 12 m square rather than exact roof footprints.
- Stainless steel uses generated seam/brushing colour and normal images. Windward ship half
  (local game -Z) uses a periodic hex colour/normal texture; leeward half remains steel.
  Four generated images are 512×512. All source images are packed into GLBs at export.
  Flat site materials use PBR factors, without unnecessary maps. There are at most eight
  material definitions; actual exported material/texture counts require the pending build.
- No logos, flags, names, registration marks or lettering are drawn on geometry/textures.
- LOD1 uses Blender collapse decimation at 0.25 per mesh, preserving rig nodes. Thin trusses,
  nozzle rims, tiles and flap silhouettes require visual review at LOD transition distance.

## Budgets and measured output

| File | Compressed bytes | Triangles | Textures | Budget |
|---|---|---|---|---|
| starbase.glb | NOT GENERATED | unavailable | unavailable | 6 MB / 600k tris / ≤12 materials |
| tower_a.glb | NOT GENERATED | unavailable | unavailable | 2.5 MB / 250k tris |
| tower_a_lod1.glb | NOT GENERATED | unavailable | unavailable | approximately 25% base tris |
| tower_b.glb | NOT GENERATED | unavailable | unavailable | 2.5 MB / 250k tris |
| tower_b_lod1.glb | NOT GENERATED | unavailable | unavailable | approximately 25% base tris |
| starship_stack.glb | NOT GENERATED | unavailable | unavailable | 4 MB / 300k tris |
| starship_stack_lod1.glb | NOT GENERATED | unavailable | unavailable | approximately 25% base tris |

MB budgets mean decimal bytes. `asset_metrics.json` is the intended authoritative measured
report after compression, not a prediction from Python primitive counts.

## Preview manifest (planned, none rendered)

All paths are under unversioned `out/renders/starbase/`, 1600×900 PNG, daylight Cycles,
24 samples with denoising, fixed orthographic cameras. No preview environment is exported.
The overview camera is southwest at exactly 40 degrees elevation relative to its target.

```text
site_southwest_40deg.png
stack_on_mount.png
tower_a_closed.png
tower_a_open.png
tower_b_closed.png
tower_b_open.png
stack_east.png
stack_north_windward.png
stack_west.png
stack_south_leeward.png
ship_windward.png
ship_leeward.png
```

Claude's remaining review: run generators, resolve any Blender API/export errors, inspect all
12 renders and close/open swept clearances, verify the mixed pad arrangement, run compression
and `check_starbase.mjs`, inspect LOD silhouettes, and replace this draft status with actual
metrics. Browser/WebGPU, multiplayer and launch/catch animation acceptance are not performed.
