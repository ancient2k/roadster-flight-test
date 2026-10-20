#!/bin/sh
# Rebuild LOD0 and render comparison views. Usage: tools/blender/iterate.sh [views] [extra render args]
BL=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
cd "$(dirname "$0")/../.." || exit 1
OUT=$($BL -b --factory-startup -P tools/blender/build_roadster.py 2>&1)
echo "$OUT" | grep -E "roadster\]|Traceback|Error|line [0-9]"
echo "$OUT" | grep -q "\[roadster\] wrote" || exit 1
$BL -b --factory-startup -P tools/blender/render_views.py -- --views "${1:-front,rear,rear34,front34,side,top}" $2 $3 2>&1 | grep -E "Traceback|Error|wrote"
