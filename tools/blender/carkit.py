"""Vehicle construction kit for the vehicle models props (Semi, Model 3/Y/S, Cybertruck).

Same approach as the roadster: a quad cage lofted from half profiles, edge creases on design lines and
material borders, Catmull-Clark subdivision, closed ends, solidify, boolean wheel arches and panel-gap
grooves, bevel + weighted normals, box UVs. Geometry is authored in the vehicle frame
(x left, y up, z forward; ground y = 0) and converted with common.B().

Profile convention (13 points per half, bottom centre -> left side -> top centre):
  0 bottom centre, 1 floor edge, 2 rocker bottom, 3 rocker top (dark/paint), 4 lower door, 5 character line,
  6 shoulder, 7 belt (paint/trim), 8 glass bottom, 9 glass top, 10 roof edge, 11 roof mid, 12 top centre
"""
from __future__ import annotations

import math

import bmesh
import bpy
from mathutils import Vector

import common as C
from common import B

NP = 13
KEYS = ["P", "T", "G", "D", "R", "Tire", "HL", "TL", "W", "X", "Rd", "Disc"]


def materials(paint_rgb, metallic=0.55, rough=0.28, *, coat=1.0, coat_rough=0.04, lod=0):
    import textures as T
    M = {
        "P": C.material("Prop_Paint", paint_rgb, metallic, rough, coat=coat, coat_roughness=coat_rough),
        "T": C.material("Prop_Trim_Gloss", (0.012, 0.012, 0.013), 0.0, 0.12, coat=1.0, coat_roughness=0.03),
        "G": C.material("Prop_Glass", (0.02, 0.022, 0.026), 0.0, 0.02, ior=1.52, cull=False),
        "D": C.material("Prop_Plastic", (0.025, 0.025, 0.027), 0.0, 0.6),
        "R": C.material("Prop_Rim", (0.55, 0.56, 0.58), 1.0, 0.3, cull=False),
        "Tire": C.material("Tire", (1.0, 1.0, 1.0), 0.0, 0.86, cull=False),
        "HL": C.material("Prop_Headlight", (0.9, 0.9, 0.9), 0.0, 0.1, emission=(1.0, 0.97, 0.92), emission_strength=6.0),
        "TL": C.material("Prop_Taillight", (0.5, 0.01, 0.01), 0.0, 0.15, emission=(1.0, 0.03, 0.02), emission_strength=3.0),
        "W": C.material("Wheelwell", (0.018, 0.018, 0.02), 0.0, 0.8, cull=False),
        "X": C.material("Prop_Metal", (0.75, 0.76, 0.78), 1.0, 0.18, cull=False),
        "Rd": C.material("Prop_Rim_Dark", (0.06, 0.062, 0.066), 0.6, 0.35, cull=False),
        "Disc": C.material("Brake_Disc", (0.35, 0.34, 0.33), 1.0, 0.4, cull=False),
    }
    C._bsdf(M["G"]).inputs["Transmission Weight"].default_value = 0.5
    n = 512 if lod == 0 else 256
    C.tex(M["P"], T.paint_normal(n), "Normal", 2.0, normal_strength=0.08)
    tn, tr, tb = T.tire(256, 512)
    C.tex(M["Tire"], tb, "Base Color"); C.tex(M["Tire"], tn, "Normal", normal_strength=1.0)
    C.tex(M["Tire"], tr, "Roughness", channel="Green")
    return M


# ---------------------------------------------------------------- cage
def loft_cage(stations, segmat, jcrease, corner_idx=()):
    """stations: [(z, [(x, y)]*NP, flags)], segmat(i, j) -> material key. Open tube with crease layer."""
    bm = bmesh.new()
    lpj = bm.verts.layers.int.new("pj")
    lrr = bm.verts.layers.int.new("rr")
    rings = []
    for r, (z, pts, _f) in enumerate(stations):
        left = [bm.verts.new(B(x, y, z)) for (x, y) in pts]
        right = [bm.verts.new(B(-x, y, z)) for (x, y) in pts[1:-1]]
        for j, v in enumerate(left):
            v[lpj], v[lrr] = j, r
        for j, v in zip(range(1, NP - 1), right):
            v[lpj], v[lrr] = j, r
        rings.append(left + list(reversed(right)))
    n = len(rings[0])

    def pidx(k):
        return k if k < NP else 2 * NP - 2 - k

    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for k in range(n):
            k2 = (k + 1) % n
            j = min(pidx(k), pidx(k2))
            f = bm.faces.new((a[k], a[k2], b[k2], b[k]))
            f.material_index = KEYS.index(segmat(i, j))
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    probe = max(bm.faces, key=lambda f: f.calc_center_median().x)
    if probe.normal.x < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    lc = bm.edges.layers.float.new("crease_edge")
    for e in bm.edges:
        c = 0.0
        if len(e.link_faces) == 2 and e.link_faces[0].material_index != e.link_faces[1].material_index:
            c = 1.0
        a_, b_ = e.verts
        if a_[lpj] == b_[lpj] and a_[lrr] != b_[lrr]:
            c = max(c, jcrease.get(a_[lpj], 0.0))
        elif a_[lrr] == b_[lrr] and a_[lrr] in corner_idx:
            c = max(c, 1.0)
        e[lc] = c
    return bm


