"""Roadster model v3 -> GLB (Blender 5.2 headless).

The body is the photo-fitted B-spline cage of body_spec.json (surface.py evaluates it; fit.py fits it
to the reconstructed reference cameras). Blender only adds what the surface model does not carry:
material regions, door/glass separation with real gaps, wall thickness, wheel arches, small radii,
and the detail parts (lights, mask, diffuser, wing, wheels, interior, nozzle empties).

Usage:
  Blender -b --factory-startup -P tools/blender/v3/build_v3.py -- [--lod 0|1] [--out path.glb] [--v31] [--spec file]
  --v31: v3.1 (body_spec_v31.json from v31_spec.py, bevels on closed edges, door scoop, black intake)
         -> roadster_v31.glb / roadster_v31_lod1.glb
  --v32: v3.2 = v3.1 + rear "smile" (d_033: flat white lens let into the recess under the tail-light
         lip, dark seam on its contour, plate mounted on it) -> roadster_v32.glb / roadster_v32_lod1.glb
  --v33: v3.3 = v3.2 + rear after the stream: stowed wing blade follows the deck and ends flush in
         the tail edge, carbon diffuser surround with the nozzle exits set back in it (contract positions
         unchanged), smaller nozzle bells, only the two outer strakes, plate lamps
         -> roadster_v33.glb / roadster_v33_lod1.glb
  --v34: v3.4 = v3.3 + softer rear: rounded diffuser surround
         drawn in at the bottom (own object, 8 mm round-over), 10 mm radii on the body
         creases behind the rear axle line (brass nozzles stay: d_033 shows brass, the stream's grey
         rings are light, not material), satin instead of mirror-black trim / plastic (takes the wash light like the stream instead of reflecting the dark)
         -> roadster_v34.glb / roadster_v34_lod1.glb
Contract: see docs/RENDERING.md (nodes, pivots, materials, axes). Car frame: x left, y up,
z forward, origin dry CoG; common.B() converts to Blender.
"""
from __future__ import annotations

import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402

import common as C  # noqa: E402
from common import B  # noqa: E402
import build_roadster as V2  # noqa: E402
import surface as SF  # noqa: E402
import wheel_v3 as WV  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
GROUND = SF.GROUND_Y
MAT_KEYS = ["W", "D", "G", "T", "P", "LEDF", "LEDT", "LEDB", "LEDM", "IntD"]


# ---------------------------------------------------------------- body surface -> bmesh
def region_of(spec, s, p):
    """Material and part ('body' / 'door') of the surface patch at (station param s, profile param p)."""
    mat, part = "W", "body"
    for r in spec.get("regions", []):
        if r["s"][0] <= s <= r["s"][1] and r["p"][0] <= p <= r["p"][1]:
            mat = r["mat"]; break
    for r in spec.get("parts", []):
        if r["s"][0] <= s <= r["s"][1] and r["p"][0] <= p <= r["p"][1]:
            part = r["part"]; break
    return mat, part


def body_faces(spec, lod):
    b = SF.Body(spec)
    per = 6 if lod == 0 else 2
    G, U, V = b.grid(per_u=per, per_v=per)
    pp, side = b.profile_param(U)
    nv, nu = G.shape[:2]
    if spec.get("door_scoop"):
        G = door_scoop(G, V, pp, side, spec["door_scoop"])
    G, dead = trim_arches(G)
    verts = G.reshape(-1, 3)
    faces, info = [], []
    for a in range(nv - 1):
        for k in range(nu):
            k2 = (k + 1) % nu
            q = (a * nu + k, a * nu + k2, (a + 1) * nu + k2, (a + 1) * nu + k)
            if any(dead[i] for i in q):
                continue
            s = 0.5 * (V[a] + V[a + 1])
            if s < 1.0 or s > b.ns - 2:
                continue                     # nose / tail faces are built as planar caps
            pc = 0.5 * (pp[k] + pp[k2]) if abs(pp[k] - pp[k2]) < 2 else pp[k]
            sd = side[k] if side[k] == side[k2] else (1 if verts[q[0]][0] + verts[q[1]][0] > 0 else -1)
            mat, part = region_of(spec, s, pc)
            faces.append(q); info.append((mat, part, sd))
    return verts, faces, info


ARCH_CLEAR = 0.040


def door_scoop(G, V, pp, side, sc):
    """v3.1: doubly curved scoop in the lower rear of the door (d_021/d_014: the door surface dishes
    in ahead of the rear-fender port). Bowl profile (1 - r^2)^2 over an ellipse in the design
    parameters (station s, profile p), pushed inward along -x; a crisper upper rim comes from the
    steeper falloff above the centre."""
    G = G.copy()
    s0, as_, p0, ap, depth = sc["s"], sc["ds"], sc["p"], sc["dp"], sc["depth"]
    S = V[:, None]; P = pp[None, :]
    dp = np.where(P > p0, (P - p0) / (ap * 0.7), (P - p0) / ap)   # tighter towards the shoulder
    r2 = ((S - s0) / as_) ** 2 + dp ** 2
    w = np.clip(1 - r2, 0, 1) ** 2
    G[..., 0] -= side[None, :] * depth * w
    return G


def trim_arches(G):
    """Cut the wheel arches into the surface grid: inside samples next to outside ones are moved
    along the grid line onto the arch circle (clean lip), the rest inside is removed."""
    G = G.copy()
    nv, nu = G.shape[:2]
    f = np.full((nv, nu), np.inf)
    for wid, w in V2.WHEELS.items():
        x, y, z = w["pos"]
        R = w["r"] + ARCH_CLEAR
        side = np.sign(x)
        d = np.hypot(G[..., 2] - z, G[..., 1] - y) - R
        on = (G[..., 0] * side > 0.45) & (np.abs(G[..., 2] - z) < R + 0.2)
        f = np.where(on, np.minimum(f, d), f)
    inside = f < 0
    newpos = np.zeros_like(G); cnt = np.zeros((nv, nu))
    for da, dk in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        for a in range(nv):
            a2 = a + da
            if not 0 <= a2 < nv:
                continue
            for k in np.where(inside[a])[0]:
                k2 = (k + dk) % nu
                if inside[a2, k2] or not np.isfinite(f[a2, k2]) and f[a2, k2] > 0 and False:
                    continue
                fa, fb = f[a, k], f[a2, k2]
                if fb <= 0:
                    continue
                fb = min(fb, 1.0)
                t = fa / (fa - fb)
                newpos[a, k] += G[a, k] + t * (G[a2, k2] - G[a, k]); cnt[a, k] += 1
    moved = cnt > 0
    G[moved] = newpos[moved] / cnt[moved][:, None]
    dead = (inside & ~moved).ravel()
    return G, dead


def make_bm(verts, faces, info, want, mi):
    """bmesh of the faces whose (part, side) is in `want` (set), material indices from mi."""
    bm = bmesh.new()
    used = {}
    for f, (mat, part, sd) in zip(faces, info):
        if (part, sd) not in want and (part, 0) not in want:
            continue
        vs = []
        for i in f:
            if i not in used:
                used[i] = bm.verts.new(B(*verts[i]))
            vs.append(used[i])
        if len({id(v) for v in vs}) < 3:
            continue
        try:
            nf = bm.faces.new(vs if len({id(v) for v in vs}) == 4 else list(dict.fromkeys(vs)))
        except ValueError:
            continue
        nf.material_index = mi[mat]
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=1e-4)
    # drop sliver faces left by the arch snapping
    bad = [f for f in bm.faces if f.calc_area() < 1e-7]
    bmesh.ops.delete(bm, geom=bad, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    # NOTE: no recalc_face_normals here: the grid winding is globally consistent, recalc on the
    # open (door holes, arches) shell flips whole islands. outward() fixes the global sign.
    bm.normal_update()
    return bm


def outward(bm, sign_x=0):
    """Make normals point away from the car centre (area-weighted flux through the faces)."""
    bm.normal_update()
    c0 = B(0, 0.1, 0)
    acc = sum(f.normal.dot(f.calc_center_median() - c0) * f.calc_area() for f in bm.faces)
    if acc < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
        bm.normal_update()


def fix_volume(ob):
    """Closed shells must have positive signed volume before booleans."""
    bm = bmesh.new(); bm.from_mesh(ob.data)
    vol = bm.calc_volume(signed=True)
    if vol < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data); bm.free()
    return vol


