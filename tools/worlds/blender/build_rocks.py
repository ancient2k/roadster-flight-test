"""Asset pipeline worlds: boulder sets for instancing (public/assets/worlds/_shared/rocks_<set>.glb).

  Blender -b --factory-startup -P tools/worlds/blender/build_rocks.py -- --set moon|desert|mars|stonehenge

Per set 6 variants as separate mesh nodes Rock_0..5 with ONE material (InstancedMesh per variant):
  0,1 rounded (Moon: rounded by micrometeorites), 2,3 angular, 4 flat slab, 5 elongated.
Size normalised to ~1 m diameter (scale per instance, e.g. 0.2–3 m), origin = ground plane;
the boulders sit ~12 % of their height in the ground (minY < 0, on purpose) so they do not "rest on top".
Geometry: convex hull of random points (fracture faces) -> subdivided 2x -> noise -> decimated (~400–700 triangles).
"""
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "blender", "env"))
import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Vector, noise  # noqa: E402

import env_common as E  # noqa: E402

A = E.args()
SET = A[A.index("--set") + 1] if "--set" in A else "moon"
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT = os.path.join(ROOT, "public", "assets", "worlds", "_shared")
CC = os.path.join(HERE, "..", "downloads", "_cc0")

STYLE = {   # texture, colour, rounding
    "moon": dict(src="rock_boulder_dry", desat=1.0, gain=0.55, tint=(1.0, 0.98, 0.95), round=0.55, rough=0.9),
    "desert": dict(src="rock_boulder_dry", desat=0.3, gain=1.0, tint=(1.0, 0.9, 0.75), round=0.3, rough=0.85),
    "mars": dict(src="rock_face_03", desat=0.15, gain=0.85, tint=(1.0, 0.82, 0.7), round=0.3, rough=0.85),
    "stonehenge": dict(src="rock_boulder_dry", desat=0.75, gain=0.85, tint=(0.95, 0.95, 0.9), round=0.25, rough=0.85),
}[SET]


def cc(name, m):
    return os.path.join(CC, name, f"{name}_{m}_2k.jpg")


def rock(name, seed, shape):
    r = random.Random(seed)
    sx, sy, sz = {"round": (1, 0.75, 0.9), "angular": (1, 0.8, 0.85), "slab": (1.1, 0.35, 0.9), "long": (1.4, 0.6, 0.65)}[shape]
    pts = []
    for _ in range(36 if shape != "round" else 70):
        v = Vector((r.gauss(0, 1), r.gauss(0, 1), r.gauss(0, 1))).normalized()
        k = r.uniform(0.85, 1.0)
        pts.append(Vector((v.x * sx * 0.5 * k, v.y * sz * 0.5 * k, v.z * sy * 0.5 * k)))
    bm = bmesh.new()
    for p in pts:
        bm.verts.new(p)
    bmesh.ops.convex_hull(bm, input=bm.verts)
    for _ in range(2):
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=1, use_grid_fill=True)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    rnd = STYLE["round"] * (1.3 if shape == "round" else 0.6)
    off = Vector((seed * 3.1, seed * 1.7, 0))
    for v in bm.verts:
        p = v.co
        # round off towards an ellipsoid + noise (coarse + fine)
        ell = Vector((p.x / sx, p.y / sz, p.z / sy)).normalized() * 0.5
        ell = Vector((ell.x * sx, ell.y * sz, ell.z * sy))
        p2 = p.lerp(ell, rnd)
        n = p2.normalized()
        p2 += n * (noise.noise(p2 * 3.0 + off) * 0.06 + noise.noise(p2 * 9.0 + off) * 0.015)
        v.co = p2
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    E.link(ob)
    # set into the ground: lower edge at -12 % of the height
    zs = [v.co.z for v in me.vertices]
    h = max(zs) - min(zs)
    for v in me.vertices:
        v.co.z -= min(zs) + 0.12 * h
    E.decimate(ob, 0.45)
    for p in me.polygons:
        p.use_smooth = True
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    ob.select_set(False)
    me.materials.append(bpy.data.materials["Rock"])
    return ob


def build():
    E.reset()
    s = STYLE
    d = E.prep_tex(cc(s["src"], "diff"), f"rock_{SET}_diff.jpg", desat=s["desat"], gain=s["gain"], tint=s["tint"], size=1024)
    a = E.prep_data(cc(s["src"], "arm"), f"rock_{SET}_arm.jpg", size=1024, rough_scale=0.5, rough_add=s["rough"] * 0.5, metal=0.0)
    n = E.prep_data(cc(s["src"], "nor_gl"), f"rock_{SET}_nor.jpg", size=1024)
    E.material("Rock", diff=d, arm=a, nor=n, normal_strength=1.2)
    root = E.empty(f"Rocks_{SET}", (0, 0, 0))
    total = 0
    for i, shape in enumerate(["round", "round", "angular", "angular", "slab", "long"]):
        ob = rock(f"Rock_{i}", 100 + i * 7 + len(SET), shape)
        ob.parent = root
        total += E.tris(ob)
        print(f"[ws-f] Rock_{i} ({shape}): {E.tris(ob)} tris")
    E.export_glb(f"rocks_{SET}", out_dir=OUT)


build()