def subdivide(bm, levels: int):
    me = bpy.data.meshes.new("cage")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("cage", me)
    bpy.context.scene.collection.objects.link(ob)
    if levels > 0:
        md = ob.modifiers.new("Sub", "SUBSURF")
        md.levels = md.render_levels = levels
        md.use_creases = True
        md.boundary_smooth = "PRESERVE_CORNERS"
        md.quality = 3
        C.apply_modifiers(ob)
    out = bmesh.new()
    out.from_mesh(ob.data)
    old = ob.data
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(old)
    return out


def close_ends(bm, key="P"):
    zs = [-v.co.y for v in bm.verts]
    zmax, zmin = max(zs), min(zs)
    for front in (True, False):
        edges = [e for e in bm.edges if e.is_boundary and all(
            ((-v.co.y) > zmax - 0.05) if front else ((-v.co.y) < zmin + 0.05) for v in e.verts)]
        if not edges:
            continue
        res = bmesh.ops.edgeloop_fill(bm, edges=edges)
        for f in res["faces"]:
            f.material_index = KEYS.index(key)
        bmesh.ops.triangulate(bm, faces=res["faces"], quad_method="BEAUTY", ngon_method="BEAUTY")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])


def body_object(name, bm, M):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for k in KEYS:
        me.materials.append(M[k])
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def shell(ob, M, cutters, thickness=0.016, bevel_w=0.003, segs=2):
    """Solidify (inner shell dark), boolean cutters (arches, gaps), bevel, weighted normals."""
    me = ob.data
    nb = len(KEYS)
    for _ in KEYS:
        me.materials.append(M["D"])
    for _ in KEYS:
        me.materials.append(M["T"])
    sd = ob.modifiers.new("Solid", "SOLIDIFY")
    sd.thickness, sd.offset = thickness, -1.0
    sd.use_even_offset, sd.use_quality_normals = False, True
    sd.material_offset, sd.material_offset_rim = nb, 2 * nb
    C.apply_modifiers(ob)
    bm = bmesh.new(); bm.from_mesh(ob.data)
    gi = KEYS.index("G") + nb
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index == gi], context="FACES")
    bm.to_mesh(ob.data); bm.free()
    for cut in cutters:
        bo = ob.modifiers.new("Cut", "BOOLEAN")
        bo.operation, bo.solver, bo.object, bo.material_mode = "DIFFERENCE", "EXACT", cut, "INDEX"
        C.apply_modifiers(ob)
        bpy.data.objects.remove(cut)
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.0004)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=0.0004)
    bm.to_mesh(ob.data); bm.free()
    C.shade_by_angle(ob, 32)
    C.bevel(ob, width=bevel_w, segments=segs, angle_deg=30)
    C.weighted_normals(ob)


def cutter_object(name, verts, faces, key, M):
    ob = C.mesh_object(name, verts, faces, [M[k] for k in KEYS], [KEYS.index(key)] * len(faces))
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data); bm.free()
    for p in ob.data.polygons:
        p.material_index = KEYS.index(key)
    ob.hide_render = True
    return ob


def arch_cutter(M, centres, radius, inner=0.25, outer=0.6, seg=56):
    verts, faces = [], []
    for (x, y, z) in centres:
        sgn = 1 if x > 0 else -1
        b = len(verts)
        for i in range(seg):
            a = 2 * math.pi * i / seg
            for xx in (x - sgn * inner, x + sgn * outer):
                verts.append(B(xx, y + radius * math.sin(a), z + radius * math.cos(a)))
        for i in range(seg):
            i2 = (i + 1) % seg
            faces.append((b + 2 * i, b + 2 * i2, b + 2 * i2 + 1, b + 2 * i + 1))
        faces.append(tuple(b + 2 * i for i in range(seg)))
        faces.append(tuple(b + 2 * i + 1 for i in reversed(range(seg))))
    return cutter_object("arches", verts, faces, "W", M)


