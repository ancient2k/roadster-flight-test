"""Original Tesla Roadster (2008, Lotus Elise based) with "Starman" at the wheel -> roadster1_starman.glb.

Usage: Blender -b --factory-startup -P tools/blender/build_starman.py -- [--out path.glb]

Built from published dimensions (length 3.946 m, width 1.851 m, height 1.127 m, wheelbase 2.352 m,
tyres 175/55 R16 front, 225/45 R17 rear) and the well-known 2018 Falcon Heavy photos: cherry-red
paint, open top, black windshield frame, Starman in a white suit sitting on the left (driver) seat,
right hand on the steering wheel, left arm resting on the door top. No logos or lettering.

Frame: metres, +Y up, nose +Z, left side +X. Origin = centre of the vehicle bounding box.
Nodes: Roadster1 (root) > Body, Wheel_FL/FR/RL/RR (origin at wheel centre, spin about X), Starman,
SteeringWheel, Windshield.
"""
from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import carkit as K  # noqa: E402
import common as C  # noqa: E402
from common import B  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
L, W, H = 3.946, 1.851, 1.127
WB = 2.352
ZF, ZR = 1.17, 1.17 - WB          # axle positions (front overhang ~0.80 m)
RF, RR_ = 0.299, 0.317            # tyre radii
TWF, TWR = 0.175, 0.225
TRACK_F, TRACK_R = 1.464, 1.499
HW = W / 2


def interp(keys, t):
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if t1 <= t <= t0:
            a = (t - t1) / (t0 - t1) if t0 != t1 else 0
            return v1 + (v0 - v1) * a
    return keys[0][1] if t > keys[0][0] else keys[-1][1]


# side silhouettes (z -> height above ground)
FENDER = [(1.973, 0.50), (1.93, 0.60), (1.75, 0.70), (1.30, 0.80), (1.10, 0.81), (0.80, 0.80), (0.55, 0.84),
          (0.0, 0.86), (-0.55, 0.88), (-0.90, 0.93), (-1.30, 0.95), (-1.75, 0.95), (-1.93, 0.93), (-1.973, 0.88)]
CENTRE = [(1.973, 0.48), (1.93, 0.56), (1.75, 0.63), (1.30, 0.70), (0.80, 0.74), (0.56, 0.78), (0.54, 0.80),
          (-0.56, 0.80), (-0.60, 0.90), (-0.90, 0.93), (-1.30, 0.94), (-1.75, 0.94), (-1.93, 0.92), (-1.973, 0.86)]
COCKPIT = (0.52, -0.58)            # open cockpit between these stations


def profile(z):
    edge = max(0.0, (abs(z) - 1.55) / 0.42)
    hw = HW * (1 - 0.10 * edge ** 2)
    if -0.6 < z < 0.6:
        hw = HW * (0.955 + 0.04 * (abs(z) / 0.6) ** 2)   # waisted doors
    lo = 0.14 + 0.10 * edge ** 2.5
    ft, ct = interp(FENDER, z), interp(CENTRE, z)
    pts = [(0, lo), (0.82 * hw, lo), (0.95 * hw, lo + 0.05), (0.985 * hw, lo + 0.13), (hw, 0.40), (0.995 * hw, 0.56),
           (0.965 * hw, ft - 0.06), (0.88 * hw, ft), (0.70 * hw, ft - 0.025), (0.50 * hw, ct + 0.012),
           (0.32 * hw, ct + 0.004), (0.15 * hw, ct + 0.001), (0, ct)]
    if edge > 0.3:
        k = ((edge - 0.3) / 0.7) ** 1.5
        pts = [(x * (1 - 0.18 * k), y + (0.42 - y) * 0.22 * k) for (x, y) in pts]
    return pts


