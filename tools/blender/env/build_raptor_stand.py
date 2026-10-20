"""Raptor engine test stand (raptor_stand.glb / raptor_stand_lod1.glb), distant object (~1 km).

  Blender -b --factory-startup -P tools/blender/env/build_raptor_stand.py [-- --lod 1]

glTF frame, origin = centre of the footprint (track.ts: 30 x 60 x 30 m), flame trench exit = +X.
  - concrete base 22 x 9 x 22 m with flame trench (open towards +X), deflector wedge, water deluge pipes
  - test stand frame (steel) 14 x 14 m up to 60 m, work platforms every 7.5 m, crane jib at the top
  - engine (nozzle bell) hanging above the trench, empty `Engine` (local -Z = exhaust direction, downwards)
  - empty `Flame_Exit` at the trench outlet (local -Z = outflow direction +X) -> steam emitter
  - 3 upright tanks (LOX/CH4, white) + spherical tank, pipe bridges
  - work lights `Site_Lights` (warm sodium vapour) and red aviation warning lights `Aviation_Red`
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mathutils import Vector  # noqa: E402

import env_common as E  # noqa: E402

LOD = E.lod_arg()


def build():
    E.reset()
    E.mat_concrete("Concrete", tile=4.0, gain=0.8)
    E.mat_galv("Steel_Galv", tile=3.0)
    E.mat_painted("Tank_White", (0.78, 0.79, 0.8), rough=0.4, metal=0.0, tile=6.0, seed=61, var=0.1)
    E.mat_painted("Soot", (0.06, 0.055, 0.05), rough=0.9, metal=0.0, tile=4.0, seed=62, var=0.4)
    E.mat_painted("Engine_Metal", (0.35, 0.3, 0.27), rough=0.35, metal=1.0, seed=63)
    E.emissive("Site_Lights", (1.0, 0.72, 0.42), 60.0, base=(0.9, 0.8, 0.6))
    E.emissive("Aviation_Red", (1.0, 0.05, 0.02), 40.0, base=(0.5, 0.05, 0.05))
    root = E.empty("RaptorStand", (0, 0, 0), size=5)
    mb = E.MB()
    sg = 8 if LOD == 0 else 5

    # ---------------- base with flame trench (trench along +X, 6 m wide, 6 m deep)
    BX, BY, BZ = 22.0, 9.0, 22.0
    TW = 6.0
    for sz in (-1, 1):   # two blocks left/right of the trench
        mb.box((0, BY / 2, sz * (TW / 2 + (BZ - TW) / 4)), (BX, BY, (BZ - TW) / 2), "Concrete")
    mb.box((-BX / 2 + 3, BY / 2, 0), (6, BY, TW), "Concrete")          # back wall of the trench
    mb.box((1.5, BY - 1.0, 0), (9.0, 2.0, TW), "Concrete")            # cover slab with opening (engine)
    # deflector wedge in the trench (soot), sloping towards +X
    mb.poly([(-BX / 2 + 6, 0.05, -TW / 2), (-BX / 2 + 6, 0.05, TW / 2), (-BX / 2 + 6, BY - 2.0, TW / 2), (-BX / 2 + 6, BY - 2.0, -TW / 2)], "Soot")
    mb.poly([(-BX / 2 + 6, BY - 2.0, -TW / 2), (-BX / 2 + 6, BY - 2.0, TW / 2), (6.0, 0.05, TW / 2), (6.0, 0.05, -TW / 2)], "Soot")
    mb.poly([(-BX / 2 + 6, 0.02, -TW / 2), (BX / 2 + 6, 0.02, -TW / 2), (BX / 2 + 6, 0.02, TW / 2), (-BX / 2 + 6, 0.02, TW / 2)][::-1], "Soot")
    for sz in (-1, 1):   # sooty trench walls
        z = sz * (TW / 2 - 0.01)
        pts = [(-BX / 2 + 6, 0.05, z), (BX / 2, 0.05, z), (BX / 2, BY - 0.5, z), (-BX / 2 + 6, BY - 0.5, z)]
        mb.poly(pts if sz > 0 else pts[::-1], "Soot")
        # outlet guide walls
        mb.box((BX / 2 + 4, 1.5, sz * (TW / 2 + 0.4 + 0.8)), (8, 3.0, 0.8), "Concrete")
    # deluge pipes above the trench outlet
    for k in range(3):
        mb.tube((BX / 2 - 0.5, BY - 2.6 - k * 0.9, -TW / 2), (BX / 2 - 0.5, BY - 2.6 - k * 0.9, TW / 2), 0.25, "Steel_Galv", seg=sg)

    # ---------------- test stand frame
    TX, TZ, TH = 14.0, 14.0, 60.0
    x0 = -2.0
    cols = [(x0 - TX / 2, -TZ / 2), (x0 + TX / 2, -TZ / 2), (x0 + TX / 2, TZ / 2), (x0 - TX / 2, TZ / 2)]
    for x, z in cols:
        mb.tube((x, BY, z), (x, TH, z), 0.45, "Steel_Galv", seg=4, square=True)
    levels = [BY + 7.5 * k for k in range(1, 8)] + [TH - 0.2]
    for i, y in enumerate(levels):
        for k in range(4):
            a, b = cols[k], cols[(k + 1) % 4]
            mb.tube((a[0], y, a[1]), (b[0], y, b[1]), 0.25, "Steel_Galv", seg=4, square=True)
            yp = levels[i - 1] if i else BY
            if LOD == 0 or i % 2 == 0:
                mb.tube((a[0], yp, a[1]), (b[0], y, b[1]), 0.14, "Steel_Galv", seg=4, square=True)
        if i % 2 == 1 or i == len(levels) - 1:   # work platforms (grating) + lights
            mb.box((x0, y + 0.1, 0), (TX, 0.2, TZ), "Steel_Galv")
            for x, z in cols:
                mb.box((x * 0.95 + x0 * 0.05, y + 0.5, z * 0.95), (0.6, 0.4, 0.6), "Site_Lights")
    # crane jib and hoist at the top
    mb.tube((x0, TH, 0), (x0 + 16, TH + 4, 0), 0.4, "Steel_Galv", seg=4, square=True)
    mb.tube((x0 + TX / 2, TH - 7.5, 0), (x0 + 16, TH + 4, 0), 0.2, "Steel_Galv", seg=4, square=True)
    mb.tube((x0 + 15, TH + 3.6, 0), (x0 + 15, TH - 12, 0), 0.05, "Steel_Galv", seg=4)
    for x, z in cols:
        mb.box((x, TH + 0.4, z), (0.5, 0.5, 0.5), "Aviation_Red")
    mb.box((x0 + 16, TH + 4.4, 0), (0.6, 0.6, 0.6), "Aviation_Red")
    # diagonal bracing of the tower (stream/concept: truss + supports)
    for x, z in cols:
        sx, sz = math.copysign(1, x - x0), math.copysign(1, z)
        mb.tube((x + sx * 7, 0.35, z + sz * 7), (x, BY + 15, z), 0.3, "Steel_Galv", seg=4, square=True)

    # ---------------- engine (nozzle bell) above the trench opening, exhaust downwards
    eng = Vector((1.5, BY + 2.2, 0))
    prof = [(0.0, 3.6), (0.6, 3.6), (0.75, 3.0), (0.55, 2.4), (0.45, 2.1), (0.7, 1.6), (1.0, 0.9), (1.3, 0.0)]
    mb.lathe([(r, -z) for r, z in prof][::-1], "Engine_Metal", seg=16 if LOD == 0 else 8,
             axis_a=tuple(eng + Vector((0, 3.6, 0))), axis_b=tuple(eng + Vector((0, 4.6, 0))))
    mb.box((1.5, BY + 6.0, 0), (5, 0.6, 5), "Steel_Galv")     # thrust frame

    # ---------------- tanks and pipe bridge
    for k, (x, z, r, h) in enumerate([(-14, 16, 3.0, 22), (-6, 18, 3.0, 22), (3, 17, 2.4, 16)]):
        mb.lathe([(0, 0), (r, 0), (r, h), (r * 0.7, h + r * 0.45), (0, h + r * 0.6)], "Tank_White", seg=sg * 2,
                 axis_a=(x, 0, z), axis_b=(x, 1, z))
        if LOD == 0:
            for y in (h * 0.33, h * 0.66):
                mb.lathe([(r + 0.05, y), (r + 0.05, y + 0.3)], "Steel_Galv", seg=sg * 2, axis_a=(x, 0, z), axis_b=(x, 1, z))
            mb.box((x + r + 0.3, h + 0.6, z), (0.4, 0.3, 0.4), "Site_Lights")
    # spherical tank
    sph = [(5.0 * math.sin(math.radians(a)), 5.0 * (1 - math.cos(math.radians(a))) + 3) for a in range(0, 181, 15 if LOD == 0 else 30)]
    mb.lathe(sph, "Tank_White", seg=sg * 2, axis_a=(14, 0, 16), axis_b=(14, 1, 16))
    for a in range(0, 360, 60):
        x, z = 14 + 3.5 * math.cos(math.radians(a)), 16 + 3.5 * math.sin(math.radians(a))
        mb.tube((x, 0, z), (x, 5, z), 0.2, "Steel_Galv", seg=6)
    # pipe bridge tanks -> stand
    for k in range(3):
        mb.tube((-14 + 0.0, 4 + k * 0.6, 13), (x0 - TX / 2, 4 + k * 0.6, 6), 0.25, "Steel_Galv", seg=sg)
    for x in (-12, -8, -4):
        mb.tube((x, 0, 12), (x, 5.5, 12), 0.15, "Steel_Galv", seg=4, square=True)

    mb.build("RaptorStand_Mesh", root)
    print(f"[ws-f] raptor_stand LOD{LOD}: {mb.tri_count()} tris")
    E.aim_empty("Engine", tuple(eng), (0, -1, 0), root)
    E.aim_empty("Flame_Exit", (BX / 2 + 1, 2.5, 0), (1, 0.15, 0), root)
    E.export_glb("raptor_stand", lod=LOD)


build()
