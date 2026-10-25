"""Asset pipeline worlds: pyramids of Giza + Sphinx (public/assets/worlds/earth_giza/*.glb).

  Blender -b --factory-startup -P tools/worlds/blender/build_giza.py [-- --lod 1]

Dimensions (present state, Lehner/Hawass "Giza and the Pyramids", Petrie survey):
  Khufu    base 230.34 m, slope 51.84°, originally 146.6 m, today 138.5 m (platform ~10 m),
           casing missing -> stepped core (~0.7–1.5 m courses), survey mast on the top.
  Khafre   base 215.25 m, slope 53.13°, originally 143.5 m, today 136.4 m; top ~25 % with
           its smooth Tura limestone casing preserved.
  Menkaure 102.2 x 104.6 m, slope 51.34°, originally 65.5 m, today 61 m; lower courses with
           rose granite casing, breach in the north face.
  Sphinx   73 m long, 20 m high, 19 m wide, faces east (local +Z), modelled in simplified form.
glTF frame: origin = base centre at ground level, sides axis-aligned (north = -Z). One mesh per file.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "blender", "env"))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector, noise  # noqa: E402

import env_common as E  # noqa: E402

LOD = E.lod_arg()
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT = os.path.join(ROOT, "public", "assets", "worlds", "earth_giza")
CC = os.path.join(HERE, "..", "downloads", "_cc0")


def cc(name, m):
    return os.path.join(CC, name, f"{name}_{m}_2k.jpg")


def mat_limestone(name, src="large_sandstone_blocks_01", tint=(1.0, 0.93, 0.8), gain=1.0, desat=0.55, tile=6.0, nstr=1.0):
    d = E.prep_tex(cc(src, "diff"), f"giza_{name}_diff.jpg", desat=desat, gain=gain, tint=tint, size=1024)
    a = E.prep_data(cc(src, "arm"), f"giza_{name}_arm.jpg", size=1024, metal=0.0)
    n = E.prep_data(cc(src, "nor_gl"), f"giza_{name}_nor.jpg", size=1024)
    return E.material(name, diff=d, arm=a, nor=n, normal_strength=nstr, tile=tile)


UVU, UVV = 4.6, 2.3      # texture large_sandstone_blocks_01: ~3 block rows per tile -> 3 courses of ~0.75 m


def stepped_pyramid(mb, base_x, base_z, slope_deg, h_now, course=0.75, segs=8, inset=1.2, erosion=0.35,
                    casing_from=None, casing_mat="Casing", core_mat="Limestone", granite_to=0.0, seed=1):
    """Stepped pyramid core: per course a vertical riser ring + tread, eroded edges.
    casing_from: smooth casing faces above this height (Khafre). granite_to: granite casing up to this height."""
    t = 1.0 / math.tan(math.radians(slope_deg))
    n = int(h_now / course)
    r = np.random.default_rng(seed)
    taper = 14.0     # m below the casing over which the core's set-back runs out (no overhang under the casing)

    def setback(y):
        if casing_from is None:
            return inset
        u = min(1.0, max(0.0, (casing_from - y) / taper))
        return inset * u * u * (3 - 2 * u)

    def half(y):
        s = setback(y)
        return base_x / 2 - s - y * t, base_z / 2 - s - y * t

    def ring(y, dx, dz, k):
        """Perimeter points (corners + intermediate points) with erosion; k = course number (seed)."""
        pts = []
        corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
        for c in range(4):
            a, b = corners[c], corners[(c + 1) % 4]
            for s in range(segs):
                f = s / segs
                x = (a[0] + (b[0] - a[0]) * f) * dx
                z = (a[1] + (b[1] - a[1]) * f) * dz
                # erosion: set back inwards, stronger at the corners
                edge = min(f, 1 - f) if s else 0.0
                e = erosion * (0.5 + noise.noise(Vector((x * 0.08, y * 0.3, z * 0.08 + k))) + (0.9 if s == 0 else 0.0))
                e *= setback(y) / inset if inset > 0 else 1.0     # the core under the casing is intact
                nrm = Vector((x, 0, z))
                nrm = Vector((math.copysign(1, x) if abs(x) / dx > abs(z) / dz else 0, 0, math.copysign(1, z) if abs(z) / dz >= abs(x) / dx else 0))
                if s == 0:
                    nrm = Vector((a[0], 0, a[1])).normalized() * 1.4
                pts.append(Vector((x, y, z)) - nrm * max(e, 0) - Vector((0, 0, 0)))
        return pts

    prev_top = None
    for k in range(n):
        y0, y1 = k * course, (k + 1) * course
        if casing_from is not None and y1 > casing_from + 1e-6:
            break      # the core ends under the casing (a last course reaching into it poked through its faces)
        dx, dz = half(y0)
        if dx < 1.0:
            break
        bot = ring(y0, dx, dz, k)
        top = [p + Vector((0, course, 0)) for p in bot]
        mat = "Granite" if y1 <= granite_to else core_mat
        m = len(bot)
        u = 0.0
        for i in range(m):
            j = (i + 1) % m
            L = (bot[j] - bot[i]).length
            mb.poly([tuple(top[i]), tuple(top[j]), tuple(bot[j]), tuple(bot[i])], mat,
                    uvs=[(u / UVU, y1 / UVV), ((u + L) / UVU, y1 / UVV), ((u + L) / UVU, y0 / UVV), (u / UVU, y0 / UVV)])
            u += L
        # tread to the next (inset) course
        dx2, dz2 = half(y1)
        if dx2 > 1.0 and not (casing_from is not None and y1 >= casing_from):
            nxt = ring(y1, dx2, dz2, k + 1)
            for i in range(m):
                j = (i + 1) % m
                quad = [top[i], top[j], nxt[j], nxt[i]]
                mb.poly([tuple(p) for p in quad][::-1], mat, uvs=[(p.x / UVU, p.z / UVV) for p in quad][::-1])
        prev_top = (top, y1, dx, dz)
    top, ytop, dx, dz = prev_top
    if casing_from is not None:
        # smooth casing: frustum from casing_from to (almost) the apex, outside on the casing line
        hxc, hzc = base_x / 2 - (casing_from) * t, base_z / 2 - casing_from * t
        apex = h_now
        hxa, hza = max(base_x / 2 - apex * t, 0.6), max(base_z / 2 - apex * t, 0.6)
        lo = [Vector((sx * hxc, casing_from, sz * hzc)) for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        hi = [Vector((sx * hxa, apex, sz * hza)) for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        for i in range(4):
            j = (i + 1) % 4
            Lb, Ls = (lo[j] - lo[i]).length / 8, (hi[j] - lo[j]).length / 8
            mb.poly([tuple(hi[i]), tuple(hi[j]), tuple(lo[j]), tuple(lo[i])], casing_mat,
                    uvs=[(0, Ls), (Lb, Ls), (Lb, 0), (0, 0)])
        mb.poly([tuple(p) for p in hi][::-1], casing_mat)
        # underside of the casing, facing down (it was wound upward: culled from below, the open shell could be seen
        # into while driving up the face); the core's set-back has run out here, so it closes flush on the core
        mb.poly([tuple(p) for p in [Vector((sx * hxc, casing_from, sz * hzc)) for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]], core_mat)
    else:
        mb.poly([tuple(p) for p in top][::-1], core_mat, uvs=[(p.x / 6, p.z / 6) for p in top][::-1])   # summit platform
    return ytop


def khufu():
    E.reset()
    mat_limestone("Limestone", tint=(1.0, 0.88, 0.7), gain=1.25)
    E.material("Mast_Wood", (0.25, 0.2, 0.15), 0.0, 0.8)
    mb = E.MB()
    segs = 8 if LOD == 0 else 3
    yt = stepped_pyramid(mb, 230.34, 230.34, 51.84, 138.5, course=0.75, segs=segs, inset=1.4, seed=1)
    # survey mast (marks the original height of 146.6 m)
    mb.tube((0, yt, 0), (0, 146.6, 0), 0.08, "Mast_Wood", seg=6)
    for a in range(3):
        ang = a * 2.094
        mb.tube((math.cos(ang) * 2, yt, math.sin(ang) * 2), (0, yt + 4, 0), 0.03, "Mast_Wood", seg=4)
    ob = mb.build("Khufu")
    E.weather_colors(ob, 1, cell=1.6)
    print(f"[ws-f] khufu: {mb.tri_count()} tris")
    E.export_glb("giza_khufu", lod=LOD, out_dir=OUT, vertex_colors=True)


def khafre():
    E.reset()
    mat_limestone("Limestone", tint=(1.0, 0.88, 0.7), gain=1.2)
    mat_limestone("Casing", src="large_sandstone_blocks_01", tint=(1.0, 0.94, 0.84), gain=1.22, desat=0.8, tile=8.0, nstr=0.35)
    mb = E.MB()
    segs = 8 if LOD == 0 else 3
    stepped_pyramid(mb, 215.25, 215.25, 53.13, 136.4, course=0.8, segs=segs, inset=1.6, casing_from=105.0, seed=2)
    ob = mb.build("Khafre")
    E.weather_colors(ob, 2, cell=1.6)
    print(f"[ws-f] khafre: {mb.tri_count()} tris")
    E.export_glb("giza_khafre", lod=LOD, out_dir=OUT, vertex_colors=True)


def menkaure():
    E.reset()
    mat_limestone("Limestone", tint=(1.0, 0.86, 0.68), gain=1.15)
    gd = E.prep_tex(cc("rock_boulder_dry", "diff"), "giza_granite_diff.jpg", desat=0.6, gain=0.5, tint=(0.95, 0.7, 0.62), size=1024)
    ga = E.prep_data(cc("rock_boulder_dry", "arm"), "giza_granite_arm.jpg", size=1024, rough_scale=0.8, metal=0.0)
    gn = E.prep_data(cc("rock_boulder_dry", "nor_gl"), "giza_granite_nor.jpg", size=1024)
    E.material("Granite", diff=gd, arm=ga, nor=gn, tile=4.0)
    mb = E.MB()
    segs = 8 if LOD == 0 else 3
    stepped_pyramid(mb, 102.2, 104.6, 51.34, 61.0, course=0.7, segs=segs, inset=0.8, erosion=0.45, granite_to=8.0, seed=3)
    mb.build("Menkaure")
    ob = bpy.data.objects["Menkaure"]
    # breach in the north face (-Z): recess via a boolean box
    cut = bpy.data.objects.new("cut", bpy.data.meshes.new("cut"))
    E.link(cut)
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(cut.data)
    cut.scale = (9, 5, 16)            # Blender: x, y(=-z glTF), z(=y)
    cut.location = E.G(3, 18, -44.5)
    mod = ob.modifiers.new("bresche", "BOOLEAN")
    mod.object = cut
    mod.operation = "DIFFERENCE"
    with bpy.context.temp_override(object=ob, active_object=ob):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cut)
    E.weather_colors(ob, 3, cell=1.4)
    print(f"[ws-f] menkaure: {E.tris(ob)} tris")
    E.export_glb("giza_menkaure", lod=LOD, out_dir=OUT, vertex_colors=True)


def sphinx():
    """Simplified Sphinx from metaball volumes (body, paws, haunches, head with nemes), horizontally
    layered erosion, decimated. Faces local +Z."""
    E.reset()
    mat_limestone("Limestone", src="rock_boulder_dry", tint=(1.0, 0.86, 0.66), gain=0.95, desat=0.35, tile=5.0)
    mball = bpy.data.metaballs.new("SphinxMB")
    mball.resolution = 0.7 if LOD == 0 else 1.4
    mball.threshold = 0.6
    ob = bpy.data.objects.new("SphinxMB", mball)
    E.link(ob)

    def el(pos, size, kind="ELLIPSOID", stiff=2.0):
        e = mball.elements.new()
        e.type = kind
        e.co = E.G(*pos)
        e.radius = 1.0
        sx, sy, sz = size
        e.size_x, e.size_y, e.size_z = sx, sz, sy      # Blender: x, y(=glTF z), z(=glTF y)
        e.stiffness = stiff
    # body (back up to ~13 m), chest
    el((0, 7.5, -8), (9, 6.5, 20))
    el((0, 9.5, 8), (8, 7.0, 7))
    el((0, 7.0, -24), (8.5, 6.0, 7))           # haunches
    for sx in (-1, 1):
        el((sx * 6.5, 2.5, 18), (2.4, 2.0, 12))      # front paws (long, flat)
        el((sx * 7.5, 4.0, -20), (3.5, 4.0, 7))      # hind legs
        el((sx * 8.5, 7.5, 6), (2.6, 4.5, 4))        # shoulders
    el((0, 3.0, 0), (9.5, 3.0, 30), "CUBE", 1.0)      # plinth/belly
    el((0, 15.5, 10.5), (3.6, 4.6, 3.6))          # head
    el((0, 13.5, 9.0), (5.5, 3.5, 2.2))           # nemes headdress wings
    for sx in (-1, 1):
        el((sx * 3.8, 12.0, 10.0), (1.6, 4.0, 1.4))   # cloth lappets at the sides
    el((0, 18.8, 9.5), (2.8, 1.6, 3.0))           # top of the head
    el((0, 12.5, 12.0), (1.8, 2.0, 1.6))          # chin/beard base
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.convert(target="MESH")
    me_ob = bpy.context.view_layer.objects.active
    # horizontally layered erosion (Mokattam limestone beds): displacement along the normal, stepped in height
    me = me_ob.data
    me.calc_loop_triangles()
    for v in me.vertices:
        p = v.co
        layer = math.sin(p.z * 2.1) * 0.18 + math.sin(p.z * 5.3 + 1.0) * 0.07
        n3 = noise.noise(p * 0.35) * 0.35 + noise.noise(p * 1.3) * 0.08
        v.co = p + v.normal * (layer + n3 - 0.15) * (1.0 if p.z > 1.0 else 0.4)
    # cut off the base: clamp everything below y=0 to 0
    for v in me.vertices:
        if v.co.z < 0:
            v.co.z = 0.0
    E.decimate(me_ob, 0.5 if LOD == 0 else 0.25)
    # UVs: box projection in metres
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=5.0)
    bpy.ops.object.mode_set(mode="OBJECT")
    for poly in me.polygons:
        poly.use_smooth = True
    me.materials.append(bpy.data.materials["Limestone"])
    me_ob.name = "Sphinx"
    print(f"[ws-f] sphinx: {E.tris(me_ob)} tris")
    E.export_glb("giza_sphinx", lod=LOD, out_dir=OUT)


def queen(name, base, slope, h_now, seed, course=0.6, erosion=0.6, granite_to=0.0, casing_from=None):
    """Queens' pyramids (G1-a/b/c east of Khufu, G3-a/b/c south of Menkaure), ruined:
    stepped core without casing, eroded top, rubble cone at the foot."""
    E.reset()
    mat_limestone("Limestone", tint=(1.0, 0.87, 0.69), gain=1.15)
    if casing_from is not None:
        mat_limestone("Casing", src="large_sandstone_blocks_01", tint=(1.0, 0.93, 0.82), gain=1.18, desat=0.8, tile=6.0, nstr=0.4)
    mb = E.MB()
    segs = 8 if LOD == 0 else 3
    stepped_pyramid(mb, base, base, slope, h_now, course=course, segs=segs, inset=0.6, erosion=erosion, seed=seed,
                    casing_from=casing_from)
    # rubble at the foot: flat, irregular frustum ring of limestone debris
    rng = np.random.default_rng(seed + 50)
    for k in range(int(base * 1.2)):
        a = rng.uniform(0, 2 * math.pi)
        r = base / 2 + rng.uniform(-1.0, 3.5)
        x, z = math.cos(a) * r, math.sin(a) * r
        x, z = max(-base / 2 - 3, min(base / 2 + 3, x)), max(-base / 2 - 3, min(base / 2 + 3, z))
        sz = rng.uniform(0.5, 1.6)
        mb.box((x, sz * 0.35, z), (sz * rng.uniform(0.8, 1.6), sz * 0.7, sz * rng.uniform(0.8, 1.6)), "Limestone")
    ob = mb.build(name)
    E.weather_colors(ob, seed, cell=1.4)
    print(f"[r5] {name}: {mb.tri_count()} tris")
    E.export_glb(f"giza_{name}", lod=LOD, out_dir=OUT, vertex_colors=True)


def queens():
    queen("g1a", 49.5, 51.8, 24.0, 11)                      # Hetepheres I (?), heavily eroded
    queen("g1b", 49.0, 51.8, 22.0, 12)                      # Meritites I
    queen("g1c", 46.25, 51.8, 27.0, 13, erosion=0.45)       # Henutsen, best preserved
    queen("g3a", 44.3, 52.2, 22.0, 14, erosion=0.5)         # true pyramid, casing missing
    queen("g3b", 31.2, 58.0, 15.0, 15, course=3.4, erosion=0.8)   # step pyramid (4 steps visible)
    queen("g3c", 31.2, 58.0, 14.0, 16, course=3.4, erosion=0.8)


def sphinx2():
    """Sphinx from the SDF model (tools/worlds/sphinx_sdf.py -> downloads/earth_giza/sphinx_sdf.ply):
    marching-cubes surface, decimated, box UV in metres. Faces local +Z, y = 0 = enclosure floor."""
    E.reset()
    mat_limestone("Limestone", src="rock_boulder_dry", tint=(1.0, 0.85, 0.64), gain=0.95, desat=0.35, tile=5.0)
    ply = os.path.join(HERE, "..", "downloads", "earth_giza", "sphinx_sdf.ply")
    if not os.path.exists(ply):
        import subprocess
        subprocess.run([sys.executable if "python" in os.path.basename(sys.executable) else "python3",
                        os.path.join(HERE, "..", "sphinx_sdf.py"), ply], check=True)
    bpy.ops.wm.ply_import(filepath=ply)
    ob = bpy.context.view_layer.objects.active
    ob.data.transform(Matrix.Rotation(math.radians(90), 4, "X"))     # glTF y-up PLY -> Blender z-up
    E.decimate(ob, 0.16 if LOD == 0 else 0.05)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=5.0)
    bpy.ops.object.mode_set(mode="OBJECT")
    for poly in ob.data.polygons:
        poly.use_smooth = True
    ob.data.materials.append(bpy.data.materials["Limestone"])
    ob.name = "Sphinx"
    print(f"[r5] sphinx: {E.tris(ob)} tris")
    E.export_glb("giza_sphinx", lod=LOD, out_dir=OUT)


ONLY = E.args()[E.args().index("--only") + 1] if "--only" in E.args() else None
for nm, fn in (("khufu", khufu), ("khafre", khafre), ("menkaure", menkaure), ("sphinx", sphinx2), ("queens", queens)):
    if ONLY in (None, nm):
        fn()
