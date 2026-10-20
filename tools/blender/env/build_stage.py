"""Stage as in the stream (stage.glb / stage_lod1.glb).

  Blender -b --factory-startup -P tools/blender/env/build_stage.py [-- --lod 1]

glTF frame: origin = centre of the stage footprint at ground level, audience/front = +Z.
  Deck 40 x 14 m, top at 1.2 m (track.ts size), front edge slightly convex (+0.8 m in the middle),
  red LED edges (stage edge at the top + plinth line), black back wall 44 x 12 m with red accent lines,
  two LED walls 13.6 x 7.65 m (material Screen_Emissive, UV 0..1 per wall -> video/graphic texture swappable),
  40 cm trusses (towers + roof and front truss), 12 moving heads (empties Beam_0..11, local -Z = beam),
  two flown line arrays (8 boxes each), sub stacks, stairs on both sides.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import env_common as E  # noqa: E402

LOD = E.lod_arg()
W, D, H = 40.0, 14.0, 1.2
BULGE = 0.8
SCREEN_W, SCREEN_H = 13.6, 7.65
SCREEN_X, SCREEN_Y0, SCREEN_Z = 12.2, H + 1.6, -6.2
TRUSS_Y = 13.0


def front_z(x):
    """Front edge: convex arc, z = D/2 - 0.8 at the corners ... D/2 in the middle."""
    return D / 2 - BULGE + BULGE * (1 - (x / (W / 2)) ** 2)


def screen_texture():
    """Default image for the LED walls: bright studio cyclorama motif (as in the stream) with a red accent line.
    Linear values; the renderer may replace it with video/canvas (emissiveMap)."""
    w, h = 1024, 576
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    u, v = x / w, y / h                       # v = 0 at the bottom
    horizon = 0.36
    wall = np.clip(0.55 + 0.45 * (v - horizon) / (1 - horizon), 0, 1)
    floor = np.clip(0.75 - 0.5 * (horizon - v) / horizon, 0, 1)
    img = np.where(v > horizon, wall, floor)
    img = img * (1 - 0.55 * ((u - 0.5) * 1.6) ** 2)                 # vignette
    sweep = np.exp(-((v - horizon) / 0.05) ** 2) * 0.25             # cyclorama
    img = np.clip(img + sweep, 0, 1) * 0.9
    # hinted vehicle silhouette (wedge-shaped, no logo)
    cx = 0.5
    body = (np.abs(u - cx) < 0.28) & (v > horizon - 0.02) & (v < horizon + 0.11 - 0.25 * np.abs(u - cx - 0.04) ** 1.2)
    img = np.where(body, img * 0.92 + 0.06, img)
    shadow = np.exp(-(((u - cx) / 0.32) ** 4) - ((v - horizon + 0.03) / 0.025) ** 2) * 0.5
    img = np.clip(img - shadow, 0, 1)
    rgb = np.stack([img, img * 0.985, img * 0.97], -1)
    bar = (v > 0.05) & (v < 0.065) & (np.abs(u - 0.5) < 0.42)
    rgb[bar] = (1.0, 0.04, 0.03)
    out = np.ones((h, w, 4), np.float32)
    out[..., :3] = rgb ** 2.2                                    # to linear for saving as PNG (sRGB)
    out[..., :3] = rgb
    return E.save_rgba(out, "stage_screen.jpg", "JPEG")


def grille_texture():
    n = 256
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    p = 16
    d = np.sqrt(((x % p) - p / 2) ** 2 + ((y % p) - p / 2 + (x // p % 2) * 0) ** 2)
    v = np.where(d < 4.5, 0.008, 0.06)
    img = np.ones((n, n, 4), np.float32)
    img[..., :3] = v[..., None]
    return E.save_rgba(img, "speaker_grille.png")


def moving_head(mb, pos, d):
    """Hanging moving head on the truss: yoke + head, lens Beam_Emissive along d."""
    x, y, z = pos
    mb.box((x, y - 0.1, z), (0.42, 0.2, 0.32), "Fixture")                   # base
    mb.tube((x, y - 0.2, z), (x, y - 0.32, z), 0.08, "Fixture", seg=8)
    c = Vector((x, y - 0.6, z))
    M, _ = mb.frame(c, c + d)
    mb.push(M)
    for sx in (-1, 1):
        mb.box((sx * 0.2, 0.0, -0.05), (0.04, 0.12, 0.42), "Fixture")
    mb.lathe([(0.0, -0.24), (0.12, -0.24), (0.17, -0.12), (0.17, 0.12), (0.15, 0.16), (0.12, 0.165)], "Fixture",
             seg=14 if LOD == 0 else 8)
    mb.disk((0, 0, 0.162), 0.12, "Beam_Emissive", seg=14 if LOD == 0 else 8)
    mb.pop()
    return c + d * 0.17


def line_array(mb, top, n=8):
    """Flown line array (J curve), front = +Z."""
    x, y, z = top
    mb.box((x, y + 0.08, z), (1.4, 0.12, 0.9), "Steel_Black")               # flying frame
    mb.tube((x, y + 0.14, z), (x, TRUSS_Y - 0.25, z), 0.012, "Steel_Black", seg=4)   # chain hoist
    ang = 0.0
    py, pz = y, z
    for i in range(n):
        ang += math.radians(0.5 + i * 0.9)
        M = Matrix.Translation((x, py - 0.18, pz)) @ Matrix.Rotation(ang, 4, "X")
        mb.push(M)
        mb.box((0, 0, 0), (1.3, 0.36, 0.62), "Speaker")
        mb.box((0, 0, 0.312), (1.24, 0.30, 0.01), "Speaker_Grille")
        mb.pop()
        py -= 0.37 * math.cos(ang)
        pz += 0.37 * math.sin(ang) * 0.6


def build():
    E.reset()
    E.mat_painted("Stage_Deck", (0.035, 0.035, 0.037), rough=0.32, metal=0.0, tile=3.0, seed=41, var=0.07)
    E.material("Stage_Fascia", (0.012, 0.012, 0.013), 0.0, 0.8)
    E.material("Drape", (0.008, 0.008, 0.009), 0.0, 0.95)
    E.mat_black_steel("Steel_Black")
    E.mat_painted("Fixture", (0.03, 0.03, 0.032), rough=0.4, metal=0.3, seed=43)
    E.material("Speaker", (0.015, 0.015, 0.016), 0.0, 0.75)
    E.material("Speaker_Grille", (1, 1, 1), 0.3, 0.6, diff=grille_texture(), tile=0.25)
    E.emissive("LED_Red", (1.0, 0.03, 0.02), 25.0, base=(0.3, 0.02, 0.02))
    E.emissive("Screen_Emissive", None, 4.0, base=(0.01, 0.01, 0.01), tex=screen_texture())
    E.emissive("Beam_Emissive", (0.85, 0.92, 1.0), 40.0, base=(0.8, 0.85, 0.9))
    E.material("Screen_Frame", (0.01, 0.01, 0.01), 0.2, 0.5)

    root = E.empty("Stage", (0, 0, 0), size=2.0)
    mb = E.MB()
    nseg = 32 if LOD == 0 else 12

    # ---------------- deck (extruded outline), fascia
    xs = np.linspace(-W / 2, W / 2, nseg + 1)
    front = [(x, front_z(x)) for x in xs]
    back_z = -D / 2
    top = [(x, H, z) for x, z in front][::-1] + [(-W / 2, H, back_z), (W / 2, H, back_z)]
    # top face as fan of quads (UV in metres)
    for i in range(nseg):
        x0, x1 = xs[i], xs[i + 1]
        mb.poly([(x0, H, back_z), (x0, H, front_z(x0)), (x1, H, front_z(x1)), (x1, H, back_z)][::1], "Stage_Deck")
    lip = 0.05
    for i in range(nseg):   # front fascia
        x0, x1 = xs[i], xs[i + 1]
        mb.poly([(x0, 0, front_z(x0)), (x1, 0, front_z(x1)), (x1, H, front_z(x1)), (x0, H, front_z(x0))], "Stage_Fascia")
    for sx in (-1, 1):
        x = sx * W / 2
        pts = [(x, 0, back_z), (x, 0, front_z(x)), (x, H, front_z(x)), (x, H, back_z)]
        mb.poly(pts[::-1] if sx > 0 else pts, "Stage_Fascia")
    mb.poly([(-W / 2, 0, back_z), (-W / 2, H, back_z), (W / 2, H, back_z), (W / 2, 0, back_z)], "Stage_Fascia")
    # LED edges: at the top of the edge (slightly recessed) + plinth line
    for i in range(nseg):
        x0, x1 = xs[i], xs[i + 1]
        for yy, hh in ((H - 0.02, 0.05), (0.12, 0.04)):
            z0, z1 = front_z(x0) + 0.012, front_z(x1) + 0.012
            mb.poly([(x0, yy - hh / 2, z0), (x1, yy - hh / 2, z1), (x1, yy + hh / 2, z1), (x0, yy + hh / 2, z0)], "LED_Red",
                    uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])
        # light strip on the stage surface (edge)
        mb.poly([(x0, H + 0.004, front_z(x0) - 0.06), (x0, H + 0.004, front_z(x0) - 0.02),
                 (x1, H + 0.004, front_z(x1) - 0.02), (x1, H + 0.004, front_z(x1) - 0.06)], "LED_Red",
                uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])

    # ---------------- stairs (left/right, at the side towards the front)
    for sx in (-1, 1):
        nst = 6
        for k in range(nst):
            hh = H * (k + 1) / (nst + 0)
            zz = 3.5 - k * 0.32
            mb.box((sx * (W / 2 + 0.6), hh / 2, zz), (1.2, hh, 0.32), "Stage_Fascia")
            mb.box((sx * (W / 2 + 0.6), hh + 0.01, zz + 0.13), (1.2, 0.02, 0.04), "LED_Red") if LOD == 0 else None
        if LOD == 0:
            mb.tube((sx * (W / 2 + 1.2), H + 1.0, 1.6), (sx * (W / 2 + 1.2), 1.0, 3.7), 0.025, "Steel_Black", seg=6)
            for zz in (1.7, 3.6):
                hh = H * (1 - (zz - 1.6) / 2.1 * 0.83)
                mb.tube((sx * (W / 2 + 1.2), 0, zz), (sx * (W / 2 + 1.2), hh + 1.0, zz), 0.025, "Steel_Black", seg=6)

    # ---------------- back wall (drape) with red accent lines
    mb.box((0, 6.5, back_z - 0.35), (W + 6, 13.0, 0.3), "Drape")
    for yy in (H + 0.25, H + 0.4):
        mb.box((0, yy, back_z - 0.19), (W - 2, 0.035, 0.02), "LED_Red")
    for sx in (-1, 1):   # vertical red light columns (stream: red verticals)
        for k in range(3):
            x = sx * (3.2 + k * 1.1)
            mb.box((x, H + 3.3, back_z - 0.18), (0.08, 5.6, 0.03), "LED_Red")

    # ---------------- LED walls
    for sx in (-1, 1):
        cx = sx * SCREEN_X
        x0, x1 = cx - SCREEN_W / 2, cx + SCREEN_W / 2
        y0, y1 = SCREEN_Y0, SCREEN_Y0 + SCREEN_H
        mb.box((cx, (y0 + y1) / 2, SCREEN_Z - 0.2), (SCREEN_W + 0.3, SCREEN_H + 0.3, 0.35), "Screen_Frame")
        mb.poly([(x0, y0, SCREEN_Z), (x1, y0, SCREEN_Z), (x1, y1, SCREEN_Z), (x0, y1, SCREEN_Z)], "Screen_Emissive",
                uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])
        # supports
        for xx in (x0 + 1.0, x1 - 1.0):
            mb.tube((xx, H, SCREEN_Z - 0.4), (xx, y0, SCREEN_Z - 0.4), 0.08, "Steel_Black", seg=4, square=True)

    # ---------------- trusses: 2 towers at the front + 2 at the back, roof/front truss
    tw = 0.4
    tz_front, tz_back = 4.2, back_z + 0.6
    TX = W / 2 + 1.0
    lr, cr = (0.012, 0.025) if LOD == 0 else (0.02, 0.03)
    ls = 4 if LOD == 0 else 3
    for sx in (-1, 1):
        for tz in (tz_front, tz_back):
            mb.box((sx * TX, 0.02, tz), (0.9, 0.04, 0.9), "Steel_Black")          # base plate
            mb.box_truss((sx * TX, 0.04, tz), (sx * TX, TRUSS_Y, tz), tw, "Steel_Black", cr, lr, 6, ls, up=(0, 0, 1))
        mb.box_truss((sx * TX, TRUSS_Y + tw / 2, tz_back), (sx * TX, TRUSS_Y + tw / 2, tz_front), tw, "Steel_Black", cr, lr, 6, ls)
    for tz in (tz_front, tz_back, (tz_front + tz_back) / 2):
        mb.box_truss((-TX, TRUSS_Y + tw / 2, tz), (TX, TRUSS_Y + tw / 2, tz), tw, "Steel_Black", cr, lr, 6, ls)

    # ---------------- moving heads on the front truss
    beams = []
    nfix = 12
    for i in range(nfix):
        x = -W / 2 + 2.0 + i * (W - 4.0) / (nfix - 1)
        fan = (i - (nfix - 1) / 2) / ((nfix - 1) / 2)
        d = Vector((fan * 0.55, 0.75, 0.35)).normalized()          # stream: beams fan out upwards/outwards
        p = moving_head(mb, (x, TRUSS_Y, tz_front), d)
        beams.append((p, d))
    # additional wash lights on the centre truss (down onto the stage)
    for i in range(8 if LOD == 0 else 0):
        x = -W / 2 + 4 + i * (W - 8) / 7
        d = Vector((0, -0.85, 0.5)).normalized()
        moving_head(mb, (x, TRUSS_Y, (tz_front + tz_back) / 2), d)

    # ---------------- line arrays + subs
    for sx in (-1, 1):
        line_array(mb, (sx * (TX + 1.4), TRUSS_Y - 1.2, tz_front + 0.4), 8 if LOD == 0 else 6)
        mb.tube((sx * TX, TRUSS_Y + 0.2, tz_front), (sx * (TX + 1.4), TRUSS_Y + 0.2, tz_front + 0.4), 0.06, "Steel_Black", seg=4, square=True)
        for k in range(3):
            mb.box((sx * (W / 2 - 3.5 - k * 1.25), 0.38, front_z(sx * (W / 2 - 3.5)) + 0.6), (1.2, 0.75, 0.9), "Speaker")
            mb.box((sx * (W / 2 - 3.5 - k * 1.25), 0.38, front_z(sx * (W / 2 - 3.5)) + 1.051), (1.12, 0.66, 0.01), "Speaker_Grille")

    mb.build("Stage_Mesh", root)
    print(f"[ws-f] stage LOD{LOD}: {mb.tri_count()} tris")
    for i, (p, d) in enumerate(beams):
        E.aim_empty(f"Beam_{i}", tuple(p), tuple(d), root)
    # stage spot points for the renderer (centre of the stage, where the car stands)
    E.empty("Stage_Center", (0, H, 1.5), root)
    E.export_glb("stage", lod=LOD)


build()
