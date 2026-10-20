#!/usr/bin/env python3
"""Gizeh: Sphinx-Gehege ins Nahfeld-Höhenmodell stempeln und die Königinnenpyramiden als
Wahrzeichen eintragen (meta.json + landmarks.json). Idempotent: das unveränderte Höhenmodell wird beim
ersten Lauf nach tools/worlds/downloads/earth_giza/terrain_h16.wsf.png gesichert und immer von dort gestempelt.

    python3 tools/worlds/giza_detail.py

Gehege (Lehner 1991): ebener, aus dem Fels geschnittener Boden um die Sphinx, Westwand ~8–10 m hoch, nach Osten
offen zu den Taltempeln. Boden hier y = -45,5 m (Nahkachel-Bezug), Rechteck x 684…790, z -114…-60.
"""
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from height_detail import height  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
D = os.path.join(ROOT, "public", "assets", "worlds", "earth_giza")
BK = os.path.join(ROOT, "tools", "worlds", "downloads", "earth_giza", "terrain_h16.wsf.png")
FLOOR = -45.5
RECT = (684.0, 790.0, -114.0, -60.0)

QUEENS = [  # file, x, z, base (m), note
    ("giza_g1a.glb", 553.0, -505.0, 49.5, "G1-a (Hetepheres I.?), Königinnenpyramide östlich von Cheops"),
    ("giza_g1b.glb", 553.0, -450.0, 49.0, "G1-b (Meritites I.)"),
    ("giza_g1c.glb", 551.0, -398.0, 46.25, "G1-c (Henutsen)"),
    ("giza_g3a.glb", -140.0, 322.0, 44.3, "G3-a, Königinnenpyramide südlich von Mykerinos"),
    ("giza_g3b.glb", -196.0, 322.0, 31.2, "G3-b, Stufenpyramide"),
    ("giza_g3c.glb", -245.0, 322.0, 31.2, "G3-c, Stufenpyramide"),
]


def main():
    m = json.load(open(os.path.join(D, "meta.json")))
    t = m["tiles"]["near"]
    src = os.path.join(D, t["heightmap"])
    if not os.path.exists(BK):
        os.makedirs(os.path.dirname(BK), exist_ok=True)
        shutil.copy2(src, BK)
    a = np.array(Image.open(BK)).astype(np.float64)
    lo, hi = t["heightMinM"], t["heightMaxM"]
    h = lo + a / 65535.0 * (hi - lo)
    n, S = t["resolution"], t["sizeM"]
    cs = S / (n - 1)
    x0, x1, z0, z1 = RECT
    c0, c1 = int((x0 + S / 2) / cs), int(np.ceil((x1 + S / 2) / cs))
    r0, r1 = int((z0 + S / 2) / cs), int(np.ceil((z1 + S / 2) / cs))
    sub = h[r0:r1 + 1, c0:c1 + 1]
    # cut down to the floor where the rock is higher; toward the open east side fill up to it (ramp of 1 cell)
    h[r0:r1 + 1, c0:c1 + 1] = FLOOR
    # soften the wall foot by one cell (talus) on W/N/S
    for (rr, cc) in [(r0 - 1, slice(c0, c1 + 1)), (r1 + 1, slice(c0, c1 + 1)), (slice(r0, r1 + 1), c0 - 1)]:
        h[rr, cc] = np.maximum(FLOOR, h[rr, cc] - 0.45 * (h[rr, cc] - FLOOR))
    print(f"Gehege: {sub.shape}, Fels vorher {sub.min():.1f}…{sub.max():.1f} m -> Boden {FLOOR} m")
    out = np.clip(np.round((h - lo) / (hi - lo) * 65535.0), 0, 65535).astype(np.uint16)
    Image.fromarray(out).save(src)
    hh = lo + out.astype(np.float64) / 65535.0 * (hi - lo)
    ctr = hh[(n - 1) // 2, (n - 1) // 2]
    print(f"Kachelmitte {ctr:.3f} m (muss 0 bleiben)")

    # landmarks: Sphinx on the enclosure floor, queens on the lowest corner of their footprint
    lms = m["landmarks"]
    for lm in lms:
        if lm["file"] == "giza_sphinx.glb":
            lm["y"] = FLOOR
            lm["note"] = "Sphinx blickt nach Osten; steht im Gehege (Boden -45,5 m, R5 gestempelt)"
    keep = [lm for lm in lms if not lm["file"].startswith("giza_g")]
    for f, x, z, b, note in QUEENS:
        ys = [height(hh, t, x + dx * b / 2, z + dz * b / 2) for dx in (-1, 0, 1) for dz in (-1, 0, 1)]
        keep.append({"file": f, "x": x, "y": round(min(ys) - 0.4, 3), "z": z, "headingDeg": 180.0, "compassDeg": 0.0,
                     "note": note + " (R5, prozedural gestufter Kern)"})
    for lm in keep:  # physics: pyramids get the smooth drivable frustum + talus (src/shared/pyramid.ts)
        if lm["file"] != "giza_sphinx.glb":
            lm["collider"] = "pyramid"
    m["landmarks"] = keep
    json.dump(m, open(os.path.join(D, "meta.json"), "w"), ensure_ascii=False, indent=2)
    lj = os.path.join(D, "landmarks.json")
    L = json.load(open(lj))
    L = [l for l in L if not l["glb"].startswith("giza_g")]
    for l in L:
        if l["glb"] == "giza_sphinx.glb":
            l["pos"]["y"] = FLOOR
        l["collider"] = "mesh" if l["glb"] == "giza_sphinx.glb" else "pyramid"
    for (f, x, z, b, note), lm in zip(QUEENS, keep[-len(QUEENS):]):
        L.append({"glb": f, "pos": {"x": x, "y": lm["y"], "z": z}, "headingDeg": 180.0, "collider": "pyramid",
                  "size": {"x": b, "y": round(b * 0.6, 1), "z": b}, "note": note})
    json.dump(L, open(lj, "w"), ensure_ascii=False, indent=1)
    print("Wahrzeichen:", [l["file"] for l in keep])


if __name__ == "__main__":
    main()
