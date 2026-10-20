#!/usr/bin/env bash
# build all environment GLBs (LOD0 + LOD1 where available) and check them.
#   tools/blender/env/build_all.sh [name ...]     e.g. build_all.sh stage light_tower
set -euo pipefail
cd "$(dirname "$0")/../../.."
B=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
tools/blender/env/fetch_cc0.sh >/dev/null
ALL="light_tower stage grandstand crowd ramp_truss raptor_stand smallprops vegetation"
LODS="light_tower stage grandstand raptor_stand"
for n in ${@:-$ALL}; do
  $B -b --factory-startup -P tools/blender/env/build_$n.py 2>&1 | grep -E "\[ws-f\]|Error|Traceback" || true
  if [[ " $LODS " == *" $n "* ]]; then
    $B -b --factory-startup -P tools/blender/env/build_$n.py -- --lod 1 2>&1 | grep -E "\[ws-f\]|Error|Traceback" || true
  fi
done
python3 tools/blender/env/check_glb.py
