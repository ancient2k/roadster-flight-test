"""Procedural Tesla Roadster (Gen 2, 2026 reveal) -> GLB.

Usage (headless):
  Blender -b --factory-startup -P tools/blender/build_roadster.py -- [--lod 0|1] [--out path.glb] [--no-export]

Contract (src/shared/roadster.ts): metres, glTF +Y up, nose +Z, left side +X,
origin = dry CoG (wheels touch the ground at y ~= -0.44/-0.45). All geometry here is authored in
that car frame; common.B() converts to Blender (x, -z, y). Pivots are object origins.
"""
from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402

import common as C  # noqa: E402
from common import B  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GY = -0.45  # ground-referenced heights -> CoG frame: y = yg + GY

# ---------------------------------------------------------------- ROADSTER config (mirrors src/shared/roadster.ts)
S12, C12 = math.sin(math.radians(12)), math.cos(math.radians(12))
WHEELS = {
    "FL": dict(pos=(0.85, -0.095, 1.40), r=0.345, w=0.295),
    "FR": dict(pos=(-0.85, -0.095, 1.40), r=0.345, w=0.295),
    "RL": dict(pos=(0.86, -0.085, -1.25), r=0.355, w=0.345),
    "RR": dict(pos=(-0.86, -0.085, -1.25), r=0.355, w=0.345),
}
NOZZLES = [
    ((0.36, -0.20, -2.05), (0, 0, 1)), ((0.12, -0.20, -2.05), (0, 0, 1)),
    ((-0.12, -0.20, -2.05), (0, 0, 1)), ((-0.36, -0.20, -2.05), (0, 0, 1)),
    ((0.78, -0.30, 1.85), (-S12, C12, 0)), ((-0.78, -0.30, 1.85), (S12, C12, 0)),
    ((0.78, -0.30, -1.80), (-S12, C12, 0)), ((-0.78, -0.30, -1.80), (S12, C12, 0)),
    ((0.85, 0.0, 2.00), (-1, 0, 0)), ((-0.85, 0.0, 2.00), (1, 0, 0)),
]


def read_shared_config():
    """Cross-check the mirrored constants against src/shared/roadster.ts (fail loudly on drift)."""
    path = os.path.join(ROOT, "src", "shared", "roadster.ts")
    try:
        src = open(path, encoding="utf8").read()
    except OSError:
        return
    import re
    for wid, w in WHEELS.items():
        m = re.search(r"id: '%s', pos: \{ x: ([-\d.]+), y: ([-\d.]+), z: ([-\d.]+) \}, radius: ([\d.]+), width: ([\d.]+)" % wid, src)
        assert m, f"wheel {wid} not found in roadster.ts"
        got = tuple(float(v) for v in m.groups())
        exp = (*w["pos"], w["r"], w["w"])
        assert all(abs(a - b) < 1e-9 for a, b in zip(got, exp)), f"wheel {wid} drift: ts={got} py={exp}"
    for i, (pos, _) in enumerate(NOZZLES):
        m = re.search(r"\{ id: %d, .*?pos: \{ x: ([-\d.]+), y: ([-\d.]+), z: ([-\d.]+) \}" % i, src)
        assert m, f"nozzle {i} not found"
        got = tuple(float(v) for v in m.groups())
        assert all(abs(a - b) < 1e-9 for a, b in zip(got, pos)), f"nozzle {i} drift: {got} vs {pos}"


# ---------------------------------------------------------------- materials
def make_materials(lod: int) -> dict[str, bpy.types.Material]:
    M = {}
    M["W"] = C.material("Paint_AnoWhite", (0.86, 0.865, 0.855), 0.0, 0.36, coat=0.8, coat_roughness=0.10)
    M["D"] = C.material("Carbon", (1.0, 1.0, 1.0), 0.0, 0.38, coat=0.8, coat_roughness=0.06)
    M["G"] = C.material("Glass_Tint", (0.016, 0.018, 0.021), 0.0, 0.015, ior=1.52, cull=False)
    C._bsdf(M["G"]).inputs["Transmission Weight"].default_value = 0.5
    M["Tire"] = C.material("Tire", (1.0, 1.0, 1.0), 0.0, 0.86, cull=False)
    M["Rim"] = C.material("Rim", (0.82, 0.83, 0.83), 0.0, 0.32, coat=0.5, coat_roughness=0.2, cull=False)
    M["RimDark"] = C.material("Rim_Dark", (0.05, 0.052, 0.056), 0.55, 0.38, cull=False)
    M["Brass"] = C.material("Brass_Nozzle", (0.66, 0.47, 0.28), 1.0, 0.34, cull=False)
    M["LEDF"] = C.material("LED_Front", (1, 1, 1), 0, 0.3, emission=(1.0, 0.97, 0.92), emission_strength=12.0)
    M["LEDT"] = C.material("LED_Tail", (0.6, 0.02, 0.02), 0, 0.3, emission=(1.0, 0.03, 0.015), emission_strength=6.0)
    M["LEDB"] = C.material("LED_Brake", (0.6, 0.02, 0.02), 0, 0.3, emission=(1.0, 0.02, 0.01), emission_strength=2.0)
    M["LEDM"] = C.material("LED_Marker", (0.6, 0.02, 0.02), 0, 0.3, emission=(1.0, 0.04, 0.02), emission_strength=3.0)
    M["Int"] = C.material("Interior", (0.72, 0.72, 0.70), 0.0, 0.62)
    M["IntD"] = C.material("Interior_Dark", (0.035, 0.036, 0.04), 0.0, 0.55)
    M["T"] = C.material("Trim_Black", (0.012, 0.012, 0.013), 0.0, 0.18, coat=1.0, coat_roughness=0.05)
    M["Well"] = C.material("Wheelwell", (0.018, 0.018, 0.02), 0.0, 0.8, cull=False)
    M["Disc"] = C.material("Brake_Disc", (1.0, 1.0, 1.0), 1.0, 0.42, cull=False)
    M["Caliper"] = C.material("Caliper", (0.05, 0.05, 0.055), 0.3, 0.3, coat=0.8, coat_roughness=0.1, cull=False)
    M["Display"] = C.material("Display", (0.01, 0.01, 0.012), 0, 0.1, emission=(0.35, 0.55, 0.9), emission_strength=1.5)
    M["Chrome"] = C.material("Metal_Dark", (0.25, 0.25, 0.26), 1.0, 0.25, cull=False)
    M["Machined"] = C.material("Rim_Machined", (0.80, 0.80, 0.81), 1.0, 0.22, cull=False)
    M["P"] = C.material("Plastic_Black", (0.018, 0.018, 0.02), 0.0, 0.62)
    import textures as T
    n = 1024 if lod == 0 else 512
    cb, cn, cr = T.carbon(n)
    C.tex(M["D"], cb, "Base Color", 1 / 0.048)
    C.tex(M["D"], cn, "Normal", 1 / 0.048, normal_strength=0.6)
    C.tex(M["D"], cr, "Roughness", 1 / 0.048, channel="Green")
    C.tex(M["W"], T.paint_roughness(n, base=0.34, var=0.05), "Roughness", 1.5, channel="Green")
    C.tex(M["W"], T.paint_normal(n), "Coat Normal", 3.0, normal_strength=0.18)
    tn, tr, tb = T.tire(512 if lod == 0 else 256, 1024 if lod == 0 else 512)
    C.tex(M["Tire"], tb, "Base Color"); C.tex(M["Tire"], tn, "Normal", normal_strength=1.0)
    C.tex(M["Tire"], tr, "Roughness", channel="Green")
    db, dn, drr = T.brake_disc(n)
    C.tex(M["Disc"], db, "Base Color"); C.tex(M["Disc"], dn, "Normal", normal_strength=1.0)
    C.tex(M["Disc"], drr, "Roughness", channel="Green")
    C.tex(M["Int"], T.leather(512), "Normal", 6.0, normal_strength=0.5)
    return M


