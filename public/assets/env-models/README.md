# Environment models

All GLBs are built reproducibly with Blender Python: `tools/blender/env/build_all.sh`
(Blender 5.2 headless, ~40 s), checked with `python3 tools/blender/env/check_glb.py`.
Dimensions, nodes and integration notes: see `docs/RENDERING.md`.

## Sources and licences

| Used for | Source | Licence |
|---|---|---|
| `barrier.glb` (geometry decimated, textures downscaled to 512²) | Poly Haven [concrete_road_barrier](https://polyhaven.com/a/concrete_road_barrier) | CC0 1.0 |
| Concrete (`Concrete` in light_tower, raptor_stand) | Poly Haven [concrete_wall_008](https://polyhaven.com/a/concrete_wall_008) | CC0 1.0 |
| Tread plate (`Steel_Tread`) | Poly Haven [metal_plate](https://polyhaven.com/a/metal_plate) | CC0 1.0 |
| All other textures (galvanising, paint, LED lenses, LED wall motifs, grass and shrub atlas, crowd atlas, speaker grille) | generated procedurally in `tools/blender/env/*.py` | own work (project) |

Poly Haven files downloaded on 18 Oct 2026 with `tools/blender/env/fetch_cc0.sh`.
Licence text: https://polyhaven.com/license (CC0, no attribution required).