def wheel_liners(M, centres, radius, inner=0.24, outer=0.08):
    v, f = [], []
    for (x, y, z) in centres:
        sgn = 1 if x > 0 else -1
        b = len(v)
        n = 24
        for i in range(n + 1):
            a = math.radians(-25 + 230 * i / n)
            for xx in (x - sgn * inner, x + sgn * outer):
                v.append((xx, y + radius * math.sin(a), z + radius * math.cos(a)))
        for i in range(n):
            q = (b + 2 * i, b + 2 * i + 1, b + 2 * i + 3, b + 2 * i + 2)
            f.append(q if sgn > 0 else q[::-1])
        c = len(v)
        v.append((x - sgn * inner, y, z))
        for i in range(n):
            q = (c, b + 2 * (i + 1), b + 2 * i)
            f.append(q if sgn > 0 else q[::-1])
    return C.mesh_object("liners", C.to_blender(v), f, [M[k] for k in KEYS], [KEYS.index("W")] * len(f))


def gap_cutter(M, profile_fn, z, j0, j1, width=0.0045, depth=0.010, both=True, name="gap"):
    """Thin groove following the side profile between points j0..j1 at station z (both sides)."""
    verts, faces = [], []
    pts = profile_fn(z)
    for sgn in ((1, -1) if both else (1,)):
        poly = [Vector((sgn * pts[j][0], pts[j][1])) for j in range(j0, j1 + 1)]
        inner, outer = [], []
        for k, p in enumerate(poly):
            a = poly[max(k - 1, 0)]; b = poly[min(k + 1, len(poly) - 1)]
            t = (b - a).normalized()
            nrm = Vector((t.y, -t.x)) * sgn
            if nrm.x * sgn < 0:
                nrm = -nrm
            inner.append(p - nrm * depth)
            outer.append(p + nrm * 0.06)
        # extend the ends a little so the groove runs out cleanly
        ring = inner + list(reversed(outer))
        base = len(verts)
        for dz in (-width / 2, width / 2):
            for q in ring:
                verts.append(B(q.x, q.y, z + dz))
        m = len(ring)
        for i in range(m):
            i2 = (i + 1) % m
            faces.append((base + i, base + i2, base + m + i2, base + m + i))
        faces.append(tuple(base + i for i in range(m)))
        faces.append(tuple(base + m + i for i in reversed(range(m))))
    return cutter_object(name, verts, faces, "T", M)


def cross_gap_cutter(M, z, x_half, y_top, width=0.0045, depth=0.010, crown=0.02, name="xgap"):
    """Transverse groove across a hood/trunk at station z (crowned top surface)."""
    verts, faces = [], []
    n = 10
    inner = [Vector((x_half * (2 * i / n - 1), y_top - crown * (2 * i / n - 1) ** 2 - depth)) for i in range(n + 1)]
    outer = [Vector((p.x, p.y + depth + 0.08)) for p in reversed(inner)]
    ring = inner + outer
    m = len(ring)
    for dz in (-width / 2, width / 2):
        for q in ring:
            verts.append(B(q.x, q.y, z + dz))
    for i in range(m):
        i2 = (i + 1) % m
        faces.append((i, i2, m + i2, m + i))
    faces.append(tuple(range(m)))
    faces.append(tuple(m + i for i in reversed(range(m))))
    return cutter_object(name, verts, faces, "T", M)