# ---------------------------------------------------------------- body loft data
# Each station: z (car frame) and 12 half-profile points (x, yg[, dz]) from bottom centre round the left
# side (+X) to the top centre. yg = height above ground. Point roles:
#  0 bottom centre, 1 floor edge, 2 rocker bottom, 3 sill (dark/white split), 4 lower side,
#  5 mid crease (widest), 6 shoulder, 7 fender crest / beltline / haunch, 8 hood edge / side-glass base /
#  buttress, 9 hood / roof rail (top of side glass), 10 hood / rail inner = glass edge, 11 top centre.
ST = [
    (2.25, [(0, .15), (.62, .15), (.86, .17), (.87, .24), (.90, .38), (.92, .48), (.875, .59, -.01), (.74, .655), (.60, .575, -.02), (.58, .47), (.30, .47), (0, .47)]),
    (2.05, [(0, .11), (.68, .11), (.90, .145), (.91, .25), (.945, .40), (.965, .50), (.925, .66), (.745, .745), (.55, .61), (.50, .605), (.25, .608), (0, .61)]),
    (1.82, [(0, .10), (.70, .10), (.915, .15), (.93, .27), (.965, .42), (.995, .55), (.948, .70), (.75, .80), (.48, .655), (.40, .655), (.20, .657), (0, .66)]),
    (1.40, [(0, .10), (.70, .10), (.92, .15), (.94, .28), (.975, .43), (1.0, .56), (.958, .73), (.76, .845), (.46, .69), (.38, .692), (.19, .695), (0, .70)]),
    (0.92, [(0, .10), (.70, .10), (.91, .16), (.915, .25), (.935, .42), (.962, .60), (.972, .74), (.875, .845), (.80, .78), (.76, .772), (.70, .765), (0, .755)]),
    (0.08, [(0, .10), (.70, .10), (.905, .165), (.895, .27), (.900, .44), (.945, .61), (.962, .74), (.89, .81), (.845, .825), (.58, 1.055), (.52, 1.08), (0, 1.10)]),
    (-0.40, [(0, .10), (.70, .10), (.905, .165), (.895, .30), (.902, .45), (.948, .62), (.965, .75), (.905, .815), (.855, .83), (.585, 1.07), (.52, 1.097), (0, 1.115)]),
    (-0.62, [(0, .10), (.70, .10), (.91, .165), (.905, .315), (.912, .46), (.958, .625), (.972, .755), (.92, .825), (.865, .84), (.62, 1.055), (.52, 1.10), (0, 1.12)]),
    (-0.90, [(0, .10), (.70, .10), (.915, .16), (.925, .345), (.950, .47), (.995, .63), (.985, .77), (.945, .865), (.88, .865), (.74, .985), (.50, 1.08), (0, 1.095)]),
    (-1.25, [(0, .10), (.70, .10), (.92, .16), (.97, .40), (1.015, .47), (1.035, .63), (1.0, .80), (.965, .89), (.935, .90), (.925, .908), (.42, 1.035), (0, 1.045)]),
    (-1.62, [(0, .11), (.70, .11), (.86, .16), (.92, .40), (.99, .50), (1.02, .64), (.99, .81), (.955, .90), (.78, .915), (.60, .93), (.36, .96), (0, .965)]),
    (-1.95, [(0, .15), (.62, .15), (.72, .19), (.76, .31), (.80, .46), (.93, .66), (.955, .80), (.945, .905), (.78, .895), (.60, .905), (.36, .91), (0, .91)]),
    (-2.08, [(0, .18), (.60, .18), (.68, .22), (.72, .32), (.75, .46), (.90, .70), (.94, .79), (.935, .905), (.78, .895), (.60, .90), (.36, .905), (0, .905)]),
]
NP = 12
DOOR_ST = (4, 7)       # door spans station 4 (z 0.92) .. station 7 (z -0.62)
DOOR_SEG = (3, 8)      # profile segments 3..8 (sill .. side glass)


def seg_material(i: int, j: int) -> str:
    """Material key for the loft quad between station i..i+1 and profile points j..j+1."""
    if j <= 2:
        return "D"
    if i >= 9 and j in (3, 4):           # dark lower rear quarter behind the wheel
        return "D"
    if 4 <= i <= 8:                      # greenhouse
        if j == 8:
            return "G"
        if j == 10:
            return "G"
    if i == 9 and j == 10:
        return "G"
    if i == 8 and j == 6:                # dark haunch vent behind the side glass
        return "T"
    if i == 10 and j >= 8:               # deck recess under the stowed wing
        return "T"
    return "W"


def station_point(i: int, j: int, side: int) -> Vector:
    z, pts = ST[i]
    p = pts[j]
    dz = p[2] if len(p) > 2 else 0.0
    return Vector((side * p[0], p[1] + GY, z + dz))


MAT_ORDER = ["W", "D", "G", "T", "Well", "IntD", "Int", "LEDF", "P"]

# Longitudinal refinement: every loft interval is split into SUB sub-stations along a cardinal spline
# through the stations. CORNER stations keep a tangent break (real transverse creases: nose, windshield
# base and header, deck edges), everything in between flows smoothly like stamped panels.
SUB = 2
LEVELS = 2
CORNER = {0, 1, 4, 5, 10, 11, 12}
REF: list[tuple[int, float]] = []


def make_ref(sub: int):
    REF.clear()
    for i in range(len(ST) - 1):
        k = 1 if i in (0, len(ST) - 2) else sub
        for s_ in range(k):
            REF.append((i, s_ / k))
    REF.append((len(ST) - 1, 0.0))


def _tangent(i: int, j: int, side: int, at_end: bool, seg_i: int) -> Vector:
    n = len(ST)
    if i in CORNER or i == 0 or i == n - 1:
        return station_point(seg_i + 1, j, side) - station_point(seg_i, j, side)
    return (station_point(i + 1, j, side) - station_point(i - 1, j, side)) * 0.5


def rpoint(r: int, j: int, side: int) -> Vector:
    i, t = REF[r]
    p0 = station_point(i, j, side)
    if t == 0.0:
        return p0
    p1 = station_point(i + 1, j, side)
    m0 = _tangent(i, j, side, False, i) * 0.8
    m1 = _tangent(i + 1, j, side, True, i) * 0.8
    t2, t3 = t * t, t * t * t
    return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1


def build_body_bm(exclude_door=True, caps=True):
    """Lofted hull (subdivision cage). Returns (bmesh, door_quads, material index map).
    Vertex int layers 'pj' (profile point) and 'rr' (refined station) drive the crease rules."""
    bm = bmesh.new()
    lpj = bm.verts.layers.int.new("pj")
    lrr = bm.verts.layers.int.new("rr")
    ring_ids = []  # per refined station: list of BMVerts around the ring (len 2*NP-2)
    for r in range(len(REF)):
        left = [bm.verts.new(B(*rpoint(r, j, 1))) for j in range(NP)]
        right = [bm.verts.new(B(*rpoint(r, j, -1))) for j in range(1, NP - 1)]
        for j, v in enumerate(left):
            v[lpj], v[lrr] = j, r
        for j, v in zip(range(1, NP - 1), right):
            v[lpj], v[lrr] = j, r
        ring = left + list(reversed(right))  # 0..11 left, then 10R..1R
        ring_ids.append(ring)
    n = len(ring_ids[0])

    def pidx(k):  # ring position -> (profile point index, side)
        return (k, 1) if k < NP else (2 * NP - 2 - k, -1)

    door_quads = {1: [], -1: []}
    mi = {k: idx for idx, k in enumerate(MAT_ORDER)}
    for r in range(len(REF) - 1):
        i = REF[r][0]
        a, b = ring_ids[r], ring_ids[r + 1]
        for k in range(n):
            k2 = (k + 1) % n
            j = min(pidx(k)[0], pidx(k2)[0])
            side = pidx(k)[1] if pidx(k)[0] != 0 and pidx(k)[0] != NP - 1 else pidx(k2)[1]
            in_door = DOOR_ST[0] <= i < DOOR_ST[1] and DOOR_SEG[0] <= j <= DOOR_SEG[1]
            if in_door and exclude_door:
                door_quads[side].append((r, j))
                continue
            f = bm.faces.new((a[k], a[k2], b[k2], b[k]))
            f.material_index = mi[seg_material(i, j)]
    # caps
    if caps:
        fcap = bm.faces.new(list(reversed(ring_ids[0])))
        rcap = bm.faces.new(ring_ids[-1])
        fcap.material_index = mi["W"]
        rcap.material_index = mi["W"]
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    else:
        # orient the open tube outward: first face of the left side must point to +x
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        probe = max(bm.faces, key=lambda f: f.calc_center_median().x)
        if probe.normal.x < 0:
            bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    return bm, door_quads, mi


# crease weight of longitudinal cage edges per profile point (design lines); material borders are always 1
J_CREASE = {1: 1.0, 2: 1.0, 3: 1.0, 4: 0.0, 5: 0.55, 6: 0.85, 7: 1.0, 8: 1.0, 9: 1.0, 10: 1.0}
CORNER_RING_CREASE = 1.0


