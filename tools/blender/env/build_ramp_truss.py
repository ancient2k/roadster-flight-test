"""Stahlfachwerk-Modul für Rampen-Unterbau (ramp_truss.glb + ramp_truss_cap.glb).

  Blender -b --factory-startup -P tools/blender/env/build_ramp_truss.py

Kachelbares Turm-Modul (Raster 2,5 x 2,5 x 2,5 m), glTF-Rahmen, Ursprung = Mitte der Unterseite:
  - 4 Eckstiele Rohr 114,3 mm genau auf x, z = ±1,25 (benachbarte Module teilen sich die Stiele),
    Flanschplatten unten (y 0..0,02) und oben (2,48..2,5) mit je 4 Schrauben -> gestapelt = Flanschstoß.
  - Riegel Rohr 60,3 mm auf y = 0,18 an allen vier Seiten, Diagonalen auf allen vier Seiten
    (Richtung wechselt je Seite), Horizontalverband (Diagonale in der Riegelebene).
  - Knotenbleche 12 mm an jedem Stab-Anschluss, je 2–3 Sechskantschrauben M20.
Anschlusspunkte: Stielköpfe (±1,25, 2,5, ±1,25) = Stielfüße des nächsten Moduls; seitlich Raster 2,5 m.
ramp_truss_cap.glb: oberer Abschluss (Kopfplatten, Riegel + Diagonale auf y = 0,15), auf die oberste Lage
  gesetzt: Position = Ursprung des untersten Moduls + (0, n * 2,5, 0) bei n Lagen.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mathutils import Vector  # noqa: E402

import env_common as E  # noqa: E402

S = 2.5
H = S / 2
RC, RB, RD = 0.0572, 0.0302, 0.0242   # Stiel, Riegel, Diagonale (Radien)
YR = 0.18                              # Riegelhöhe


def bolt(mb, p, n, mat="Steel_Galv", L=0.06):
    """Sechskantschraube M20: Kopf (6-kant) + Schaftende entlang Normale n."""
    p, n = Vector(p), Vector(n).normalized()
    mb.tube(p, p + n * 0.016, 0.017, mat, seg=6)
    mb.tube(p - n * (L - 0.016), p, 0.0105, mat, seg=6, caps=True)


def gusset(mb, c, u, v, w, h, normal, bolts=()):
    """Knotenblech: Rechteck w x h in der Ebene (u, v) um c, 12 mm dick, Schrauben an lokalen (a, b)."""
    c, u, v, nrm = Vector(c), Vector(u).normalized(), Vector(v).normalized(), Vector(normal).normalized()
    t = 0.006
    corners = [c + u * a + v * b for a, b in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]
    top = [p + nrm * t for p in corners]
    bot = [p - nrm * t for p in corners]
    mb.poly(top, "Steel_Galv")
    mb.poly(bot[::-1], "Steel_Galv")
    for k in range(4):
        mb.poly([bot[k], bot[(k + 1) % 4], top[(k + 1) % 4], top[k]], "Steel_Galv")
    for a, b in bolts:
        bolt(mb, c + u * a + v * b + nrm * t, nrm)


def build_bay():
    mb = E.MB()
    C = [(-H, -H), (H, -H), (H, H), (-H, H)]
    for x, z in C:
        mb.tube((x, 0.02, z), (x, S - 0.02, z), RC, "Steel_Galv", seg=10)
        mb.box((x, 0.01, z), (0.26, 0.02, 0.26), "Steel_Galv")                    # Fußflansch
        mb.box((x, S - 0.01, z), (0.26, 0.02, 0.26), "Steel_Galv")
        for sx in (-1, 1):
            for sz in (-1, 1):
                bolt(mb, (x + sx * 0.095, S, z + sz * 0.095), (0, 1, 0), L=0.05)   # Schrauben am Kopfflansch
    for k in range(4):
        (x0, z0), (x1, z1) = C[k], C[(k + 1) % 4]
        a, b = Vector((x0, 0, z0)), Vector((x1, 0, z1))
        d = (b - a).normalized()
        out = Vector((d.z, 0, -d.x))                       # Außennormale der Seite
        if out.dot(Vector(((x0 + x1) / 2, 0, (z0 + z1) / 2))) < 0:
            out = -out
        # Riegel (zwischen den Stielen, mit Knotenblech am Stiel)
        pa = a + d * (RC + 0.12) + Vector((0, YR, 0))
        pb = b - d * (RC + 0.12) + Vector((0, YR, 0))
        mb.tube(pa, pb, RB, "Steel_Galv", seg=8)
        for p, s in ((a, 1), (b, -1)):
            gusset(mb, p + d * s * (RC + 0.1) + Vector((0, YR, 0)), d, (0, 1, 0), 0.2, 0.16, Vector((0, 1, 0)).cross(d),
                   bolts=[(-0.04 * s, 0.0), (0.05 * s, 0.0)])
        # Diagonale: Richtung wechselt je Seite
        lo, hi = (a, b) if k % 2 == 0 else (b, a)
        dd = (hi - lo).normalized()
        p0 = lo + dd * (RC + 0.16) + Vector((0, YR + 0.12, 0))
        p1 = hi - dd * (RC + 0.16) + Vector((0, S - 0.22, 0))
        mb.tube(p0, p1, RD, "Steel_Galv", seg=8)
        nrm = Vector((0, 1, 0)).cross(d)
        for p, s, y in ((lo, 1, YR + 0.12), (hi, -1, S - 0.22)):
            gusset(mb, p + dd * s * (RC + 0.1) + Vector((0, y, 0)), dd, (0, 1, 0), 0.22, 0.2, nrm,
                   bolts=[(0.05 * s, -0.04), (0.05 * s, 0.04), (-0.03 * s, 0.0)])
    # Horizontalverband
    a, b = Vector((-H, YR + 0.06, -H)), Vector((H, YR + 0.06, H))
    dd = (b - a).normalized()
    mb.tube(a + dd * 0.25, b - dd * 0.25, RD, "Steel_Galv", seg=8)
    for p, s in ((a, 1), (b, -1)):
        gusset(mb, p + dd * s * 0.2, dd, Vector((0, 1, 0)).cross(dd), 0.2, 0.14, (0, 1, 0), bolts=[(0.04 * s, 0.0), (-0.04 * s, 0.0)])
    return mb


def build_cap():
    mb = E.MB()
    C = [(-H, -H), (H, -H), (H, H), (-H, H)]
    y = 0.0
    for x, z in C:   # Kopfplatten
        mb.box((x, 0.01, z), (0.3, 0.02, 0.3), "Steel_Galv")
        mb.tube((x, 0.02, z), (x, 0.22, z), RC, "Steel_Galv", seg=10)
    for k in range(4):
        (x0, z0), (x1, z1) = C[k], C[(k + 1) % 4]
        a, b = Vector((x0, 0.15, z0)), Vector((x1, 0.15, z1))
        d = (b - a).normalized()
        mb.tube(a + d * RC, b - d * RC, RB * 1.3, "Steel_Galv", seg=8)
    a, b = Vector((-H, 0.15, H)), Vector((H, 0.15, -H))
    dd = (b - a).normalized()
    mb.tube(a + dd * 0.1, b - dd * 0.1, RD, "Steel_Galv", seg=8)
    return mb


def build():
    for name, fn in (("ramp_truss", build_bay), ("ramp_truss_cap", build_cap)):
        E.reset()
        E.mat_galv("Steel_Galv", tile=1.0)
        mb = fn()
        mb.build(name.replace("ramp_truss", "RampTruss").replace("_cap", "_Cap"))
        print(f"[ws-f] {name}: {mb.tri_count()} tris")
        E.export_glb(name)


build()