def build_body(M, lod):
    zs = [1.973, 1.96, 1.93, 1.86, 1.75, 1.55, 1.30, 1.10, 0.80, 0.60, COCKPIT[0], 0.30, 0.0, -0.30, COCKPIT[1],
          -0.62, -0.90, -1.30, -1.55, -1.75, -1.86, -1.93, -1.96, -1.973]
    stations = [(z, profile(z), COCKPIT[1] - 1e-6 <= z <= COCKPIT[0] + 1e-6) for z in zs]

    def segmat(i, j):
        if j <= 1:
            return "D"
        return "P"
    jc = {1: 1.0, 2: 0.6, 3: 0.3, 4: 0.0, 5: 0.35, 6: 0.0, 7: 0.7, 8: 0.0, 9: 0.0, 10: 0.0}
    bm = K.loft_cage(stations, segmat, jc, {zs.index(COCKPIT[0]), zs.index(COCKPIT[1])})
    # open the cockpit: remove top faces (profile segments 8..11) between the cockpit stations
    lpj = bm.verts.layers.int.get("pj"); lrr = bm.verts.layers.int.get("rr")
    i0, i1 = zs.index(COCKPIT[0]), zs.index(COCKPIT[1])
    kill = [f for f in bm.faces if all(i0 <= v[lrr] <= i1 for v in f.verts) and min(v[lpj] for v in f.verts) >= 7]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm = K.subdivide(bm, 2 if lod == 0 else 1)
    K.close_ends(bm, "P")
    body = K.body_object("Body", bm, M)
    centres = [(TRACK_F / 2, RF, ZF), (-TRACK_F / 2, RF, ZF), (TRACK_R / 2, RR_, ZR), (-TRACK_R / 2, RR_, ZR)]

    def prof_at(z):
        return profile(z)
    cutters = [K.arch_cutter(M, centres[:2], RF + 0.035, inner=0.2), K.arch_cutter(M, centres[2:], RR_ + 0.035, inner=0.2)]
    for z in (0.50, -0.50):           # door shut lines
        cutters.append(K.gap_cutter(M, prof_at, z, 3, 7, name="door"))
    cutters.append(K.cross_gap_cutter(M, 1.55, HW * 0.55, interp(CENTRE, 1.55), name="bonnet"))
    cutters.append(K.cross_gap_cutter(M, -1.60, HW * 0.55, interp(CENTRE, -1.60), crown=0.01, name="boot"))
    K.shell(body, M, cutters, thickness=0.014)
    return body, centres


def tube(p0, p1, r0, r1, seg=16, caps=True):
    """Tapered capsule between two car-frame points (verts in car frame, faces)."""
    p0, p1 = Vector(p0), Vector(p1)
    ax = p1 - p0
    Lh = ax.length
    q = ax.normalized().to_track_quat("Z", "Y")
    rot = q.to_matrix()
    prof = []
    ring = 6
    if caps:
        for k in range(ring, 0, -1):
            a = (math.pi / 2) * k / ring
            prof.append((r0 * math.cos(a), -r0 * math.sin(a)))
    prof += [(r0, 0.0), (r1, Lh)]
    if caps:
        for k in range(1, ring + 1):
            a = (math.pi / 2) * k / ring
            prof.append((r1 * math.cos(a), Lh + r1 * math.sin(a)))
    verts, faces = [], []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        for (r, zz) in prof:
            v = Vector((r * math.cos(a), r * math.sin(a), zz))
            verts.append(tuple(rot @ v + p0))
    m = len(prof)
    for i in range(seg):
        i2 = (i + 1) % seg
        for j in range(m - 1):
            faces.append((i * m + j, i2 * m + j, i2 * m + j + 1, i * m + j + 1))
    return verts, faces


def ellipsoid(c, r, seg=20, rings=12):
    verts, faces = [], []
    for j in range(rings + 1):
        th = math.pi * j / rings
        for i in range(seg):
            ph = 2 * math.pi * i / seg
            verts.append((c[0] + r[0] * math.sin(th) * math.cos(ph), c[1] + r[1] * math.cos(th),
                          c[2] + r[2] * math.sin(th) * math.sin(ph)))
    for j in range(rings):
        for i in range(seg):
            i2 = (i + 1) % seg
            faces.append((j * seg + i, j * seg + i2, (j + 1) * seg + i2, (j + 1) * seg + i))
    return verts, faces


class Parts:
    def __init__(self):
        self.v, self.f, self.m = [], [], []

    def add(self, vf, mi):
        v, f = vf
        b = len(self.v)
        self.v += list(v)
        self.f += [tuple(b + i for i in ff) for ff in f]
        self.m += [mi] * len(f)