def subdivide_cage(bm, levels: int, name="cage"):
    """Edge creases from the design rules, then Catmull-Clark (OpenSubdiv) -> new bmesh."""
    lpj = bm.verts.layers.int.get("pj")
    lrr = bm.verts.layers.int.get("rr")
    lc = bm.edges.layers.float.get("crease_edge") or bm.edges.layers.float.new("crease_edge")
    corner_r = {r for r, (i, t) in enumerate(REF) if t == 0.0 and i in CORNER}
    for e in bm.edges:
        c = 0.0
        if len(e.link_faces) == 2 and e.link_faces[0].material_index != e.link_faces[1].material_index:
            c = 1.0
        if lpj is not None:
            a, b = e.verts
            if a[lpj] == b[lpj] and a[lrr] != b[lrr]:
                c = max(c, J_CREASE.get(a[lpj], 0.0))
            elif a[lrr] == b[lrr] and a[lrr] in corner_r:
                c = max(c, CORNER_RING_CREASE)
        e[lc] = c
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    md = ob.modifiers.new("Sub", "SUBSURF")
    md.levels = md.render_levels = levels
    md.use_creases = True
    md.boundary_smooth = "PRESERVE_CORNERS"
    md.use_limit_surface = True
    md.quality = 3
    C.apply_modifiers(ob)
    out = bmesh.new()
    out.from_mesh(ob.data)
    old = ob.data
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(old)
    return out


def fill_end_caps(bm, mi):
    """Close the subdivided tube at nose and tail (door openings stay open)."""
    zs = [-v.co.y for v in bm.verts]
    zmax, zmin = max(zs), min(zs)
    for front in (True, False):
        edges = [e for e in bm.edges if e.is_boundary and all(
            ((-v.co.y) > zmax - 0.12) if front else ((-v.co.y) < zmin + 0.12) for v in e.verts)]
        res = bmesh.ops.edgeloop_fill(bm, edges=edges)
        for f in res["faces"]:
            f.material_index = mi["W"]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])


def cap_regions(bm, mi, front: bool):
    """Bisect the nose/tail cap into regions, assign materials and recess some of them."""
    zc = ST[0][0] if front else ST[-1][0]

    def cap_faces():
        out = []
        for f in bm.faces:
            c = f.calc_center_median()
            cz = -c.y
            nz = -f.normal.y
            if (front and cz > 2.19 and nz > 0.9) or (not front and cz < -2.06 and nz < -0.9):
                out.append(f)
        return out

    bmesh.ops.triangulate(bm, faces=cap_faces(), quad_method="BEAUTY", ngon_method="BEAUTY")
    if front:
        planes_y, planes_x = [0.445, 0.33, 0.20], [0.58]
    else:
        planes_y, planes_x = [0.905, 0.845, 0.79, 0.56], [0.66]
    for yg in planes_y:
        fs = cap_faces()
        geom = list({v for f in fs for v in f.verts}) + list({e for f in fs for e in f.edges}) + fs
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=B(0, yg + GY, zc), plane_no=Vector((0, 0, 1)))
    for xs in planes_x:
        for sgn in (1, -1):
            fs = cap_faces()
            geom = list({v for f in fs for v in f.verts}) + list({e for f in fs for e in f.edges}) + fs
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=B(sgn * xs, 0, zc), plane_no=Vector((1, 0, 0)))

    recess = {}  # region -> (faces, depth)
    for f in cap_faces():
        c = f.calc_center_median()
        x, yg = abs(c.x), c.z - GY
        if front:
            if x < 0.58:
                if yg > 0.445:
                    key, mat, depth = "led", "T", 0.012
                elif yg > 0.33:
                    key, mat, depth = "mask", "T", 0.012
                elif yg > 0.20:
                    key, mat, depth = "intake", "P", 0.08
                else:
                    key, mat, depth = "lip", "D", 0.0
            else:
                key, mat, depth = ("fender", "W", 0.0) if yg > 0.20 else ("flow", "D", 0.0)
        else:
            if yg > 0.905:
                key, mat, depth = "top", "W", 0.0
            elif yg > 0.845:
                key, mat, depth = "slot", "T", 0.03
            elif yg > 0.79:
                key, mat, depth = "bar", "W", 0.0
            elif yg > 0.56:
                key, mat, depth = ("plate", "D", 0.035) if x < 0.66 else ("corner", "D", 0.0)
            else:
                key, mat, depth = ("diffuser", "D", 0.13) if x < 0.66 else ("corner", "D", 0.0)
        f.material_index = mi[mat]
        recess.setdefault(key, ([], depth))[0].append(f)
    for key, (fs, depth) in recess.items():
        if depth <= 0:
            continue
        r = bmesh.ops.inset_region(bm, faces=fs, thickness=0.004, depth=0.0)
        fs = [f for f in fs if f.is_valid]
        geom = fs + list({e for f in fs for e in f.edges}) + list({v for f in fs for v in f.verts})
        ex = bmesh.ops.extrude_face_region(bm, geom=geom)
        bmesh.ops.delete(bm, geom=[f for f in fs if f.is_valid], context="FACES")
        verts = [e for e in ex["geom"] if isinstance(e, bmesh.types.BMVert)]
        # move inward along car -z (front) / +z (rear) -> Blender +y / -y
        bmesh.ops.translate(bm, verts=verts, vec=Vector((0, depth if front else -depth, 0)))
        new_faces = [e for e in ex["geom"] if isinstance(e, bmesh.types.BMFace)]
        moved = set(verts)
        for f in new_faces:
            if not all(v in moved for v in f.verts):  # side walls of the recess
                f.material_index = mi["T"] if key != "plate" else mi["D"]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])


def make_cutters(M):
    """Wheel-arch cutters (cylinders along X) as one object."""
    verts, faces = [], []
    for wid, w in WHEELS.items():
        x, y, z = w["pos"]
        r = w["r"] + 0.038
        sgn = 1 if x > 0 else -1
        x0, x1 = x - sgn * 0.23, x + sgn * 0.5
        seg = 64
        base = len(verts)
        for i in range(seg):
            a = 2 * math.pi * i / seg
            for xx in (x0, x1):
                verts.append(B(xx, y + r * math.sin(a), z + r * math.cos(a)))
        for i in range(seg):
            i2 = (i + 1) % seg
            faces.append((base + 2 * i, base + 2 * i2, base + 2 * i2 + 1, base + 2 * i + 1))
        faces.append(tuple(base + 2 * i for i in range(seg)))
        faces.append(tuple(base + 2 * i + 1 for i in reversed(range(seg))))
    nfw = len(faces)
    # triangular headlight pockets under the fender shoulders (prisms along z)
    for sgn in (1, -1):
        tri = [(sgn * 0.600, 0.560), (sgn * 0.795, 0.592), (sgn * 0.686, 0.452)]
        base = len(verts)
        for z in (2.19, 2.45):
            for (x, yg) in tri:
                verts.append(B(x, yg + GY, z))
        fl = [(0, 1, 2), (5, 4, 3), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)]
        faces += [tuple(base + i for i in f) for f in fl]
    ob = C.mesh_object("ArchCutter", verts, faces, [M[k] for k in MAT_ORDER],
                       [MAT_ORDER.index("Well")] * nfw + [MAT_ORDER.index("T")] * (len(faces) - nfw))
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me); bm.free()
    for k, p in enumerate(me.polygons):
        p.material_index = MAT_ORDER.index("Well") if k < nfw else MAT_ORDER.index("T")
    ob.hide_render = True
    ob.hide_set(True)
    return ob


def shrink_boundary(bm, dist=0.0025):
    """Pull open boundary edges (door cut lines) back along the surface -> visible panel gaps."""
    move = {}
    lrr = bm.verts.layers.int.get("rr")
    last = len(REF) - 1
    for e in bm.edges:
        if not e.is_boundary or not e.link_faces:
            continue
        if lrr is not None and all(v[lrr] in (0, last) for v in e.verts):
            continue
        f = e.link_faces[0]
        mid = (e.verts[0].co + e.verts[1].co) / 2
        d = f.calc_center_median() - mid
        n = f.normal
        d = d - n * d.dot(n)
        if d.length < 1e-9:
            continue
        d.normalize()
        for v in e.verts:
            move.setdefault(v, Vector()).__iadd__(d)
    for v, d in move.items():
        if d.length > 1e-9:
            v.co += d.normalized() * dist


def cleanup(ob, dist=0.0005):
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=dist)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=dist)
    bm.to_mesh(ob.data); bm.free()


