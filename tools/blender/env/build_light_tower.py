"""Stadium floodlight mast (light_tower.glb / light_tower_lod1.glb).

  Blender -b --factory-startup -P tools/blender/env/build_light_tower.py [-- --lod 1]

Structure (glTF frame, origin = mast centre at ground level, front/light direction = +Z):
  concrete foundation 2.4 x 2.4 m (0.45 m above ground) + switch cabinets, square lattice mast
  (1.5 m -> 0.9 m, galvanised) up to 22.2 m, maintenance platform with railing, fixed ladder with back cage,
  lamp frame 5.6 x 3.6 m in front of the mast (22.4..26 m) with 4 x 4 LED floodlights (yokes, cooling fins,
  glare visors). Cables from every luminaire to the distribution box and as a bundle down the mast.
  Empties Light_0..15 at the lens centre, local -Z = light direction (rows 0..3 from the top, columns from -X).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import env_common as E  # noqa: E402

LOD = E.lod_arg()
H_MAST = 22.2          # top of the lattice mast / platform
W0, W1 = 1.5, 0.9      # mast width bottom / top (centre distance of the corner legs)
PED = 0.45             # foundation overhang
FRAME_Z = 1.05         # lamp frame in front of the mast axis
COLS = [-2.1, -0.7, 0.7, 2.1]
ROWS = [25.45, 24.5, 23.55, 22.6]   # luminaire centres from top to bottom
YAW = [-13.0, -4.5, 4.5, 13.0]      # fan-out (degrees)
PITCH = [11.0, 15.0, 20.0, 26.0]    # downward tilt per row (top = far)


def lens_texture():
    """LED lens: 7-cell honeycomb of bright single LEDs with a reflector halo (emission, sRGB)."""
    n = 256
    y, x = np.mgrid[0:n, 0:n].astype(np.float32) / n * 2 - 1
    img = np.zeros((n, n, 4), np.float32)
    rr = np.sqrt(x * x + y * y)
    base = np.clip(1.0 - rr, 0, 1) ** 0.6 * 0.35
    acc = np.zeros((n, n), np.float32)
    pts = [(0, 0)] + [(0.52 * math.cos(a), 0.52 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 7)[:-1]] \
        + [(0.86 * math.cos(a), 0.86 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 13)[:-1] + 0.25]
    for px, py in pts:
        d = np.sqrt((x - px) ** 2 + (y - py) ** 2)
        acc += np.exp(-(d / 0.07) ** 2) * 1.0 + np.exp(-(d / 0.2) ** 2) * 0.25
    v = np.clip(base + acc, 0, 1) * (rr < 0.98)
    img[..., 0] = v
    img[..., 1] = v * 0.985
    img[..., 2] = v * 0.95
    img[..., 3] = 1
    return E.save_rgba(img, "lamp_lens.png")


def lamp_dir(r, c):
    p, yw = math.radians(PITCH[r]), math.radians(YAW[c])
    return Vector((math.sin(yw) * math.cos(p), -math.sin(p), math.cos(yw) * math.cos(p)))


def build():
    E.reset()
    E.mat_galv("Steel_Galv")
    E.mat_tread("Steel_Tread")
    E.mat_concrete("Concrete")
    E.mat_painted("Lamp_Housing", (0.055, 0.058, 0.062), rough=0.42, metal=0.55)
    E.mat_painted("Cabinet", (0.24, 0.25, 0.25), rough=0.5, metal=0.2)
    E.material("Cable", (0.012, 0.012, 0.012), 0.0, 0.55)
    E.emissive("Lamp_Emissive", (1.0, 0.97, 0.92), 30.0, base=(0.9, 0.9, 0.88), tex=lens_texture())

    root = E.empty("LightTower", (0, 0, 0), size=1.0)
    mb = E.MB()
    seg_c = 8 if LOD == 0 else 6
    seg_m = 6 if LOD == 0 else 4

    # ---------------- foundation + cabinets
    mb.box((0, 0.03, 0), (2.4, 0.06, 2.4), "Concrete")              # foundation slab (flush, 6 cm)
    mb.box((0, PED / 2, 0), (2.0, PED, 2.0), "Concrete")
    mb.box((0, PED - 0.02, 0), (2.06, 0.04, 2.06), "Concrete")
    if LOD == 0:
        for sx in (-1, 1):
            for sz in (-1, 1):
                c = (sx * W0 / 2, PED, sz * W0 / 2)
                mb.box((c[0], PED + 0.015, c[2]), (0.36, 0.03, 0.36), "Steel_Galv")
                for bx in (-1, 1):
                    for bz in (-1, 1):
                        mb.tube((c[0] + bx * 0.13, PED, c[2] + bz * 0.13), (c[0] + bx * 0.13, PED + 0.09, c[2] + bz * 0.13), 0.016, "Steel_Galv", seg=6)
                        mb.tube((c[0] + bx * 0.13, PED + 0.03, c[2] + bz * 0.13), (c[0] + bx * 0.13, PED + 0.055, c[2] + bz * 0.13), 0.028, "Steel_Galv", seg=6, square=True)
    # switch cabinets behind the mast (-Z) on their own plinth
    mb.box((0.15, 0.06, -1.55), (1.9, 0.12, 0.7), "Concrete")
    for x in (-0.38, 0.62):
        mb.box((x, 0.12 + 0.8, -1.55), (0.85, 1.6, 0.5), "Cabinet")
        mb.box((x, 0.12 + 1.63, -1.55), (0.93, 0.06, 0.6), "Cabinet")             # rain roof
        if LOD == 0:
            mb.box((x, 0.12 + 0.8, -1.295), (0.78, 1.5, 0.012), "Cabinet")         # door
            mb.box((x + 0.3, 0.12 + 0.85, -1.285), (0.03, 0.16, 0.025), "Steel_Galv")  # handle
    mb.tube((0.15, 0.3, -1.3), (0.15, 0.3, -0.7), 0.05, "Cable", seg=seg_m)             # conduit to the mast

    # ---------------- lattice mast
    def corner(y, sx, sz):
        w = W0 + (W1 - W0) * (y / H_MAST)
        return (sx * w / 2, y, sz * w / 2)

    y0 = PED + 0.06
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    for sx, sz in corners:
        a = corner(y0, sx, sz)
        b = corner(H_MAST, sx, sz)
        mb.tube(a, b, 0.07, "Steel_Galv", seg=seg_c)
    levels = []
    y = y0 + 0.25
    step = 1.45
    while y < H_MAST - 0.2:
        levels.append(y)
        y += step
    levels.append(H_MAST - 0.05)
    for i, y in enumerate(levels):
        for k in range(4):
            a = corner(y, *corners[k])
            b = corner(y, *corners[(k + 1) % 4])
            mb.tube(a, b, 0.032, "Steel_Galv", seg=seg_m, caps=False)
            if i + 1 < len(levels):
                y2 = levels[i + 1]
                if i % 2 == 0:
                    mb.tube(corner(y, *corners[k]), corner(y2, *corners[(k + 1) % 4]), 0.024, "Steel_Galv", seg=seg_m, caps=False)
                else:
                    mb.tube(corner(y, *corners[(k + 1) % 4]), corner(y2, *corners[k]), 0.024, "Steel_Galv", seg=seg_m, caps=False)
        if LOD == 0 and i % 3 == 1:   # inner bracing (diagonal in the cross-section)
            mb.tube(corner(y, -1, -1), corner(y, 1, 1), 0.02, "Steel_Galv", seg=4, caps=False)

    # ---------------- platform + railing (y = H_MAST)
    PW, PD = 3.4, 2.6
    pz = 0.25
    mb.box((0, H_MAST + 0.04, pz), (PW, 0.08, PD), "Steel_Tread")
    for sx in (-1, 1):   # brackets
        mb.tube((sx * W1 / 2, H_MAST - 1.2, -W1 / 2), (sx * PW / 2, H_MAST, pz + PD / 2), 0.03, "Steel_Galv", seg=seg_m)
        mb.tube((sx * W1 / 2, H_MAST - 1.2, W1 / 2), (sx * PW / 2, H_MAST, pz - PD / 2), 0.03, "Steel_Galv", seg=seg_m)
    rail_y = [0.5, 1.05] if LOD == 0 else [1.05]
    pts = [(-PW / 2, pz - PD / 2), (PW / 2, pz - PD / 2), (PW / 2, pz + PD / 2 - 0.0), (-PW / 2, pz + PD / 2)]
    for k in range(3):   # front (+Z) open towards the lamp frame -> 3 sides
        a, b = pts[(k + 3) % 4], pts[k]
        if k == 0:
            a, b = pts[0], pts[1]
        elif k == 1:
            a, b = pts[1], pts[2]
        else:
            a, b = pts[3], pts[0]
        for ry in rail_y:
            mb.tube((a[0], H_MAST + ry, a[1]), (b[0], H_MAST + ry, b[1]), 0.022, "Steel_Galv", seg=seg_m)
        n = max(2, int(math.dist(a, b) / 1.1) + 1)
        for t in range(n):
            f = t / (n - 1)
            px, pz2 = a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
            mb.tube((px, H_MAST + 0.08, pz2), (px, H_MAST + 1.08, pz2), 0.022, "Steel_Galv", seg=seg_m)
        if LOD == 0:
            mb.box(((a[0] + b[0]) / 2, H_MAST + 0.15, (a[1] + b[1]) / 2),
                   (abs(b[0] - a[0]) + 0.01, 0.14, abs(b[1] - a[1]) + 0.01), "Steel_Galv")   # toe board

    # ---------------- ladder with cage on the back face (-Z)
    if LOD == 0:
        lz = -W0 / 2 - 0.25
        for y in np.arange(y0 + 0.3, H_MAST + 1.0, 0.3):
            w = W0 + (W1 - W0) * (min(y, H_MAST) / H_MAST)
            z = -w / 2 - 0.22
            mb.tube((-0.22, y, z), (0.22, y, z), 0.014, "Steel_Galv", seg=4, caps=False)
        for sx in (-1, 1):
            mb.tube((sx * 0.22, y0, -W0 / 2 - 0.22), (sx * 0.22, H_MAST + 1.05, -W1 / 2 - 0.22), 0.02, "Steel_Galv", seg=6)
        for y in np.arange(2.6, H_MAST, 1.25):
            w = W0 + (W1 - W0) * (y / H_MAST)
            zc = -w / 2 - 0.22 - 0.35
            hoop = [(0.36 * math.cos(a), y, zc + 0.36 * math.sin(a)) for a in np.linspace(0, math.pi, 7)]
            hoop = [(p[0], p[1], min(p[2], -w / 2 - 0.2)) for p in [(0.36 * math.cos(a), y, zc - 0.36 * math.sin(a)) for a in np.linspace(0, math.pi, 7)]]
            hoop = [(0.36, y, -w / 2 - 0.2)] + hoop + [(-0.36, y, -w / 2 - 0.2)]
            for p, q in zip(hoop[:-1], hoop[1:]):
                mb.tube(p, q, 0.012, "Steel_Galv", seg=4, caps=False)
        for ang in (0.35, 1.57, 2.8):
            pa = (0.36 * math.cos(ang), 2.6, -W0 / 2 - 0.57 - 0.36 * math.sin(ang) + 0.35)
            pb = (0.36 * math.cos(ang), H_MAST - 0.6, -W1 / 2 - 0.57 - 0.36 * math.sin(ang) + 0.35)
            mb.tube(pa, pb, 0.012, "Steel_Galv", seg=4, caps=False)

    # ---------------- lamp frame (in front of the mast top)
    FX = 2.85
    bars_y = [22.25, 23.08, 24.03, 24.98, 25.93]
    for y in bars_y:
        mb.tube((-FX, y, FRAME_Z), (FX, y, FRAME_Z), 0.06, "Steel_Galv", seg=4, square=True)
    for x in (-FX, -1.4, 0.0, 1.4, FX):
        mb.tube((x, 22.2, FRAME_Z), (x, 25.99, FRAME_Z), 0.06, "Steel_Galv", seg=4, square=True)
    for x in (-W1 / 2, W1 / 2):   # outrigger mast head -> frame
        for y in (22.25, 25.93):
            mb.tube((x, y, W1 / 2), (x, y, FRAME_Z), 0.05, "Steel_Galv", seg=4, square=True)
        mb.tube((x, H_MAST - 0.05, W1 / 2), (x, 25.93, W1 / 2), 0.07, "Steel_Galv", seg=seg_c)   # mast extension
        mb.tube((x, 22.25, W1 / 2), (x * 3.0, 25.93, FRAME_Z), 0.035, "Steel_Galv", seg=seg_m)
    if LOD == 0:
        for x0, x1 in ((-FX, -1.4), (1.4, FX)):
            mb.tube((x0, 22.25, FRAME_Z - 0.02), (x1, 25.93, FRAME_Z - 0.02), 0.025, "Steel_Galv", seg=4)
    # distribution box behind the frame
    mb.box((0, 22.75, FRAME_Z - 0.32), (0.7, 0.55, 0.3), "Cabinet")

    # ---------------- lamps
    lens_pts = []
    seg_l = 20 if LOD == 0 else 12
    for r, y in enumerate(ROWS):
        for c, x in enumerate(COLS):
            d = lamp_dir(r, c)
            center = Vector((x, y, FRAME_Z + 0.62))
            M, _ = mb.frame(center, center + d)
            mb.push(M)
            prof = [(0.0, -0.36), (0.20, -0.36), (0.20, -0.30)]
            if LOD == 0:   # cooling fins
                for k in range(5):
                    z0 = -0.30 + k * 0.045
                    prof += [(0.30, z0), (0.30, z0 + 0.018), (0.235, z0 + 0.018), (0.235, z0 + 0.045)]
                prof += [(0.335, -0.075)]
            else:
                prof += [(0.30, -0.25), (0.335, -0.08)]
            prof += [(0.335, 0.0), (0.355, 0.012), (0.355, 0.035), (0.305, 0.04)]
            mb.lathe(prof, "Lamp_Housing", seg=seg_l, cap_start=False)
            # glare visor, thin-walled: inside + outside
            mb.lathe([(0.355, 0.035), (0.385, 0.19), (0.37, 0.195), (0.34, 0.045)], "Lamp_Housing", seg=seg_l)
            mb.disk((0, 0, 0.035), 0.305, "Lamp_Emissive", normal=(0, 0, 1), seg=seg_l)
            # yoke: side plates + cross yoke at the back
            for sx in (-1, 1):
                mb.box((sx * 0.375, 0, -0.17), (0.025, 0.09, 0.5), "Lamp_Housing")
                if LOD == 0:
                    mb.tube((sx * 0.355, 0, 0.0), (sx * 0.41, 0, 0.0), 0.05, "Lamp_Housing", seg=10)  # swivel joint
            mb.box((0, 0, -0.43), (0.78, 0.09, 0.05), "Lamp_Housing")
            back = mb.P((0, 0, -0.45))
            cab = mb.P((0, 0.0, -0.36))
            mb.pop()
            # bracket to the frame
            mount = Vector((x, y, FRAME_Z + 0.06))
            mb.tube(back, mount, 0.045, "Steel_Galv", seg=6)
            lens_pts.append((r, c, center + d * 0.04, d, cab))
    # cables: every luminaire with a loop to the cable tray on the rail below, trays -> centre leg -> distribution box
    if LOD == 0:
        for r, c, _, _, cab in lens_pts:
            a = Vector(cab)
            yb = max(yy for yy in bars_y if yy < ROWS[r])
            b = Vector((COLS[c] + 0.25, yb + 0.07, FRAME_Z - 0.1))
            pts = []
            for t in np.linspace(0, 1, 5):
                p = a.lerp(b, t)
                p.y -= math.sin(math.pi * t) * 0.12
                pts.append(p)
            for p, q in zip(pts[:-1], pts[1:]):
                mb.tube(p, q, 0.011, "Cable", seg=4, caps=False)
        for yb in bars_y[:-1]:
            mb.tube((-FX + 0.1, yb + 0.07, FRAME_Z - 0.1), (FX - 0.1, yb + 0.07, FRAME_Z - 0.1), 0.028, "Cable", seg=4, caps=False)
        mb.tube((0.12, 22.32, FRAME_Z - 0.1), (0.12, 25.0, FRAME_Z - 0.1), 0.04, "Cable", seg=6, caps=False)
        mb.tube((0.12, 22.32, FRAME_Z - 0.1), (0.12, 22.9, FRAME_Z - 0.2), 0.04, "Cable", seg=6, caps=False)
    # cable bundle down the mast (on the back, leg -X/-Z)
    bundle = [Vector((0.0, 22.5, FRAME_Z - 0.3)), Vector((0.0, 22.2, -W1 / 2 - 0.08))]
    for y in np.linspace(21.5, 1.2, 8 if LOD == 0 else 3):
        w = W0 + (W1 - W0) * (y / H_MAST)
        bundle.append(Vector((-0.12, y, -w / 2 - 0.09)))
    bundle.append(Vector((-0.12, 0.6, -W0 / 2 - 0.1)))
    bundle.append(Vector((0.15, 0.32, -0.75)))
    for p, q in zip(bundle[:-1], bundle[1:]):
        mb.tube(p, q, 0.055, "Cable", seg=6, caps=False)

    ob = mb.build("LightTower_Mesh", root, mat_order=["Steel_Galv", "Steel_Tread", "Lamp_Housing", "Lamp_Emissive", "Concrete", "Cabinet", "Cable"])
    print(f"[ws-f] light_tower LOD{LOD}: {mb.tri_count()} tris")

    # light empties: lens centre, local -Z = light direction
    for i, (r, c, p, d, _) in enumerate(lens_pts):
        E.aim_empty(f"Light_{i}", tuple(p), tuple(d), root)
    E.export_glb("light_tower", lod=LOD)


build()
