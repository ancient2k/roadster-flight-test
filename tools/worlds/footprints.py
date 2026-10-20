#!/usr/bin/env python3
"""Asset pipeline worlds: footprint area of Apollo 11 (moon_tranquility) or Apollo 15 (moon_hadley).

Output to public/assets/worlds/<site>/:
  bootprint_nor.png / bootprint_albedo.png  256x128 decal of an A7L lunar boot (33 x 15 cm, cross ribs),
                                             normal map (OpenGL) + albedo multiplier (grey value, 1 = unchanged)
  footprints.json                           prints (x, z, yawDeg, foot) relative to the LM (x east, z south), world position = LM + (x, z)
  trampled.png                              1024² overlay (greyscale, albedo multiplier ~0.85 on paths) over 'trampledSizeM'
Paths after the EVA maps (Apollo 11 Traverse Map, LPI/NASA): ladder (W) -> circle around the LM, flag, TV camera
(~15 m NW), EASEP (~15 m SSW), Armstrong's detour to Little West crater (~60 m E) and sampling to the NE.

    python3 tools/worlds/footprints.py moon_tranquility
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

PATHS = {
    "moon_tranquility": [
        # waypoints (x east, z south) in m relative to the LM; LM front/ladder in the west (-4.7, 0)
        [(-4.9, 0.0), (-7.0, -3.0), (-6.0, -6.5), (-2.0, -7.5), (3.0, -6.5), (6.5, -2.0), (6.0, 3.5), (2.0, 7.0), (-3.0, 6.5), (-6.5, 3.0), (-4.9, 0.4)],
        [(-4.9, 0.2), (-7.5, -1.5), (-9.0, -4.0)],                       # flag / TV shots
        [(-6.0, -4.0), (-10.0, -9.0), (-12.5, -14.0), (-11.0, -9.0), (-6.5, -5.0)],   # TV camera NW
        [(-5.5, 3.0), (-8.0, 8.0), (-10.0, 13.0), (-13.5, 10.5), (-10.5, 12.5), (-7.0, 7.0), (-5.0, 2.0)],   # EASEP SSW
        [(5.0, -3.0), (9.0, -8.0), (12.0, -10.0), (9.5, -6.0), (6.0, -2.5)],   # sampling NE
        [(6.0, 0.5), (20.0, 1.5), (40.0, 2.0), (55.0, 1.0), (58.0, 3.5), (54.0, 4.0), (38.0, 3.0), (18.0, 2.5), (6.5, 1.5)],  # Little West
    ],
    "moon_hadley": [
        [(-4.9, 0.0), (-7.0, -3.0), (-5.0, -7.0), (0.0, -7.5), (5.5, -5.0), (7.0, 0.0), (5.0, 5.5), (0.0, 7.5), (-6.0, 5.0), (-4.9, 0.4)],
        [(5.0, -4.0), (15.0, -10.0), (30.0, -15.0), (40.0, -12.0)],      # to the rover parking spot
        [(-6.0, 4.0), (-25.0, 30.0), (-40.0, 60.0), (-60.0, 95.0), (-75.0, 110.0)],   # ALSEP (~110 m NW)
    ],
}


def boot_decal(w=256, h=128):
    """Height field of a boot print (sole 33 x 15 cm in 256 x 128 px), giving the normal and albedo maps."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    u = (x / (w - 1)) * 2 - 1          # length (heel -1 .. toe +1)
    v = (y / (h - 1)) * 2 - 1
    # sole shape: superellipse, wider at the front
    half_w = 0.78 + 0.18 * (u + 1) / 2 - 0.25 * np.clip(u - 0.7, 0, 1)
    r = (np.abs(u) ** 3.5 + np.abs(v / half_w) ** 3.5)
    inside = np.clip((1.0 - r) * 8, 0, 1)
    rib = 0.5 + 0.5 * np.cos(u * math.pi * 11)          # cross ribs of the sole
    rib = np.where(np.abs(u) < 0.92, rib, 0)
    depth = inside * (0.75 + 0.25 * rib)                  # imprint (positive = deeper)
    rim = np.clip(1.0 - np.abs(r - 1.05) * 6, 0, 1) * 0.35   # raised rim
    hgt = -depth + rim
    gy, gx = np.gradient(hgt * 6.0)
    n = np.stack([-gx, gy, np.ones_like(hgt)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    nor = ((n * 0.5 + 0.5) * 255 + 0.5).astype(np.uint8)
    alb = np.clip(1.0 - 0.18 * inside - 0.06 * rib * inside + 0.05 * rim, 0, 1)
    alpha = np.clip(inside + rim * 1.5, 0, 1)
    a = np.stack([alb, alb, alb, alpha], -1)
    return nor, (a * 255 + 0.5).astype(np.uint8)


def main(site):
    out = os.path.join(ROOT, "public", "assets", "worlds", site)
    meta_p = os.path.join(out, "meta.json")
    meta = json.load(open(meta_p))
    lm = next(l for l in meta["landmarks"] if l["file"].startswith("apollo_lm"))
    r = np.random.default_rng(11)
    prints = []
    for path in PATHS[site]:
        for (x0, z0), (x1, z1) in zip(path[:-1], path[1:]):
            L = math.hypot(x1 - x0, z1 - z0)
            yaw = math.degrees(math.atan2(x1 - x0, z1 - z0))     # 0° = facing +Z (south)
            step = 0.75
            for k in range(int(L / step)):
                t = (k + r.uniform(0, 0.3)) / max(L / step, 1)
                px, pz = x0 + (x1 - x0) * t, z0 + (z1 - z0) * t
                side = 1 if k % 2 else -1
                nx, nz = math.cos(math.radians(yaw)), -math.sin(math.radians(yaw))
                prints.append({"x": round(px + nx * 0.14 * side + r.normal(0, 0.05), 3),
                               "z": round(pz + nz * 0.14 * side + r.normal(0, 0.05), 3),
                               "yawDeg": round(yaw + r.normal(0, 7), 1), "foot": "R" if side > 0 else "L"})
    # trampled area around the LM (dense, undirected)
    for _ in range(500):
        a, d = r.uniform(0, 2 * math.pi), abs(r.normal(0, 4.0)) + 3.0
        prints.append({"x": round(math.cos(a) * d, 3), "z": round(math.sin(a) * d, 3),
                       "yawDeg": round(r.uniform(0, 360), 1), "foot": "L" if r.random() < 0.5 else "R"})
    nor, alb = boot_decal()
    Image.fromarray(nor).save(os.path.join(out, "bootprint_nor.png"), optimize=True)
    Image.fromarray(alb).save(os.path.join(out, "bootprint_albedo.png"), optimize=True)
    # overlay
    size = 140.0
    N = 1024
    ov = np.zeros((N, N), np.float32)
    for p in prints:
        c = int((p["x"] / size + 0.5) * N)
        rr = int((p["z"] / size + 0.5) * N)
        if 2 <= c < N - 2 and 2 <= rr < N - 2:
            ov[rr - 2:rr + 3, c - 2:c + 3] += 0.35
    from PIL import ImageFilter
    ovi = Image.fromarray((np.clip(ov, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3))
    ov = np.asarray(ovi, np.float32) / 255
    Image.fromarray(((1.0 - 0.15 * ov) * 255 + 0.5).astype(np.uint8)).save(os.path.join(out, "trampled.png"), optimize=True)
    json.dump({"origin": "LM-Mitte (meta.landmarks apollo_lm_descent: x, z); x = Ost, z = Süd, Höhe = Gelände",
               "lm": {"x": lm["x"], "z": lm["z"]}, "bootSizeM": [0.33, 0.15],
               "decal": {"normal": "bootprint_nor.png", "albedo": "bootprint_albedo.png",
                         "note": "Decal-Länge (Textur-u) entlang yawDeg (0° = +Z/Süd); Tiefe ~3 cm"},
               "trampled": {"file": "trampled.png", "sizeM": size, "note": "Albedo-Multiplikator, zentriert auf das LM"},
               "prints": prints}, open(os.path.join(out, "footprints.json"), "w"), separators=(",", ":"))
    meta["footprints"] = {"file": "footprints.json", "count": len(prints)}
    json.dump(meta, open(meta_p, "w"), indent=2, ensure_ascii=False)
    print(f"{site}: {len(prints)} Fußabdrücke")


for s in sys.argv[1:] or ["moon_tranquility"]:
    main(s)
