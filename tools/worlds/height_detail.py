#!/usr/bin/env python3
"""Geländehöhe (Nahkachel, bilinear) an Weltpunkten eines Ortes – für Wahrzeichen-y in meta/landmarks.

    python3 tools/worlds/height_detail.py mars_gale 8 26 [x z ...]
"""
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def grid(site):
    d = os.path.join(ROOT, "public", "assets", "worlds", site)
    m = json.load(open(os.path.join(d, "meta.json")))
    t = m["tiles"]["near"]
    a = np.array(Image.open(os.path.join(d, t["heightmap"]))).astype(np.float64)
    h = t["heightMinM"] + a / 65535.0 * (t["heightMaxM"] - t["heightMinM"])
    return h, t


def height(h, t, x, z):
    n = t["resolution"]
    c = (x - t.get("centerX", 0) + t["sizeM"] / 2) / t["sizeM"] * (n - 1)
    r = (z - t.get("centerZ", 0) + t["sizeM"] / 2) / t["sizeM"] * (n - 1)
    c0, r0 = int(np.clip(np.floor(c), 0, n - 2)), int(np.clip(np.floor(r), 0, n - 2))
    fc, fr = c - c0, r - r0
    return float((h[r0, c0] * (1 - fc) + h[r0, c0 + 1] * fc) * (1 - fr) + (h[r0 + 1, c0] * (1 - fc) + h[r0 + 1, c0 + 1] * fc) * fr)


if __name__ == "__main__":
    site = sys.argv[1]
    h, t = grid(site)
    v = list(map(float, sys.argv[2:]))
    for i in range(0, len(v), 2):
        print(f"{v[i]:.2f} {v[i + 1]:.2f} -> {height(h, t, v[i], v[i + 1]):.3f}")
