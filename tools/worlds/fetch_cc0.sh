#!/usr/bin/env bash
# worlds: CC0 textures from Poly Haven (https://polyhaven.com/license) into tools/worlds/downloads/_cc0/.
# Image data only. Idempotent.
set -euo pipefail
cd "$(dirname "$0")"
OUT=downloads/_cc0
RES=${RES:-2k}
PH=https://dl.polyhaven.org/file/ph-assets/Textures/jpg
TEX="grass_ground ground_grey gray_rocks coast_sand_01 aerial_sand red_sand red_laterite_soil_stones dry_riverbed_rock rock_boulder_dry large_sandstone_blocks_01 rock_face_03 dark_rock rock_ground"
for t in $TEX; do
  mkdir -p "$OUT/$t"
  for m in diff nor_gl arm; do
    f="$OUT/$t/${t}_${m}_${RES}.jpg"
    [ -s "$f" ] || { echo "  ↓ $f"; curl -sfL "$PH/$RES/$t/${t}_${m}_${RES}.jpg" -o "$f"; }
  done
done
echo "fertig: $(du -sh "$OUT" | cut -f1)"
