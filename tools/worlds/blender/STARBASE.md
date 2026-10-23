# Starbase — review round 1 revisions

## Status (2026-10-22)

Claude reported that the original generators both completed with exit 0 outside the
sandbox, produced all seven GLBs and twelve previews, and preserved the requested node
hierarchy. The original exporter reported invalid meshes, and the renders showed sparse
structure, weak materials and duplicated trench slabs.

This revision changes **scripts and this document only**. Blender, compression and Git were
not run, as requested. Existing GLBs, renders and layout JSON have not been rewritten.
New native mesh validation, compressed sizes, LOD appearance and renders await Claude's
rebuild. Counts below distinguish source geometry from exported measurements.

## Changes in this revision

- Mesh construction filters coincident polygon corners and zero-area faces. Lathe poles
  become triangles. Source face indices and UV lengths are asserted before creating a mesh.
- `clean_mesh()` calls `mesh.validate(clean_customdata=False)`, welds duplicate vertices,
  dissolves degenerate edges, deletes duplicate/zero-area faces, triangulates, removes loose
  geometry and recalculates normals. It validates again, checks vertex/edge/loop indices and
  triangle areas, and requires a subsequent validation to make no repairs. This runs after
  mesh construction and again immediately before each export, including after decimation.
- Tower: 38 structural bays, approximately 3.53 m (A) / 3.57 m (B) spacing; fabricated box
  columns, I-section girders and diagonals on all four faces, catwalks, handrails, switchback
  stairs, elevator cage, cable trays, guide rails and cable bundles. The plain white cube is
  replaced by an open crown with a compact hoist housing, drums/sheaves and a short crane boom.
- Carriage: a three-sided frame wraps around the tower, with bogies and ram bodies. Each
  40 m catch arm has a triangular section 3.8 m deep, braces every 2.5 m, a broad upper inner
  rail and 48 rollers. The section grows outward to preserve the existing catch opening.
  The QD arm has a covered walkway, service pipes and a three-sided hood open at its tip.
- Booster: 6 × 3 m grid fins, lower chines, two nearly full-length raceway/conduit assemblies,
  circumferential tank/dome weld bands, skirt thickness and an open thrust frame. The 33
  engines have open bells, cooling bands, powerheads and feed pipes. Booster bell radius is
  reduced to 0.51 m to avoid overlap in the 20-engine outer ring. Catch pins are cylindrical stubs.
- Ship: the windward half has physically scaled 0.30 m-across-flats hex tiles, per-tile tone
  and roughness variation, and a 1.2 mm normal-map height field with approximately 4 mm joints.
  A tessellated shared material boundary zigzags by ±0.075 m; there are no overlapping tile
  skins. The final approximately 0.6 m of the nose is a tiled cap. Flap windward faces use
  the same physical UV scale, with steel leeward faces. Both engine skirts remain open below.
- Stainless steel: base colour around (0.75, 0.74, 0.72), metallic 1, roughness map 0.25–0.35,
  1.8 m ring seams in normal/roughness maps and subtle axial streaking. Tower structure uses
  painted dark grey, roughness 0.6. Tanks use off-white paint, roughness 0.5. Preview ambient
  light is more neutral to reduce the blue cast on steel.
- Mount A: six built-up legs, radial table girders, 24 hold-down clamp assemblies, outer service
  rails, feed pipes and a segmented water-cooled plate with headers. Mount B: an aperture in
  a concrete deck over a three-sided trench, open at one end, with cooling ribs and headers.
- LOD1 remains collapse decimation at 0.25 per mesh, followed by the same mesh validation.
  New export logs print validated triangle counts before writing each GLB.

## Dark X-shaped slabs: source and correction

The original `layer=-1` branch made every underground feature a dark **surface** prism.
The two long trench footprints were OSM **1549519359** near A and **1352374225** near B.
Their surfaces overlapped the separately generated mount plates/trench floor, producing
cross-shaped dark areas in the overview. This attribution follows the source geometry and
OSM coordinates; the corrected image still requires rendering.

These underground surface prisms are now omitted. The remaining underground control centre
(OSM 1454334539) is also omitted at the ground surface. A remains the requested open mount
with its cooled plate. B gets the explicit deck/trench geometry, oriented along the long
OSM trench edge. The contradictory `height=146` on the A trench remains ignored.

Pipelines already use round pipe segments on supports and were not the source of those
large slabs. The static gantry (OSM 1549519360) remains a post-and-girder assembly, with no
filled slab. Described catch gantries belong to the animated tower models and are not
also drawn as static site geometry.

## Counts and budgets

Raw counts were obtained by evaluating the actual mesh-generating routines with a small
NumPy vector adapter and an in-memory object sink, without importing or running Blender.
They are sums of polygon triangulation counts **before BMesh cleanup or export**; duplicate
face removal may lower the final values. No simulated result is claimed as a Blender test.

