#!/bin/sh
# Build props (optionally a comma list) and render a contact sheet to out/renders/props_compare.png
BL=${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}
cd "$(dirname "$0")/../.." || exit 1
$BL -b --factory-startup -P tools/blender/build_props.py -- ${1:+--only $1} 2>&1 | grep -E "props\]|Traceback|Error|line [0-9]"
for m in $(echo "${1:-model3,modelY,modelS,cybertruck,semi}" | tr ',' ' '); do
  $BL -b --factory-startup -P tools/blender/render_views.py -- --glb public/assets/props/$m.glb --auto --ground 0 --prefix prop_$m --res 960x540 2>&1 | grep -E "Traceback|Error"
done
python3 - <<'PY'
import os
from PIL import Image
d = "out/renders/"
ms = [m for m in ["model3", "modelY", "modelS", "cybertruck", "semi"] if os.path.exists(f"{d}prop_{m}_auto34.png")]
s = Image.new("RGB", (1280, 360 * len(ms)))
for i, m in enumerate(ms):
    for j, v in enumerate(["auto34", "autorear"]):
        s.paste(Image.open(f"{d}prop_{m}_{v}.png").resize((640, 360)), (j * 640, i * 360))
s.save(d + "props_compare.png")
PY
