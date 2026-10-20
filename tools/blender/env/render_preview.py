"""EEVEE-Nachtvorschau eines Umgebungs-GLBs (McGregor-Look: nasser Asphalt, Dunst, Flutlicht).

  Blender -b --factory-startup -P tools/blender/env/render_preview.py -- \
      --glb public/assets/env-models/light_tower.glb --out out/renders/env_light_tower.png \
      [--cam dist,elev,azim,target_y] [--lens 35] [--spots] [--key 1.0] [--res 1600x900]
      [--array dx,n] [--extra other.glb@x,y,z,headingDeg ...]

--spots: echte Spotlights an allen Light_*-Empties (Richtung = glTF-lokal -Z).
--array: das Asset n-mal im Abstand dx entlang X (Kachel-/Instancing-Vorschau).
azim 0 = Kamera vor dem Asset (auf der +Z-Seite, Blick zur Front).
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
ENV = os.path.join(ROOT, "public", "assets", "env")


def arg(name, default=None, many=False):
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if many:
        return [a[i + 1] for i, x in enumerate(a) if x == name]
    return a[a.index(name) + 1] if name in a else default


def flag(name):
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return name in a


def G(x, y, z):
    return Vector((x, -z, y))


def import_glb(path, loc=(0, 0, 0), heading=0.0):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    roots = [o for o in new if o.parent is None]
    for r in roots:
        r.location = G(*loc)
        r.rotation_mode = "XYZ"
        r.rotation_euler[2] += math.radians(heading)
    return new


def mat_asphalt():
    m = bpy.data.materials.new("PreviewAsphalt")
    nt = m.node_tree
    p = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (0.25, 0.25, 0.25)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])

    def img(name, nc=False):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(os.path.join(ENV, name))
        if nc:
            t.image.colorspace_settings.name = "Non-Color"
        nt.links.new(mp.outputs["Vector"], t.inputs["Vector"])
        return t
    d = img("asphalt_diff.jpg")
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    mul.inputs[7].default_value = (0.35, 0.35, 0.37, 1)
    nt.links.new(d.outputs["Color"], mul.inputs[6])
    nt.links.new(mul.outputs[2], p.inputs["Base Color"])
    a = img("asphalt_arm.jpg", True)
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(a.outputs["Color"], sep.inputs["Color"])
    wet = nt.nodes.new("ShaderNodeMath")
    wet.operation = "MULTIPLY"
    wet.inputs[1].default_value = 0.32       # nasser Asphalt (Stream: Spiegelungen)
    nt.links.new(sep.outputs["Green"], wet.inputs[0])
    nt.links.new(wet.outputs[0], p.inputs["Roughness"])
    n = img("asphalt_nor.jpg", True)
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.inputs["Strength"].default_value = 0.6
    nt.links.new(n.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])
    return m


def setup_world(strength=0.06, haze=0.0025):
    w = bpy.data.worlds.new("Night")
    bpy.context.scene.world = w
    nt = w.node_tree
    bg = next(n for n in nt.nodes if n.type == "BACKGROUND")
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(os.path.join(ENV, "night_1k.hdr"))
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    if haze > 0:
        out = next(n for n in nt.nodes if n.type == "OUTPUT_WORLD")
        vol = nt.nodes.new("ShaderNodeVolumePrincipled")
        vol.inputs["Density"].default_value = haze
        vol.inputs["Anisotropy"].default_value = 0.55
        vol.inputs["Color"].default_value = (0.75, 0.78, 0.85, 1)
        nt.links.new(vol.outputs[0], out.inputs["Volume"])


def spot(name, loc, direction, energy, angle_deg=30, blend=0.4, color=(1, 0.97, 0.92), radius=0.3):
    ld = bpy.data.lights.new(name, "SPOT")
    ld.energy = energy
    ld.spot_size = math.radians(angle_deg)
    ld.spot_blend = blend
    ld.color = color
    ld.shadow_soft_size = radius
    ob = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = Vector(direction).normalized().to_track_quat("-Z", "Y")
    return ob


def compositor_bloom():
    sc = bpy.context.scene
    ng = bpy.data.node_groups.new("Comp", "CompositorNodeTree")
    sc.compositing_node_group = ng
    rl = ng.nodes.new("CompositorNodeRLayers")
    gl = ng.nodes.new("CompositorNodeGlare")
    out = ng.nodes.new("NodeGroupOutput")
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    try:
        gl.inputs["Type"].default_value = "Bloom"
    except Exception:
        pass
    gl.inputs["Threshold"].default_value = 1.2
    gl.inputs["Strength"].default_value = 0.6
    gl.inputs["Size"].default_value = 0.6
    ng.links.new(rl.outputs["Image"], gl.inputs["Image"])
    ng.links.new(gl.outputs["Image"], out.inputs[0])


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    w, h = (int(v) for v in arg("--res", "1600x900").split("x"))
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.eevee.taa_render_samples = int(arg("--samples", "64"))
    sc.eevee.use_raytracing = True
    sc.eevee.use_shadows = True
    sc.eevee.volumetric_end = 400
    sc.eevee.volumetric_tile_size = "4"
    sc.eevee.use_volumetric_shadows = True
    sc.view_settings.view_transform = "AgX"
    try:
        sc.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    sc.view_settings.exposure = float(arg("--exposure", "0"))

    glb = os.path.join(ROOT, arg("--glb"))
    arr = arg("--array")
    objs = []
    grid = arg("--grid")
    if grid:
        nx, ny, nz, st = grid.split(",")
        for i in range(int(nx)):
            for j in range(int(ny)):
                for k in range(int(nz)):
                    objs += import_glb(glb, ((i - (int(nx) - 1) / 2) * float(st), j * float(st), (k - (int(nz) - 1) / 2) * float(st)))
    elif arr:
        dx, n = arr.split(",")
        for i in range(int(n)):
            objs += import_glb(glb, ((i - (int(n) - 1) / 2) * float(dx), 0, 0))
    else:
        objs = import_glb(glb)
    import random
    for sc_s in arg("--scatter", many=True):     # glb,anzahl,radius,seed
        p, cnt, rad, sd = sc_s.split(",")
        rr = random.Random(int(sd))
        base = import_glb(os.path.join(ROOT, p))
        meshes = [o for o in base if o.type == "MESH"]
        for k in range(int(cnt)):
            for m in meshes:
                d = m.copy() if k else m
                if k:
                    bpy.context.scene.collection.objects.link(d)
                    d.parent = None
                ang = rr.uniform(0, 6.283)
                rad_k = float(rad) * math.sqrt(rr.random())
                d.location = Vector((math.cos(ang) * rad_k, math.sin(ang) * rad_k, 0))
                d.rotation_euler = (d.rotation_euler[0], 0, rr.uniform(0, 6.283))
                s_ = rr.uniform(0.75, 1.25)
                d.scale = (s_, s_, s_ * rr.uniform(0.85, 1.15))
                objs.append(d)
    spread = arg("--spread")
    if spread:
        ms = [o for o in objs if o.type == "MESH" and o.parent is not None]
        for k, o in enumerate(ms):
            o.location.x += (k - (len(ms) - 1) / 2) * float(spread)
    for ex in arg("--extra", many=True):
        p, t = ex.split("@")
        x, y, z, hd = (float(v) for v in t.split(","))
        objs += import_glb(os.path.join(ROOT, p), (x, y, z), hd)

    # ground
    bpy.ops.mesh.primitive_plane_add(size=float(arg("--ground", "600")), location=(0, 0, 0))
    gnd = bpy.context.active_object
    gnd.data.materials.append(mat_asphalt())
    setup_world(float(arg("--world", "0.06")), float(arg("--haze", "0.0006")))

    # bbox of the asset (Blender coords)
    mins = Vector((1e9,) * 3)
    maxs = Vector((-1e9,) * 3)
    for o in objs:
        if o.type == "MESH":
            for c in o.bound_box:
                p = o.matrix_world @ Vector(c)
                mins = Vector(map(min, mins, p))
                maxs = Vector(map(max, maxs, p))
    size = (maxs - mins).length
    center = (mins + maxs) / 2

    # camera
    cam_s = arg("--cam")
    if cam_s:
        dist, elev, azim, ty = (float(v) for v in cam_s.split(","))
    else:
        dist, elev, azim, ty = size * 1.25, 12, 30, center.z
    tgt = Vector((center.x, center.y, ty))
    e, a = math.radians(elev), math.radians(azim)
    # azim 0 -> +Z (glTF) side = Blender -Y
    loc = tgt + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
    cd = bpy.data.cameras.new("Cam")
    cd.lens = float(arg("--lens", "35"))
    cd.clip_end = 5000
    cam = bpy.data.objects.new("Cam", cd)
    sc.collection.objects.link(cam)
    if arg("--campos"):
        loc = G(*(float(v) for v in arg("--campos").split(",")))
        tgt = G(*(float(v) for v in arg("--target").split(",")))
    cam.location = loc
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = (tgt - loc).to_track_quat("-Z", "Y")
    sc.camera = cam

    # lighting: key flood from camera side/high, cold rim from behind, red LED bounce
    key = float(arg("--key", "1.0"))
    if key > 0:
        kpos = tgt + Vector((math.sin(a + 0.9) * size * 1.6, -math.cos(a + 0.9) * size * 1.6, size * 0.9 + 20))
        spot("Key", kpos, tgt - kpos, 9e4 * key * max(size / 30, 0.5) ** 2, 45, 0.6, radius=1.0)
        rpos = tgt + Vector((-math.sin(a) * size * 1.4, math.cos(a) * size * 1.4, size * 0.6 + 15))
        spot("Rim", rpos, tgt - rpos, 4e4 * key * max(size / 30, 0.5) ** 2, 40, 0.5, (0.8, 0.88, 1.0), radius=1.0)
    red = float(arg("--red", "1.0"))
    if red > 0:
        for sx in (-1, 1):
            ld = bpy.data.lights.new("Red", "AREA")
            ld.energy = 150 * red * max(size / 30, 0.3)
            ld.color = (1.0, 0.05, 0.03)
            ld.size = max(size * 0.8, 2)
            ob = bpy.data.objects.new("Red", ld)
            sc.collection.objects.link(ob)
            ob.location = center + Vector((sx * size * 0.7, -size * 0.6, 0.05))
            ob.rotation_euler = (math.radians(-80), 0, 0)
    if flag("--spots"):
        for o in objs:
            if o.name.startswith("Light_"):
                d = o.matrix_world.to_3x3() @ Vector((0, 1, 0))     # glTF -Z == Blender local +Y
                spot("S_" + o.name, o.matrix_world.translation + d * 0.1, d, float(arg("--spot_w", "6000")), 26, 0.5, radius=0.3)
    compositor_bloom()

    out = os.path.join(ROOT, arg("--out"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sc.render.filepath = out
    sc.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    print("[ws-f] preview", out)


main()
