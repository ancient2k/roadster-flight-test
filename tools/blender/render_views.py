"""Render comparison views of an exported GLB (headless EEVEE) to out/renders/.

Usage:
  Blender -b --factory-startup -P tools/blender/render_views.py -- [--glb path] [--prefix model]
          [--views front,rear,...] [--res 1280x720] [--samples 64] [--open]
Views are matched to reference stills in research/frames/design (see VIEWS).
Cameras are given in the car/glTF frame (x left, y up, z forward; origin = CoG, ground y = -0.45).
"""
from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import common as C  # noqa: E402
from common import B  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GROUND = -0.45

# name: (camera pos, target, focal mm, reference still)
VIEWS = {
    "front": ((0.0, 0.05, 6.2), (0.0, 0.05, 0.0), 55, "d_039"),
    "rear": ((0.0, 0.45, -5.4), (0.0, 0.05, 0.0), 45, "d_033"),
    "rear34": ((2.7, -0.05, -4.6), (0.15, 0.05, -0.6), 35, "d_036"),
    "front34": ((3.6, 0.55, 4.6), (0.0, 0.0, 0.2), 40, "d_014"),
    "side": ((11.0, 0.15, 0.0), (0.0, 0.1, 0.0), 55, "d_034"),
    "top": ((0.0, 12.0, 0.001), (0.0, 0.0, 0.0), 50, "-"),
    "front_close": ((-0.9, 0.05, 4.6), (0.0, 0.0, 1.8), 40, "d_040"),
    "rear_close": ((0.9, 0.05, -4.3), (0.0, 0.0, -1.9), 40, "d_032"),
    "wheel": ((2.4, -0.1, -1.6), (0.86, -0.1, -1.25), 50, "d_036"),
    "cowl": ((1.2, 0.9, 2.6), (0.4, 0.3, 0.9), 50, "-"),
    "rear34_high": ((-3.4, 1.5, -4.4), (0.0, 0.1, -0.4), 38, "d_005"),
    "front34_low": ((-3.2, -0.15, 3.8), (0.0, 0.05, 0.4), 32, "d_021"),
}


def set_engine(scene):
    items = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    for cand in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
        if cand in items:
            scene.render.engine = cand
            return cand
    return scene.render.engine


def look_at(cam, pos, target):
    cam.location = B(*pos)
    d = B(*target) - B(*pos)
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = d.to_track_quat("-Z", "Y")


def setup_stage(scene, samples):
    world = bpy.data.worlds.new("Stage")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.006, 0.007, 0.008, 1)
    bg.inputs["Strength"].default_value = 1.0
    scene.world = world
    # glossy dark stage floor
    fm = C.material("_Floor", (0.010, 0.011, 0.012), 0.0, 0.30)
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, GROUND))
    bpy.context.active_object.data.materials.append(fm)
    # key/fill/rim area lights (stage-like, cool white) + red accent from behind
    def area(name, pos, target, power, size, color=(1, 1, 1)):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy = power
        ld.size = size
        ld.color = color
        ob = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(ob)
        look_at(ob, pos, target)
        return ob
    # reveal-stage look: small overhead spots (sharp, mirror streaks on the glossy floor), soft strips,
    # faint coloured rims from behind
    def spot(name, pos, target, power, size_deg=40, blend=0.6, radius=0.25, color=(1, 1, 1)):
        ld = bpy.data.lights.new(name, "SPOT")
        ld.energy = power
        ld.spot_size = math.radians(size_deg)
        ld.spot_blend = blend
        ld.shadow_soft_size = radius
        ld.color = color
        ob = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(ob)
        look_at(ob, pos, target)
    for i, (x, z) in enumerate(((1.8, 2.0), (-1.8, 2.0), (1.8, -1.6), (-1.8, -1.6), (0.0, 0.2))):
        spot(f"Spot{i}", (x, 6.5, z), (x * 0.3, -0.45, z * 0.4), 1500, 30, 0.8, 0.35)
    area("StripL", (5.5, 1.8, 0.0), (0, 0, 0), 260, 6.0, (0.85, 0.95, 1.0))
    area("StripR", (-5.5, 1.8, 0.0), (0, 0, 0), 260, 6.0, (0.85, 0.95, 1.0))
    area("Front", (0.0, 1.8, 7.0), (0, 0, 0), 120, 4.0)
    area("Back", (0.0, 1.8, -7.0), (0, 0, 0), 120, 4.0)
    area("RimRed", (-6.0, 2.5, -6.0), (0, 0.3, 0), 70, 2.0, (1.0, 0.12, 0.08))
    # red stage LED lines low on both sides (red reflections along the flanks as in the stills)
    area("RedL", (3.2, 0.05, 0.0), (0, -0.05, 0), 45, 0.12, (1.0, 0.06, 0.04))
    bpy.data.lights["RedL"].shape = "RECTANGLE"; bpy.data.lights["RedL"].size_y = 6.0
    area("RedR", (-3.2, 0.05, 0.0), (0, -0.05, 0), 45, 0.12, (1.0, 0.06, 0.04))
    bpy.data.lights["RedR"].shape = "RECTANGLE"; bpy.data.lights["RedR"].size_y = 6.0
    area("RimTeal", (6.0, 2.0, -6.0), (0, 0, 0), 90, 3.0, (0.3, 0.8, 0.9))
    scene.render.film_transparent = False
    ee = getattr(scene, "eevee", None)
    if ee is not None:
        for attr, val in (("taa_render_samples", samples), ("use_raytracing", True), ("use_shadows", True),
                          ("use_gtao", True), ("use_bloom", True)):
            if hasattr(ee, attr):
                try:
                    setattr(ee, attr, val)
                except Exception:
                    pass
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        try:
            scene.view_settings.look = "Medium High Contrast"
        except TypeError:
            pass


