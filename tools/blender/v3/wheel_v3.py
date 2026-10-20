"""v3 wheel: tyre (v2 profile), closed white aero disc with six raised dark turbine blades (as in the
reveal photos: d_021/d_036 close-ups), machined chamfers, dark hub, drilled/vented disc and
6-piston caliper (caliper reused from v2 geometry rules).

Authored in car coordinates (x axial, outboard = +x for the left wheels), converted with B().
"""
import math

import bmesh
import bpy

import common as C
from common import B
import build_roadster as V2


def build_wheel(wid, M, parent, lod):
    w = V2.WHEELS[wid]
    R, W = w["r"], w["w"]
    h = W / 2
    Rr = R - 0.072
    side = 1 if w["pos"][0] > 0 else -1
    seg = 128 if lod == 0 else 40
    allv, allf, fm, auv = [], [], [], []
    mats = [M["Tire"], M["Rim"], M["RimDark"], M["Disc"], M["Well"], M["Machined"]]

    def add(verts, faces, mi, uvs=None, mis=None):
        base = len(allv)
        allv.extend(verts)
        auv.extend(uvs if uvs is not None else [(0.0, 0.0)] * len(verts))
        allf.extend(tuple(base + i for i in f) for f in faces)
        fm.extend(mis if mis is not None else [mi] * len(faces))

    v, f, uv = C.lathe(V2.tire_profile(R, W, Rr), seg, closed=False, uv=40)
    add(v, f, 0, uv)
    xo = h - 0.020                       # outer face plane of the rim lip
    barrel = [(Rr - 0.006, -(h - 0.02)), (Rr - 0.02, -(h - 0.03)), (Rr - 0.02, xo - 0.03), (Rr + 0.006, xo - 0.006),
              (Rr + 0.012, xo + 0.002), (Rr - 0.004, xo + 0.006)]
    v, f = C.lathe(barrel, seg); add(v, f, 2)
    v, f = C.lathe([(Rr - 0.004, xo + 0.006), (Rr - 0.010, xo + 0.008), (Rr - 0.018, xo + 0.004)], seg); add(v, f, 5)
    # closed, slightly concave white aero face (the photos show no openings between the blades)
    face = [(Rr - 0.018, xo + 0.004), (Rr - 0.030, xo - 0.002), (0.80 * Rr, xo - 0.012), (0.55 * Rr, xo - 0.022),
            (0.30 * Rr, xo - 0.030), (0.17 * Rr, xo - 0.032)]
    v, f = C.lathe(face, seg); add(v, f, 1)
    # dark hub cone + cap
    hub = [(0.17 * Rr, xo - 0.032), (0.165 * Rr, xo - 0.012), (0.12 * Rr, xo - 0.004), (0.05 * Rr, xo - 0.001), (0.0, xo - 0.001)]
    v, f = C.lathe(hub, 32 if lod else 64); add(v, f, 2)
    if lod == 0:
        for k in range(5):
            a = 2 * math.pi * k / 5 + 0.3
            cy, cz = 0.10 * Rr * math.cos(a), 0.10 * Rr * math.sin(a)
            v, f = C.lathe([(0.0, xo + 0.004), (0.008, xo + 0.004), (0.010, xo - 0.002), (0.010, xo - 0.01)], 6)
            add([(x, y + cy, z + cz) for (x, y, z) in v], f, 5)

    def face_x(r):
        # axial position of the white face at radius r (piecewise linear through `face`)
        pts = sorted((pr, px) for pr, px in face)
        for (r0, x0), (r1, x1) in zip(pts, pts[1:]):
            if r0 <= r <= r1:
                return x0 + (x1 - x0) * (r - r0) / (r1 - r0)
        return pts[0][1] if r < pts[0][0] else pts[-1][1]

    # six turbine blades: long tapered dark fins, raised from the face, twisted (leading edge swept),
    # with a bright machined chamfer on the trailing flank and a dark slot along the centre
    nb = 6
    steps = 14 if lod == 0 else 4
    for k in range(nb):
        a = 2 * math.pi * k / nb + 0.12
        L0, L1 = 0.15 * Rr, Rr - 0.026
        rings = []
        for s_ in range(steps + 1):
            t = s_ / steps
            r = L0 + (L1 - L0) * t
            hw = 0.050 * (1 - t) ** 1.25 + 0.0045                     # half width (m), tapers to a point
            height = 0.030 * (1 - 0.75 * t) + 0.004                    # raised above the face
            sweep = 0.20 * t * t                                       # turbine twist (rad)
            xf = face_x(r)
            ang = a + sweep
            # cross-section: base L, chamfer L, top L, top R, chamfer R (bright), base R
            sec = [(-hw, xf - 0.002), (-0.75 * hw, xf + 0.85 * height), (-0.25 * hw, xf + height),
                   (0.30 * hw, xf + height * 0.96), (0.85 * hw, xf + 0.45 * height), (hw, xf - 0.002)]
            ring = []
            for dw, xx in sec:
                aa = ang + dw / r
                ring.append((xx, r * math.cos(aa), r * math.sin(aa)))
            rings.append(ring)
        sv = [p for ring in rings for p in ring]
        m = 6
        faces, mis = [], []
        for s_ in range(steps):
            for q in range(m - 1):
                faces.append((s_ * m + q, s_ * m + q + 1, (s_ + 1) * m + q + 1, (s_ + 1) * m + q))
                mis.append(5 if q == 3 else 2)           # trailing chamfer machined, rest dark
        faces.append(tuple(range(m))[::-1]); mis.append(2)
        faces.append(tuple(range(steps * m, steps * m + m))); mis.append(2)
        add(sv, faces, 2, mis=mis)
    # vented, drilled disc and hat (v2 dimensions)
    dr = Rr - 0.055
    xd0 = h - 0.13
    th = 0.034
    dseg = 72 if lod == 0 else 32
    for xx, flip in ((xd0 + th / 2, 1), (xd0 - th / 2, -1)):
        v, f = C.lathe([(dr, xx), (0.105, xx)] if flip > 0 else [(0.105, xx), (dr, xx)], dseg)
        add(v, f, 3, [(y / (2 * dr) + 0.5, z / (2 * dr) + 0.5) for (_, y, z) in v])
    v, f = C.lathe([(dr, xd0 - th / 2), (dr, xd0 + th / 2)], dseg); add(v, f, 3)
    v, f = C.lathe([(0.105, xd0 + th / 2), (0.10, xd0 + th / 2 + 0.035), (0.075, xd0 + th / 2 + 0.04), (0.0, xd0 + th / 2 + 0.04)], 36)
    add(v, f, 2)
    if side < 0:
        allv = [(-x, y, z) for (x, y, z) in allv]
        allf = [tuple(reversed(fc)) for fc in allf]
    ob = C.mesh_object(f"Wheel_{wid}", C.to_blender(allv), allf, mats, fm, parent=parent, loc=B(*w["pos"]), uvs=auv)
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data); bm.free()
    C.shade_by_angle(ob, 40)
    # caliper (same as v2: separate node, does not spin)
    ca0, ca1 = math.radians(100), math.radians(152)
    cs = 10 if lod == 0 else 5
    sect = [(dr - 0.062, xd0 + th / 2 + 0.002), (dr - 0.066, xd0 + th / 2 + 0.03), (dr + 0.012, xd0 + th / 2 + 0.032),
            (dr + 0.024, xd0 + th / 2 + 0.01), (dr + 0.024, xd0 - th / 2 - 0.01), (dr + 0.012, xd0 - th / 2 - 0.026),
            (dr - 0.066, xd0 - th / 2 - 0.024), (dr - 0.062, xd0 - th / 2 - 0.002)]
    v, f = C.lathe(sect, cs, a0=ca0, a1=ca1)
    m = len(sect)
    f.append(tuple(range(m))[::-1]); f.append(tuple(range(cs * m, (cs + 1) * m)))
    v = [(x, y, -z) for (x, y, z) in v]
    f = [tuple(reversed(fc)) for fc in f]
    if side < 0:
        v = [(-x, y, z) for (x, y, z) in v]
        f = [tuple(reversed(fc)) for fc in f]
    cal = C.mesh_object(f"Caliper_{wid}", C.to_blender(v), f, [M["Caliper"]], parent=parent, loc=B(*w["pos"]))
    bm = bmesh.new(); bm.from_mesh(cal.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(cal.data); bm.free()
    C.shade_by_angle(cal, 35)
    if lod == 0:
        C.bevel(cal, 0.004, 3, 30, harden=True)
    return ob, cal