# ---------------------------------------------------------------- wheels
def wheel_mesh(M, pos, R, W, *, rim_frac=0.64, style="aero", spokes=5, seg=72, truck=False):
    """Returns a mesh object for one wheel at pos (vehicle frame); outer face towards +x for x > 0."""
    side = 1 if pos[0] > 0 else -1
    h = W / 2
    Rr = R * rim_frac
    allv, allf, fm, uv = [], [], [], []

    def add(v, f, key, uvs=None):
        b = len(allv)
        allv.extend(v)
        uv.extend(uvs if uvs is not None else [(0.0, 0.0)] * len(v))
        allf.extend(tuple(b + i for i in ff) for ff in f)
        fm.extend([KEYS.index(key)] * len(f))

    prof = [(Rr - 0.004, -(h - 0.012)), (Rr + 0.012, -(h - 0.002)), (Rr + 0.45 * (R - Rr), -h), (R - 0.025, -(h - 0.004)),
            (R - 0.008, -(h - 0.016)), (R, -(h - 0.04))]
    for g in (-0.4 * h, 0.0, 0.4 * h):
        prof += [(R, g - 0.007), (R - 0.007, g - 0.005), (R - 0.007, g + 0.005), (R, g + 0.007)]
    prof += [(R, h - 0.04), (R - 0.008, h - 0.016), (R - 0.025, h - 0.004), (Rr + 0.45 * (R - Rr), h),
             (Rr + 0.012, h - 0.002), (Rr - 0.004, h - 0.012)]
    v, f, u = C.lathe(prof, seg, closed=False, uv=36)
    add(v, f, "Tire", u)
    xo = h - 0.018
    # rim barrel + lip
    v, f = C.lathe([(Rr - 0.004, -(h - 0.012)), (Rr - 0.018, -(h - 0.03)), (Rr - 0.018, xo - 0.03), (Rr + 0.004, xo),
                    (Rr - 0.006, xo + 0.004)], seg)
    add(v, f, "Rd")
    if truck:
        # steel wheel: dished disc, hub, 10 lug nuts
        v, f = C.lathe([(Rr - 0.006, xo + 0.004), (Rr * 0.8, xo - 0.04), (Rr * 0.45, xo - 0.06), (Rr * 0.32, xo - 0.03),
                        (Rr * 0.2, xo - 0.01), (0.0, xo - 0.01)], seg)
        add(v, f, "X")
        for k in range(10):
            a = 2 * math.pi * k / 10
            cy, cz = 0.36 * Rr * math.cos(a), 0.36 * Rr * math.sin(a)
            vv, ff = C.lathe([(0.0, xo - 0.02), (0.014, xo - 0.02), (0.014, xo - 0.05)], 6)
            add([(x, y + cy, z + cz) for (x, y, z) in vv], ff, "X")
    elif style == "spoke":
        # open five-double-spoke rim (Model 3/Y/S): a dark back plate deep in the barrel so the gaps
        # read dark, slim silver spokes from the hub to the lip, a dark hub cap
        v, f = C.lathe([(Rr - 0.012, xo - 0.075), (0.0, xo - 0.075)], seg)
        add(v, f, "W")
        v, f = C.lathe([(0.24 * Rr, xo - 0.03), (0.24 * Rr, xo - 0.008), (0.17 * Rr, xo + 0.002), (0.0, xo + 0.004)], 24)
        add(v, f, "Rd")
        for k in range(2 * spokes):
            a = 2 * math.pi * (k // 2) / spokes + (0.11 if k % 2 else -0.11)
            sv = []
            steps = 4
            for s_ in range(steps + 1):
                t = s_ / steps
                r = 0.21 * Rr + (Rr - 0.012 - 0.21 * Rr) * t
                hw = 0.016 * (1 - 0.35 * t) + 0.006
                # spokes splay apart towards the lip and dish back into the barrel
                ang = a + (0.05 if k % 2 else -0.05) * t
                xd = xo - 0.004 - 0.03 * t * t
                for dw, xx in ((-hw, xd - 0.012), (-hw * 0.6, xd + 0.004), (hw * 0.6, xd + 0.004), (hw, xd - 0.012)):
                    sv.append((xx, r * math.cos(ang + dw / r), r * math.sin(ang + dw / r)))
            ff = []
            for s_ in range(steps):
                for q in range(3):
                    ff.append((s_ * 4 + q, s_ * 4 + q + 1, (s_ + 1) * 4 + q + 1, (s_ + 1) * 4 + q))
            ff += [(0, 3, 2, 1), (steps * 4, steps * 4 + 1, steps * 4 + 2, steps * 4 + 3)]
            add(sv, ff, "R")
        dr = Rr - 0.05
        v, f = C.lathe([(0.08, h - 0.11), (dr, h - 0.11), (dr, h - 0.085), (0.08, h - 0.085)], 36)
        add(v, f, "Disc")
        # calliper (dark) at the rear top of the disc
        v, f = C.lathe([(dr - 0.01, h - 0.075), (dr + 0.015, h - 0.075), (dr + 0.015, h - 0.12), (dr - 0.01, h - 0.12)], 8,
                       a0=0.6, a1=1.4)
        add(v, f, "Rd")
    else:
        # dished face + hub
        dish = [(Rr - 0.006, xo + 0.004), (Rr - 0.03, xo), (0.55 * Rr, xo - 0.015), (0.22 * Rr, xo - 0.03), (0.0, xo - 0.028)]
        v, f = C.lathe(dish, seg)
        add(v, f, "R" if style == "aero" else "Rd")
        # spokes / aero blades (proud of the face)
        n = spokes
        for k in range(n):
            a = 2 * math.pi * k / n
            sv = []
            steps = 5
            for s_ in range(steps + 1):
                t = s_ / steps
                r = 0.2 * Rr + (Rr - 0.04 - 0.2 * Rr) * t
                hw = (0.07 if style == "aero" else 0.035) * (1 - 0.5 * t) + 0.012
                xd = xo - 0.028 + 0.028 * t
                for dw, xx in ((-hw, xd - 0.004), (-hw * 0.7, xd + 0.012), (hw * 0.7, xd + 0.012), (hw, xd - 0.004)):
                    ang = a + dw / r + 0.06 * t
                    sv.append((xx, r * math.cos(ang), r * math.sin(ang)))
            ff = []
            for s_ in range(steps):
                for q in range(3):
                    ff.append((s_ * 4 + q, s_ * 4 + q + 1, (s_ + 1) * 4 + q + 1, (s_ + 1) * 4 + q))
            ff += [(0, 3, 2, 1), (steps * 4, steps * 4 + 1, steps * 4 + 2, steps * 4 + 3)]
            add(sv, ff, "R")
        # brake disc behind
        dr = Rr - 0.05
        v, f = C.lathe([(0.08, h - 0.11), (dr, h - 0.11), (dr, h - 0.085), (0.08, h - 0.085)], 36)
        add(v, f, "Disc")
    if side < 0:
        allv = [(-x, y, z) for (x, y, z) in allv]
        allf = [tuple(reversed(ff)) for ff in allf]
    allv = [(x + pos[0], y + pos[1], z + pos[2]) for (x, y, z) in allv]
    ob = C.mesh_object("wheel", C.to_blender(allv), allf, [M[k] for k in KEYS], fm, uvs=uv)
    C.shade_by_angle(ob, 40)
    return ob


# ---------------------------------------------------------------- lights projected onto the body
def projected_patch(M, body, outline_xy, key, front=True, offset=0.006, name="light", housing=None):
    """Polygon in the x-y plane projected along z onto the body surface (front: from +z, rear: from -z).
    housing: (scale, key) adds a slightly larger dark patch behind for depth."""
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body, dg)
    d = Vector((0, 1, 0)) if front else Vector((0, -1, 0))   # Blender: car -z == +y_b
    start_z = 50.0 if front else -50.0

    def proj(pts, off):
        out = []
        for (x, y) in pts:
            o = B(x, y, start_z)
            hit = bvh.ray_cast(o, d)
            if hit[0] is None:
                return None
            out.append(hit[0] + hit[1] * off)
        return out
    objs = []
    layers = [(1.0, key, offset)]
    if housing:
        layers.insert(0, (housing[0], housing[1], offset * 0.45))
    for scale, k, off in layers:
        cx = sum(p[0] for p in outline_xy) / len(outline_xy)
        cy = sum(p[1] for p in outline_xy) / len(outline_xy)
        pts = [(cx + (x - cx) * scale, cy + (y - cy) * scale) for (x, y) in outline_xy]
        q = proj(pts, off)
        if q is None:
            continue
        n = len(q)
        faces = [tuple(range(n))] if front else [tuple(reversed(range(n)))]
        ob = C.mesh_object(name, [tuple(p) for p in q], faces, [M[kk] for kk in KEYS], [KEYS.index(k)])
        bm = bmesh.new(); bm.from_mesh(ob.data)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bm.to_mesh(ob.data); bm.free()
        objs.append(ob)
    return objs