def shrink_open_boundary(bm, dist):
    """Pull open boundary verts back along the surface (panel gap half-width)."""
    move = {}
    for e in bm.edges:
        if not e.is_boundary or not e.link_faces:
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


def flange(bm, depth, mat_index):
    """Turn open boundary edges inward (towards the cabin) -> visible return flange in gaps."""
    edges = [e for e in bm.edges if e.is_boundary]
    if not edges:
        return
    vn = {}
    for e in edges:
        for v in e.verts:
            vn.setdefault(v, Vector())
            for f in v.link_faces:
                vn[v] += f.normal
    ret = bmesh.ops.extrude_edge_only(bm, edges=edges)
    newv = [g for g in ret["geom"] if isinstance(g, bmesh.types.BMVert)]
    newf = [g for g in ret["geom"] if isinstance(g, bmesh.types.BMFace)]
    # map new verts to their source (same position)
    src = {tuple(round(c, 7) for c in v.co): v for v in vn}
    for v in newv:
        s = src.get(tuple(round(c, 7) for c in v.co))
        n = vn.get(s, Vector((0, 0, 1)))
        if n.length > 1e-9:
            v.co -= n.normalized() * depth
    for f in newf:
        f.material_index = mat_index


# cap zones (car frame, heights above ground): (name, x range, yg range, material, recess depth)
FRONT_ZONES = [("led", (0, 0.64), (0.455, 9), "T", 0.010), ("mask", (0, 0.64), (0.30, 0.455), "T", 0.020),
               ("intake", (0, 0.64), (0.18, 0.30), "P", 0.080), ("lip", (0, 0.64), (-9, 0.18), "D", 0.0),
               ("fender", (0.64, 9), (0.24, 9), "W", 0.0), ("flow", (0.64, 9), (-9, 0.24), "D", 0.0)]
REAR_ZONES = [("band", (0, 9), (0.769, 9), "T", 0.012), ("strip", (0, 9), (0.724, 0.769), "W", 0.0),
              ("smile", (0, 0.66), (0.55, 0.724), "W", 0.035), ("corner", (0.66, 9), (0.50, 0.724), "W", 0.0),
              ("diffuser", (0, 0.66), (-9, 0.55), "D", 0.12), ("cornerlow", (0.66, 9), (-9, 0.50), "D", 0.0)]


# headlight triangle on the nose face (x, height above ground), measured from d_039 (measure.py)
HL_TRI = [(0.615, 0.468), (0.805, 0.492), (0.705, 0.352)]


def clip_rect(poly, x0, x1, y0, y1):
    """Sutherland-Hodgman clip of a 2D polygon by an axis-aligned rectangle."""
    def clip(P, inside, inter):
        out = []
        for i in range(len(P)):
            a, b = P[i - 1], P[i]
            ia, ib = inside(a), inside(b)
            if ib:
                if not ia:
                    out.append(inter(a, b))
                out.append(b)
            elif ia:
                out.append(inter(a, b))
        return out

    def ix(xv):
        return lambda a, b: (xv, a[1] + (b[1] - a[1]) * (xv - a[0]) / (b[0] - a[0]))

    def iy(yv):
        return lambda a, b: (a[0] + (b[0] - a[0]) * (yv - a[1]) / (b[1] - a[1]), yv)
    P = list(poly)
    for ins, inter in ((lambda p: p[0] >= x0, ix(x0)), (lambda p: p[0] <= x1, ix(x1)),
                       (lambda p: p[1] >= y0, iy(y0)), (lambda p: p[1] <= y1, iy(y1))):
        if not P:
            break
        P = clip(P, ins, inter)
    return P


def cap_mesh(spec, lod):
    """Nose/tail faces: the rim ring of the surface (outline) is clipped into zone rectangles; each
    zone is a planar polygon at its recess depth with side walls. Returns verts, faces, mats."""
    from mathutils.geometry import tessellate_polygon
    b = SF.Body(spec)
    per = 6 if lod == 0 else 2
    G, U, V = b.grid(per_u=per, per_v=per)
    out_v, out_f, out_m = [], [], []
    for front in (True, False):
        a = int(np.argmin(np.abs(V - (1.0 if front else b.ns - 2))))
        ring = G[a]
        zc = float(ring[:, 2].mean())
        outline = [(float(p[0]), float(p[1] - GROUND)) for p in ring]
        zones = FRONT_ZONES if front else REAR_ZONES
        sgnz = -1 if front else 1           # recess direction (into the car)
        for name, xr, yr, mat, depth in zones:
            if V31 and name == "intake":
                mat = "D"                   # v3.1: the intake is a black recess (d_039), not paint
            for side in (1, -1):
                if side < 0 and xr[0] == 0:
                    continue                # centre zones span both sides once
                x0, x1 = (-min(xr[1], 5), min(xr[1], 5)) if xr[0] == 0 else ((xr[0], 5) if side > 0 else (-5, -xr[0]))
                P = clip_rect(outline, x0, x1, max(yr[0], -5), min(yr[1], 5))
                # drop duplicate consecutive points
                Q = []
                for p in P:
                    if not Q or abs(p[0] - Q[-1][0]) + abs(p[1] - Q[-1][1]) > 1e-5:
                        Q.append(p)
                if len(Q) > 2 and abs(Q[0][0] - Q[-1][0]) + abs(Q[0][1] - Q[-1][1]) < 1e-5:
                    Q.pop()
                if len(Q) < 3:
                    continue
                z = zc + sgnz * depth
                base = len(out_v)
                for x, yg in Q:
                    out_v.append((x, yg + GROUND, z))
                loops = [[Vector((x, yg, 0)) for x, yg in Q]]
                if front and name == "fender":
                    loops.append([Vector((side * x, yg, 0)) for x, yg in HL_TRI])
                    base_h = None
                tris = tessellate_polygon(loops)
                if len(loops) > 1:
                    for x, yg in HL_TRI:
                        out_v.append((side * x, yg + GROUND, z))
                for t in tris:
                    out_f.append(tuple(base + i for i in t)); out_m.append(mat)
                if depth > 0:
                    wb = len(out_v)
                    for x, yg in Q:
                        out_v.append((x, yg + GROUND, zc + sgnz * 0.001))
                    n = len(Q)
                    for i in range(n):
                        j = (i + 1) % n
                        out_f.append((base + i, base + j, wb + j, wb + i)); out_m.append("T")
    return out_v, out_f, out_m


def build_caps(spec, M, root, lod):
    v, f, m = cap_mesh(spec, lod)
    keys = sorted(set(m))
    ob = C.mesh_object("Caps", C.to_blender(v), f, [M[k] for k in keys], [keys.index(k) for k in m], parent=root)
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    # cap normals: +z at the nose, -z at the tail (Blender -y / +y)
    for fc in bm.faces:
        c = fc.calc_center_median()
        if abs(fc.normal.y) > 0.9 and (fc.normal.y < 0) != (-c.y > 0):
            fc.normal_flip()
    bm.to_mesh(ob.data); bm.free()
    for p in ob.data.polygons:
        p.use_smooth = False
    return ob


