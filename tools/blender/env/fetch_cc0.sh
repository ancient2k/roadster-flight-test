#!/usr/bin/env bash
# downloads the CC0 sources (Poly Haven, https://polyhaven.com/license) into tools/blender/env/cc0/.
# Images/glTF data only, no executable code. Idempotent (existing files are skipped).
set -euo pipefail
cd "$(dirname "$0")"
OUT=cc0
mkdir -p "$OUT"
PH=https://dl.polyhaven.org/file/ph-assets

get() { # url  target
  [ -s "$2" ] || { echo "  ↓ $2"; curl -sfL "$1" -o "$2"; }
}

# --- textures (1k, normal = OpenGL)
for t in metal_plate concrete_wall_008 painted_metal_shutter; do
  mkdir -p "$OUT/$t"
  for m in diff nor_gl arm; do get "$PH/Textures/jpg/1k/$t/${t}_${m}_1k.jpg" "$OUT/$t/${t}_${m}_1k.jpg"; done
done

# --- models (glTF 1k) + alpha/dry variants
for m in concrete_road_barrier grass_medium_01 shrub_02 shrub_04 dry_branches_medium_01; do
  mkdir -p "$OUT/$m/textures"
  get "$PH/Models/gltf/1k/$m/${m}_1k.gltf" "$OUT/$m/${m}_1k.gltf"
  get "$PH/Models/gltf/1k/$m/$m.bin" "$OUT/$m/$m.bin"
  for k in diff nor_gl arm; do get "$PH/Models/jpg/1k/$m/${m}_${k}_1k.jpg" "$OUT/$m/textures/${m}_${k}_1k.jpg"; done
done
for m in grass_medium_01 shrub_02 shrub_04; do
  get "$PH/Models/png/1k/$m/${m}_alpha_1k.png" "$OUT/$m/textures/${m}_alpha_1k.png"
done
get "$PH/Models/png/1k/grass_medium_01/grass_medium_01_dry_diff_1k.png" "$OUT/grass_medium_01/textures/grass_medium_01_dry_diff_1k.png"
echo "fertig: $(du -sh "$OUT" | cut -f1)"
