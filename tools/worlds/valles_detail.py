#!/usr/bin/env python3
"""Valles Marineris: Sporn-und-Rinnen-Relief und Schichtbänke an den Steilwänden.

    python3 tools/worlds/valles_detail.py

Das HRSC/MOLA-Mischmodell (200 m/px) zeichnet die 6–8 km hohen Wände von Coprates Chasma als glatte Rampen;
feinere offizielle DTMs (HiRISE/CTX/HRSC-Einzelorbit) sind für diesen Punkt nicht erreichbar. Wie in den
HRSC-/CTX-Bildern gliedern sich die Wände in Sporne und Rinnen (Abstand ~1–3 km, im Nahfeld feinere Runsen)
und in harte Lagen, die Bänke bilden. Beides wird hier hangabhängig aufgeprägt:
  - Ausrichtung: geglättetes Gefälle der Fernkachel (σ ≈ 1 km), für Nah- und Fernkachel dasselbe Feld
    (gleiche Verschiebung im Überblendband)
  - Sporne/Rinnen: gratartiges Rauschen quer zum Hang (λ 2400/700/180 m), längs gestreckt (×5)
  - Bänke: Treppung der Höhe (Lagen 120 m und 22 m) mit 25 % Stufenanteil
  - Gewicht: nur an Hängen (Neigung 12°…30°), nicht im Umkreis 900 m um den Spawn, Kachelmitte bleibt 0
Idempotent: Original (asset pipeline) in tools/worlds/downloads/mars_valles/*.wsf.png.
"""
import json
import os
import shutil

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
D = os.path.join(ROOT, "public", "assets", "worlds", "mars_valles")
BKD = os.path.join(ROOT, "tools", "worlds", "downloads", "mars_valles")


def load(t, name):
    src = os.path.join(D, t["heightmap"])
    bk = os.path.join(BKD, name + ".wsf.png")
    if not os.path.exists(bk):
        os.makedirs(BKD, exist_ok=True)
        shutil.copy2(src, bk)
    a = np.array(Image.open(bk)).astype(np.float64)
    return t["heightMinM"] + a / 65535.0 * (t["heightMaxM"] - t["heightMinM"]), src


def save(h, t, src):
    lo, hi = float(h.min()) - 1.0, float(h.max()) + 1.0
    t["heightMinM"], t["heightMaxM"] = round(lo, 1), round(hi, 1)
    lo, hi = t["heightMinM"], t["heightMaxM"]
    out = np.clip(np.round((h - lo) / (hi - lo) * 65535.0), 0, 65535).astype(np.uint16)
    Image.fromarray(out).save(src)
    return lo + out.astype(np.float64) / 65535.0 * (hi - lo)


def vnoise(u, v, seed):
    """Smooth value noise on the integer lattice (C1 via smoothstep), vectorised."""
    iu, iv = np.floor(u), np.floor(v)
    fu, fv = u - iu, v - iv
    fu, fv = fu * fu * (3 - 2 * fu), fv * fv * (3 - 2 * fv)

    def h(a, b):
        x = np.sin(a * 127.1 + b * 311.7 + seed * 74.7) * 43758.5453
        return (x - np.floor(x)) * 2 - 1
    return (h(iu, iv) * (1 - fu) * (1 - fv) + h(iu + 1, iv) * fu * (1 - fv) + h(iu, iv + 1) * (1 - fu) * fv + h(iu + 1, iv + 1) * fu * fv)


def main():
    m = json.load(open(os.path.join(D, "meta.json")))
    tn, tf = m["tiles"]["near"], m["tiles"]["far"]
    hn, srcn = load(tn, "terrain_h16")
    hf, srcf = load(tf, "terrain_far_h16")
    # direction field from the far tile (smoothed ~1 km)
    nf, Sf = tf["resolution"], tf["sizeM"]
    csf = Sf / (nf - 1)
    hs = ndimage.gaussian_filter(hf, 1000 / csf)
    gz, gx = np.gradient(hs, csf)

    def field_at(x, z):
        c = (x + Sf / 2) / csf
        r = (z + Sf / 2) / csf
        return (ndimage.map_coordinates(gx, [r, c], order=1, mode="nearest"),
                ndimage.map_coordinates(gz, [r, c], order=1, mode="nearest"))

    def displace(h, x, z, cs):
        # slope weight from the smoothed relief (~300 m): the fine DEM texture must not switch it per pixel
        sz_, sx_ = np.gradient(ndimage.gaussian_filter(h, max(1.0, 300 / cs)), cs)
        slope = np.hypot(sx_, sz_)
        w = np.clip((slope - 0.21) / (0.58 - 0.21), 0, 1)
        w = w * w * (3 - 2 * w)
        w *= np.clip((np.hypot(x, z) - 900) / 600, 0, 1)
        dx, dz = field_at(x, z)
        L = np.hypot(dx, dz) + 1e-9
        dx, dz = dx / L, dz / L
        u = x * -dz + z * dx            # across the slope
        v = x * dx + z * dz             # down the slope
        ridge = np.zeros_like(h)
        for lam, amp, seed in ((2400, 260, 1), (700, 70, 2), (180, 14, 3)):
            n = vnoise(u / lam, v / (5 * lam), seed)
            ridge += amp * (1 - 2 * np.abs(n)) * 0.5
        # benches: stair-step the elevation (hard layers), 25 % of each step as a riser-flat pair
        bench = np.zeros_like(h)
        for step, k in ((120, 0.25), (22, 0.25)):
            q = h / step
            bench += (np.floor(q) + np.clip((q - np.floor(q)) / 0.75, 0, 1) - q) * step * k
        return h + w * (ridge + bench)

    nn, Sn = tn["resolution"], tn["sizeM"]
    csn = Sn / (nn - 1)
    zz, xx = np.mgrid[0:nn, 0:nn].astype(np.float64)
    hn2 = displace(hn, xx * csn - Sn / 2, zz * csn - Sn / 2, csn)
    zz, xx = np.mgrid[0:nf, 0:nf].astype(np.float64)
    hf2 = displace(hf, xx * csf - Sf / 2, zz * csf - Sf / 2, csf)
    c = (nn - 1) // 2
    hn2 -= hn2[c, c]                  # contract: near-tile centre = 0 (spawn area untouched anyway)
    qn = save(hn2, tn, srcn)
    save(hf2, tf, srcf)
    print(f"Valles: Nah Δ {np.abs(hn2 - hn).max():.1f} m (Mitte {qn[c, c]:.3f}), Fern Δ {np.abs(hf2 - hf).max():.1f} m")
    json.dump(m, open(os.path.join(D, "meta.json"), "w"), ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