def side_patch(M, body, z, y, length, height, key, offset=0.004, depth=0.010, name="handle"):
    """Small slab on both body sides (vehicle frame x width, y up, z length): the four corners are
    ray-cast from outside along -x/+x onto the body and pushed out along the surface normal."""
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body, dg)
    objs = []
    for sgn in (1, -1):
        corners = [(z - length / 2, y - height / 2), (z + length / 2, y - height / 2), (z + length / 2, y + height / 2), (z - length / 2, y + height / 2)]
        hits = []
        for (zz, yy) in corners:
            hit = bvh.ray_cast(B(sgn * 5.0, yy, zz), B(-sgn, 0, 0))
            if hit[0] is None:
                break
            hits.append((hit[0], hit[1]))
        if len(hits) < 4:
            continue
        n = sum((h[1] for h in hits), Vector()) / 4
        v = [tuple(p + n * offset) for p, _ in hits] + [tuple(p + n * (offset + depth)) for p, _ in hits]
        f = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
        ob = C.mesh_object(name, v, f, [M[kk] for kk in KEYS], [KEYS.index(key)] * 6)
        bm = bmesh.new(); bm.from_mesh(ob.data)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bm.to_mesh(ob.data); bm.free()
        objs.append(ob)
    return objs


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    return ob
