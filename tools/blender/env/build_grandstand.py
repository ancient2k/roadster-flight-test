"""Mobile Alu-Tribüne mit Absperrgittern (grandstand.glb / grandstand_lod1.glb).

  Blender -b --factory-startup -P tools/blender/env/build_grandstand.py [-- --lod 1]

glTF-Rahmen: Ursprung = Mitte der Grundfläche, Front (Blick der Zuschauer, zur Strecke) = +Z.
  Grundfläche 50 x 20 m (track.ts): vorne 2,2 m Laufzone mit Absperrgittern (z = +10),
  18 Sitzreihen (Tiefe 0,95 m, Steigung 0,42 m) mit Alu-Sitz- und Trittbohlen, 3 Treppenaufgänge,
  verzinkte Unterkonstruktion (Rahmen alle 2,5 m), Rück- und Seitengeländer.
  Empties Row_0..17: Sitzmitte jeder Reihe (x = 0, y = Sitzoberkante, z = Sitzposition) für die Crowd.
  Reihe i: Trittbrett y = 0,30 + 0,42 i; Sitz y = Trittbrett + 0,42; Sitz-z = 7,8 - 0,95 i - 0,62.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mathutils import Vector  # noqa: E402

import env_common as E  # noqa: E402

LOD = E.lod_arg()
W, D = 50.0, 20.0
ROWS, RD, RH = 18, 0.95, 0.42
Z0 = D / 2 - 2.2            # Vorderkante der ersten Reihe
F0 = 0.30                   # Trittbrett Reihe 0
AISLES = [-12.5, 0.0, 12.5]
AW = 1.3                    # Gangbreite


def row_z(i):   # Vorderkante Reihe i
    return Z0 - i * RD


def foot_y(i):
    return F0 + i * RH


def seat_segments():
    """x-Intervalle der Sitzbänke (zwischen den Gängen)."""
    edges = [-W / 2 + 0.3] + sum([[a - AW / 2, a + AW / 2] for a in AISLES], []) + [W / 2 - 0.3]
    return [(edges[k], edges[k + 1]) for k in range(0, len(edges), 2)]


def fence_panel(mb, x0, z, y0=0.0, L=2.3, mat="Steel_Galv"):
    """Absperrgitter ("Bauzaun-Hamburger"/Mojo-light): Rahmenrohr, senkrechte Stäbe, Füße."""
    h = 1.1
    mb.tube((x0, y0 + 0.12, z), (x0, y0 + h, z), 0.019, mat, seg=6)
    mb.tube((x0 + L, y0 + 0.12, z), (x0 + L, y0 + h, z), 0.019, mat, seg=6)
    mb.tube((x0, y0 + h, z), (x0 + L, y0 + h, z), 0.019, mat, seg=6)
    mb.tube((x0, y0 + 0.2, z), (x0 + L, y0 + 0.2, z), 0.019, mat, seg=6)
    n = 14 if LOD == 0 else 0
    for k in range(1, n):
        x = x0 + L * k / n
        mb.tube((x, y0 + 0.2, z), (x, y0 + h, z), 0.008, mat, seg=4, caps=False)
    for x in (x0 + 0.1, x0 + L - 0.1):   # Flachfüße
        mb.box((x, y0 + 0.02, z), (0.06, 0.04, 0.7), mat)
        mb.tube((x, y0 + 0.04, z), (x, y0 + 0.14, z), 0.012, mat, seg=4)


def build():
    E.reset()
    E.mat_galv("Steel_Galv")
    E.mat_painted("Aluminium", (0.55, 0.56, 0.58), rough=0.38, metal=1.0, tile=2.0, seed=51, var=0.1)
    E.mat_painted("Riser", (0.04, 0.04, 0.045), rough=0.55, metal=0.2, tile=2.0, seed=52, var=0.1)
    E.emissive("LED_Red", (1.0, 0.03, 0.02), 25.0, base=(0.3, 0.02, 0.02))
    root = E.empty("Grandstand", (0, 0, 0), size=2.0)
    mb = E.MB()
    segs = seat_segments()
    sg = 6 if LOD == 0 else 4

    # ---------------- Sitzreihen
    for i in range(ROWS):
        z = row_z(i)
        fy = foot_y(i)
        for x0, x1 in segs:
            L = x1 - x0
            cx = (x0 + x1) / 2
            # Trittbretter (2 Profile), Sitzbohle, Setzstufe
            mb.box((cx, fy - 0.02, z - 0.2), (L, 0.04, 0.38), "Aluminium")
            mb.box((cx, fy - 0.02, z - 0.6), (L, 0.04, 0.3), "Aluminium") if LOD == 0 else None
            mb.box((cx, fy + RH - 0.03, z - RD + 0.33), (L, 0.05, 0.3), "Aluminium")
            mb.box((cx, fy + RH / 2 - 0.02, z - RD + 0.015), (L, RH, 0.03), "Riser")
            # Sitzstützen
            for xs in [x0 + 0.15 + k * 1.6 for k in range(int((L - 0.3) / 1.6) + 1)]:
                mb.box((xs, fy + RH / 2 - 0.04, z - RD + 0.33), (0.05, RH - 0.06, 0.05), "Aluminium") if LOD == 0 else None
        # Gänge: Zwischenstufen
        for a in AISLES:
            mb.box((a, fy - 0.02, z - RD / 2), (AW, 0.04, RD), "Aluminium")
            mb.box((a, fy + RH / 2 - 0.02, z - RD + 0.015), (AW, RH, 0.03), "Riser")
            mb.box((a, fy + RH / 2 - 0.02, z - RD / 2), (AW, 0.04, RD / 2), "Aluminium")
            mb.box((a, fy + RH / 4, z - RD / 2 + 0.01), (AW, RH / 2, 0.02), "Riser")
    # Gang-Handläufe (Mittelgeländer)
    for a in AISLES:
        p0 = (a, foot_y(0) + 0.9, row_z(0))
        p1 = (a, foot_y(ROWS - 1) + 0.9, row_z(ROWS - 1) - RD)
        mb.tube(p0, p1, 0.022, "Steel_Galv", seg=sg)
        for i in range(0, ROWS, 3):
            mb.tube((a, foot_y(i), row_z(i) - 0.3), (a, foot_y(i) + 0.9 + (i * RH) * 0 , row_z(i) - 0.3), 0.022, "Steel_Galv", seg=sg)
    # Vordere Brüstung (vor Reihe 0) + Treppen zur Laufzone
    mb.box((0, F0 / 2, Z0 + 0.02), (W - 0.6, F0, 0.04), "Riser")
    for a in AISLES:
        mb.box((a, F0 / 2 - 0.02, Z0 + 0.2), (AW, F0 / 2 + 0.0, 0.36), "Aluminium")

    # ---------------- Unterkonstruktion (Rahmen alle 2,5 m)
    zb = row_z(ROWS - 1) - RD
    ytop = foot_y(ROWS - 1)
    nx = int(W / 2.5)
    for k in range(nx + 1):
        x = -W / 2 + 0.3 + k * (W - 0.6) / nx
        mb.tube((x, F0 - 0.08, Z0), (x, ytop - 0.08, zb), 0.06, "Steel_Galv", seg=4, square=True)   # Schrägträger
        for i in range(0, ROWS, 3 if LOD == 0 else 6):
            z = row_z(i) - RD / 2
            y = foot_y(i) - 0.1
            mb.tube((x, 0.0, z), (x, y, z), 0.045, "Steel_Galv", seg=sg)
            mb.box((x, 0.01, z), (0.25, 0.02, 0.25), "Steel_Galv")
            if LOD == 0 and i + 3 < ROWS:
                z2 = row_z(i + 3) - RD / 2
                mb.tube((x, 0.15, z), (x, foot_y(i + 3) - 0.2, z2), 0.025, "Steel_Galv", seg=4, caps=False)
        mb.tube((x, 0.0, zb + 0.05), (x, ytop - 0.1, zb + 0.05), 0.05, "Steel_Galv", seg=sg)
    # Längsverbände
    for i in range(0, ROWS, 3 if LOD == 0 else 6):
        z = row_z(i) - RD / 2
        for yy in (0.25, max(0.3, foot_y(i) * 0.55)):
            mb.tube((-W / 2 + 0.3, yy, z), (W / 2 - 0.3, yy, z), 0.025, "Steel_Galv", seg=4, caps=False)

    # ---------------- Rück- und Seitengeländer
    ry = ytop + RH
    mb.box((0, ry, zb + 0.15), (W, 0.04, 0.3), "Aluminium")      # oberster Laufsteg
    for yy in (ry + 0.5, ry + 1.05):
        mb.tube((-W / 2, yy, zb), (W / 2, yy, zb), 0.025, "Steel_Galv", seg=sg)
    npost = int(W / 2.0)
    for k in range(npost + 1):
        x = -W / 2 + k * W / npost
        mb.tube((x, ry - 0.05, zb), (x, ry + 1.05, zb), 0.025, "Steel_Galv", seg=sg)
    if LOD == 0:
        mb.box((0, ry + 0.55, zb - 0.01), (W, 0.95, 0.01), "Riser")  # Windschutz/Banner hinten
    for sx in (-1, 1):
        x = sx * W / 2
        p0 = Vector((x, foot_y(0) + 1.0, Z0))
        p1 = Vector((x, ytop + 1.0, zb))
        for dy in (0.0, -0.5):
            mb.tube(p0 + Vector((0, dy, 0)), p1 + Vector((0, dy, 0)), 0.025, "Steel_Galv", seg=sg)
        for i in range(0, ROWS, 2):
            mb.tube((x, foot_y(i), row_z(i) - 0.3), (x, foot_y(i) + 1.0, row_z(i) - 0.3), 0.022, "Steel_Galv", seg=sg)
        # rote LED-Kante an der Seitenwange (Stream: rote Lichtlinien überall)
        mb.tube((x + sx * 0.05, F0, Z0 + 0.02), (x + sx * 0.05, ytop, zb), 0.02, "LED_Red", seg=4)

    # ---------------- Absperrgitter vor der Tribüne (Laufzone)
    L = 2.3
    n = int((W + 4) / (L + 0.05))
    x = -n * (L + 0.05) / 2
    for k in range(n):
        fence_panel(mb, x, D / 2 - 0.35, L=L)
        x += L + 0.05

    mb.build("Grandstand_Mesh", root)
    print(f"[ws-f] grandstand LOD{LOD}: {mb.tri_count()} tris")
    for i in range(ROWS):
        E.empty(f"Row_{i}", (0, foot_y(i) + RH, row_z(i) - RD + 0.33), root)
    E.export_glb("grandstand", lod=LOD)


build()