def main():
    args = C.args_after_dashdash()
    glb = args[args.index("--glb") + 1] if "--glb" in args else os.path.join(ROOT, "public/assets/car/roadster.glb")
    prefix = args[args.index("--prefix") + 1] if "--prefix" in args else "model"
    views = args[args.index("--views") + 1].split(",") if "--views" in args else list(VIEWS)
    res = args[args.index("--res") + 1] if "--res" in args else "1280x720"
    samples = int(args[args.index("--samples") + 1]) if "--samples" in args else 48
    outdir = args[args.index("--outdir") + 1] if "--outdir" in args else os.path.join(ROOT, "out/renders")
    C.reset_scene()
    scene = bpy.context.scene
    eng = set_engine(scene)
    print("[render] engine", eng)
    bpy.ops.import_scene.gltf(filepath=glb)
    if "--open" in args:
        for name, sgn in (("Door_L", 1), ("Door_R", -1)):
            ob = bpy.data.objects.get(name)
            if ob:
                ob.rotation_mode = "XYZ"
                ob.rotation_euler.rotate_axis("Y", math.radians(-sgn * 70))  # Blender -Y == car +Z
        w = bpy.data.objects.get("Wing")
        if w:
            w.rotation_mode = "XYZ"
            w.rotation_euler.rotate_axis("X", math.radians(28))
        prefix += "_open"
    global GROUND
    if "--ground" in args:
        GROUND = float(args[args.index("--ground") + 1])
    setup_stage(scene, samples)
    for m in bpy.data.materials:  # raytraced refraction for transmissive glass
        if hasattr(m, "use_raytrace_refraction"):
            m.use_raytrace_refraction = True
    rx, ry = (int(v) for v in res.split("x"))
    scene.render.resolution_x, scene.render.resolution_y = rx, ry
    scene.render.image_settings.file_format = "PNG"
    cam_data = bpy.data.cameras.new("Cam")
    cam = bpy.data.objects.new("Cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    os.makedirs(outdir, exist_ok=True)
    if "--auto" in args:  # frame the imported object(s): 3/4 front view from its bbox
        pts = [o.matrix_world @ Vector(c) for o in bpy.data.objects if o.type == "MESH" and o.name != "Plane" for c in o.bound_box]
        mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        c = (mn + mx) / 2
        ctr = (c.x, c.z, -c.y)
        rad = (mx - mn).length / 2
        d = rad * 2.6
        VIEWS.clear()
        VIEWS["auto34"] = ((ctr[0] + d * 0.55, ctr[1] + d * 0.25, ctr[2] + d * 0.8), ctr, 40, "-")
        VIEWS["autorear"] = ((ctr[0] - d * 0.55, ctr[1] + d * 0.2, ctr[2] - d * 0.8), ctr, 40, "-")
        VIEWS["autoside"] = ((ctr[0] + d * 1.0, ctr[1] + d * 0.05, ctr[2]), ctr, 40, "-")
        VIEWS["autofront"] = ((ctr[0] + d * 0.25, ctr[1] + d * 0.45, ctr[2] + d * 0.85), ctr, 40, "-")
        views = list(VIEWS)
    for v in views:
        pos, tgt, focal, ref = VIEWS[v]
        cam_data.lens = focal
        cam_data.sensor_width = 36
        look_at(cam, pos, tgt)
        scene.render.filepath = os.path.join(outdir, f"{prefix}_{v}.png")
        bpy.ops.render.render(write_still=True)
        print("[render] wrote", scene.render.filepath)


if __name__ == "__main__":
    main()
