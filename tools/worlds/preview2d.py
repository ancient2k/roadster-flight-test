#!/usr/bin/env python3
"""asset pipeline Welten: 2D-Kontrollbild je Ort (Hillshade mit Sonne aus meta.json x Albedo, Spawn/Wahrzeichen markiert,
plus Horizont-Kachel). Ausgabe out/renders/world_<ort>_map.png.

    python3 tools/worlds/preview2d.py [ort ...]
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
W = os.path.join(ROOT, "public", "assets", "worlds")


def load_h(d, t):
    a = np.array(Image.open(os.path.join(d, t["heightmap"]))).astype(np.float64)
    return t["heightMinM"] + a / 65535 * (t["heightMaxM"] - t["heightMinM"])


def hillshade(h, mpp, sun):
    gy, gx = np.gradient(h, mpp)
    n = np.stack([-gx, np.ones_like(h), gy], -1)      # (x Ost, y oben, z Süd): dh/dz = gy (Zeile nach Süd)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    s = np.array(sun)
    return np.clip(n @ s, 0, 1)


def main(site):
    d = os.path.join(W, site)
    m = json.load(open(os.path.join(d, "meta.json")))
    t = m["tiles"]["near"]
    h = load_h(d, t)
    sun = m["sun"]["direction"]
    # flacheres Licht für die Lesbarkeit, gleiche Richtung
    sh = hillshade(h, t["metersPerPixel"], sun)
    alb = np.array(Image.open(os.path.join(d, t["albedo"])).convert("RGB").resize(h.shape[::-1])).astype(np.float64) / 255
    img = np.clip(alb * (0.25 + 1.6 * sh[..., None]), 0, 1)
    im = Image.fromarray((img * 255).astype(np.uint8)).resize((1024, 1024), Image.LANCZOS)
    dr = ImageDraw.Draw(im)
    size = t["sizeM"]

    def px(x, z):
        return (x / size + 0.5) * 1024, (z / size + 0.5) * 1024
    sx, sz = px(m["spawn"]["x"], m["spawn"]["z"])
    dr.ellipse([sx - 6, sz - 6, sx + 6, sz + 6], outline=(0, 255, 0), width=2)
    for lm in m["landmarks"]:
        x, z = px(lm["x"], lm["z"])
        dr.rectangle([x - 4, z - 4, x + 4, z + 4], outline=(255, 60, 60), width=2)
    panels = [im]
    if "far" in m["tiles"]:
        f = m["tiles"]["far"]
        hf = load_h(d, f)
        shf = hillshade(hf, f["metersPerPixel"], sun)
        lo, hi = np.percentile(hf, [1, 99])
        col = 0.3 + 0.7 * (hf - lo) / max(hi - lo, 1e-6)
        fi = np.clip(col * (0.3 + 1.2 * shf), 0, 1)
        fim = Image.fromarray((fi * 255).astype(np.uint8)).convert("RGB").resize((1024, 1024), Image.LANCZOS)
        fd = ImageDraw.Draw(fim)
        r = size / f["sizeM"] * 512
        fd.rectangle([512 - r, 512 - r, 512 + r, 512 + r], outline=(0, 255, 0), width=2)
        panels.append(fim)
    out = Image.new("RGB", (1024 * len(panels), 1024))
    for i, p in enumerate(panels):
        out.paste(p, (1024 * i, 0))
    p = os.path.join(ROOT, "docs", "reports", "img", f"world_{site}_map.png")
    out.save(p)
    print(p)


for s in sys.argv[1:] or sorted(os.listdir(W)):
    if os.path.exists(os.path.join(W, s, "meta.json")):
        main(s)