def bm_object(name, bm, M, parent, loc=None):
    mats = [M[k] for k in MAT_KEYS]
    ob = C.bm_to_object(name, bm, mats, parent=parent)
    if loc is not None:  # re-centre on a pivot (verts are world positions)
        piv = B(*loc)
        for v in ob.data.vertices:
            v.co -= piv
        ob.location = piv
    return ob


def solidify(ob, thickness, M):
    me = ob.data
    nb = len(MAT_KEYS)
    for k in MAT_KEYS:  # inner shell
        me.materials.append(M["IntD"] if k in ("W", "D") else M[k])
    for _ in MAT_KEYS:  # rims
        me.materials.append(M["T"])
    sd = ob.modifiers.new("Solid", "SOLIDIFY")
    sd.thickness = thickness
    sd.offset = -1.0
    sd.use_even_offset = False
    sd.use_quality_normals = True
    sd.material_offset = nb
    sd.material_offset_rim = 2 * nb
    C.apply_modifiers(ob)
    # single-surface glass: drop the inner glass shell and the glass rims (as v2 finish_shell)
    g = MAT_KEYS.index("G")
    bm = bmesh.new(); bm.from_mesh(ob.data)
    kill = [f for f in bm.faces if f.material_index == g + nb]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(ob.data); bm.free()


def clamp_to_caps(ob, spec):
    """v3.1: the solidify offset of the last surface row runs along strongly creased vertex normals and
    pushes the inner shell and its rim up to ~1 cm through the nose and tail planes (black saw-tooth
    around the horns and above the LED bar). Every vertex beyond a cap plane is pulled back onto it."""
    z = [st["z"] for st in spec["stations"]]
    zf, zt = max(z), min(z)
    n = 0
    for v in ob.data.vertices:
        cz = -v.co.y                       # Blender -Y == car +Z
        if cz > zf - 0.0005:
            v.co.y = -(zf - 0.0005); n += 1
        elif cz < zt + 0.0005:
            v.co.y = -(zt + 0.0005); n += 1
    ob.data.update()
    print(f"[v3] clamped {n} verts to the cap planes", flush=True)


def arch_cutter(M, clearance=0.040):
    verts, faces = [], []
    for wid, w in V2.WHEELS.items():
        x, y, z = w["pos"]
        r = w["r"] + clearance
        sgn = 1 if x > 0 else -1
        x0, x1 = x - sgn * 0.26, x + sgn * 0.6
        seg = 72
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
    ob = C.mesh_object("ArchCutter", verts, faces, [M["T"]])
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data); bm.free()
    fix_volume(ob)
    ob.hide_render = True
    return ob


def boolean(ob, cutter, op="DIFFERENCE"):
    bo = ob.modifiers.new("Bool", "BOOLEAN")
    bo.operation = op
    bo.solver = "EXACT"
    bo.object = cutter
    bo.material_mode = "TRANSFER"
    C.apply_modifiers(ob)


DEBUG = set(os.environ.get("V3_DEBUG", "").split(","))
SPEC_PATH = None       # body_spec.json (v3) unless --spec is given
V31 = False            # v3.1 details (bevels, door scoop); set by --v31
SMILE = False          # v3.2 rear smile panel; set by --v32 (implies --v31)
V33 = False            # v3.3 rear; set by --v33 (implies --v32)
V34 = False            # v3.4 softer rear; set by --v34 (implies --v33)


def mark_bevel_edges(ob, angle_deg, skip_mats=(), weight_fn=None):
    """Bevel weight 1 on sharp edges that are safe to bevel: manifold (two faces), not touching an
    open boundary (glass edges, gap flanges end there - bevel artefacts at open ends), and not on
    a skipped material (glass). weight_fn(edge) -> weight (scales the bevel width) replaces 1.0.
    Returns the number of marked edges."""
    bm = bmesh.new(); bm.from_mesh(ob.data)
    lay = bm.edges.layers.float.get("bevel_weight_edge") or bm.edges.layers.float.new("bevel_weight_edge")
    open_v = {v for e in bm.edges if not e.is_manifold for v in e.verts}
    lim = math.radians(angle_deg)
    n = 0
    for e in bm.edges:
        w = 0.0
        if e.is_manifold and not (e.verts[0] in open_v or e.verts[1] in open_v):
            f1, f2 = e.link_faces
            if f1.material_index not in skip_mats and f2.material_index not in skip_mats and e.calc_face_angle(0) > lim:
                w = weight_fn(e) if weight_fn else 1.0; n += 1
        e[lay] = w
    bm.to_mesh(ob.data); bm.free()
    return n


def finish(ob, lod, angle=14, width=0.003, bevel=False, skip_mats=(), weight_fn=None):
    V2.cleanup(ob, 0.0003)
    C.shade_by_angle(ob, angle)
    if bevel and lod == 0 and "nobevel" not in DEBUG:
        n = mark_bevel_edges(ob, max(angle, 25), skip_mats, weight_fn)
        md = C.bevel(ob, width=width, segments=2, angle_deg=angle, apply=False, limit="WEIGHT")
        md.miter_outer = "MITER_SHARP"
        C.apply_modifiers(ob)
        print(f"[v3] bevel {ob.name}: {n} edges", flush=True)
    C.weighted_normals(ob)


# ---------------------------------------------------------------- sampling helpers on the body
class BodyQuery:
    def __init__(self, spec):
        self.b = SF.Body(spec)
        self.G, self.U, self.V = self.b.grid(per_u=8, per_v=8)
        self.pp, self.side = self.b.profile_param(self.U)

    def point(self, s, p, side=1):
        a = int(np.argmin(np.abs(self.V - s)))
        cand = np.where(self.side == side)[0]
        k = cand[int(np.argmin(np.abs(self.pp[cand] - p)))]
        return Vector(self.G[a, k])

    def z_of(self, s):
        a = int(np.argmin(np.abs(self.V - s)))
        return float(self.G[a, :, 2].mean())


def ray(bvh, origin, direction):
    """origin/direction in car frame; returns hit (car frame) or None."""
    o = B(*origin); d = B(*direction).normalized()
    hit = bvh.ray_cast(o, d, 5.0)
    if hit[0] is None:
        return None
    h = hit[0]
    return Vector((h.x, h.z, -h.y)), hit[1]


# ---------------------------------------------------------------- detail parts
def add_mesh(store, verts, faces, mi):
    base = len(store[0])
    store[0].extend(verts)
    store[1].extend(tuple(base + i for i in f) for f in faces)
    store[2].extend([mi] * len(faces))


def box(cx, cy, cz, sx, sy, sz):
    return V2.box(cx, cy, cz, sx, sy, sz)