def finish_shell(ob, M, lod, thickness=0.018, cutter=None, inner_map=None):
    """Solidify -> optional boolean -> bevel -> weighted normals. Material slots tripled for inner/rim."""
    me = ob.data
    base = [s.material for s in ob.material_slots]
    nb = len(base)
    inner_map = inner_map or {}
    for m in base:  # inner shell
        me.materials.append(inner_map.get(m.name, M["IntD"]))
    for _ in base:  # rim (openings)
        me.materials.append(M["T"])
    sd = ob.modifiers.new("Solid", "SOLIDIFY")
    sd.thickness = thickness
    sd.offset = -1.0
    sd.use_even_offset = False
    sd.use_quality_normals = True
    sd.material_offset = nb
    sd.material_offset_rim = 2 * nb
    C.apply_modifiers(ob)
    # single-surface glass: drop the inner glass shell
    gi = [i for i, m in enumerate(base) if m.name == "Glass_Tint"]
    if gi:
        bm = bmesh.new(); bm.from_mesh(ob.data)
        kill = [f for f in bm.faces if f.material_index in [g + nb for g in gi]]
        bmesh.ops.delete(bm, geom=kill, context="FACES")
        bm.to_mesh(ob.data); bm.free()
    if cutter is not None:
        bo = ob.modifiers.new("Arches", "BOOLEAN")
        bo.operation = "DIFFERENCE"
        bo.solver = "EXACT"
        bo.object = cutter
        bo.material_mode = "INDEX"
        C.apply_modifiers(ob)
    cleanup(ob)
    C.shade_by_angle(ob, 32)
    C.bevel(ob, width=0.004, segments=3 if lod == 0 else 1, angle_deg=28)
    C.weighted_normals(ob)


# ---------------------------------------------------------------- doors
def build_doors(door_quads, M, parent, lod):
    doors = {}
    for side, quads in door_quads.items():
        name = "Door_L" if side > 0 else "Door_R"
        # hinge line: along the roof rail (point 9) between door stations; pivot at its midpoint
        pa = station_point(DOOR_ST[0], 9, side)
        pb = station_point(DOOR_ST[1], 9, side)
        pivot = (pa + pb) / 2
        pivot = Vector((side * 0.60, 0.62, 0.15))
        bm = bmesh.new()
        lpj = bm.verts.layers.int.new("pj")
        lrr = bm.verts.layers.int.new("rr")
        vmap = {}

        def V(i, j):
            if (i, j) not in vmap:
                p = rpoint(i, j, side) - pivot
                v = bm.verts.new(B(*p))
                v[lpj], v[lrr] = j, i
                vmap[(i, j)] = v
            return vmap[(i, j)]

        mats = ["W", "G", "D"]
        for (i, j) in quads:
            f = bm.faces.new((V(i, j), V(i, j + 1), V(i + 1, j + 1), V(i + 1, j)))
            mk = seg_material(REF[i][0], j)
            f.material_index = mats.index(mk) if mk in mats else 0
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        shrink_boundary(bm, 0.0025)
        # make normals point outward (+side x)
        if sum(f.normal.x for f in bm.faces) * side < 0:
            bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
        bm = subdivide_cage(bm, LEVELS if lod == 0 else 1, name)
        ob = C.bm_to_object(name, bm, [M[k] for k in mats], parent=parent, loc=B(*pivot))
        finish_shell(ob, M, lod, thickness=0.022, inner_map={"Paint_AnoWhite": M["IntD"], "Carbon": M["IntD"]})
        doors[side] = ob
    return doors


# ---------------------------------------------------------------- wheels
def tire_profile(R, w, Rr):
    h = w / 2
    pts = [(Rr - 0.004, -(h - 0.018)), (Rr + 0.012, -(h - 0.004)), (Rr + 0.03, -(h - 0.001)),
           (Rr + 0.45 * (R - Rr), -h), (R - 0.028, -(h - 0.004)), (R - 0.012, -(h - 0.013)),
           (R - 0.003, -(h - 0.03)), (R, -(h - 0.046))]
    grooves = [-0.55 * h, -0.18 * h, 0.18 * h, 0.55 * h]
    for g in grooves:
        pts += [(R, g - 0.007), (R - 0.008, g - 0.005), (R - 0.008, g + 0.005), (R, g + 0.007)]
    pts += [(R, h - 0.046), (R - 0.003, h - 0.03), (R - 0.012, h - 0.013), (R - 0.028, h - 0.004),
            (Rr + 0.45 * (R - Rr), h), (Rr + 0.03, h - 0.001), (Rr + 0.012, h - 0.004), (Rr - 0.004, h - 0.018)]
    return pts