def build_starman(SM, parent, seat_x, lod):
    """Seated astronaut. SM: list of materials [suit, dark, visor, glove, boot, accent]."""
    P = Parts()
    seg = 18 if lod == 0 else 10
    sx = seat_x
    hip = (sx, 0.36, -0.30)
    # torso (seated, slightly reclined), backpack-free suit, chest unit
    P.add(ellipsoid((sx, 0.62, -0.36), (0.20, 0.28, 0.14), seg, 12), 0)
    P.add(ellipsoid((sx, 0.42, -0.33), (0.19, 0.12, 0.15), seg, 8), 0)
    P.add(ellipsoid((sx, 0.67, -0.24), (0.11, 0.07, 0.03), 12, 6), 5)                      # chest panel
    # neck ring + helmet with dark visor
    P.add(tube((sx, 0.86, -0.38), (sx, 0.91, -0.37), 0.085, 0.085, seg, caps=False), 1)
    P.add(ellipsoid((sx, 1.02, -0.36), (0.125, 0.14, 0.135), seg + 6, 14), 0)
    P.add(ellipsoid((sx, 1.02, -0.30), (0.10, 0.085, 0.085), seg + 6, 12), 2)              # visor (front half proud)
    # shoulders
    lsh, rsh = (sx + 0.21, 0.80, -0.37), (sx - 0.21, 0.80, -0.37)
    P.add(ellipsoid(lsh, (0.08, 0.08, 0.08), seg, 8), 0)
    P.add(ellipsoid(rsh, (0.08, 0.08, 0.08), seg, 8), 0)
    # left arm: upper arm out to the door, forearm along the door top, hand gripping the door frame
    lel = (sx + 0.40, 0.80, -0.28)
    lwr = (HW * 0.93, 0.86, -0.02)
    P.add(tube(lsh, lel, 0.065, 0.058, seg), 0)
    P.add(tube(lel, lwr, 0.056, 0.048, seg), 0)
    P.add(ellipsoid((HW * 0.94, 0.85, 0.06), (0.05, 0.035, 0.07), 12, 8), 3)                # glove on the door
    # right arm to the steering wheel (rim at 10 o'clock relative to the driver)
    rel = (sx - 0.30, 0.62, -0.12)
    rwr = (sx - 0.10, 0.80, 0.16)
    P.add(tube(rsh, rel, 0.065, 0.058, seg), 0)
    P.add(tube(rel, rwr, 0.056, 0.048, seg), 0)
    P.add(ellipsoid((sx - 0.08, 0.82, 0.20), (0.045, 0.05, 0.055), 12, 8), 3)
    # legs: thighs forward, shins down into the footwell, boots
    for dx in (0.10, -0.10):
        knee = (sx + dx * 1.1, 0.48, 0.18)
        ank = (sx + dx * 1.2, 0.22, 0.45)
        P.add(tube((sx + dx, 0.36, -0.28), knee, 0.085, 0.07, seg), 0)
        P.add(tube(knee, ank, 0.065, 0.055, seg), 0)
        P.add(ellipsoid((sx + dx * 1.2, 0.20, 0.53), (0.06, 0.055, 0.11), 12, 8), 4)
    # accent stripes (dark panels on the suit legs / helmet band)
    P.add(tube((sx, 0.93, -0.37), (sx, 0.95, -0.37), 0.128, 0.128, seg + 6, caps=False), 5)
    ob = C.mesh_object("Starman", C.to_blender(P.v), P.f, SM, P.m, parent=parent)
    C.shade_by_angle(ob, 60)
    md = ob.modifiers.new("Sub", "SUBSURF")
    md.levels = 1
    C.apply_modifiers(ob)
    return ob


def side_scoops(M, body):
    """Dark Elise-style intakes on the rear quarters, projected onto the body from the side."""
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body, dg)
    out = []
    for sgn in (1, -1):
        ring = []
        n = 20
        for i in range(n):
            a = 2 * math.pi * i / n
            z = -0.66 + 0.15 * math.cos(a) + 0.03 * math.sin(a)
            y = 0.47 + 0.075 * math.sin(a) - 0.03 * math.cos(a)
            o = B(sgn * 2.0, y, z)
            hit = bvh.ray_cast(o, B(-sgn, 0, 0))
            if hit[0] is None:
                break
            ring.append(tuple(hit[0] + hit[1] * 0.004))
        if len(ring) != n:
            print("[starman] scoop projection failed", sgn, len(ring))
            continue
        faces = [tuple(range(n)) if sgn > 0 else tuple(reversed(range(n)))]
        ob = C.mesh_object("scoop", ring, faces, [M[k] for k in K.KEYS], [K.KEYS.index("T")])
        out.append(ob)
    return out