def prism(poly, z0, z1):
    """Extrude a polygon given in (x, y) at z0..z1 (car frame)."""
    n = len(poly)
    v = [(x, y, z0) for x, y in poly] + [(x, y, z1) for x, y in poly]
    f = [tuple(range(n))[::-1], tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        f.append((i, j, n + j, n + i))
    return v, f


def strip(points, width_dir, w, thick_dir, t):
    """Thin ribbon along points (car frame), width along width_dir, thickness along thick_dir."""
    v, f = [], []
    wd = Vector(width_dir).normalized() * (w / 2)
    td = Vector(thick_dir).normalized() * t
    for p in points:
        p = Vector(p)
        v += [tuple(p - wd), tuple(p + wd), tuple(p + wd + td), tuple(p - wd + td)]
    for i in range(len(points) - 1):
        a, b = 4 * i, 4 * (i + 1)
        for q in range(4):
            q2 = (q + 1) % 4
            f.append((a + q, a + q2, b + q2, b + q))
    f.append((0, 1, 2, 3)[::-1]); n = 4 * (len(points) - 1); f.append((n, n + 1, n + 2, n + 3))
    return v, f


def build_front(M, root, bq, bvh, lod):
    """LED bar, recessed mask with intake grille, splitter, triangular headlight pockets."""
    lights, parts = ([], [], []), ([], [], [])
    zf = bq.z_of(1.0)                       # nose face plane (rim station)
    hood = bq.point(1.0, 12)                # top centre of the nose face
    horn = bq.point(1.0, 8)                 # inner horn edge at the nose
    led_y = hood.y - 0.018
    xl = abs(horn.x) - 0.02
    # LED bar: thin emissive line in the recessed "led" zone right under the hood edge
    led_y = GROUND + 0.47
    xl = 0.62
    pts = [(x, led_y, zf - 0.010 + 0.004) for x in np.linspace(-xl, xl, 24)]
    v, f = strip(pts, (0, 1, 0), 0.008, (0, 0, -1), 0.004)
    if V31:
        # d_039: one continuous light line at the hood edge, flush with the face (not hidden in the groove)
        led_y = GROUND + 0.462
        pts = [(x, led_y, zf + 0.002) for x in np.linspace(-0.635, 0.635, 32)]
        v, f = strip(pts, (0, 1, 0), 0.011, (0, 0, -1), 0.006)
    add_mesh(lights, v, f, 0)
    # intake grille slats inside the deep intake recess
    nsl = 6 if lod == 0 else 3
    for k in range(nsl):
        yy = GROUND + 0.18 + 0.12 * (k + 0.5) / nsl
        v, f = box(0, yy, zf - 0.06, 2 * xl - 0.04, 0.005, 0.04)
        add_mesh(parts, v, f, 2)
    # lower lip / splitter: black blade with raised centre, swept ends
    prof = [(-0.92, GROUND + 0.16, zf - 0.14), (-0.70, GROUND + 0.13, zf - 0.04), (-0.30, GROUND + 0.125, zf - 0.02),
            (0.30, GROUND + 0.125, zf - 0.02), (0.70, GROUND + 0.13, zf - 0.04), (0.92, GROUND + 0.16, zf - 0.14)]
    v, f = strip([p for p in prof], (0, 0, 1), 0.10, (0, -1, 0), 0.018)
    add_mesh(parts, v, f, 3)
    # headlight pockets: triangular holes in the nose face (cap_mesh), dark walls 7 cm deep,
    # chrome reflector at the back, LED triangle in front of it
    for sgn in (1, -1):
        c = bq.point(1.0, 7, sgn)
        tri = [Vector((sgn * x, yg + GROUND, zf)) for x, yg in HL_TRI]
        cen = (tri[0] + tri[1] + tri[2]) / 3
        back = [cen + (p - cen) * 0.8 + Vector((0, 0, -0.07)) for p in tri]
        v = [tuple(p) for p in tri] + [tuple(p) for p in back]
        fcs = [(0, 1, 4, 3), (1, 2, 5, 4), (2, 0, 3, 5)]
        add_mesh(parts, v, fcs, 1)
        add_mesh(parts, [tuple(p) for p in back], [(0, 1, 2)], 5)
        led = [tuple(cen + (p - cen) * 0.55 + Vector((0, 0, -0.03))) for p in tri]
        add_mesh(lights, led, [(0, 1, 2), (2, 1, 0)], 0)
        # corner reflector (red) low on the fender front
        rv, rf = box(sgn * (abs(c.x) - 0.06), GROUND + 0.26, zf + 0.002, 0.10, 0.06, 0.006)
        add_mesh(parts, rv, rf, 4)
    lo = C.mesh_object("Light_Head", C.to_blender(lights[0]), lights[1], [M["LEDF"]], lights[2], parent=root)
    po = C.mesh_object("FrontParts", C.to_blender(parts[0]), parts[1], [M["T"], M["T"], M["P"], M["D"], M["LEDM"], M["Chrome"]], parts[2], parent=root)
    for o in (lo, po):
        bm = bmesh.new(); bm.from_mesh(o.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.to_mesh(o.data); bm.free()
        C.shade_by_angle(o, 35)
    return lo, po


def build_rear(M, root, bq, lod):
    """Tail light band (LED_Tail + LED_Brake), plate, diffuser strakes, brass nozzles, fans."""
    L3 = json.load(open(os.path.join(HERE, "cameras.json")))["lm3"]
    zt = bq.z_of(bq.b.ns - 2)
    bt = bq.point(bq.b.ns - 2, 7); bb = bq.point(bq.b.ns - 2, 6); sb = bq.point(bq.b.ns - 2, 5)
    tail, brake, parts = ([], [], []), ([], [], []), ([], [], [])
    xw = abs(bt.x) - 0.01
    ymid = 0.5 * (bt.y + bb.y)
    # LED lines inside the recessed black band (band recess 12 mm towards +z)
    zb = zt + 0.012 - 0.004
    tw, bw = (0.015, 0.008) if V33 else (0.010, 0.006)   # v3.3: stream bar reads thicker at distance
    v, f = strip([(x, ymid - 0.008, zb) for x in np.linspace(-xw + 0.03, xw - 0.03, 30)], (0, 1, 0), tw, (0, 0, 1), 0.003)
    add_mesh(tail, v, f, 0)
    v, f = strip([(x, ymid + 0.014, zb) for x in np.linspace(-0.55, 0.55, 20)], (0, 1, 0), bw, (0, 0, 1), 0.003)
    add_mesh(brake, v, f, 0)
    if V33:
        # stream: the centre third of the bar reads as a brighter double line even without braking
        v, f = strip([(x, ymid + 0.004, zb) for x in np.linspace(-0.55, 0.55, 20)], (0, 1, 0), 0.006, (0, 0, 1), 0.003)
        add_mesh(tail, v, f, 0)
    # plate (blank, white) on a dark mount at the reconstructed position
    pT = L3.get("plate_T", [0.15, 0.245, -1.913]); pB = L3.get("plate_B", [0.15, 0.107, -1.955])
    pc_y = 0.5 * (pT[1] + pB[1]); pc_z = zt + 0.035 - 0.010
    if SMILE:
        pc_z = build_smile(parts, lod) + 0.004
    v, f = box(0, pc_y, pc_z, 0.315, abs(pT[1] - pB[1]) + 0.012, 0.012)
    add_mesh(parts, v, f, 0)
    v, f = box(0, pc_y, pc_z - 0.008, 0.305, abs(pT[1] - pB[1]), 0.004)
    add_mesh(parts, v, f, 6 if V33 else 2)      # v3.3: plate lit by its lamps (stream: brightest rear part)
    # diffuser: ramp + vertical strakes; reaches z <= -2.0 (contract box) under the bumper
    y0, y1 = GROUND + 0.10, GROUND + 0.42
    ramp = [(-0.78, y0, -1.45), (0.78, y0, -1.45), (0.78, y1, zt - 0.02), (-0.78, y1, zt - 0.02)]
    add_mesh(parts, ramp, [(0, 1, 2, 3), (3, 2, 1, 0)], 3)
    strakes = np.linspace(-0.72, 0.72, 7 if lod == 0 else 5)
    frame = None
    if V33:
        strakes = (-0.72, 0.72)              # d_033 / stream: no inner fins, only the outer side plates
        if V34:
            # outer side plates stay: without them Heck-3/4 IoU drops 0.9488 -> 0.9437 (d_007 far corner)
            frame = build_diffuser_frame_v34(M, root, lod)
        else:
            build_diffuser_frame(parts, lod)
    for x in strakes:
        side = [(y0 - 0.015, -1.55), (y0 + 0.03, -2.04), (y1 + 0.02, -2.02), (y1 + 0.03, zt - 0.02)]
        th = 0.010 if V31 else 0.007         # v3.1: 2 cm strakes, closed so their edges can be bevelled
        v = [(x - th, yy, zz) for yy, zz in side] + [(x + th, yy, zz) for yy, zz in side]
        fcs = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3)]
        add_mesh(parts, v, fcs + ([(3, 7, 4, 0)] if V31 else []), 3)
    # four brass nozzles at the contract positions (exhaust axis +z of Nozzle_0..3 = -z car)
    seg = 40 if lod == 0 else 16
    for (pos, _) in V2.NOZZLES[:4]:
        x, y, z = pos
        # exit plane at the contract position, bell opens towards the exhaust (-z), throat inside (+z)
        prof = [(0.054, 0.004), (0.050, 0.0), (0.046, 0.02), (0.036, 0.07), (0.028, 0.11), (0.026, 0.14)]
        if V33:
            # stream / d_033: smaller bells (rim ~ 1/3 of the plate width), feed tube back to the housing
            # short can back to the housing wall (DF_ZW), no visible feed tube
            prof = [(0.040, 0.10), (0.046, 0.085), (0.046, 0.004), (0.043, 0.0), (0.040, 0.02), (0.032, 0.07), (0.026, 0.09)]
        v, f = C.lathe([(r, z + dzz) for r, dzz in prof], seg)
        # lathe revolves about car x; rotate to the z axis: (x', y', z') = (r cos, r sin, axial)
        v = [(x + vy, y + vz, vx) for (vx, vy, vz) in v]
        add_mesh(parts, v, f, 5)
        dz_cap = 0.09 if V33 else 0.14
        r_cap = 0.026
        v, f = C.lathe([(r, z + dzz) for r, dzz in [(r_cap, dz_cap), (0.0, dz_cap)]], seg)
        v = [(x + vy, y + vz, vx) for (vx, vy, vz) in v]
        add_mesh(parts, v, f, 3 if V33 else 1)   # v3.3: black throat (stream: the bores read black)
        if V33:
            continue                             # set back in the diffuser surround instead of a collar
        # dark housing collar
        v, f = C.lathe([(r, z + dzz) for r, dzz in [(0.054, 0.004), (0.070, 0.004), (0.070, 0.06)]], seg)
        v = [(x + vy, y + vz, vx) for (vx, vy, vz) in v]
        add_mesh(parts, v, f, 1)
    if V33:
        # plate lamps (d_033: two small white lamps under the strip, above the plate)
        lamps = ([], [], [])
        for sx in (-1, 1):
            v, f = box(sx * 0.075, SM_Y1 - 0.010, SM_ZREC - 0.002, 0.050, 0.009, 0.003)
            add_mesh(lamps, v, f, 0)
        C.mesh_object("Light_Plate", C.to_blender(lamps[0]), lamps[1], [M["LEDF"]], lamps[2], parent=root)
    to = C.mesh_object("Light_Tail", C.to_blender(tail[0]), tail[1], [M["LEDT"]], tail[2], parent=root)
    bo = C.mesh_object("Light_Brake", C.to_blender(brake[0]), brake[1], [M["LEDB"]], brake[2], parent=root)
    rear_mats = [M["T"], M["Chrome"], M["W"], M["D"], M["P"], M["Brass"]]
    if V33:
        rear_mats.append(C.material("Plate_Lit", (0.9, 0.9, 0.88), 0.0, 0.4, emission=(1.0, 0.98, 0.94), emission_strength=0.35))
    po = C.mesh_object("RearParts", C.to_blender(parts[0]), parts[1], rear_mats, parts[2], parent=root)
    for o in (to, bo, po):
        bm = bmesh.new(); bm.from_mesh(o.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.to_mesh(o.data); bm.free()
        C.shade_by_angle(o, 35)
    if V31 and lod == 0:
        # rounded strake and plate edges (closed parts only, see mark_bevel_edges)
        n = mark_bevel_edges(po, 30)
        C.bevel(po, width=0.003, segments=2, angle_deg=30, limit="WEIGHT")
        print(f"[v3] bevel RearParts: {n} edges", flush=True)
    if frame is not None:
        V2.join_into(po, [frame])            # after the RearParts bevel: the frame carries its own round-over
    return to, bo, po


# v3.2 rear smile (d_033). Rear face below the tail-light lip (measured on the v3.1 GLB): lip at
# z -1.930 for y 0.29-0.33, a recessed white field z -1.895 for |x| < 0.60, y 0.10-0.28, carbon below.
SM_X, SM_Y0, SM_Y1, SM_ZREC = 0.60, 0.100, 0.281, -1.895


def smile_edges(u):
    """Top / bottom edge height of the lens at u = x / SM_X in [-1, 1] (d_033): a long, nearly
    constant-height pill - straight top just under the lip, flat bottom a little above the recess
    floor that sweeps up only over the outer fifth into rounded tips at the top corners (keeps the
    dark wedges under the tips small)."""
    a = abs(u)
    top = 0.262 - 0.006 * a ** 2
    s = min(1.0, max(0.0, (a - 0.78) / 0.22))
    s = s * s * (3 - 2 * s)
    bot = 0.114 + (top - 0.114) * s ** 0.8
    return top, bot


def band(inner, outer, z0, z1, closed):
    """Closed slab between two (x, y) polylines of equal length, front face at z0, back at z1."""
    n = len(inner)
    v = [(x, y, z0) for x, y in inner] + [(x, y, z0) for x, y in outer] + \
        [(x, y, z1) for x, y in inner] + [(x, y, z1) for x, y in outer]
    I, O, Ib, Ob = 0, n, 2 * n, 3 * n
    f = []
    for i in range(n if closed else n - 1):
        j = (i + 1) % n
        f += [(I + i, O + i, O + j, I + j), (Ib + i, Ib + j, Ob + j, Ob + i),
              (O + i, Ob + i, Ob + j, O + j), (I + i, I + j, Ib + j, Ib + i)]
    if not closed:
        for k in (0, n - 1):
            f.append((I + k, Ib + k, Ob + k, O + k))
    return v, f


def build_smile(parts, lod):
    """Lens let into the recess plane (the v3.2 lens sat on a dark rectangle
    with a 6 mm step and a 30 mm dome and read as stuck on). Now: a flat pillow, 1.5 mm edge and
    at most 10 mm crown with rounded shoulders, standing on the recess field; dark only as a 6 mm
    shadow seam around the contour and as the carbon strip under the lens bottom down to the recess
    floor (d_033: the area above the lens is white, below it dark). Returns the z of the lens front
    at the plate (the plate is mounted on the lens)."""
    zr = SM_ZREC
    nu, nv = (72, 12) if lod == 0 else (28, 5)
    us = [math.copysign(abs(t) ** 0.8, t) for t in np.linspace(-0.995, 0.995, nu + 1)]

    def crown(u, t):
        across = max(0.0, 1 - (2 * t - 1) ** 4) ** 0.5           # flat top, rounded shoulders
        along = max(0.0, 1 - abs(u) ** 6) ** 0.5
        return 0.0015 + 0.0085 * across * along

    front, back = [], []
    for u in us:
        top, bot = smile_edges(u)
        for j in range(nv + 1):
            t = j / nv
            y = bot + (top - bot) * t
            front.append((u * SM_X, y, zr - crown(u, t)))
            back.append((u * SM_X, y, zr + 0.004))
    n = len(front)
    verts = front + back
    faces = []
    W = nv + 1
    for i in range(nu):
        for j in range(nv):
            a, b, c, d = i * W + j, (i + 1) * W + j, (i + 1) * W + j + 1, i * W + j + 1
            faces.append((a, d, c, b))                       # front faces -z (towards the rear)
            faces.append((a + n, b + n, c + n, d + n))
    for i in range(nu):                                      # bottom and top walls
        for j in (0, nv):
            a, b = i * W + j, (i + 1) * W + j
            faces.append((a, b, b + n, a + n) if j == 0 else (a, a + n, b + n, b))
    for i in (0, nu):                                        # end walls
        for j in range(nv):
            a, d = i * W + j, i * W + j + 1
            faces.append((a, a + n, d + n, d) if i == 0 else (a, d, d + n, a + n))
    add_mesh(parts, verts, faces, 2)

    # dark seam: the lens outline (top left->right, bottom right->left) offset outwards by 6 mm
    outline = [(u * SM_X, smile_edges(u)[0]) for u in us] + [(u * SM_X, smile_edges(u)[1]) for u in reversed(us)]
    m = len(outline)
    off = []
    for k in range(m):
        (x0, y0), (x1, y1) = outline[k - 1], outline[(k + 1) % m]
        tx, ty = x1 - x0, y1 - y0
        ln = math.hypot(tx, ty) or 1.0
        nx, ny = -ty / ln, tx / ln                           # clockwise outline -> outward = left
        x, y = outline[k]
        off.append((max(-SM_X + 0.002, min(SM_X - 0.002, x + 0.006 * nx)), min(SM_Y1 - 0.004, y + 0.006 * ny)))
    v, f = band(outline, off, zr - 0.0007, zr + 0.003, True)
    add_mesh(parts, v, f, 3)
    # carbon strip below the lens down to the recess floor (reaches the tips at the corners)
    lower = [(u * SM_X, smile_edges(u)[1] - 0.004) for u in us]
    floor = [(u * SM_X, SM_Y0 + 0.001) for u in us]
    v, f = band(floor, lower, zr - 0.0006, zr + 0.003, False)
    add_mesh(parts, v, f, 3)
    # lens front at the plate centre height (u = 0)
    top, bot = smile_edges(0.0)
    return zr - crown(0.0, (0.176 - bot) / (top - bot))


# v3.3 diffuser surround (stream ramp frames r_029-r_032, d_033): a carbon U-frame under the smile
# whose rear face lies 2 cm behind the nozzle exits (contract z -2.05), so the nozzle row sits set back
# in a dark zone; a back wall closes the opening behind the nozzle cans, short vertical fins below the
# nozzles stand for the diffuser fins / fan grille, and a sloped carbon lip runs from the smile floor to the frame top.
DF_X, DF_XI, DF_Y0, DF_Y1, DF_YI0, DF_YI1 = 0.60, 0.50, -0.35, 0.070, -0.31, 0.020
DF_Z0, DF_Z1, DF_ZW = -1.99, -2.07, -1.955


def build_diffuser_frame(parts, lod):
    ch = 0.07                                    # chamfered upper corners (stream: angled shoulders beside the nozzle row)
    outer = [(-DF_X, DF_Y0), (-DF_X, DF_Y1 - ch), (-DF_X + ch, DF_Y1), (DF_X - ch, DF_Y1), (DF_X, DF_Y1 - ch), (DF_X, DF_Y0)]
    chi = 0.05
    inner = [(-DF_XI, DF_YI0), (-DF_XI, DF_YI1 - chi), (-DF_XI + chi, DF_YI1), (DF_XI - chi, DF_YI1), (DF_XI, DF_YI1 - chi), (DF_XI, DF_YI0)]
    # ring = band between the two outlines (closed), front face at the rear (z1), back at z0
    v, f = band(inner, outer, DF_Z1, DF_Z0, True)
    add_mesh(parts, v, f, 3)
    # back wall behind the nozzle cans (between frame and the recessed diffuser cap)
    v, f = box(0, 0.5 * (DF_Y0 + DF_Y1), 0.5 * (DF_ZW + DF_Z0) - 0.003, 2 * DF_X, DF_Y1 - DF_Y0, DF_Z0 - DF_ZW + 0.006)
    add_mesh(parts, v, f, 3)
    # sloped lip: smile floor (y SM_Y0 + 0.004, z just behind the recess) down to the frame top edge
    th = 0.012
    a0, a1 = (SM_Y0 + 0.004, SM_ZREC - 0.004), (DF_Y1, DF_Z1)
    lip = [(-DF_X, a0[0], a0[1]), (DF_X, a0[0], a0[1]), (DF_X - ch, a1[0], a1[1]), (-DF_X + ch, a1[0], a1[1])]
    lip += [(x, y - th, z) for x, y, z in lip]
    add_mesh(parts, lip, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)], 3)
    # short vertical fins below the nozzle row (d_007: low diffuser fins; stream: grille under the nozzles)
    for x in np.linspace(-0.40, 0.40, 5 if lod == 0 else 3):
        v, f = box(x, 0.5 * (DF_YI0 + (-0.255)), 0.5 * (DF_ZW + DF_Z1) - 0.002, 0.012, -0.255 - DF_YI0, DF_ZW - DF_Z1 - 0.008)
        add_mesh(parts, v, f, 3)


