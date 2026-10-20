#!/usr/bin/env python3
"""Stonehenge: Erdwerke ins Nahfeld-Höhenmodell stempeln (das 30-m-DEM kennt sie nicht).

    python3 tools/worlds/stonehenge_layout.py

Idempotent (Original von asset pipeline gesichert unter tools/worlds/downloads/earth_stonehenge/terrain_h16.wsf.png).
Nach Cleal, Walker & Montague (1995) / English Heritage:
  Graben: Kreisring um die Mitte, Mittel-Ø ~105 m (Außenkante ~110 m), ~6 m breit, heute ~0,8 m tief
  Wall:   innen am Graben, ~6 m breit, heute ~0,4 m hoch (Gegenwall außen ~0,2 m)
  Eingänge: Nordost (Avenue, Azimut 41…60°) und Süd (Azimut 163…172°)
  Avenue: zwei Wälle ~12 m auseinander mit Außengräben, vom Nordosteingang 520 m entlang der Sonnwendachse (49,9°)
"""
import json
import math
import os
import shutil

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
D = os.path.join(ROOT, "public", "assets", "worlds", "earth_stonehenge")
BK = os.path.join(ROOT, "tools", "worlds", "downloads", "earth_stonehenge", "terrain_h16.wsf.png")
AXIS = 49.9


def bump(d, w):
    """Smooth profile 1 at d = 0, 0 at |d| >= w (cosine)."""
    return np.where(np.abs(d) < w, 0.5 + 0.5 * np.cos(np.pi * np.clip(d / w, -1, 1)), 0.0)


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
    zz, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    x = xx * cs - S / 2
    z = zz * cs - S / 2
    r = np.hypot(x, z)
    az = (np.degrees(np.arctan2(x, -z)) + 360) % 360
    gap = ((az > 41) & (az < 60)) | ((az > 163) & (az < 172))
    ring = ~gap
    dh = np.zeros_like(h)
    dh += np.where(ring, -0.8 * bump(r - 52.5, 3.6), 0)          # ditch
    dh += np.where(ring, 0.4 * bump(r - 46.5, 3.4), 0)           # inner bank
    dh += np.where(ring, 0.18 * bump(r - 58.5, 2.6), 0)          # outer counterscarp bank
    # Avenue: local frame along the axis (u = along, v = across)
    ax, azr = math.sin(math.radians(AXIS)), -math.cos(math.radians(AXIS))
    u = x * ax + z * azr
    v = -x * azr + z * ax                                         # across: the axis rotated by +90°
    inside = (u > 50) & (u < 570)
    fade = np.clip((u - 50) / 10, 0, 1) * np.clip((570 - u) / 40, 0, 1)
    for s in (-1, 1):
        dh += np.where(inside, fade * (0.3 * bump(v - s * 6.5, 2.6) - 0.35 * bump(v - s * 10.5, 2.0)), 0)
    h2 = h + dh
    out = np.clip(np.round((h2 - lo) / (hi - lo) * 65535.0), 0, 65535).astype(np.uint16)
    Image.fromarray(out).save(src)
    hh = lo + out.astype(np.float64) / 65535.0 * (hi - lo)
    c = (n - 1) // 2
    print(f"Erdwerke gestempelt: Δh {dh.min():.2f}…{dh.max():.2f} m; Kachelmitte {hh[c, c]:.3f} m")


if __name__ == "__main__":
    main()
