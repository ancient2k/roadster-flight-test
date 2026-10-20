#!/usr/bin/env python3
"""asset pipeline Welten: Detailtexturen (Poly Haven CC0) für die Geländeshader nach public/assets/worlds/_shared/detail/.

Je Detailtextur <name>_diff.jpg (sRGB, auf mittlere Helligkeit 0,5 linear-normiert -> im Shader
albedo = kachelAlbedo * detail * 2), <name>_nor.jpg (OpenGL), <name>_arm.jpg (AO/Rough/Metal), 1024².
detail.json: Kachelgröße (m) und Quelle. Splat-Kanäle der Orte: R = rock, G = fine, B = dark.

    python3 tools/worlds/detail_textures.py
"""
import json
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
CC = os.path.join(HERE, "downloads", "_cc0")
OUT = os.path.join(ROOT, "public", "assets", "worlds", "_shared", "detail")

# name: (Poly-Haven-Quelle, Entsättigung, Farbton, Kachel in m)
DETAIL = {
    "regolith": ("rock_ground", 1.0, (1.0, 0.98, 0.95), 4.0),
    "regolith_rocky": ("gray_rocks", 1.0, (1.0, 1.0, 1.0), 3.0),
    "sand": ("coast_sand_01", 0.4, (1.0, 0.95, 0.85), 6.0),
    "limestone": ("rock_boulder_dry", 0.5, (1.0, 0.95, 0.85), 5.0),
    "mars_soil": ("red_laterite_soil_stones", 0.0, (1.0, 1.0, 1.0), 4.0),
    "mars_rock": ("rock_face_03", 0.2, (1.0, 0.9, 0.8), 6.0),
    "mars_layered": ("dry_riverbed_rock", 0.1, (1.0, 0.92, 0.85), 8.0),
    "grass_chalk": ("grass_ground", 0.0, (0.82, 1.08, 0.72), 3.0),
}


def srgb2lin(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def lin2srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def main():
    os.makedirs(OUT, exist_ok=True)
    meta = {}
    for name, (src, desat, tint, tile) in DETAIL.items():
        def load(m):
            return Image.open(os.path.join(CC, src, f"{src}_{m}_2k.jpg")).convert("RGB").resize((1024, 1024), Image.LANCZOS)
        d = srgb2lin(np.asarray(load("diff"), np.float64) / 255)
        lum = d @ np.array([0.2126, 0.7152, 0.0722])
        d = d * (1 - desat) + lum[..., None] * desat
        d = d * np.array(tint)
        d = d / d.mean() * 0.5                     # mittlere lineare Helligkeit 0,5 -> Faktor 2 im Shader
        Image.fromarray((lin2srgb(d) * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, f"{name}_diff.jpg"), quality=88)
        load("nor_gl").save(os.path.join(OUT, f"{name}_nor.jpg"), quality=92)
        load("arm").save(os.path.join(OUT, f"{name}_arm.jpg"), quality=92)
        meta[name] = {"tileM": tile, "source": f"https://polyhaven.com/a/{src}", "license": "CC0 1.0",
                      "use": "albedo = kachelAlbedo * detail_diff * 2 (linear)"}
        print(name, "<-", src)
    json.dump(meta, open(os.path.join(OUT, "detail.json"), "w"), indent=2, ensure_ascii=False)


main()