# v3.4 surround (stream r_029-r_031, 0-60 z_011): the black zone under the smile is a soft shape -
# straight top under the plate, shoulders sweeping down and out, sides drawn in towards the bottom,
# all corners rounded, 8 mm round-overs on its edges instead of the v3.3 outline with flat chamfers.
DF4_OUT = [(-0.53, -0.35), (-0.565, -0.20), (-0.60, -0.07), (-0.55, 0.02), (-0.40, 0.07), (0.0, 0.07),
           (0.40, 0.07), (0.55, 0.02), (0.60, -0.07), (0.565, -0.20), (0.53, -0.35), (0.0, -0.35)]
DF4_IN = [(-0.465, -0.31), (-0.49, -0.20), (-0.515, -0.09), (-0.47, -0.01), (-0.36, 0.02), (0.0, 0.02),
          (0.36, 0.02), (0.47, -0.01), (0.515, -0.09), (0.49, -0.20), (0.465, -0.31), (0.0, -0.31)]


def build_diffuser_frame_v34(M, root, lod):
    it = 3 if lod == 0 else 2
    outer, inner = chaikin(DF4_OUT, it), chaikin(DF4_IN, it)
    parts = ([], [], [])
    # flat face like v3.3 (d_033: straight-faced black zone), soft outline, rounded-over edges
    v, f = band(inner, outer, DF_Z1, DF_Z0, True)
    add_mesh(parts, v, f, 0)
    # back wall behind the nozzle cans, only as wide as the opening (hidden behind the bezel)
    v, f = box(0, 0.5 * (DF_YI0 + DF_YI1), 0.5 * (DF_ZW + DF_Z0) - 0.003, 1.06, DF_YI1 - DF_YI0 + 0.02, DF_Z0 - DF_ZW + 0.006)
    add_mesh(parts, v, f, 0)
    # sloped lip from the smile floor to the straight top of the surround
    th = 0.012
    a0, a1 = (SM_Y0 + 0.004, SM_ZREC - 0.004), (DF_Y1, DF_Z1)
    lip = [(-DF_X, a0[0], a0[1]), (DF_X, a0[0], a0[1]), (0.46, a1[0], a1[1]), (-0.46, a1[0], a1[1])]
    lip += [(x, y - th, z) for x, y, z in lip]
    add_mesh(parts, lip, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)], 0)
    for x in np.linspace(-0.40, 0.40, 5 if lod == 0 else 3):
        v, f = box(x, 0.5 * (DF_YI0 + (-0.255)), 0.5 * (DF_ZW + DF_Z1) - 0.002, 0.012, -0.255 - DF_YI0, DF_ZW - DF_Z1 - 0.008)
        add_mesh(parts, v, f, 0)
    ob = C.mesh_object("DiffuserFrame", C.to_blender(parts[0]), parts[1], [M["T"]], parts[2], parent=root)
    bm = bmesh.new(); bm.from_mesh(ob.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.to_mesh(ob.data); bm.free()
    if lod == 0:
        C.bevel(ob, width=0.008, segments=3, angle_deg=40)
    C.shade_by_angle(ob, 35)
    return ob


def build_marker(M, root):
    L3 = json.load(open(os.path.join(HERE, "cameras.json")))["lm3"]
    x, y, z = L3.get("side_marker", [0.92, 0.15, -1.63])
    v, f = [], []
    for sgn in (1, -1):
        b = len(v)
        v += [(sgn * (abs(x) + 0.004), y - 0.008, z + 0.10), (sgn * (abs(x) + 0.004), y + 0.008, z + 0.10),
              (sgn * (abs(x) + 0.004), y + 0.012, z - 0.10), (sgn * (abs(x) + 0.004), y - 0.004, z - 0.10)]
        f.append(tuple(b + i for i in ((0, 1, 2, 3) if sgn > 0 else (3, 2, 1, 0))))
    return C.mesh_object("Light_Marker", C.to_blender(v), f, [M["LEDM"]], parent=root)


def stowed_blade(bvh, span, z0, zt, q, lod):
    """v3.3 (stream: wing stowed flush): the blade skin is sampled on the body deck (rays from
    above), 2.5 mm proud and 8 mm thick, and its trailing edge ends 3 mm ahead of the tail plane, so the
    stowed wing reads as part of the deck with the tail edge as its trailing edge. Returns verts, faces,
    face materials (0 paint, 1 carbon), blade pivot (1/4 chord, centreline) and its height."""
    nx, nz = (32, 10) if lod == 0 else (10, 4)
    z1 = zt + 0.003
    xs = [-span + 2 * span * i / nx for i in range(nx + 1)]
    zs = [z0 + (z1 - z0) * j / nz for j in range(nz + 1)]
    H = np.full((nx + 1, nz + 1), np.nan)
    for i, x in enumerate(xs):
        for j, z in enumerate(zs):
            h = ray(bvh, (x, 1.5, z), (0, -1, 0))
            if h is not None:
                H[i, j] = h[0].y
    for j in range(nz + 1):                      # fill misses along the span from the neighbours
        col = H[:, j]; ok = ~np.isnan(col)
        col[~ok] = np.interp(np.flatnonzero(~ok), np.flatnonzero(ok), col[ok])
    # crowned deck: even quartic in x per chord row (the raw hits carry 1-2 cm kinks at the tail edge
    # from the band corners, which would make the trailing edge wavy)
    X = np.array(xs)
    A = np.stack([np.ones_like(X), X ** 2, X ** 4], 1)
    for j in range(nz + 1):
        H[:, j] = A @ np.linalg.lstsq(A, H[:, j], rcond=None)[0]
    top, th = 0.0025, 0.008
    verts = []
    for i, x in enumerate(xs):
        for j, z in enumerate(zs):
            verts += [(x, H[i, j] + top, z), (x, H[i, j] + top - th, z)]
    W = nz + 1
    def vid(i, j, lo):
        return 2 * (i * W + j) + lo
    faces, fm = [], []
    for i in range(nx):
        for j in range(nz):
            faces.append((vid(i, j, 0), vid(i, j + 1, 0), vid(i + 1, j + 1, 0), vid(i + 1, j, 0))); fm.append(0)
            faces.append((vid(i, j, 1), vid(i + 1, j, 1), vid(i + 1, j + 1, 1), vid(i, j + 1, 1))); fm.append(1)
    for i in range(nx):                          # leading (carbon seam) and trailing edge (paint)
        faces.append((vid(i, 0, 0), vid(i + 1, 0, 0), vid(i + 1, 0, 1), vid(i, 0, 1))); fm.append(1)
        faces.append((vid(i, nz, 0), vid(i, nz, 1), vid(i + 1, nz, 1), vid(i + 1, nz, 0))); fm.append(0)
    for j in range(nz):                          # tips
        faces.append((vid(0, j, 0), vid(0, j, 1), vid(0, j + 1, 1), vid(0, j + 1, 0))); fm.append(1)
        faces.append((vid(nx, j, 0), vid(nx, j + 1, 0), vid(nx, j + 1, 1), vid(nx, j, 1))); fm.append(1)
    zq = z0 + (z1 - z0) * q
    yq = float(np.interp(zq, zs, H[nx // 2])) + top
    return verts, faces, fm, Vector((0.0, yq, zq)), yq


def build_wing(M, root, bq, lod, bvh=None):
    """Wing = Empty at the contract hinge; blade lies flush on the rear deck when stowed. Swan-neck
    struts (two per side link) attach to the blade from above; Wing_Blade pivots at 1/4 chord."""
    hinge = Vector((0.0, 0.455, -1.50))
    wing = C.empty("Wing", B(*hinge), root, size=0.1)
    zt = bq.z_of(bq.b.ns - 2)
    # deck surface heights under the blade span (sample the body at the centreline and at the edge)
    chord_z0, chord_z1 = -1.72, zt + 0.004
    span = abs(bq.point(bq.b.ns - 2, 7).x) - 0.10
    ys = []
    for zz in (chord_z0, chord_z1):
        s = int(np.argmin(np.abs(bq.G[:, :, 2].mean(1) - zz)))
        ys.append(float(bq.G[s, :, 1].max()))
    nsx = 24 if lod == 0 else 8
    verts, faces, fm = [], [], []
    th = 0.010
    q = 0.25
    zq = chord_z0 + (chord_z1 - chord_z0) * q
    yq = ys[0] + (ys[1] - ys[0]) * q
    blade_pivot = Vector((0.0, yq + 0.002, zq))
    for i in range(nsx + 1):
        x = -span + 2 * span * i / nsx
        bend = 0.012 * (abs(x) / span) ** 2
        for (zz, yy) in ((chord_z0, ys[0]), (chord_z1, ys[1])):
            verts.append((x, yy + 0.006 + 0 * bend, zz))
            verts.append((x, yy + 0.006 - th, zz))
    for i in range(nsx):
        a = 4 * i; b = 4 * (i + 1)
        faces += [(a, b, b + 2, a + 2), (a + 1, a + 3, b + 3, b + 1), (a + 2, b + 2, b + 3, a + 3), (a, a + 1, b + 1, b)]
        fm += [0, 1, 1, 1]
    faces += [(0, 2, 3, 1), (4 * nsx, 4 * nsx + 1, 4 * nsx + 3, 4 * nsx + 2)]
    fm += [1, 1]
    if V33 and bvh is not None:
        verts, faces, fm, blade_pivot, yq = stowed_blade(bvh, span, chord_z0, zt, q, lod)
    verts = [tuple(Vector(p) - blade_pivot) for p in verts]
    blade_root = C.empty("Wing_BladePivot", B(*(blade_pivot - hinge)), wing, size=0.05)
    blade = C.mesh_object("Wing_Blade", C.to_blender(verts), faces, [M["W"], M["D"]], fm, parent=wing,
                          loc=B(*(blade_pivot - hinge)))
    bpy.data.objects.remove(blade_root)
    # swan-neck struts: from the deck pivot below, arching up and back to the blade top surface
    sv, sf = [], []
    for sgn in (1, -1):
        x = sgn * 0.42
        pts = []
        for t in np.linspace(0, 1, 10 if lod == 0 else 5):
            zz = -1.52 + (zq - 0.03 + 1.52) * t
            yy = 0.36 + (yq - 0.045 - 0.36) * math.sin(0.5 * math.pi * t)
            pts.append((x, yy, zz))
        v, f = strip(pts, (1, 0, 0), 0.018, (0, 1, 0), 0.03)
        b0 = len(sv); sv += v; sf += [tuple(b0 + i for i in fc) for fc in f]
    sv = [tuple(Vector(p) - hinge) for p in sv]
    struts = C.mesh_object("Wing_Struts", C.to_blender(sv), sf, [M["D"]], parent=wing)
    for o in (blade, struts):
        bm = bmesh.new(); bm.from_mesh(o.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.to_mesh(o.data); bm.free()
        C.shade_by_angle(o, 35)
    return wing


# v3.4: softer rear
REAR_BEVEL_Y = 1.62    # Blender y (= -z car) behind which body creases get the large radius


def rear_bevel_weight(e):
    """Bevel width factor per body edge: 1.0 (10 mm) behind the rear axle line, 0.2 (2 mm, v3.3) elsewhere."""
    y = 0.5 * (e.verts[0].co.y + e.verts[1].co.y)
    return 1.0 if y > REAR_BEVEL_Y else 0.2


def satin_black(M):
    """Stream (ramp wash light, 0-60 side light): the black rear parts read dark grey with soft sheen,
    not as a mirror of the dark hall. Trim and plastic get a little more albedo and a rougher coat."""
    p = C._bsdf(M["T"])
    p.inputs["Base Color"].default_value = (0.028, 0.028, 0.030, 1.0)
    p.inputs["Roughness"].default_value = 0.42
    p.inputs["Coat Weight"].default_value = 0.35
    p.inputs["Coat Roughness"].default_value = 0.22
    p = C._bsdf(M["P"])
    p.inputs["Base Color"].default_value = (0.034, 0.034, 0.036, 1.0)
    p.inputs["Roughness"].default_value = 0.55


def chaikin(pts, it):
    """Closed-polygon corner rounding (Chaikin): each pass cuts every corner at 1/4 and 3/4."""
    for _ in range(it):
        out = []
        for i in range(len(pts)):
            (x0, y0), (x1, y1) = pts[i], pts[(i + 1) % len(pts)]
            out += [(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1), (0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1)]
        pts = out
    return pts


# ---------------------------------------------------------------- build
def build(lod=0):
    C.reset_scene()
    V2.read_shared_config()
    spec = SF.load_spec(SPEC_PATH)
    spec.update(json.load(open(os.path.join(HERE, "regions.json"))))
    if V31:
        # door scoop centred ahead of the rear-fender port, below the waist (design params s, p)
        spec["door_scoop"] = {"s": 9.55, "ds": 1.25, "p": 4.55, "dp": 1.05, "depth": 0.016}
    M = V2.make_materials(lod)
    if V34:
        satin_black(M)
    mi = {k: i for i, k in enumerate(MAT_KEYS)}
    root = C.empty("Roadster", (0, 0, 0))
    verts, faces, info = body_faces(spec, lod)
    # --- body shell (everything except doors), glass split off afterwards
    bm = make_bm(verts, faces, info, {("body", 1), ("body", -1)}, mi)
    outward(bm)
    shrink_open_boundary(bm, 0.0025)
    body = bm_object("Body", bm, M, root)
    if "nosolid" not in DEBUG:
        solidify(body, 0.018, M)
        if V31:
            clamp_to_caps(body, spec)
    print("[v3] body signed volume:", fix_volume(body), flush=True)
    gl = [MAT_KEYS.index("G"), MAT_KEYS.index("G") + len(MAT_KEYS)]
    if V34:
        # 10 mm radii on the creases behind the rear axle (tail edge, band lips, rear corners), 2 mm elsewhere
        finish(body, lod, bevel=True, width=0.010, skip_mats=gl, weight_fn=rear_bevel_weight)
    else:
        finish(body, lod, bevel=V31, width=0.002, skip_mats=gl)
    # --- doors (pivot on the roof hinge line, contract)
    doors = []
    for sd, name in ((1, "Door_L"), (-1, "Door_R")):
        dbm = make_bm(verts, faces, info, {("door", sd)}, mi)
        shrink_open_boundary(dbm, 0.0025)
        outward(dbm)
        door = bm_object(name, dbm, M, root, loc=(sd * 0.60, 0.62, 0.15))
        solidify(door, 0.022, M)
        finish(door, lod, bevel=V31, width=0.002, skip_mats=gl)
        doors.append(door)
    # --- wheel wells, details
    wv, wf = V2.build_wells(M)
    wells = C.mesh_object("Wells", wv, wf, [M["Well"]], parent=root)
    bq = BodyQuery(spec)
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body, dg)
    capob = build_caps(spec, M, root, lod)
    head, front = build_front(M, root, bq, bvh, lod)
    tail, brake, rear = build_rear(M, root, bq, lod)
    marker = build_marker(M, root)
    interior, seat, yoke = V2.build_interior(M, root, lod)
    V2.join_into(body, [wells, front, rear, interior, capob])
    for wid in V2.WHEELS:
        WV.build_wheel(wid, M, root, lod)
    wing = build_wing(M, root, bq, lod, bvh)
    for ob in [body, *doors, seat, yoke] + list(wing.children):
        C.box_uv(ob, 1.0)
    V2.build_nozzle_empties(root)
    return root


def main():
    args = C.args_after_dashdash()
    lod = int(args[args.index("--lod") + 1]) if "--lod" in args else 0
    global SPEC_PATH, V31, SMILE, V33, V34
    V34 = "--v34" in args
    V33 = "--v33" in args or V34
    SMILE = "--v32" in args or V33
    V31 = "--v31" in args or SMILE
    if V31:
        SPEC_PATH = os.path.join(HERE, "body_spec_v31.json")
    if "--spec" in args:
        SPEC_PATH = args[args.index("--spec") + 1]
    tag = "v34" if V34 else "v33" if V33 else "v32" if SMILE else ("v31" if V31 else "v3")
    default = f"roadster_{tag}.glb" if lod == 0 else f"roadster_{tag}_lod1.glb"
    out = args[args.index("--out") + 1] if "--out" in args else os.path.join(ROOT, "public", "assets", "car", default)
    build(lod)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    print(f"[v3] LOD{lod} triangles: {C.triangle_count(meshes)}", flush=True)
    C.export_glb(out)
    print(f"[v3] wrote {out} ({os.path.getsize(out) / 1e6:.2f} MB)", flush=True)
    if "--save-blend" in args:
        bpy.ops.wm.save_as_mainfile(filepath=args[args.index("--save-blend") + 1])


if __name__ == "__main__":
    main()