def build():
    C.reset_scene()
    args = C.args_after_dashdash()
    lod = 0
    M = K.materials((0.36, 0.015, 0.03), 0.6, 0.25, coat=1.0, coat_rough=0.03)   # cherry red metallic
    root = C.empty("Roadster1", (0, 0, 0))
    body, centres = build_body(M, lod)
    # interior tub: floor, bulkheads, dash, two black seats, tunnel
    P = Parts()
    P.add(ellipsoid((0, 0.22, -0.02), (0.78, 0.03, 0.56), 16, 4), 0)
    for z in (0.56, -0.60):
        v = [(x, y, z) for x in (-0.80, 0.80) for y in (0.20, 0.82)]
        P.add((v, [(0, 1, 3, 2), (2, 3, 1, 0)]), 0)
    P.add(ellipsoid((0, 0.72, 0.48), (0.78, 0.07, 0.12), 16, 6), 0)                 # dash
    P.add(ellipsoid((0, 0.32, 0.0), (0.10, 0.10, 0.55), 10, 6), 0)                 # tunnel
    for sx in (0.37, -0.37):
        P.add(ellipsoid((sx, 0.30, -0.25), (0.22, 0.07, 0.24), 14, 6), 1)          # cushion
        P.add(ellipsoid((sx, 0.62, -0.50), (0.22, 0.30, 0.07), 14, 8), 1)          # backrest
    intr = C.mesh_object("Interior", C.to_blender(P.v), P.f, [M["D"], C.material("Seat_Black", (0.02, 0.02, 0.022), 0.0, 0.55)],
                         P.m)
    C.shade_by_angle(intr, 50)
    # windshield: curved glass with black frame
    wv, wf, wm = [], [], []
    n = 12
    for i in range(n + 1):
        t = i / n
        x = -1 + 2 * t
        for (zz, yy, half) in ((0.56, 0.835, 0.66), (0.10, 1.127, 0.56)):
            bow = 0.06 * (1 - x * x)
            wv.append((x * half, yy, zz + bow))
    for i in range(n):
        wf.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1))
        wm.append(0)
    glass = C.mesh_object("Windshield", C.to_blender(wv), wf, [M["G"]], wm, parent=root)
    fv, ff_ = [], []
    for (a, b) in ((wv[0], wv[1]), (wv[-2], wv[-1]), (wv[1], wv[-1])):
        vv, f2 = tube(a, b, 0.018, 0.018, 8)
        base = len(fv)
        fv += vv
        ff_ += [tuple(base + k for k in q) for q in f2]
    frame = C.mesh_object("Frame", C.to_blender(fv), ff_, [M["T"]])
    # mirrors on the doors
    mv, mf = [], []
    for sgn in (1, -1):
        v1, f1 = ellipsoid((sgn * (HW + 0.045), 0.93, 0.42), (0.06, 0.042, 0.055), 14, 8)
        base = len(mv); mv += v1; mf += [tuple(base + k for k in q) for q in f1]
        v2, f2 = tube((sgn * HW * 0.95, 0.87, 0.45), (sgn * (HW + 0.01), 0.92, 0.43), 0.012, 0.012, 8)
        base = len(mv); mv += v2; mf += [tuple(base + k for k in q) for q in f2]
    mirrors = C.mesh_object("Mirrors", C.to_blender(mv), mf, [M["P"]])
    C.shade_by_angle(mirrors, 50)
    # headlights: teardrop clear lenses with chrome reflectors on the front fenders; red tail lamps
    lv, lf, lm = [], [], []
    for sgn in (1, -1):
        # teardrop lens swept back along the fender top (rotated ellipsoid), chrome bowl inside
        v1, f1 = ellipsoid((0, 0, 0), (0.13, 0.05, 0.25), 20, 10)
        rot = Matrix.Rotation(math.radians(-14), 3, "X") @ Matrix.Rotation(math.radians(sgn * 10), 3, "Y")
        c1 = Vector((sgn * 0.60, 0.695, 1.70))
        v1 = [tuple(rot @ Vector(p) + c1) for p in v1]
        base = len(lv); lv += v1; lf += [tuple(base + k for k in q) for q in f1]; lm += [0] * len(f1)
        v2, f2 = ellipsoid((0, 0, 0), (0.10, 0.035, 0.20), 16, 8)
        v2 = [tuple(rot @ Vector(p) + c1 - Vector((0, 0.008, 0))) for p in v2]
        base = len(lv); lv += v2; lf += [tuple(base + k for k in q) for q in f2]; lm += [1] * len(f2)
        v3, f3 = ellipsoid((sgn * 0.70, 0.74, -1.955), (0.12, 0.05, 0.03), 14, 6)
        base = len(lv); lv += v3; lf += [tuple(base + k for k in q) for q in f3]; lm += [2] * len(f3)
    lens = C.material("Lens_Clear", (0.9, 0.92, 0.95), 0.0, 0.02, ior=1.49, cull=False)
    C._bsdf(lens).inputs["Transmission Weight"].default_value = 0.95
    lamps = C.mesh_object("Lamps", C.to_blender(lv), lf, [lens, M["X"], C.material("Tail_Red", (0.6, 0.02, 0.02), 0.0, 0.1,
                                                                                    coat=1.0, coat_roughness=0.0)], lm)
    C.shade_by_angle(lamps, 60)
    objs = [body, intr, frame, mirrors, lamps, K.wheel_liners(M, centres, RF + 0.03, inner=0.18)]
    objs += K.projected_patch(M, body, [(-0.42, 0.30), (0.42, 0.30), (0.36, 0.40), (-0.36, 0.40)], "D", True, name="mouth")
    objs += K.projected_patch(M, body, [(-0.55, 0.20), (0.55, 0.20), (0.55, 0.30), (-0.55, 0.30)], "D", False, name="diffuser")
    objs += side_scoops(M, body)
    body = K.join(objs, "Body")
    body.parent = root
    # side scoops in front of the rear wheels (dark, projected from the side)
    # wheels (own nodes, spin about X)
    wheels = []
    for wid, c in zip(("FL", "FR", "RL", "RR"), centres):
        r = RF if wid[0] == "F" else RR_
        tw = TWF if wid[0] == "F" else TWR
        wob = K.wheel_mesh(M, (0, 0, 0) if False else c, r, tw, rim_frac=0.68, style="spoke", spokes=10, seg=72)
        # move origin to the wheel centre
        me = wob.data
        off = B(*c)
        for v in me.vertices:
            v.co -= off
        wob.location = off
        wob.name = f"Wheel_{wid}"
        wob.parent = root
        wheels.append(wob)
    # steering wheel (left-hand drive)
    sv, sf = [], []
    seat_x = 0.37
    ctr = Vector((seat_x, 0.80, 0.24))
    for i in range(24):
        a0, a1 = 2 * math.pi * i / 24, 2 * math.pi * (i + 1) / 24
        p0 = ctr + Vector((0.18 * math.cos(a0), 0.18 * math.sin(a0) * 0.9, -0.18 * math.sin(a0) * 0.35))
        p1 = ctr + Vector((0.18 * math.cos(a1), 0.18 * math.sin(a1) * 0.9, -0.18 * math.sin(a1) * 0.35))
        v, f = tube(p0, p1, 0.016, 0.016, 8, caps=False)
        base = len(sv); sv += v; sf += [tuple(base + k for k in q) for q in f]
    v, f = tube(tuple(ctr), tuple(ctr + Vector((0, -0.10, 0.28))), 0.03, 0.03, 10)
    base = len(sv); sv += v; sf += [tuple(base + k for k in q) for q in f]
    sw = C.mesh_object("SteeringWheel", C.to_blender(sv), sf, [M["T"]], parent=root)
    SM = [C.material("Suit_White", (0.86, 0.86, 0.85), 0.0, 0.55),
          C.material("Suit_Dark", (0.05, 0.05, 0.055), 0.0, 0.4),
          C.material("Visor", (0.01, 0.01, 0.012), 0.6, 0.04, coat=1.0, coat_roughness=0.0),
          C.material("Glove", (0.10, 0.10, 0.11), 0.0, 0.6),
          C.material("Boot", (0.80, 0.80, 0.80), 0.0, 0.5),
          C.material("Suit_Accent", (0.12, 0.12, 0.13), 0.0, 0.4)]
    star = build_starman(SM, root, seat_x, lod)
    # recentre: origin = centre of the vehicle bounding box (all meshes)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    centre = (mn + mx) / 2
    for o in root.children:
        o.location -= centre
    for o in [body, star, sw, glass] + wheels:
        C.box_uv(o, 1.0) if o.type == "MESH" and o.name not in [w.name for w in wheels] else None
    out = args[args.index("--out") + 1] if "--out" in args else os.path.join(ROOT, "public/assets/car/roadster1_starman.glb")
    C.export_glb(out)
    print(f"[starman] {C.triangle_count(meshes)} tris, {os.path.getsize(out) / 1e6:.2f} MB, centre offset {tuple(round(c, 3) for c in centre)}")


if __name__ == "__main__":
    build()
