"""Render GLBs in the reconstructed reference cameras (Blender, EEVEE, stage light from render_views).

Usage:
  Blender -b --factory-startup -P tools/blender/v3/render_compare.py -- --glb a.glb --tag v3
          [--views d_007,d_039] [--samples 32] [--only Wheel_] [--outdir dir] [--sim sim.json]
OpenCV camera (cameras.json) -> Blender: position C = -R^T t (car frame) -> B(C); camera local axes
x = +cam_x, y = -cam_y, z = -cam_z (rows of R), each mapped with B(); lens = f * 36 / 1280 with a
horizontal 36 mm sensor; principal point = image centre (shift 0) unless a similarity alignment
(front view, see iou.py) is passed via --sim.
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import common as C  # noqa: E402
from common import B  # noqa: E402
import render_views as RV  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
W, H = 1280, 720


def rodrigues(r):
    th = math.sqrt(sum(x * x for x in r))
    if th < 1e-12:
        return Matrix.Identity(3)
    k = Vector(r) / th
    K = Matrix(((0, -k.z, k.y), (k.z, 0, -k.x), (-k.y, k.x, 0)))
    return Matrix.Identity(3) + math.sin(th) * K + (1 - math.cos(th)) * (K @ K)


def place_camera(cam, c, sim=None):
    f = c[0]; R = rodrigues(c[1:4]); t = Vector(c[4:7])
    Cw = -(R.transposed() @ t)
    cam.location = B(*Cw)
    ax = [Vector(R[i]) for i in range(3)]               # camera axes in car frame
    bx, by, bz = B(*ax[0]), -B(*ax[1]), -B(*ax[2])
    M = Matrix((bx, by, bz)).transposed()
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = M.to_quaternion()
    d = cam.data
    d.sensor_fit = "HORIZONTAL"; d.sensor_width = 36.0
    s, tx, ty, cx, cy = 1.0, 0.0, 0.0, W / 2, H / 2
    if sim:
        (s, tx, ty), (cx, cy) = sim["p"], sim["c"]
    d.lens = s * f * 36.0 / W
    ppx = s * W / 2 + (1 - s) * cx + tx
    ppy = s * H / 2 + (1 - s) * cy + ty
    d.shift_x = (ppx - W / 2) / W
    d.shift_y = -(ppy - H / 2) / W
    d.clip_start = 0.05; d.clip_end = 200


def steer(name_prefix, angle):
    for o in bpy.data.objects:
        if o.name.startswith(("Wheel_FL", "Wheel_FR", "Caliper_FL", "Caliper_FR")) and o.parent and not o.parent.name.startswith(("Wheel", "Caliper")):
            o.rotation_mode = "QUATERNION"
            # car +Y (up) is Blender +Z
            o.rotation_quaternion = o.rotation_quaternion @ Matrix.Rotation(angle, 4, "Z").to_quaternion()


def main():
    a = C.args_after_dashdash()
    glb = a[a.index("--glb") + 1]
    tag = a[a.index("--tag") + 1] if "--tag" in a else "m"
    views = a[a.index("--views") + 1].split(",") if "--views" in a else ["d_039", "d_033", "d_006", "d_007", "d_014", "d_021"]
    samples = int(a[a.index("--samples") + 1]) if "--samples" in a else 32
    outdir = a[a.index("--outdir") + 1] if "--outdir" in a else os.path.join(ROOT, "out/renders")
    only = a[a.index("--only") + 1] if "--only" in a else None
    sims = json.load(open(a[a.index("--sim") + 1])) if "--sim" in a else {}
    cams = json.load(open(os.path.join(HERE, "cameras.json")))["cams"]
    C.reset_scene()
    scene = bpy.context.scene
    RV.set_engine(scene)
    bpy.ops.import_scene.gltf(filepath=glb)
    if only:
        for o in list(bpy.data.objects):
            if o.type == "MESH" and not o.name.startswith(only):
                bpy.data.objects.remove(o)
    RV.GROUND = -0.44
    RV.setup_stage(scene, samples)
    for m in bpy.data.materials:
        if hasattr(m, "use_raytrace_refraction"):
            m.use_raytrace_refraction = True
    scene.render.resolution_x, scene.render.resolution_y = W, H
    scene.render.image_settings.file_format = "PNG"
    cd = bpy.data.cameras.new("Cam"); cam = bpy.data.objects.new("Cam", cd)
    scene.collection.objects.link(cam); scene.camera = cam
    os.makedirs(outdir, exist_ok=True)
    base_rot = {o.name: o.rotation_quaternion.copy() for o in bpy.data.objects if o.rotation_mode == "QUATERNION"}
    for v in views:
        c = cams[v]
        for o in bpy.data.objects:
            if o.name in base_rot:
                o.rotation_quaternion = base_rot[o.name].copy()
        if abs(c[8]) > 1e-4:
            steer("Wheel_F", c[8])
        place_camera(cam, c, sims.get(v))
        scene.render.filepath = os.path.join(outdir, f"r4_{tag}_{v}.png")
        bpy.ops.render.render(write_still=True)
        print("[render] wrote", scene.render.filepath, flush=True)


if __name__ == "__main__":
    main()
