"""Asset pipeline worlds: EEVEE preview of a site from public/assets/worlds/<site>/ (terrain + landmarks + sun).

  Blender -b --factory-startup -P tools/worlds/blender/render_world.py -- --site earth_giza \
      --out out/renders/world_earth_giza.png [--cam x,y,z] [--target x,y,z] [--lens 35]
      [--crop 1600] [--res 1600x900] [--exposure 0] [--sun_strength 4] [--far]

Camera/target in local site coordinates (glTF: +X east, +Y up, -Z north; y relative to the terrain with --agl).
Terrain: window --crop (m) around the target at full resolution, horizon tile (--far) coarsely behind it.
"""
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


def arg(n, d=None, many=False):
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if many:
        return [a[i + 1] for i, x in enumerate(a) if x == n]
    return a[a.index(n) + 1] if n in a else d


def flag(n):
    return n in (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])


def G(x, y, z):
    return Vector((x, -z, y))


def load_h(d, t):
    from PIL import Image  # noqa  (not in Blender) -> fallback below
    return None


def read_png16(path):
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"
    w, h = img.size
    a = np.empty(w * h * img.channels, np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(h, w, img.channels)[::-1, :, 0]      # Blender: row 0 = bottom -> flip (row 0 = north)
    bpy.data.images.remove(img)
    return a.astype(np.float64)


def terrain_mesh(name, H, size, cx, cz, x0, x1, z0, z1, step, mat, yoff=0.0, hole=None):
    """Grid mesh from the height field H (row 0 = north) for the rectangle [x0,x1] x [z0,z1] (local), every step-th cell."""
    n = H.shape[0]
    mpp = size / (n - 1)
    c0 = max(int((x0 - cx) / mpp + (n - 1) / 2), 0)
    c1 = min(int((x1 - cx) / mpp + (n - 1) / 2), n - 1)
    r0 = max(int((z0 - cz) / mpp + (n - 1) / 2), 0)
    r1 = min(int((z1 - cz) / mpp + (n - 1) / 2), n - 1)
    cols = np.arange(c0, c1 + 1, step)
    rows = np.arange(r0, r1 + 1, step)
    X = cx + (cols - (n - 1) / 2) * mpp
    Z = cz + (rows - (n - 1) / 2) * mpp
    hh = H[np.ix_(rows, cols)] + yoff
    nr, nc = len(rows), len(cols)
    xv, zv = np.meshgrid(X, Z)
    verts = np.stack([xv.ravel(), zv.ravel() * -1, hh.ravel()], -1)      # Blender (x, -z, y)
    idx = np.arange(nr * nc).reshape(nr, nc)
    quads = np.stack([idx[:-1, :-1], idx[1:, :-1], idx[1:, 1:], idx[:-1, 1:]], -1).reshape(-1, 4)
    if hole is not None:      # leave out the rectangle (the finer tile lies there)
        hx0, hx1, hz0, hz1 = hole
        qx = xv[:-1, :-1].ravel()
        qz = zv[:-1, :-1].ravel()
        keep = ~((qx > hx0) & (qx < hx1 - (X[1] - X[0])) & (qz > hz0) & (qz < hz1 - (Z[1] - Z[0])))
        quads = quads[keep]
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts))
    me.vertices.foreach_set("co", verts.astype(np.float32).ravel())
    me.loops.add(quads.size)
    me.loops.foreach_set("vertex_index", quads.astype(np.int32).ravel())
    me.polygons.add(len(quads))
    me.polygons.foreach_set("loop_start", np.arange(0, quads.size, 4, dtype=np.int32))
    me.polygons.foreach_set("loop_total", np.full(len(quads), 4, np.int32))
    me.polygons.foreach_set("use_smooth", np.ones(len(quads), bool))
    uv = me.uv_layers.new(name="UVMap")
    u = ((xv - cx) / size + 0.5).ravel()
    v = (1 - ((zv - cz) / size + 0.5)).ravel()
    luv = np.stack([u[quads.ravel()], v[quads.ravel()]], -1).astype(np.float32)
    uv.data.foreach_set("uv", luv.ravel())
    me.update()
    me.validate()
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def terrain_material(d, t, detail=None):
    m = bpy.data.materials.new("Terrain")
    nt = m.node_tree
    p = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    p.inputs["Roughness"].default_value = 0.95
    if t.get("albedo"):
        tx = nt.nodes.new("ShaderNodeTexImage")
        tx.image = bpy.data.images.load(os.path.join(d, t["albedo"]))
        tx.extension = "EXTEND"
        if detail:
            # detail texture (tiling in metres) multiplied, normalised to a mean of 1
            tc = nt.nodes.new("ShaderNodeTexCoord")
            mp = nt.nodes.new("ShaderNodeMapping")
            mp.inputs["Scale"].default_value = (detail[1], detail[1], detail[1])
            nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
            dt = nt.nodes.new("ShaderNodeTexImage")
            dt.image = bpy.data.images.load(detail[0])
            nt.links.new(mp.outputs["Vector"], dt.inputs["Vector"])
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs["Factor"].default_value = 1.0
            gain = nt.nodes.new("ShaderNodeMath")
            nt.links.new(tx.outputs["Color"], mix.inputs[6])
            mul = nt.nodes.new("ShaderNodeVectorMath")
            mul.operation = "SCALE"
            mul.inputs["Scale"].default_value = detail[2]
            nt.links.new(dt.outputs["Color"], mul.inputs[0])
            nt.links.new(mul.outputs[0], mix.inputs[7])
            nt.links.new(mix.outputs[2], p.inputs["Base Color"])
            if len(detail) > 3 and detail[3]:
                nn = nt.nodes.new("ShaderNodeTexImage")
                nn.image = bpy.data.images.load(detail[3])
                nn.image.colorspace_settings.name = "Non-Color"
                nt.links.new(mp.outputs["Vector"], nn.inputs["Vector"])
                nm = nt.nodes.new("ShaderNodeNormalMap")
                nm.inputs["Strength"].default_value = 1.0
                nt.links.new(nn.outputs["Color"], nm.inputs["Color"])
                nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])
        else:
            nt.links.new(tx.outputs["Color"], p.inputs["Base Color"])
    return m


