# Umgebungs-Modelle

Alle GLBs werden reproduzierbar per Blender-Python gebaut: `tools/blender/env/build_all.sh`
(Blender 5.2 headless, ~40 s), geprüft mit `python3 tools/blender/env/check_glb.py`.
Maße, Knoten und Einbauhinweise: siehe `docs/RENDERING.md`.

## Quellen und Lizenzen

| Verwendung | Quelle | Lizenz |
|---|---|---|
| `barrier.glb` (Geometrie, dezimiert, + Texturen auf 512² verkleinert) | Poly Haven [concrete_road_barrier](https://polyhaven.com/a/concrete_road_barrier) | CC0 1.0 |
| Beton (`Concrete` in light_tower, raptor_stand) | Poly Haven [concrete_wall_008](https://polyhaven.com/a/concrete_wall_008) | CC0 1.0 |
| Riffelblech (`Steel_Tread`) | Poly Haven [metal_plate](https://polyhaven.com/a/metal_plate) | CC0 1.0 |
| Alle übrigen Texturen (Verzinkung, Lack, LED-Linsen, LED-Wand-Motive, Gras- und Strauchatlas, Publikumsatlas, Lautsprechergitter) | prozedural erzeugt in `tools/blender/env/*.py` | eigenes Werk (Projekt) |

Poly-Haven-Dateien heruntergeladen am 18.10.2026 per `tools/blender/env/fetch_cc0.sh`.
Lizenztext: https://polyhaven.com/license (CC0, keine Namensnennung nötig).
