"""Side-by-side montage: model renders vs. reference stills (system python + Pillow).
Usage: python3 tools/blender/montage.py [prefix] [out.png]"""
import os, sys
from PIL import Image, ImageDraw
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
IMG = os.path.join(ROOT, "out/renders")
REF = os.path.join(ROOT, "research/frames/design")
PAIRS = [("front", "d_039"), ("rear", "d_033"), ("rear34", "d_036"), ("front34", "d_014"), ("side", "d_034"), ("top", None)]
prefix = sys.argv[1] if len(sys.argv) > 1 else "model"
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(IMG, f"{prefix}_compare.png")
W, H = 640, 360
rows = [p for p in PAIRS if os.path.exists(os.path.join(IMG, f"{prefix}_{p[0]}.png"))]
sheet = Image.new("RGB", (2 * W, H * len(rows)), (0, 0, 0))
d = ImageDraw.Draw(sheet)
for i, (v, ref) in enumerate(rows):
    sheet.paste(Image.open(os.path.join(IMG, f"{prefix}_{v}.png")).convert("RGB").resize((W, H)), (0, i * H))
    if ref:
        sheet.paste(Image.open(os.path.join(REF, ref + ".jpg")).convert("RGB").resize((W, H)), (W, i * H))
    d.text((8, i * H + 6), f"model {v}", fill=(255, 255, 0))
    d.text((W + 8, i * H + 6), f"ref {ref}", fill=(255, 255, 0))
sheet.save(out)
print(out)