def far_material(base):
    m = bpy.data.materials.new("Far")
    p = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    p.inputs["Base Color"].default_value = (*base, 1)
    p.inputs["Roughness"].default_value = 0.95
    return m


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    site = arg("--site")
    d = os.path.join(ROOT, "public", "assets", "worlds", site)
    meta = json.load(open(os.path.join(d, "meta.json")))
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    w, h = (int(v) for v in arg("--res", "1600x900").split("x"))
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.eevee.taa_render_samples = int(arg("--samples", "48"))
    sc.eevee.use_raytracing = True
    sc.eevee.use_shadows = True
    sc.view_settings.view_transform = "AgX"
    try:
        sc.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    sc.view_settings.exposure = float(arg("--exposure", "0"))

    t = meta["tiles"]["near"]
    H = read_png16(os.path.join(d, t["heightmap"]))
    H = t["heightMinM"] + H * (t["heightMaxM"] - t["heightMinM"])
    n = H.shape[0]
    mpp = t["metersPerPixel"]

    def height(x, z):
        c = int(round(x / mpp + (n - 1) / 2))
        r = int(round(z / mpp + (n - 1) / 2))
        return float(H[min(max(r, 0), n - 1), min(max(c, 0), n - 1)])

    tgt = [float(v) for v in arg("--target", f"{meta['spawn']['x']},0,{meta['spawn']['z']}").split(",")]
    cam = [float(v) for v in arg("--cam", f"{tgt[0]},2,{tgt[2] + 30}").split(",")]
    if flag("--agl"):
        tgt[1] += height(tgt[0], tgt[2])
        cam[1] += height(cam[0], cam[2])
    if flag("--agl_cam"):          # only the camera relative to the terrain, the target absolute
        cam[1] += height(cam[0], cam[2])
    crop = float(arg("--crop", "1600"))
    det = arg("--detail")
    detail = None
    if det:
        p_, s_, g_, *nrm = det.split(",")
        detail = (os.path.join(ROOT, p_), float(s_), float(g_), os.path.join(ROOT, nrm[0]) if nrm else None)
    mat = terrain_material(d, t, detail)
    cx_, cz_ = tgt[0], tgt[2]
    step = int(arg("--step", "1"))
    terrain_mesh("Near", H, t["sizeM"], 0, 0, cx_ - crop / 2, cx_ + crop / 2, cz_ - crop / 2, cz_ + crop / 2, step, mat)
    # rest of the close-range tile coarser
    terrain_mesh("NearCoarse", H, t["sizeM"], 0, 0, -t["sizeM"] / 2, t["sizeM"] / 2, -t["sizeM"] / 2, t["sizeM"] / 2, 4, mat, yoff=-0.05,
                 hole=(cx_ - crop / 2, cx_ + crop / 2, cz_ - crop / 2, cz_ + crop / 2))
    if flag("--far") and "far" in meta["tiles"]:
        f = meta["tiles"]["far"]
        HF = read_png16(os.path.join(d, f["heightmap"]))
        HF = f["heightMinM"] + HF * (f["heightMaxM"] - f["heightMinM"])
        base = tuple(float(v) for v in arg("--farcolor", "0.1,0.1,0.1").split(","))
        terrain_mesh("Far", HF, f["sizeM"], f["centerX"], f["centerZ"], -f["sizeM"] / 2, f["sizeM"] / 2, -f["sizeM"] / 2, f["sizeM"] / 2, 1, far_material(base), yoff=-1.0,
                     hole=(-t["sizeM"] / 2, t["sizeM"] / 2, -t["sizeM"] / 2, t["sizeM"] / 2))

    def use_vcol(objs):
        """Preview: multiply COLOR_0 with the base colour like three.js."""
        for o in objs:
            if o.type != "MESH" or not o.data.color_attributes:
                continue
            an = o.data.color_attributes[0].name
            for slot in o.material_slots:
                m = slot.material
                if not m or m.get("_vc"):
                    continue
                m["_vc"] = 1
                nt2 = m.node_tree
                pb = next(nn for nn in nt2.nodes if nn.type == "BSDF_PRINCIPLED")
                ca = nt2.nodes.new("ShaderNodeVertexColor")
                ca.layer_name = an
                mx = nt2.nodes.new("ShaderNodeMix")
                mx.data_type = "RGBA"
                mx.blend_type = "MULTIPLY"
                mx.inputs["Factor"].default_value = 1.0
                src = pb.inputs["Base Color"].links[0].from_socket if pb.inputs["Base Color"].links else None
                if src:
                    nt2.links.new(src, mx.inputs[6])
                else:
                    mx.inputs[6].default_value = pb.inputs["Base Color"].default_value
                nt2.links.new(ca.outputs["Color"], mx.inputs[7])
                nt2.links.new(mx.outputs[2], pb.inputs["Base Color"])

    # landmarks
    for lm in meta["landmarks"]:
        p = os.path.join(d, lm["file"])
        if not os.path.exists(p):
            continue
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=p)
        new = [o for o in bpy.data.objects if o not in before]
        use_vcol(new)
        for o in [o for o in new if o.parent is None]:
            o.location = G(lm["x"], lm["y"], lm["z"])
            o.rotation_mode = "XYZ"
            o.rotation_euler[2] += math.radians(lm["headingDeg"])
    for ex in arg("--extra", many=True):      # more GLBs: path@x,z,heading (y = terrain)
        p, tt = ex.split("@")
        x, z, hd = (float(v) for v in tt.split(","))
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, p))
        for o in [o for o in bpy.data.objects if o not in before and o.parent is None]:
            o.location = G(x, height(x, z), z)
            o.rotation_euler[2] += math.radians(hd)

    # sun + sky
    sun = meta["sun"]
    sd = Vector(G(*sun["direction"])).normalized()
    ld = bpy.data.lights.new("Sun", "SUN")
    ld.energy = float(arg("--sun_strength", "4.0"))
    ld.angle = math.radians(0.53)
    ct = sun.get("colorTempK", 5800)
    ld.color = (1.0, 0.93, 0.83) if ct < 5000 else (1.0, 0.98, 0.95)
    so = bpy.data.objects.new("Sun", ld)
    sc.collection.objects.link(so)
    so.rotation_mode = "QUATERNION"
    so.rotation_quaternion = (-sd).to_track_quat("-Z", "Y")
    world = bpy.data.worlds.new("W")
    sc.world = world
    nt = world.node_tree
    bg = next(nn for nn in nt.nodes if nn.type == "BACKGROUND")
    if meta["body"] == "earth":
        sky = nt.nodes.new("ShaderNodeTexSky")
        try:
            sky.sky_type = "NISHITA"
        except TypeError:
            sky.sky_type = [i.identifier for i in sky.bl_rna.properties["sky_type"].enum_items][-1]
        sky.sun_elevation = math.radians(sun["elevationDeg"])
        sky.sun_rotation = math.radians(90 - sun["azimuthDeg"]) + math.pi / 2 * 0 + math.radians(0)
        sky.sun_rotation = math.atan2(sd.y, sd.x) - math.pi / 2 * 0
        nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = float(arg("--sky", "0.25"))
    elif meta["body"] == "mars":
        bg.inputs["Color"].default_value = (0.55, 0.38, 0.25, 1)
        bg.inputs["Strength"].default_value = float(arg("--sky", "0.35"))
    else:
        bg.inputs["Color"].default_value = (0, 0, 0, 1)
        bg.inputs["Strength"].default_value = 0.0

    cd = bpy.data.cameras.new("Cam")
    cd.lens = float(arg("--lens", "35"))
    cd.clip_end = 60000
    cd.clip_start = 0.1
    co = bpy.data.objects.new("Cam", cd)
    sc.collection.objects.link(co)
    co.location = G(*cam)
    co.rotation_mode = "QUATERNION"
    co.rotation_quaternion = (G(*tgt) - G(*cam)).to_track_quat("-Z", "Y")
    sc.camera = co
    out = os.path.join(ROOT, arg("--out"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print("[ws-f] world preview", out)


main()
