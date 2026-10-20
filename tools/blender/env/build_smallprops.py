"""Small props — gate60.glb, led_fixture.glb, barrier.glb, crowd_fence.glb.

  Blender -b --factory-startup -P tools/blender/env/build_smallprops.py [-- --only gate60]

All in the glTF frame, origin bottom centre, front = +Z.
gate60      start/timing gate of the 0–60 run as in the stream: grey portal housing 10 x 6 x 1.5 m, opening
            7.2 x 4.6 m with a recessed LED wall (Screen_Emissive, UV 0..1), white LED outline
            (LED_White), red LED columns in front (LED_Red). The car starts IN FRONT of the gate (+Z) and drives away.
led_fixture red LED light column as along the stunt lanes: weighted foot, aluminium profile, diffuser 0.1..2.2 m
            (LED_Red). Instancing: 1 mesh, 2 materials (groups) -> InstancedMesh with a material array.
barrier     concrete barrier (New Jersey profile) 1.55 x 0.83 x 0.64 m, Poly Haven concrete_road_barrier (CC0),
            decimated. Length along X; tiling distance 1.56 m.
crowd_fence crowd barrier element 2.3 m (galvanised) with flat feet; length along X, tiling distance 2.35 m.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

import env_common as E  # noqa: E402

ONLY = E.args()[E.args().index("--only") + 1] if "--only" in E.args() else None


def gate_screen_texture():
    """Space/grid motif like the LED wall in the stream (dark blue, nebula, grid lines)."""
    w, h = 1024, 640
    n = E.fbm(1024, 2.4, 77)[:h, :w]
    n2 = E.fbm(1024, 1.6, 78)[:h, :w]
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    neb = np.clip((n - 0.45) * 2.2, 0, 1) ** 1.5
    img = np.zeros((h, w, 4), np.float32)
    img[..., 0] = 0.02 + 0.25 * neb + 0.05 * n2
    img[..., 1] = 0.04 + 0.32 * neb + 0.06 * n2
    img[..., 2] = 0.09 + 0.45 * neb + 0.1 * n2
    grid = ((x % 64) < 1.5) | ((y % 64) < 1.5)
    img[grid, :3] += 0.08
    rs = np.random.default_rng(3)
    for _ in range(260):   # stars
        sx, sy = rs.integers(0, w), rs.integers(0, h)
        img[max(sy - 1, 0):sy + 1, max(sx - 1, 0):sx + 1, :3] = rs.uniform(0.5, 1.0)
    img[..., :3] = np.clip(img[..., :3], 0, 1)
    img[..., 3] = 1
    return E.save_rgba(img, "gate_screen.jpg", "JPEG")


def gate60():
    E.reset()
    E.mat_painted("Gate_Panel", (0.2, 0.205, 0.21), rough=0.55, metal=0.1, tile=2.5, seed=71, var=0.12)
    E.mat_black_steel("Steel_Black")
    E.emissive("Screen_Emissive", None, 3.0, tex=gate_screen_texture())
    E.emissive("LED_White", (0.95, 0.97, 1.0), 30.0, base=(0.9, 0.9, 0.9))
    E.emissive("LED_Red", (1.0, 0.03, 0.02), 25.0, base=(0.3, 0.02, 0.02))
    root = E.empty("Gate60", (0, 0, 0), size=1)
    mb = E.MB()
    W, H, D = 10.0, 6.0, 1.5
    OW, OH = 7.2, 4.6
    pw = (W - OW) / 2
    # housing: pillars, lintel, back wall
    for sx in (-1, 1):
        mb.box((sx * (OW / 2 + pw / 2), H / 2, 0), (pw, H, D), "Gate_Panel")
    mb.box((0, OH + (H - OH) / 2, 0), (OW, H - OH, D), "Gate_Panel")
    mb.box((0, OH / 2, -D / 2 + 0.05), (OW, OH, 0.1), "Steel_Black")
    # panel joints (dark strips) on the front
    for k in range(1, 4):
        y = H * k / 4
        for sx in (-1, 1):
            mb.box((sx * (OW / 2 + pw / 2), y, D / 2 + 0.004), (pw - 0.02, 0.012, 0.01), "Steel_Black")
    for sx in (-1, 1):
        mb.box((sx * (OW / 2 + pw / 2), H / 2, D / 2 + 0.004), (0.012, H - 0.02, 0.01), "Steel_Black")
    # reveal (inside) dark
    for sx in (-1, 1):
        x = sx * OW / 2
        pts = [(x, 0, D / 2), (x, 0, -D / 2 + 0.1), (x, OH, -D / 2 + 0.1), (x, OH, D / 2)]
        mb.poly(pts if sx < 0 else pts[::-1], "Steel_Black")
    mb.poly([(-OW / 2, OH, D / 2), (-OW / 2, OH, -D / 2 + 0.1), (OW / 2, OH, -D / 2 + 0.1), (OW / 2, OH, D / 2)][::-1], "Steel_Black")
    # LED wall in the gate (recessed)
    sz = -D / 2 + 0.11
    mb.poly([(-OW / 2 + 0.05, 0.05, sz), (OW / 2 - 0.05, 0.05, sz), (OW / 2 - 0.05, OH - 0.05, sz), (-OW / 2 + 0.05, OH - 0.05, sz)],
            "Screen_Emissive", uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])
    # white LED outline around the opening (front)
    t, z = 0.06, D / 2 + 0.03
    mb.box((0, OH + t / 2 + 0.04, z), (OW + 0.2, t, 0.06), "LED_White")
    for sx in (-1, 1):
        mb.box((sx * (OW / 2 + 0.07), (OH + 0.1) / 2, z), (t, OH + 0.1, 0.06), "LED_White")
    # red LED columns in the opening (stream: red vertical bars in front of the wall)
    rs = np.random.default_rng(9)
    for k in range(12):
        x = OW / 2 - 0.35 - k * 0.22
        h = 0.9 + 1.2 * rs.random()
        mb.box((x, 0.2 + h / 2, -D / 2 + 0.45), (0.05, h, 0.05), "LED_Red")
    # skirting / plinth + cable duct
    mb.box((0, 0.04, D / 2 + 0.4), (W + 0.4, 0.08, 0.8), "Steel_Black")
    mb.build("Gate60_Mesh", root)
    print(f"[ws-f] gate60: {mb.tri_count()} tris")
    E.empty("Gate_Screen", (0, OH / 2, sz), root)
    E.export_glb("gate60")


def led_fixture():
    E.reset()
    E.mat_painted("Fixture_Black", (0.025, 0.025, 0.028), rough=0.45, metal=0.4, seed=72)
    E.emissive("LED_Red", (1.0, 0.03, 0.02), 25.0, base=(0.4, 0.03, 0.03))
    mb = E.MB()
    mb.box((0, 0.02, 0), (0.36, 0.04, 0.36), "Fixture_Black")          # foot plate (weighted)
    mb.box((0, 0.065, 0), (0.18, 0.05, 0.18), "Fixture_Black")
    mb.box((0, 1.15, -0.03), (0.07, 2.2, 0.03), "Fixture_Black")         # aluminium back profile
    mb.tube((0, 0.09, 0.0), (0, 2.2, 0.0), 0.028, "LED_Red", seg=10, caps=False)   # diffuser
    for y in (0.09, 2.2):
        mb.tube((0, y - 0.02, 0), (0, y + 0.02, 0), 0.034, "Fixture_Black", seg=10)
    mb.tube((0.05, 0.04, -0.1), (0.25, 0.005, -0.25), 0.008, "Fixture_Black", seg=4)   # cable
    mb.build("LedFixture")
    print(f"[ws-f] led_fixture: {mb.tri_count()} tris")
    E.export_glb("led_fixture")


def barrier():
    E.reset()
    objs = E.import_gltf(E.cc0("concrete_road_barrier", "concrete_road_barrier_1k.gltf"))
    ob = next(o for o in objs if o.type == "MESH")
    E.decimate(ob, 0.032)
    # take over the material, rename it
    ob.data.materials[0].name = "Concrete_Barrier"
    ob.name = "Barrier"
    ob.data.materials[0].use_backface_culling = True
    for img in list(bpy.data.images):     # textures at 512² (distant tiled object, saves 1.5 MB)
        if img.size[0] > 512:
            img.scale(512, 512)
    # origin: bottom centre; shift the mesh locally so that minY = 0 (Blender z) and x/z are centred
    bpy.context.view_layer.update()
    vs = [ob.matrix_world @ v.co for v in ob.data.vertices]
    mn = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    mx = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    off = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))
    for o in objs:
        if o.parent is None:
            o.location -= off
    print(f"[ws-f] barrier: {E.tris(ob)} tris, size {mx - mn}")
    E.export_glb("barrier")


def crowd_fence():
    E.reset()
    E.mat_galv("Steel_Galv", tile=1.0)
    mb = E.MB()
    E.fence_panel(mb, -1.15, 0.0, L=2.3)
    mb.build("CrowdFence")
    print(f"[ws-f] crowd_fence: {mb.tri_count()} tris")
    E.export_glb("crowd_fence")


for name, fn in (("gate60", gate60), ("led_fixture", led_fixture), ("barrier", barrier), ("crowd_fence", crowd_fence)):
    if ONLY in (None, name):
        fn()