| Asset | Round 1 count reported by Claude | Revised raw triangles | Target / limit |
|---|---:|---:|---|
| starbase.glb | ~49,000 | 72,036 | ≤600,000 / ≤6 MB compressed |
| tower_a.glb | ~7,000 | 105,020 | target 80–120k; ≤250k / ≤2.5 MB |
| tower_b.glb | ~7,000 | 105,020 | target 80–120k; ≤250k / ≤2.5 MB |
| starship_stack.glb | ~46,000 | 155,812 | ≤300,000 / ≤4 MB |
| tower_a_lod1.glb | — | pending Blender decimation | approximately 25% of rebuilt A |
| tower_b_lod1.glb | — | pending Blender decimation | approximately 25% of rebuilt B |
| starship_stack_lod1.glb | — | pending Blender decimation | approximately 25% of rebuilt stack |

Each tower's raw breakdown: TowerStructure 87,940; each ArmTruss 7,128; CarriageFrame 1,848;
QDTruss 976. Tower beams are accumulated into these five meshes, not individual object draw
calls. The site remains one mesh with material primitives; flight control nodes remain separate.

Eight material definitions are retained (site limit: 12). Six 512×512 images are generated:
colour, normal and roughness for steel and tiles. Only used textures/materials should export;
final image counts and any exporter-generated metallic/roughness packing must be measured
from the rebuilt GLBs. Compressed bytes and native triangle counts for this revision are
**pending**. The previous GLBs are not evidence for this revision's budgets.

## Build and verification handoff

Run from the repository root, in this order, before compressing:

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/worlds/blender/build_starship.py -- --renders
/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/worlds/blender/build_starbase.py -- --renders
node tools/compress-assets.mjs public/assets/worlds/earth_bocachica
node tools/worlds/blender/check_starbase.mjs
```

The site preview imports the uncompressed GLBs. Omit `--renders` for geometry-only builds.
The existing checker decodes meshopt and checks node hierarchy, identity scales, roots,
stage mesh separation, 124 m stack bounds, size/triangle limits, texture sizes and an
18–32% LOD triangle ratio. It writes `asset_metrics.json` only after all checks pass.
`clean_mesh()` should finish with stable valid meshes and the exporter should emit no
“Mesh ... is not valid” warnings. Any such warning is a failed rebuild requiring inspection.

Checks performed here: Python syntax; finite source coordinates and UVs; source index bounds;
matching polygon/material/UV counts; nonzero source triangle areas; tower hierarchy/hinges;
unchanged layout within 1e-12 floating-point tolerance. The layout function itself is unchanged;
Python versions can format the same coordinate as -5.1 or -5.1000000000000005.

Still to review: native cleanup and LOD counts; all material textures in GLB; compression
budgets; tile readability and nose UV distortion; truss/roller silhouettes; closed/open arm
clearances against the larger fins; guide rail/carriage clearances; removal of the slab X;
trench opening; underside engine count/spacing. These remain stylized, not engineering models.

## Coordinate and animation contract (unchanged)

Metres. Blender authoring `(east,north,up)` maps through glTF `export_yup=True` to game
`(east,up,-north)`. Geometry scales are identity. `Starbase` and `Stack` are at the reference
origin / booster skirt bottom respectively. Each `Tower` root is at its own base centre.
Heading is three.js `rotation.y` in degrees. Local tower +X faces its mount.

Reference: 25.997 N, 97.157 W; ground fill Y=0. Four unique tower footprint vertices determine
the centres and post positions. Mount centres are inferred from catch-gantry footprints.

| Placement | X | Z | Y | Heading degrees |
|---|---:|---:|---:|---:|
| Tower A | 226.5325 | 96.5525 | 0 | 3.9843882033 |
| Tower B | -106.715 | -5.1 | 0 | -84.8855532751 |
| Mount A / stack origin | 256 | 94.5 | 20 | 3.9843882033 |
| Mount B / optional stack | -104.2 | 23 | 20 | -84.8855532751 |

`starbase_layout.json`, all required node names and all animation origins are unchanged.
Geometry children retain their previous names as well.

```text
Starbase
  SiteStructures

Tower
  TowerStructure
  Carriage                       # game Y=84; translates along local +Y
    CarriageFrame
    Arm_L                        # ENU hinge [7,+5.3,0]
      ArmTruss_L
    Arm_R                        # ENU hinge [7,-5.3,0]
      ArmTruss_R
    QD_Arm                       # ENU hinge [4,-6,22]
      QDTruss
    CatchPoint                   # empty: local +X at mount, game Y=.5
    Hinge_L                      # empty: same origin as Arm_L
    Hinge_R                      # empty: same origin as Arm_R

