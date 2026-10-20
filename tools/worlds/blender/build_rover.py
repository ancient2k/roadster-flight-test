"""asset pipeline Welten: Perseverance-Rover (vereinfacht) -> public/assets/worlds/mars_jezero/perseverance.glb

  Blender -b --factory-startup -P tools/worlds/blender/build_rover.py

Maße (NASA/JPL Mars 2020 Fact Sheet): Länge 3,0 m, Breite 2,7 m, Höhe 2,2 m (Mast), 6 Aluminiumräder Ø 52,5 cm
mit Lauffläche-Stollen, Rocker-Bogie-Fahrwerk, MMRTG schräg am Heck, Roboterarm 2,1 m mit Turm, Mast mit
Kopf (SuperCam/Mastcam-Z) auf ~2,2 m. glTF-Rahmen: Ursprung zwischen den Rädern am Boden, +Z = Fahrtrichtung.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "blender", "env"))
from mathutils import Matrix, Vector  # noqa: E402

import env_common as E  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT = os.path.join(ROOT, "public", "assets", "worlds", "mars_jezero")


def wheel(mb, c, side):
    """Rad: Felge mit gewölbter Lauffläche + 48 Stollen (Grousers), Speichen angedeutet."""
    c = Vector(c)
    ax = Vector((side, 0, 0))
    r, w = 0.2625, 0.25
    mb.lathe([(0.05, -w / 2), (r - 0.01, -w / 2), (r, -w / 4), (r, w / 4), (r - 0.01, w / 2), (0.05, w / 2)], "Wheel",
             seg=32, axis_a=tuple(c - ax * 0.0), axis_b=tuple(c + ax))
    for k in range(24):
        a = k * 2 * math.pi / 24
        p = c + Vector((0, math.sin(a) * (r + 0.008), math.cos(a) * (r + 0.008)))
        mb.box(tuple(p), (w * 0.95, 0.012, 0.012), "Wheel") if False else None
        M = Matrix.Translation(p) @ Matrix.Rotation(-a, 4, "X")
        mb.push(M)
        mb.box((0, 0, 0), (w * 0.95, 0.016, 0.03), "Wheel")
        mb.pop()
    mb.lathe([(0.0, -w / 2 - 0.01), (0.06, -w / 2 - 0.01), (0.06, w / 2 + 0.01), (0.0, w / 2 + 0.01)], "Dark", seg=12,
             axis_a=tuple(c), axis_b=tuple(c + ax))


def build():
    E.reset()
    E.mat_painted("Body_White", (0.78, 0.77, 0.74), rough=0.5, metal=0.0, seed=81, var=0.1)
    E.mat_painted("Wheel", (0.55, 0.55, 0.57), rough=0.4, metal=1.0, seed=82, var=0.12)
    E.material("Dark", (0.05, 0.05, 0.055), 0.4, 0.5)
    E.material("Gold", (0.75, 0.55, 0.2), 1.0, 0.3)
    E.material("Glass", (0.02, 0.03, 0.05), 0.0, 0.1)
    E.mat_painted("Titanium", (0.45, 0.45, 0.47), rough=0.35, metal=1.0, seed=83, var=0.1)
    root = E.empty("Perseverance", (0, 0, 0), size=0.5)
    mb = E.MB()
    # Wannenkörper (WEB) + Deck
    mb.box((0, 0.95, 0.05), (1.7, 0.5, 2.1), "Body_White")
    mb.box((0, 1.22, 0.05), (1.85, 0.04, 2.25), "Body_White")
    mb.box((0, 0.72, 0.05), (1.6, 0.06, 2.0), "Dark")
    # Kalibrierziele/Kleinzeug auf dem Deck
    for x, z in ((0.5, 0.6), (-0.55, 0.4), (0.2, -0.6)):
        mb.box((x, 1.3, z), (0.25, 0.12, 0.2), "Body_White")
    # Rocker-Bogie (je Seite): Rocker vom Differential nach vorn, Bogie nach hinten mit 2 Rädern
    wheels_z = (0.98, 0.0, -0.95)
    for side in (-1, 1):
        x = side * 1.02
        piv = Vector((side * 0.92, 0.82, 0.25))
        front = Vector((x, 0.2625, wheels_z[0]))
        bog = Vector((x, 0.62, -0.45))
        mid = Vector((x, 0.2625, wheels_z[1]))
        rear = Vector((x, 0.2625, wheels_z[2]))
        for a, b in ((piv, front + Vector((0, 0.3, 0))), (front + Vector((0, 0.3, 0)), front),
                     (piv, bog), (bog, mid + Vector((0, 0.3, 0))), (mid + Vector((0, 0.3, 0)), mid),
                     (bog, rear + Vector((0, 0.3, 0))), (rear + Vector((0, 0.3, 0)), rear)):
            mb.tube(tuple(a), tuple(b), 0.035, "Titanium", seg=8)
        for z in wheels_z:
            wheel(mb, (x - side * 0.0, 0.2625, z), side)
    # Mast + Kopf
    mb.tube((0.55, 1.24, 0.85), (0.55, 2.0, 0.85), 0.055, "Body_White", seg=12)
    mb.box((0.55, 2.12, 0.88), (0.42, 0.24, 0.3), "Body_White")
    mb.lathe([(0.0, 0.0), (0.06, 0.0), (0.06, 0.02), (0.0, 0.02)], "Glass", seg=16, axis_a=(0.48, 2.15, 1.03), axis_b=(0.48, 2.15, 1.5))
    for x in (0.62, 0.72):
        mb.lathe([(0.0, 0.0), (0.035, 0.0), (0.035, 0.02), (0.0, 0.02)], "Glass", seg=12, axis_a=(x, 2.08, 1.03), axis_b=(x, 2.08, 1.5))
    # Hochgewinnantenne (sechseckig, flach) + UHF
    mb.lathe([(0.0, 0.0), (0.3, 0.0), (0.3, 0.03), (0.0, 0.03)], "Body_White", seg=6, axis_a=(-0.55, 1.4, -0.4), axis_b=(-0.4, 1.9, -0.4))
    mb.tube((-0.55, 1.24, -0.4), (-0.52, 1.4, -0.4), 0.03, "Titanium", seg=8)
    # MMRTG am Heck (schräg, mit Kühlrippen)
    a, b = Vector((0, 1.0, -1.05)), Vector((0, 1.55, -1.6))
    mb.lathe([(0.0, 0.0), (0.32, 0.0), (0.32, 0.67), (0.0, 0.67)], "Titanium", seg=8, axis_a=tuple(a), axis_b=tuple(b))
    # Kühlrippen als gestufter Rotationskörper (8 Rippen wirken aus der Distanz wie Ringe)
    prof = []
    for k in range(9):
        z0 = 0.04 + k * 0.074
        prof += [(0.33, z0), (0.46, z0 + 0.008), (0.46, z0 + 0.03), (0.33, z0 + 0.038)]
    mb.lathe(prof, "Dark", seg=8, axis_a=tuple(a), axis_b=tuple(b))
    # Roboterarm (verstaut vorn) mit Turm
    s = Vector((0.7, 1.0, 1.15))
    e1 = s + Vector((-0.5, 0.05, 0.12))
    e2 = e1 + Vector((-0.75, -0.05, 0.0))
    for p, q in ((s, e1), (e1, e2)):
        mb.tube(tuple(p), tuple(q), 0.05, "Body_White", seg=10)
    mb.box(tuple(e2 + Vector((-0.1, -0.12, 0.05))), (0.3, 0.35, 0.3), "Titanium")
    mb.lathe([(0.0, 0.0), (0.05, 0.0), (0.05, 0.12), (0.0, 0.12)], "Dark", seg=10,
             axis_a=tuple(e2 + Vector((-0.1, -0.29, 0.05))), axis_b=tuple(e2 + Vector((-0.1, -0.5, 0.05))))
    mb.build("Perseverance_Mesh", root)
    print(f"[ws-f] perseverance: {mb.tri_count()} tris")
    E.export_glb("perseverance", out_dir=OUT)


build()