def build_wheel(wid, M, parent, lod):
    w = WHEELS[wid]
    R, W = w["r"], w["w"]
    h = W / 2
    Rr = R - 0.072  # ~21-22" rim
    side = 1 if w["pos"][0] > 0 else -1
    seg = 120 if lod == 0 else 40
    allv, allf, fm, auv = [], [], [], []
    mats = [M["Tire"], M["Rim"], M["RimDark"], M["Disc"], M["Well"], M["Machined"]]

    def add(verts, faces, mi, uvs=None):
        base = len(allv)
        allv.extend(verts)
        auv.extend(uvs if uvs is not None else [(0.0, 0.0)] * len(verts))
        allf.extend(tuple(base + i for i in f) for f in faces)
        fm.extend([mi] * len(faces))

    # tire (profile x is axial, + = outboard for the left wheel; mirrored below for the right)
    v, f, uv = C.lathe(tire_profile(R, W, Rr), seg, closed=False, uv=40)
    add(v, f, 0, uv)
    # rim barrel (inner), flange lip and white aero disc face
    xo = h - 0.022  # outer face plane
    barrel = [(Rr - 0.006, -(h - 0.02)), (Rr - 0.02, -(h - 0.03)), (Rr - 0.02, xo - 0.03), (Rr + 0.006, xo - 0.006),
              (Rr + 0.012, xo + 0.002), (Rr - 0.004, xo + 0.006)]
    v, f = C.lathe(barrel, seg)
    add(v, f, 2)
    lip = [(Rr - 0.004, xo + 0.006), (Rr - 0.012, xo + 0.007), (Rr - 0.02, xo + 0.005)]
    v, f = C.lathe(lip, seg)
    add(v, f, 5)
    disc = [(Rr - 0.02, xo + 0.005), (Rr - 0.04, xo + 0.003), (0.62 * Rr, xo - 0.006), (0.30 * Rr, xo - 0.03),
            (0.17 * Rr, xo - 0.035)]
    # dark inner face behind the aero petals (seen through the gaps along the spokes)
    v, f = C.lathe([(Rr - 0.02, xo - 0.03), (0.17 * Rr, xo - 0.06)], seg)
    add(v, f, 2)
    # six white aero petals between the spokes, separated by deep dark gaps
    nsp_ = 6
    gap = 0.15
    pseg = max(4, seg // nsp_ - 2)
    for k in range(nsp_):
        a0 = 2 * math.pi * k / nsp_ + gap + 0.05
        a1 = 2 * math.pi * (k + 1) / nsp_ - gap + 0.05
        v, f = C.lathe(disc, pseg, a0=a0, a1=a1)
        m = len(disc)
        # close the petal edges down to the inner face so they read as thick panels
        ev = []
        for col, sgn in ((0, 1), (pseg, -1)):
            b = len(v)
            for j in range(m):
                x, y, z = v[col * m + j]
                ev.append((x - 0.028, y, z))
            v += ev[-m:]
            for j in range(m - 1):
                q = (col * m + j, col * m + j + 1, b + j + 1, b + j)
                f.append(q if sgn > 0 else q[::-1])
        add(v, f, 1)
    hub = [(0.17 * Rr, xo - 0.035), (0.15 * Rr, xo - 0.02), (0.11 * Rr, xo - 0.013), (0.0, xo - 0.011)]
    v, f = C.lathe(hub, 24 if lod else 48)
    add(v, f, 2)
    # five lug nuts around the centre cap
    if lod == 0:
        for k in range(5):
            a = 2 * math.pi * k / 5 + 0.3
            cy, cz = 0.125 * Rr * math.cos(a), 0.125 * Rr * math.sin(a)
            v, f = C.lathe([(0.0, xo - 0.006), (0.009, xo - 0.006), (0.011, xo - 0.014), (0.011, xo - 0.03)], 6)
            add([(x, y + cy, z + cz) for (x, y, z) in v], f, 5)
    # 6 double spokes: dark blades with bright machined chamfers, slight turbine twist
    nsp = 6
    steps = 8 if lod == 0 else 3
    for k in range(nsp):
        a = 2 * math.pi * k / nsp
        L0, L1 = 0.16 * Rr, Rr - 0.03
        for sub in (-1, 1):  # double spoke: two blades with a slit between them
            sv = []
            for s_ in range(steps + 1):
                t = s_ / steps
                r = L0 + (L1 - L0) * t
                hw = 0.048 * (1 - t) ** 0.7 + 0.006 + 0.012 * math.sin(math.pi * t) * (1 - t)
                c, bw = sub * hw * 0.52, hw * 0.44
                xd = xo - 0.035 + (0.029 * min(1, (r - 0.17 * Rr) / (0.45 * Rr))) + 0.01 * max(0, (r - 0.62 * Rr) / (0.38 * Rr))
                top = xd + 0.018 * (1 - 0.6 * t)
                twist = 0.10 * t
                for (dw, xx) in ((c - bw, xd - 0.004), (c - bw * 0.55, top), (c + bw * 0.55, top), (c + bw, xd - 0.004)):
                    ang = a + dw / r + twist
                    sv.append((xx, r * math.cos(ang), r * math.sin(ang)))
            top_f, side_f = [], []
            for s_ in range(steps):
                for q in range(3):
                    face = (s_ * 4 + q, s_ * 4 + q + 1, (s_ + 1) * 4 + q + 1, (s_ + 1) * 4 + q)
                    (top_f if q == 1 else side_f).append(face)
            caps = [(0, 3, 2, 1), (steps * 4, steps * 4 + 1, steps * 4 + 2, steps * 4 + 3)]
            base = len(allv)
            add(sv, top_f + caps, 2)
            allf.extend(tuple(base + i for i in face) for face in side_f)
            fm.extend([5] * len(side_f))
            auv.extend([])
    # ventilated, cross-drilled brake disc (rotates with the wheel), inboard of the spokes
    dr = Rr - 0.055
    xd0 = h - 0.13
    th = 0.034
    dseg = 72 if lod == 0 else 32
    for xx, flip in ((xd0 + th / 2, 1), (xd0 - th / 2, -1)):
        v, f = C.lathe([(dr, xx), (0.105, xx)] if flip > 0 else [(0.105, xx), (dr, xx)], dseg)
        uvs = [(y / (2 * dr) + 0.5, z / (2 * dr) + 0.5) for (_, y, z) in v]
        add(v, f, 3, uvs)
    v, f = C.lathe([(dr, xd0 - th / 2), (dr, xd0 + th / 2)], dseg)  # outer edge (vent slots via texture)
    add(v, f, 3)
    hat = [(0.105, xd0 + th / 2), (0.10, xd0 + th / 2 + 0.035), (0.075, xd0 + th / 2 + 0.04), (0.0, xd0 + th / 2 + 0.04)]
    v, f = C.lathe(hat, 36)
    add(v, f, 2)
    if side < 0:
        allv = [(-x, y, z) for (x, y, z) in allv]
        allf = [tuple(reversed(face)) for face in allf]
    ob = C.mesh_object(f"Wheel_{wid}", C.to_blender(allv), allf, mats, fm, parent=parent, loc=B(*w["pos"]), uvs=auv)
    C.shade_by_angle(ob, 40)
    # caliper: separate node at the wheel centre (does not spin); 6-piston monoblock straddling the disc
    ca0, ca1 = math.radians(100), math.radians(152)  # top-rear of the disc
    cs = 10 if lod == 0 else 5
    outer = [(dr - 0.062, xd0 + th / 2 + 0.004), (dr + 0.016, xd0 + th / 2 + 0.004), (dr + 0.022, xd0 + 0.006),
             (dr + 0.022, xd0 - 0.006), (dr + 0.016, xd0 - th / 2 - 0.004), (dr - 0.062, xd0 - th / 2 - 0.004)]
    # C-shaped section wrapping the disc edge: outboard piston housing thicker
    sect = [(dr - 0.062, xd0 + th / 2 + 0.002), (dr - 0.066, xd0 + th / 2 + 0.03), (dr + 0.012, xd0 + th / 2 + 0.032),
            (dr + 0.024, xd0 + th / 2 + 0.01), (dr + 0.024, xd0 - th / 2 - 0.01), (dr + 0.012, xd0 - th / 2 - 0.026),
            (dr - 0.066, xd0 - th / 2 - 0.024), (dr - 0.062, xd0 - th / 2 - 0.002)]
    v, f = C.lathe(sect, cs, a0=ca0, a1=ca1)
    m = len(sect)
    f.append(tuple(range(m))[::-1])
    f.append(tuple(range(cs * m, (cs + 1) * m)))
    v = [(x, y, -z) for (x, y, z) in v]
    f = [tuple(reversed(face)) for face in f]
    if side < 0:
        v = [(-x, y, z) for (x, y, z) in v]
        f = [tuple(reversed(face)) for face in f]
    cal = C.mesh_object(f"Caliper_{wid}", C.to_blender(v), f, [M["Caliper"]], parent=parent, loc=B(*w["pos"]))
    bm = bmesh.new(); bm.from_mesh(cal.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(cal.data); bm.free()
    C.shade_by_angle(cal, 35)
    if lod == 0:
        C.bevel(cal, 0.004, 3, 30, harden=True)
    return ob, cal


# ---------------------------------------------------------------- wheel wells (liners) in the body
def build_wells(M):
    verts, faces = [], []
    for wid, w in WHEELS.items():
        x, y, z = w["pos"]
        r = w["r"] + 0.035
        sgn = 1 if x > 0 else -1
        xin, xout = x - sgn * 0.22, x + sgn * 0.13
        seg = 40
        a0, a1 = math.radians(-35), math.radians(215)
        base = len(verts)
        for i in range(seg + 1):
            a = a0 + (a1 - a0) * i / seg
            for xx in (xin, xout):
                verts.append(B(xx, y + r * math.sin(a), z + r * math.cos(a)))
        for i in range(seg):
            q = (base + 2 * i, base + 2 * i + 1, base + 2 * i + 3, base + 2 * i + 2)
            faces.append(q if sgn > 0 else tuple(reversed(q)))
        # inner wall
        c = len(verts)
        verts.append(B(xin, y, z))
        for i in range(seg):
            q = (c, base + 2 * (i + 1), base + 2 * i)
            faces.append(q if sgn > 0 else tuple(reversed(q)))
    return verts, faces


# ---------------------------------------------------------------- lights & small parts
def ray_z(bvh, x, y, z_from, direction):
    hit = bvh.ray_cast(B(x, y, z_from), B(0, 0, direction).normalized())
    return None if hit[0] is None else -hit[0].y


def build_lights(M, parent, body_bvh):
    objs = []
    # front LED bar: thin strip across the nose at the hood/grille seam
    zf = ST[0][0]
    v, f = [], []
    x0, x1 = 0.575, 0.0
    yb, yt = 0.452 + GY, 0.459 + GY
    v = [(-0.575, yb, zf - 0.006), (0.575, yb, zf - 0.006), (0.575, yt, zf - 0.006), (-0.575, yt, zf - 0.006),
         (-0.575, yb, zf - 0.03), (0.575, yb, zf - 0.03), (0.575, yt, zf - 0.03), (-0.575, yt, zf - 0.03)]
    f = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (3, 2, 6, 7)]
    fm = [0] * len(f)
    # headlight units recessed in the pockets: pocket walls + back plate (black), chrome reflector,
    # emissive LED triangle. The pocket is cut through the shell by the arch/pocket boolean.
    for s in (1, -1):
        tri = [Vector((s * 0.600, 0.560 + GY, 0)), Vector((s * 0.795, 0.592 + GY, 0)), Vector((s * 0.686, 0.452 + GY, 0))]
        cen = (tri[0] + tri[1] + tri[2]) / 3
        zb, zf_ = 2.200, 2.262
        base = len(v)
        for z in (zb, zf_):
            for p in tri:
                q = cen + (p - cen) * 0.995
                v.append((q.x, q.y, z))
        walls = [(0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)]
        back = [(0, 1, 2)]
        if s < 0:
            walls = [w[::-1] for w in walls]
            back = [b[::-1] for b in back]
        for w in walls:
            f.append(tuple(base + i for i in w[::-1])); fm.append(1)
        for b in back:
            f.append(tuple(base + i for i in b)); fm.append(1)
        for scale, dz, mat in ((0.90, 0.002, 2), (0.66, 0.004, 0)):
            base = len(v)
            for p in tri:
                q = cen + (p - cen) * scale
                v.append((q.x, q.y, zb + dz))
            f.append((base, base + 1, base + 2) if s > 0 else (base, base + 2, base + 1))
            fm.append(mat)
    fm = fm[:len(f)]
    head = C.mesh_object("Light_Head", C.to_blender(v), f, [M["LEDF"], M["T"], M["Chrome"]], fm, parent=parent)
    objs.append(head)
    # tail band inside the rear slot, tapering at the ends
    zr = ST[-1][0] + 0.02
    yc = 0.875 + GY
    pts = []
    n = 24
    for i in range(n + 1):
        x = -0.93 + 1.86 * i / n
        t = abs(x) / 0.93
        hh = 0.009 * (1 - max(0, t - 0.85) / 0.15 * 0.8)
        pts.append((x, hh))
    v, f = [], []
    for (x, hh) in pts:
        v += [(x, yc - hh, zr), (x, yc + hh, zr)]
    for i in range(n):
        f.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1)[::-1])
    for sgn in (1, -1):  # band ends wrap round the rear corners onto the haunch side
        b = len(v)
        x = sgn * 0.9475
        v += [(x, yc - 0.004, zr - 0.012), (x, yc + 0.004, zr - 0.012), (x * 0.999, yc - 0.002, zr + 0.09),
              (x * 0.999, yc + 0.002, zr + 0.09)]
        q = (b, b + 2, b + 3, b + 1)
        f.append(q if sgn > 0 else q[::-1])
    tail = C.mesh_object("Light_Tail", C.to_blender(v), f, [M["LEDT"]], parent=parent)
    objs.append(tail)
    # brake light: thin upper strip inside the slot (separate node so the renderer can drive it)
    v, f = [], []
    yb2 = 0.893 + GY
    for (x, hh) in pts[2:-2]:
        v += [(x * 0.97, yb2 - 0.0035, zr + 0.001), (x * 0.97, yb2 + 0.0035, zr + 0.001)]
    for i in range(len(pts) - 5):
        f.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1)[::-1])
    brake = C.mesh_object("Light_Brake", C.to_blender(v), f, [M["LEDB"]], parent=parent)
    objs.append(brake)
    # rear side markers (small red wedges low on the rear corners)
    v, f = [], []
    for s in (1, -1):
        base = len(v)
        x = s * 0.955
        v += [(x, 0.50 + GY, -1.80), (x, 0.515 + GY, -1.80), (x * 0.99, 0.52 + GY, -1.98), (x * 0.99, 0.505 + GY, -1.98)]
        f.append((base, base + 1, base + 2, base + 3) if s > 0 else (base + 3, base + 2, base + 1, base))
    for s in (1, -1):
        base = len(v)
        x0, x1 = s * 0.80, s * 0.915
        zf2 = 2.253
        v += [(x0, 0.215 + GY, zf2), (x1, 0.222 + GY, zf2 - 0.01), (x1, 0.242 + GY, zf2 - 0.01), (x0, 0.235 + GY, zf2)]
        f.append((base, base + 1, base + 2, base + 3) if s > 0 else (base + 3, base + 2, base + 1, base))
    mk = C.mesh_object("Light_Marker", C.to_blender(v), f, [M["LEDM"]], parent=parent)
    objs.append(mk)
    return objs