Stack
  SuperHeavy
    BoosterHull
    GridFin_0 .. GridFin_3        # separate Grid_0 .. Grid_3 meshes
    Engine_00 .. Engine_32       # separate Nozzle_SH_00 .. Nozzle_SH_32 meshes
    CatchPins
      CatchPinGeometry
    HotStageRing                 # stage game Y=70, height 2
      VentedInterstage
    PlumeOrigin_SH               # empty, stage-local [0,0,0]
  Starship                       # stack-local game [0,72,0]
    ShipHull
    Flap_FL, Flap_FR, Flap_AL, Flap_AR
    Engine_SL_0 .. Engine_SL_2
    Engine_RVac_0 .. Engine_RVac_2
    PlumeOrigin_SS               # empty, stage-local [0,0,0]
```

Arm rotations: local game +Y; closed = 0; open L=+32°, R=-32°. QD uses the same hinge axis.
Catch rails/rollers top out at Carriage Y=.5, world Y=84.5. Booster pins are at stage Y=64.5,
therefore also world Y=84.5 on the 20 m mount. Pin reach remains ±5.5 m, rail centres ±5.3 m.
The QD's fixed Carriage offset is an animation-friendly approximation of the real mechanism.

Flap hinges use local game Y; FL/FR start at ship Y=36, AL/AR at Y=4; left/right mean negative/
positive X. Grid fins are at booster Y=65 with radial ENU headings 45/135/225/315°; their local
game Z is the tangential hinge axis. Engine gimbal origins are at the throat (SH Y=2.2,
ship Y=2.3); gimbal axes are local game X/Z. Booster and ship have no shared mesh datablocks.

## Dimensions and sources

The requested reference configuration remains 72 m booster including a 2 m hot-stage ring,
52 m ship, 9 m main diameter, 124 m stack. It is not intended to match every vehicle revision.
The ship's 52 m dimension and 33-engine booster count are also described on the
[official design page](https://www.spacex.com/vehicles/starship/design), consulted for round 1.
Other vehicle details use the user's reference and review dimensions; exact sections are
procedural approximations, with no new surveyed claims.

Booster engine rings remain 3/10/20 at radii .75/2.25/3.55 m. Ship SL/RVac rings remain
3/3 at radii 1.1/2.9 m, with bell radii .65/1.15 m. Tower heights remain OSM 143/144.5 m;
mount tops remain 20 m, outer radius 10 m and engine aperture radius 5.1 m. The concrete
trench deck is an interpretation; it is not a terrain excavation or water simulation.

Input: `tools/worlds/data/starbase_osm.json`, 258 features, extract 2026-10-22.
© OpenStreetMap contributors, [ODbL 1.0](https://www.openstreetmap.org/copyright).
Its attribution remains distinct from MIT-licensed procedural code. Source and layout SHA-256
remain unchanged. No downloaded geometry/images, names, logos, flags or lettering are used.

OSM building/slab footprints, pipeline paths, tank footprints/axes, walls and roads remain in
place. Buildings default to 4 m, containers to 2.6 m when untagged. Circular tanks default to
8 m; tagged 6/7.1 m tanks retain those values. Horizontal capsules use footprint widths.
Natural features, building-part duplicates and underground surface slabs are omitted.
Lighting positions, service fittings and heights absent from OSM are inferred. The prototype
rocket remains a generic extrusion. Fences remain simplified posts/rails. No loader,
collision, gameplay or launch/catch animation code is included.

## Render manifest

Existing twelve names/cameras remain fixed at 1600×900, daylight Cycles, 24 samples,
with a southwest overview at 40° elevation. Two underside views are added for engine review.
All files are under unversioned `out/renders/starbase/`; this revision has not rendered them.

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
booster_engines_below.png         # added
ship_engines_below.png            # added
```

The underside previews remove the temporary ground, and the ship view temporarily hides the
booster subtree. Visibility is restored before LOD export. No preview lights/camera/ground
are selected for GLB export. Commit and native rerender are delegated to Claude by the user;
the requested commit trailer remains `Co-Authored-By: Codex (GPT-6-Astra) <noreply@openai.com>`.

## Roads, slabs, launch table (Oct 2026)

Roads and paved slabs are no longer modelled: they are painted into the terrain from
`starbase_ground.json` (`tools/worlds/starbase_ground.py`, `src/render/worlds/pavedGround.ts`). The
water-cooled steel table of mount A lies flush with the ground (top at +4 cm). Rebuild only the site
model with `build_site()` (towers unchanged), then `node tools/compress-assets.mjs
public/assets/worlds/earth_bocachica/starbase.glb`. The towers' box colliders cover only the fixed
structure (`fixedBoxTris` in `src/render/worlds/index.ts`), not the catch and QD arms.
