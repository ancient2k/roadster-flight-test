"""Spectator figures for instancing (crowd_person.glb).

  Blender -b --factory-startup -P tools/blender/env/build_crowd.py

Three variants as separate mesh nodes with ONE shared material `Crowd` (256² colour atlas):
  Person_A  standing, arms hanging, dark T-shirt, jeans                    (~0.5k triangles)
  Person_B  holds the phone up (right hand, display towards the person = -Z), light shirt, longer hair
  Person_C  hooded jacket, hands in the pockets, baseball cap
Frame: feet at y = 0, view/front = +Z, height 1.70–1.78 m. Origin between the feet.
Atlas: colour fields (skin, tops, trousers, shoes, hair, phone); the phone display is stored as an
emissiveTexture (only this field glows). instanceColor for clothing variation.
Seated figures: Person_A with bent knees would be a separate node -> here Person_S (seated, seat height y = 0.45
above the origin, origin = seat surface under the buttocks... see report).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import env_common as E  # noqa: E402

# atlas: 4x4 fields of 64 px; field -> (u, v) centre
CELLS = {
    "skin": 0, "skin2": 1, "top_dark": 2, "top_white": 3, "top_red": 4, "jeans": 5, "pants_black": 6,
    "shoe": 7, "hair_dark": 8, "hair_brown": 9, "phone": 10, "screen": 11, "hood_grey": 12, "cap": 13,
}
COLORS = {  # sRGB
    "skin": (0.78, 0.58, 0.47), "skin2": (0.45, 0.31, 0.24), "top_dark": (0.06, 0.06, 0.065), "top_white": (0.85, 0.85, 0.83),
    "top_red": (0.45, 0.05, 0.05), "jeans": (0.12, 0.16, 0.24), "pants_black": (0.05, 0.05, 0.055), "shoe": (0.16, 0.16, 0.17),
    "hair_dark": (0.05, 0.035, 0.03), "hair_brown": (0.25, 0.15, 0.08), "phone": (0.02, 0.02, 0.025), "screen": (0.6, 0.7, 0.85),
    "hood_grey": (0.22, 0.22, 0.23), "cap": (0.04, 0.04, 0.045),
}


def uv(cell):
    i = CELLS[cell]
    return ((i % 4) + 0.5) / 4, ((i // 4) + 0.5) / 4


def atlas():
    n = 256
    base = np.ones((n, n, 4), np.float32)
    emi = np.zeros((n, n, 4), np.float32)
    emi[..., 3] = 1
    noise = E.fbm(n, 2.0, 5)
    for k, i in CELLS.items():
        x0, y0 = (i % 4) * 64, (i // 4) * 64
        c = np.array(COLORS[k], np.float32)
        base[y0:y0 + 64, x0:x0 + 64, :3] = np.clip(c * (0.9 + 0.2 * noise[y0:y0 + 64, x0:x0 + 64, None]), 0, 1)
        if k == "screen":
            emi[y0:y0 + 64, x0:x0 + 64, :3] = (0.75, 0.85, 1.0)
    return E.save_rgba(base, "crowd_base.png"), E.save_rgba(emi, "crowd_emi.png")


class Person:
    def __init__(self):
        self.mb = E.MB()

    def part(self, fn, cell, *a, **k):
        n0 = len(self.mb.faces)
        fn(*a, **k)
        u, v = uv(cell)
        for j in range(n0, len(self.mb.faces)):
            idx, uvs, m, sm = self.mb.faces[j]
            self.mb.faces[j] = (idx, [(u, v)] * len(idx), m, sm)

    def limb(self, a, b, r0, r1, cell, seg=8):
        self.part(self.mb.tube, cell, a, b, r0, "Crowd", seg=seg, r2=r1)

    def blob(self, c, prof, cell, sx=1.0, sz=1.0, seg=12, tilt=0.0):
        """Solid of revolution about the vertical axis (prof: [(r, dy)]), scaled in x/z."""
        M = Matrix.Translation(c) @ Matrix.Rotation(tilt, 4, "X") @ Matrix.Diagonal((sx, 1, sz, 1))
        self.mb.push(M)
        self.part(self.mb.lathe, cell, prof, "Crowd", seg=seg, axis_a=(0, 0, 0), axis_b=(0, 1, 0), cap_start=True, cap_end=True)
        self.mb.pop()


def body(p: Person, top="top_dark", pants="jeans", hair="hair_dark", skin="skin", sitting=False, hood=False):
    hip_y = 0.92
    # legs
    for sx in (-1, 1):
        if sitting:
            p.limb((sx * 0.1, 0.47, -0.05), (sx * 0.11, 0.47, 0.38), 0.08, 0.06, pants)
            p.limb((sx * 0.11, 0.47, 0.38), (sx * 0.11, 0.06, 0.42), 0.058, 0.045, pants)
            p.part(p.mb.box, "shoe", (sx * 0.11, 0.04, 0.47), (0.1, 0.08, 0.26), "Crowd")
        else:
            p.limb((sx * 0.1, hip_y, 0), (sx * 0.105, 0.5, 0.02), 0.078, 0.058, pants)
            p.limb((sx * 0.105, 0.5, 0.02), (sx * 0.11, 0.08, -0.01), 0.055, 0.044, pants)
            p.blob(Vector((sx * 0.11, 0.0, 0.045)), [(0.0, 0.0), (0.06, 0.0), (0.062, 0.05), (0.05, 0.085), (0.0, 0.09)], "shoe", sz=2.3, seg=8)
    y0 = 0.5 if sitting else hip_y
    z0 = -0.04 if sitting else 0.0
    # pelvis + torso
    p.blob(Vector((0, y0 - 0.06, z0)), [(0.15, 0.0), (0.17, 0.08), (0.165, 0.14)], pants, sz=0.68)
    bulk = 1.12 if hood else 1.0
    p.blob(Vector((0, y0 + 0.07, z0)), [(0.155 * bulk, 0.0), (0.15 * bulk, 0.14), (0.175 * bulk, 0.33), (0.18 * bulk, 0.43),
                                        (0.14 * bulk, 0.5), (0.06, 0.54)], "hood_grey" if hood else top, sz=0.62, seg=10)
    neck = y0 + 0.6
    for sx in (-1, 1):   # shoulders (deltoids) connect torso and arms
        p.blob(Vector((sx * 0.18, neck - 0.17, z0)), [(0.0, -0.06), (0.05, -0.045), (0.068, 0.0), (0.05, 0.045), (0.0, 0.06)],
               "hood_grey" if hood else top, sz=1.0, seg=8)
    p.limb((0, neck - 0.03, z0), (0, neck + 0.07, z0 + 0.01), 0.048, 0.045, skin)
    # head
    hc = Vector((0, neck + 0.17, z0 + 0.02))
    def sph(R, ph0, ph1, k=8, sy=1.12):
        """Sphere profile (r, dy) from latitude ph0 to ph1 (degrees), dy relative to the south pole, stretched in y."""
        out = []
        for i in range(k + 1):
            ph = math.radians(ph0 + (ph1 - ph0) * i / k)
            out.append((max(R * math.cos(ph), 0.0) if i < k or ph1 < 90 else 0.0, R * sy * (1 + math.sin(ph))))
        return out
    head = sph(0.1, -65, 90)
    p.blob(hc - Vector((0, 0.11, 0)), head, skin, sz=1.1, seg=12)
    if hood:
        p.blob(hc - Vector((0, 0.13, 0.03)), [(0.12, 0.0), (0.125, 0.12), (0.105, 0.22), (0.0, 0.26)], "hood_grey", sz=1.05, seg=8)
    else:
        hp = [(r, y - 0.113 * 1.12) for r, y in sph(0.113, 12, 90, 6)]
        p.blob(hc + Vector((0, 0.0, -0.006)), hp, hair, sz=1.1, seg=12)
    return neck - 0.1, z0


def arm(p, sx, shoulder, elbow, hand, sleeve, skin, short=True):
    p.limb(shoulder, elbow, 0.055, 0.045, sleeve)
    p.limb(elbow, hand, 0.045 if not short else 0.04, 0.035, sleeve if not short else skin)
    p.part(p.mb.box, skin, hand, (0.05, 0.09, 0.08), "Crowd")


def person_a():
    p = Person()
    sh, z = body(p, "top_dark", "jeans", "hair_dark")
    for sx in (-1, 1):
        arm(p, sx, (sx * 0.2, sh, z), (sx * 0.24, sh - 0.3, z - 0.02), (sx * 0.23, sh - 0.56, z + 0.04), "top_dark", "skin")
    return p


def person_b():
    p = Person()
    sh, z = body(p, "top_white", "pants_black", "hair_brown", skin="skin")
    # long hair at the back
    p.blob(Vector((0, sh + 0.13, z - 0.06)), [(0.09, 0.0), (0.1, 0.12), (0.08, 0.2), (0.0, 0.22)], "hair_brown", sz=0.6, seg=8)
    arm(p, -1, (-0.2, sh, z), (-0.24, sh - 0.3, z - 0.02), (-0.23, sh - 0.56, z + 0.04), "top_white", "skin")
    # right arm lifts the phone in front of the face (+Z), display facing the person (-Z)
    hand = Vector((0.12, sh + 0.2, z + 0.42))
    arm(p, 1, (0.2, sh, z), (0.27, sh - 0.05, z + 0.25), tuple(hand), "top_white", "skin")
    p.part(p.mb.box, "phone", tuple(hand + Vector((0, 0.06, 0.02))), (0.075, 0.155, 0.01), "Crowd")
    p.part(p.mb.box, "screen", tuple(hand + Vector((0, 0.06, 0.0145))), (0.068, 0.145, 0.002), "Crowd")
    return p


def person_c():
    p = Person()
    sh, z = body(p, "top_dark", "jeans", "hair_dark", skin="skin2", hood=True)
    for sx in (-1, 1):   # hands in the jacket pockets
        p.limb((sx * 0.21, sh, z), (sx * 0.25, sh - 0.27, z - 0.01), 0.06, 0.05, "hood_grey")
        p.limb((sx * 0.25, sh - 0.27, z - 0.01), (sx * 0.13, sh - 0.4, z + 0.11), 0.05, 0.045, "hood_grey")
    return p


def person_s():
    """Seated (grandstand): origin = ground under the feet, seat height 0.45 m."""
    p = Person()
    sh, z = body(p, "top_red", "jeans", "hair_dark", sitting=True)
    for sx in (-1, 1):
        arm(p, sx, (sx * 0.2, sh, z), (sx * 0.23, sh - 0.28, z + 0.06), (sx * 0.15, sh - 0.42, z + 0.3), "top_red", "skin")
    return p


def build():
    E.reset()
    b, e = atlas()
    E.material("Crowd", (1, 1, 1), 0.0, 0.8, diff=b, emission_tex=e, strength=3.0)
    root = E.empty("Crowd", (0, 0, 0), size=0.5)
    for name, fn, x in (("Person_A", person_a, -0.9), ("Person_B", person_b, -0.3), ("Person_C", person_c, 0.3), ("Person_S", person_s, 0.9)):
        p = fn()
        ob = p.mb.build(name, root)
        print(f"[ws-f] {name}: {p.mb.tri_count()} tris")
    E.export_glb("crowd_person")


build()