def build_rear_details(M, parent, lod):
    """Diffuser fins, 4 brass main nozzles, 4 suction fans visible in the diffuser, lower splitter."""
    allv, allf, fm = [], [], []
    mats = [M["D"], M["Brass"], M["Chrome"], M["T"], M["W"]]

    def add(verts, faces, mi):
        base = len(allv)
        allv.extend(verts)
        allf.extend(tuple(base + i for i in face) for face in faces)
        fm.extend([mi] * len(faces))

    seg = 40 if lod == 0 else 20
    # brass nozzles: (r, axial) profile along car z; lathe revolves around X so build then rotate
    for (pos, _) in NOZZLES[:4]:
        # outer shell -> rolled lip -> divergent bell -> throat (exit plane at the node position)
        prof = [(0.056, -0.13), (0.056, -0.014), (0.054, -0.003), (0.050, 0.0), (0.046, -0.002),
                (0.041, -0.02), (0.032, -0.06), (0.024, -0.095), (0.021, -0.11), (0.021, -0.13)]
        v, f = C.lathe(prof, seg)
        # lathe axis = x; map (ax, a, b) -> (pos.x + a, pos.y + b, pos.z + ax) with exit at +ax... exit faces -z
        v = [(pos[0] + a, pos[1] + b, pos[2] - ax) for (ax, a, b) in v]
        add(v, f, 1)
        # dark throat
        v, f = C.lathe([(0.0, -0.125), (0.021, -0.125)], seg)
        v = [(pos[0] + a, pos[1] + b, pos[2] - ax) for (ax, a, b) in v]
        add(v, f, 3)
    # haunch vents: five angled louvres over the dark recess behind the side glass (loft quad i=8, j=6)
    for sgn in (1, -1):
        p00, p01 = station_point(8, 6, sgn), station_point(8, 7, sgn)
        p10, p11 = station_point(9, 6, sgn), station_point(9, 7, sgn)
        nrm = (p10 - p00).cross(p01 - p00).normalized() * (1 if sgn > 0 else -1)
        if nrm.x * sgn < 0:
            nrm = -nrm
        nl = 5
        for k in range(1, nl + 1):
            t = k / (nl + 1)
            a = p00.lerp(p01, t); b = p10.lerp(p11, t)
            a = a.lerp(b, 0.06); b = b.lerp(a, 0.06)
            up = (p01 - p00).normalized() * 0.012
            out = nrm * 0.004
            quad = [a - up * 0.2 + out, b - up * 0.2 + out, b + up + out * 3.5, a + up + out * 3.5]
            back = [q - nrm * 0.006 for q in quad]
            vv = [tuple(q) for q in quad + back]
            ff = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
            if sgn < 0:
                ff = [q[::-1] for q in ff]
            add(vv, ff, 3)
    # white rear bumper blade below the tail-light slot, protruding, chamfered ends
    plan = [(-0.945, -2.07), (-0.86, -2.112), (0.86, -2.112), (0.945, -2.07)]
    yb0, yb1 = 0.792 + GY, 0.842 + GY
    v = [(x, yb0, z) for x, z in plan] + [(x, yb1, z + (0.008 if abs(x) < 0.9 else 0)) for x, z in plan]
    v += [(-0.945, yb0, -2.06), (0.945, yb0, -2.06), (0.945, yb1, -2.06), (-0.945, yb1, -2.06)]
    f = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (4, 5, 6, 7, 10, 11), (3, 2, 1, 0, 8, 9)]
    f = [(0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (4, 11, 10, 7, 6, 5), (0, 1, 2, 3, 9, 8), (3, 7, 10, 9), (0, 8, 11, 4)]
    add(v, f, 4)
    # white concave "smile" tub around the plate: straight top edge, curved lower edge, dished centre
    nu, nv = 24 if lod == 0 else 10, 6
    lv, lf = [], []
    for iu in range(nu + 1):
        u = -1 + 2 * iu / nu
        x = 0.63 * u
        ytop = 0.782
        ybot = 0.565 + 0.135 * abs(u) ** 1.6
        for iv in range(nv + 1):
            t = iv / nv
            y = ybot + (ytop - ybot) * t
            dish = 0.028 * (1 - u * u) * math.sin(math.pi * t) ** 0.8
            lv.append((x, y + GY, -2.072 + dish))
    for iu in range(nu):
        for iv in range(nv):
            a = iu * (nv + 1) + iv
            lf.append((a, a + nv + 1, a + nv + 2, a + 1))
    # thickness rim so the edge reads as a moulded part
    base_n = len(lv)
    lv += [(x, y, z + 0.03) for (x, y, z) in lv]
    edge = [iu * (nv + 1) for iu in range(nu + 1)] + [nu * (nv + 1) + iv for iv in range(1, nv + 1)] + \
           [iu * (nv + 1) + nv for iu in range(nu - 1, -1, -1)] + [iv for iv in range(nv - 1, 0, -1)]
    for a, b in zip(edge, edge[1:] + edge[:1]):
        lf.append((b, a, a + base_n, b + base_n))
    add(lv, [face[::-1] for face in lf], 4)
    # blank licence plate (no text), slightly proud of the tub
    pv, pf = box(0.0, 0.655 + GY, -2.058, 0.31, 0.155, 0.008)
    add(pv, pf, 4)
    # diffuser vertical fins
    for x in (-0.48, -0.24, 0.0, 0.24, 0.48):
        z0, z1 = -1.62, -2.085
        y0, y1 = 0.13 + GY, 0.50 + GY
        t = 0.008
        v = [(x - t, 0.10 + GY, z0), (x + t, 0.10 + GY, z0), (x + t, y0, z1), (x - t, y0, z1),
             (x - t, 0.11 + GY, z0), (x + t, 0.11 + GY, z0), (x + t, y1 - 0.12, z1), (x - t, y1 - 0.12, z1)]
        f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        add(v, f, 0)
    # 4 fans (hub + 7 blades) in the diffuser floor cavity, axis along z
    for x in (-0.36, -0.12, 0.12, 0.36):
        cy, cz = 0.42 + GY, -1.948
        v, f = C.lathe([(0.0, 0.0), (0.03, 0.0), (0.03, 0.02)], 16)
        v = [(x + a, cy + b, cz + ax) for (ax, a, b) in v]
        add(v, f, 2)
        for k in range(7):
            a = 2 * math.pi * k / 7
            r0, r1 = 0.03, 0.075
            pts = []
            for (r, da, dz) in ((r0, -0.25, 0.0), (r1, -0.15, 0.01), (r1, 0.25, 0.01), (r0, 0.2, 0.0)):
                pts.append((x + r * math.cos(a + da), cy + r * math.sin(a + da), cz + dz))
            add(pts, [(0, 1, 2, 3), (3, 2, 1, 0)], 2)
    ob = C.mesh_object("RearDetails", C.to_blender(allv), allf, mats, fm, parent=parent)
    C.shade_by_angle(ob, 40)
    if lod == 0:
        C.bevel(ob, 0.0018, 2, 35, harden=True)
    return ob


def build_front_details(M, parent, lod):
    """Front splitter blade, yaw-thruster ports, lift-nozzle rings in the floor."""
    allv, allf, fm = [], [], []
    mats = [M["D"], M["Brass"], M["T"]]

    def add(verts, faces, mi):
        base = len(allv)
        allv.extend(verts)
        allf.extend(tuple(base + i for i in face) for face in faces)
        fm.extend([mi] * len(faces))

    # splitter
    y0, y1 = 0.115 + GY, 0.14 + GY
    pts = [(-0.86, 2.18), (-0.70, 2.30), (0.70, 2.30), (0.86, 2.18), (0.86, 2.0), (-0.86, 2.0)]
    v = [(x, y0, z) for x, z in pts] + [(x, y1, z) for x, z in pts]
    n = len(pts)
    f = [tuple(range(n))[::-1] and tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    f = [tuple(range(n)), tuple(reversed(range(n, 2 * n)))]
    for i in range(n):
        i2 = (i + 1) % n
        f.append((i, n + i, n + i2, i2))
    add(v, f, 0)
    seg = 24 if lod == 0 else 12
    # yaw ports on the fender sides: brass ring + dark throat, axis along x
    for (pos, d) in NOZZLES[8:]:
        s = 1 if pos[0] > 0 else -1
        xs = s * 0.968
        prof = [(0.0, xs - s * 0.03), (0.022, xs - s * 0.03), (0.022, xs), (0.030, xs + s * 0.002)]
        v, f = C.lathe(prof, seg)
        v = [(ax, pos[1] + a, pos[2] + b) for (ax, a, b) in v]
        if s < 0:
            f = [tuple(reversed(x)) for x in f]
        add(v, f, 1)
    # lift nozzle rings flush with the floor
    for (pos, d) in NOZZLES[4:8]:
        prof = [(0.0, -0.03), (0.035, -0.03), (0.035, 0.0), (0.046, 0.002)]
        v, f = C.lathe(prof, seg)
        # axis -> y (down): (ax, a, b) -> (pos.x + a, floor - ax, pos.z + b)
        fy = 0.10 + GY - 0.003
        v = [(pos[0] + a, fy - ax, pos[2] + b) for (ax, a, b) in v]
        add(v, f, 1)
    ob = C.mesh_object("FrontDetails", C.to_blender(allv), allf, mats, fm, parent=parent)
    C.shade_by_angle(ob, 40)
    return ob


# ---------------------------------------------------------------- wing
def build_wing(M, parent, lod):
    """Active rear wing. `Wing` = hinge at the strut base (rotate about local X, + = raise),
    child `Wing_Blade` pivots at the blade quarter chord (extra pitch). Exported stowed (0°)."""
    hinge = Vector((0.0, 0.905 + GY, -1.50))
    wing = C.empty("Wing", B(*hinge), parent)
    # blade (in blade-local frame, pivot at quarter chord)
    zle, zte = -1.64, -2.09
    ytop = 0.950 + GY
    q = Vector((0.0, ytop - 0.02, zle + 0.25 * (zte - zle)))
    span = 0.89
    v, f = [], []
    # airfoil-ish section, 6 points (top surface white, bottom dark) extruded across span with upturned tips
    sec = [(zle, ytop - 0.012), (zle + 0.06, ytop), (zte + 0.05, ytop - 0.004), (zte, ytop - 0.012),
           (zte + 0.06, ytop - 0.035), (zle + 0.08, ytop - 0.045)]
    xs = [-span - 0.03, -span + 0.12, -0.25, 0.25, span - 0.12, span + 0.03]
    lift = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    zshift = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    m = len(sec)
    for x, l, zs in zip(xs, lift, zshift):
        for (z, y) in sec:
            v.append(Vector((x, y + l * (1 if z < zle - 0.1 else 0.5), z + zs)) - q)
    fm = []
    for i in range(len(xs) - 1):
        for j in range(m):
            j2 = (j + 1) % m
            f.append((i * m + j, i * m + j2, (i + 1) * m + j2, (i + 1) * m + j))
            fm.append(0 if j in (0, 1, 2, 3) else 1)
    f.append(tuple(reversed(range(m))))
    fm.append(1)
    last = (len(xs) - 1) * m
    f.append(tuple(range(last, last + m)))
    fm.append(1)
    blade = C.mesh_object("Wing_Blade", C.to_blender([tuple(p) for p in v]), f, [M["W"], M["D"]], fm,
                          parent=wing, loc=B(*(q - hinge)))
    me = blade.data
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me); bm.free()
    C.shade_by_angle(blade, 30)
    C.bevel(blade, 0.003, 2 if lod == 0 else 1, 30)
    # swan-neck struts: from the hinge forward/down, curving up and over to the blade top
    sv, sf = [], []
    for x in (-0.36, 0.36):
        path = []
        for t in [i / 8 for i in range(9)]:
            # curve from hinge (0,0) -> up and back to blade top centre (z ~ q.z, y ytop)
            zz = hinge.z + (q.z - hinge.z) * t
            yy = hinge.y + (ytop + 0.01 - hinge.y) * math.sin(t * math.pi / 2) ** 0.7 - 0.03 * math.sin(t * math.pi)
            path.append((zz, yy))
        base = len(sv)
        th, ch = 0.012, 0.05
        for (zz, yy) in path:
            for (dx, dz) in ((-th, -ch / 2), (th, -ch / 2), (th, ch / 2), (-th, ch / 2)):
                sv.append(Vector((x + dx, yy, zz + dz)) - hinge)
        for i in range(len(path) - 1):
            for k in range(4):
                k2 = (k + 1) % 4
                sf.append((base + i * 4 + k, base + i * 4 + k2, base + (i + 1) * 4 + k2, base + (i + 1) * 4 + k))
    struts = C.mesh_object("Wing_Struts", C.to_blender([tuple(p) for p in sv]), sf, [M["D"]], parent=wing)
    C.shade_by_angle(struts, 40)
    return wing


# ---------------------------------------------------------------- interior
def box(cx, cy, cz, sx, sy, sz):
    v = []
    for dx in (-1, 1):
        for dy in (-1, 1):
            for dz in (-1, 1):
                v.append((cx + dx * sx / 2, cy + dy * sy / 2, cz + dz * sz / 2))
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return v, f


def build_interior(M, parent, lod):
    allv, allf, fm = [], [], []
    mats = [M["IntD"], M["Int"], M["Display"], M["T"]]

    def add(verts, faces, mi):
        base = len(allv)
        allv.extend(verts)
        allf.extend(tuple(base + i for i in face) for face in faces)
        fm.extend([mi] * len(faces))

    # tub floor and firewall / rear bulkhead
    for (c, s) in (((0, 0.16 + GY, -0.1), (1.7, 0.03, 2.0)),
                   ((0, 0.48 + GY, 0.95), (1.6, 0.5, 0.05)),
                   ((0, 0.50 + GY, -0.95), (1.40, 0.70, 0.05)),
                   ((0, 0.30 + GY, -0.10), (0.26, 0.30, 1.6))):  # centre tunnel
        add(*box(*c, *s), 0)
    # dashboard: slab under the windshield with a soft lower lip
    add(*box(0, 0.72 + GY, 0.62, 1.55, 0.10, 0.45), 0)
    add(*box(0, 0.64 + GY, 0.42, 1.50, 0.08, 0.10), 1)
    # centre display (landscape, floating) + two small driver displays flanking the yoke
    add(*box(0, 0.83 + GY, 0.50, 0.38, 0.22, 0.012), 3)
    v, f = box(0, 0.83 + GY, 0.493, 0.36, 0.20, 0.002)
    add(v, f, 2)
    for x in (0.25, 0.51):
        add(*box(x, 0.80 + GY, 0.52, 0.12, 0.07, 0.01), 3)
        add(*box(x, 0.80 + GY, 0.514, 0.11, 0.06, 0.002), 2)
    ob = C.mesh_object("Interior", C.to_blender(allv), allf, mats, fm, parent=parent)
    C.shade_by_angle(ob, 40)
    C.bevel(ob, 0.006, 1, 40)
    # seats (one node with both seats): sculpted buckets from stacked boxes, light shells with dark inserts
    sv, sf, sm = [], [], []

    def sadd(verts, faces, mi):
        base = len(sv)
        sv.extend(verts)
        sf.extend(tuple(base + i for i in face) for face in faces)
        sm.extend([mi] * len(faces))

    seat_pivot = Vector((0.0, 0.18 + GY, -0.25))
    for x in (0.37, -0.37):
        # cushion
        sadd(*box(x, 0.26 + GY, -0.22, 0.50, 0.10, 0.52), 1)
        # side bolsters
        for dx in (-0.22, 0.22):
            sadd(*box(x + dx, 0.32 + GY, -0.22, 0.07, 0.12, 0.50), 1)
        # backrest (tilted ~25° back): built as box then sheared
        bv, bf = box(0, 0, 0, 0.50, 0.68, 0.10)
        ang = math.radians(24)
        bv2 = []
        for (bx, by, bz) in bv:
            yy = by * math.cos(ang) - bz * math.sin(ang)
            zz = by * math.sin(ang) * -1 + bz * math.cos(ang)
            bv2.append((x + bx, 0.62 + GY + yy, -0.58 + zz))
        sadd(bv2, bf, 1)
        # dark centre insert
        iv, if_ = box(0, 0, 0.055, 0.26, 0.5, 0.01)
        iv2 = []
        for (bx, by, bz) in iv:
            yy = by * math.cos(ang) - bz * math.sin(ang)
            zz = -by * math.sin(ang) + bz * math.cos(ang)
            iv2.append((x + bx, 0.62 + GY + yy, -0.58 + zz))
        sadd(iv2, if_, 0)
    # seat belts: dark webbing from the shoulder over the cushion to the hip buckle
    for x in (0.37, -0.37):
        o = 0.13 if x > 0 else -0.13
        path = [(x + o, 0.93 + GY, -0.68), (x + o * 0.3, 0.70 + GY, -0.52), (x - o * 0.5, 0.45 + GY, -0.36), (x - o * 1.4, 0.30 + GY, -0.30)]
        for (pa, pb) in zip(path, path[1:]):
            pa, pb = Vector(pa), Vector(pb)
            d = (pb - pa).normalized()
            side = d.cross(Vector((0, 0, 1))).normalized() * 0.024
            if side.length < 1e-6:
                side = Vector((0.024, 0, 0))
            off = Vector((0, 0.012, 0.03))
            sadd([tuple(pa - side + off), tuple(pa + side + off), tuple(pb + side + off), tuple(pb - side + off)],
                 [(0, 1, 2, 3), (3, 2, 1, 0)], 0)
    sv = [tuple(Vector(p) - seat_pivot) for p in sv]
    seat = C.mesh_object("Seat", C.to_blender(sv), sf, mats, sm, parent=parent, loc=B(*seat_pivot))
    C.bevel(seat, 0.02 if lod == 0 else 0.015, 3 if lod == 0 else 1, 40, harden=False)
    C.shade_by_angle(seat, 50)
    # yoke on the driver side (+X = left), pivot on the steering column axis
    ypiv = Vector((0.38, 0.68 + GY, 0.30))
    yv, yf, ym = [], [], []

    def yadd(verts, faces, mi):
        base = len(yv)
        yv.extend(verts)
        yf.extend(tuple(base + i for i in face) for face in faces)
        ym.extend([mi] * len(faces))

    # rectangular yoke rim: two grips + bottom bar + hub, in the column plane (tilted 20°)
    for (c, s, mi) in (((0.17, 0.0, 0.0), (0.04, 0.20, 0.035), 0), ((-0.17, 0.0, 0.0), (0.04, 0.20, 0.035), 0),
                       ((0.0, -0.09, 0.0), (0.34, 0.035, 0.03), 0), ((0.0, 0.0, 0.01), (0.12, 0.08, 0.04), 3),
                       ((0.12, 0.08, 0.0), (0.08, 0.03, 0.03), 0), ((-0.12, 0.08, 0.0), (0.08, 0.03, 0.03), 0),
                       ((0.0, -0.02, 0.06), (0.05, 0.05, 0.12), 3)):
        v, f = box(*c, *s)
        tilt = math.radians(-20)
        v = [(x, y * math.cos(tilt) - z * math.sin(tilt), y * math.sin(tilt) + z * math.cos(tilt)) for (x, y, z) in v]
        yadd(v, f, mi)
    yoke = C.mesh_object("Yoke", C.to_blender(yv), yf, mats, ym, parent=parent, loc=B(*ypiv))
    C.bevel(yoke, 0.01, 2 if lod == 0 else 1, 40, harden=False)
    C.shade_by_angle(yoke, 50)
    return ob, seat, yoke


# ---------------------------------------------------------------- nozzles (empties)
def build_nozzle_empties(parent):
    out = []
    for i, (pos, d) in enumerate(NOZZLES):
        e = C.empty(f"Nozzle_{i}", B(*pos), parent, size=0.05)
        ex = B(-d[0], -d[1], -d[2]).normalized()   # exhaust direction in Blender world
        ly = -ex                                   # Blender local -Y == glTF local +Z
        ref = Vector((0, 0, 1)) if abs(ly.z) < 0.9 else Vector((1, 0, 0))
        lx = ref.cross(ly).normalized()
        lz = lx.cross(ly).normalized()
        mat = Matrix((lx, ly, lz)).transposed()
        e.rotation_mode = "QUATERNION"
        e.rotation_quaternion = mat.to_quaternion()
        out.append(e)
    return out


# ---------------------------------------------------------------- main
def build(lod: int = 0):
    C.reset_scene()
    read_shared_config()
    make_ref(SUB if lod == 0 else 1)
    M = make_materials(lod)
    root = C.empty("Roadster", (0, 0, 0))
    # body hull
    bm, door_quads, mi = build_body_bm(caps=False)
    shrink_boundary(bm, 0.0025)
    bm = subdivide_cage(bm, LEVELS if lod == 0 else 1)
    fill_end_caps(bm, mi)
    cap_regions(bm, mi, front=True)
    cap_regions(bm, mi, front=False)
    body = C.bm_to_object("Body", bm, [M[k] for k in MAT_ORDER], parent=root)
    cutter = make_cutters(M)
    finish_shell(body, M, lod, thickness=0.018, cutter=cutter,
                 inner_map={"Paint_AnoWhite": M["IntD"], "Carbon": M["D"], "Trim_Black": M["T"]})
    bpy.data.objects.remove(cutter)
    # wheel wells merged into the body mesh
    wv, wf = build_wells(M)
    wells = C.mesh_object("Wells", wv, wf, [M["Well"]], parent=root)
    # BVH of the body for placing lights
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body, dg)
    extras = build_lights(M, root, bvh)
    rear = build_rear_details(M, root, lod)
    front = build_front_details(M, root, lod)
    interior, seat, yoke = build_interior(M, root, lod)
    # join static body parts into Body (lights stay separate nodes for the renderer)
    join_into(body, [wells, rear, front, interior])
    doors = build_doors(door_quads, M, root, lod)
    wheels = [build_wheel(w, M, root, lod) for w in WHEELS]
    wing = build_wing(M, root, lod)
    for ob in [body, *doors.values(), seat, yoke] + [o for o in wing.children]:
        C.box_uv(ob, 1.0)
    noz = build_nozzle_empties(root)
    return root


def join_into(target, others):
    bpy.ops.object.select_all(action="DESELECT")
    for o in others:
        o.select_set(True)
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.join()


def main():
    args = C.args_after_dashdash()
    lod = int(args[args.index("--lod") + 1]) if "--lod" in args else 0
    default = "roadster.glb" if lod == 0 else "roadster_lod1.glb"
    out = args[args.index("--out") + 1] if "--out" in args else os.path.join(ROOT, "public", "assets", "car", default)
    build(lod)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    print(f"[roadster] LOD{lod} triangles: {C.triangle_count(meshes)}")
    if "--no-export" not in args:
        C.export_glb(out)
        print(f"[roadster] wrote {out} ({os.path.getsize(out) / 1e6:.2f} MB)")
    if "--save-blend" in args:
        bpy.ops.wm.save_as_mainfile(filepath=args[args.index("--save-blend") + 1])


if __name__ == "__main__":
    main()
