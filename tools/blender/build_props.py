"""Vehicle props for the McGregor pad -> public/assets/props/*.glb (headless Blender).

Usage: Blender -b --factory-startup -P tools/blender/build_props.py -- [--only semi,model3,...]

Convention (TRACK.obstacles): metres, +Y up, front towards +Z, local x = width, y = height, z = length,
origin at the bottom centre. Each prop is built at its nominal size and finally fitted exactly to the
obstacle box. No logos or lettering. Built with carkit (subdivision cage + creases, real panel-gap
grooves, wheel arches, glass, lights); target 25-60k triangles each.
Environment props (light towers, stage, ...) belong to asset pipeline (tools/blender/env).
"""
from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import carkit as K  # noqa: E402
import common as C  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "public", "assets", "props")

# TRACK.obstacles sizes (src/shared/track.ts): x width, y height, z length
SIZES = {
    "model3": (1.85, 1.44, 4.72),
    "modelY": (1.92, 1.62, 4.75),
    "semi": (2.6, 4.1, 6.6),
    "modelS": (1.99, 1.45, 5.02),
    "cybertruck": (2.41, 1.79, 5.68),
}


def read_track_sizes():
    try:
        src = open(os.path.join(ROOT, "src", "shared", "track.ts"), encoding="utf8").read()
    except OSError:
        return
    import re
    for m in re.finditer(r"model: '(\w+)'.*?size: \{ x: ([\d.]+), y: ([\d.]+), z: ([\d.]+) \}", src):
        SIZES[m.group(1)] = tuple(float(v) for v in m.groups()[1:])


def interp(keys, t):
    """Piecewise-linear lookup in [(t, value), ...] sorted by descending t."""
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if t1 <= t <= t0:
            a = (t - t1) / (t0 - t1) if t0 != t1 else 0
            return v1 + (v0 - v1) * a
    return keys[0][1] if t > keys[0][0] else keys[-1][1]


def finish(objs, name, size):
    """Join, fit exactly to size (x width, y height, z length), origin bottom centre, export."""
    ob = K.join(objs, name)
    me = ob.data
    xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]; zs = [v.co.z for v in me.vertices]
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    sx = size[0] / (max(xs) - min(xs)); sl = size[2] / (max(ys) - min(ys)); sh = size[1] / (max(zs) - min(zs))
    z0 = min(zs)
    for v in me.vertices:
        v.co = Vector(((v.co.x - cx) * sx, (v.co.y - cy) * sl, (v.co.z - z0) * sh))
    me.update()
    C.box_uv(ob, 1.0)
    path = os.path.join(OUT, name + ".glb")
    C.export_glb(path, [ob])
    print(f"[props] {name}: {C.triangle_count([ob])} tris, {os.path.getsize(path) / 1e6:.2f} MB, "
          f"fit scale x{sx:.3f} y{sh:.3f} z{sl:.3f}")


# ---------------------------------------------------------------- sedans / SUV
SHAPES = {
    # top: side silhouette (fz -> fraction of H); belt: window base; ws_top / rg_start: windshield header and
    # rear-glass start; g0/g1: glass extent; r/wb: wheel radius / wheelbase; lights: (y fractions)
    "model3": dict(top=[(0.5, .37), (0.49, .45), (0.47, .505), (0.42, .56), (0.33, .615), (0.235, .655), (0.04, .965),
                        (-0.10, 1.0), (-0.27, .925), (-0.375, .735), (-0.44, .715), (-0.48, .68), (-0.5, .58)],
                   belt=[(0.5, .55), (0.235, .655), (-0.375, .705), (-0.5, .68)],
                   g0=0.235, ws_top=0.04, rg_start=-0.25, g1=-0.375, r=0.335, wb=2.875, tw=0.235,
                   doors=4, light_bar=False, handle="T", frame="T"),
    "modelS": dict(top=[(0.5, .37), (0.49, .45), (0.47, .50), (0.42, .555), (0.33, .605), (0.22, .65), (0.02, .965),
                        (-0.12, 1.0), (-0.29, .915), (-0.405, .74), (-0.45, .72), (-0.485, .68), (-0.5, .59)],
                   belt=[(0.5, .55), (0.22, .65), (-0.405, .705), (-0.5, .68)],
                   g0=0.22, ws_top=0.02, rg_start=-0.27, g1=-0.405, r=0.35, wb=2.96, tw=0.245, doors=4,
                   light_bar=False, handle="X", frame="X"),
    "modelY": dict(top=[(0.5, .38), (0.49, .45), (0.47, .50), (0.42, .55), (0.33, .595), (0.245, .635), (0.05, .955),
                        (-0.10, 1.0), (-0.30, .955), (-0.43, .835), (-0.475, .76), (-0.5, .64)],
                   belt=[(0.5, .54), (0.245, .635), (-0.43, .70), (-0.5, .68)],
                   g0=0.245, ws_top=0.05, rg_start=-0.33, g1=-0.43, r=0.36, wb=2.89, tw=0.255, doors=4,
                   light_bar=True, handle="T", frame="T"),
}


def sedan_profile(sh, W, H, fz):
    # plan view: the last ~16 % of the length round off elliptically (bumper corners), so nose and
    # tail are curved caps instead of flat end plates
    e = max(0.0, (abs(fz) - 0.34) / 0.16)
    plan = math.sqrt(max(0.0, 1 - 0.62 * e ** 2.4))
    hw = W / 2 * plan
    lo = 0.13 + 0.16 * e ** 2.5
    yt = interp(sh["top"], fz) * H
    yb = interp(sh["belt"], fz) * H
    gh = sh["g1"] - 1e-6 <= fz <= sh["g0"] + 1e-6
    # body side: rounded tuck-under, fullest at ~40 % height, soft shoulder into the beltline
    pts = [(0, lo), (0.78 * hw, lo), (0.92 * hw, lo + 0.04), (0.975 * hw, lo + 0.14), (hw, 0.38 * H),
           (0.99 * hw, 0.52 * H)]
    if gh:
        pts += [(0.955 * hw, yb - 0.035), (0.905 * hw, yb)]
        g_h = yt - yb
        a = (0.885 * hw, yb + 0.012)
        if g_h < 0.07:
            for k in range(1, 6):
                t = k / 5
                pts.append((a[0] * (1 - t), a[1] + (yt - a[1]) * t ** 0.5))
            pts[-1] = (0, yt)
        else:
            # tumblehome: the glasshouse leans in to a roof ~64 % of the body width
            rw = hw * 0.64
            pts += [a, (rw + 0.04, yt - 0.045), (rw, yt - 0.028), (rw * 0.5, yt - 0.005), (0, yt)]
    else:
        ybb = min(yb, yt - 0.02)
        pts += [(0.955 * hw, ybb - 0.035), (0.905 * hw, ybb), (0.86 * hw, yt - 0.014), (0.74 * hw, yt - 0.007),
                (0.56 * hw, yt - 0.003), (0.28 * hw, yt - 0.001), (0, yt)]
    if e > 0:
        # elevation: the end sections shrink towards the bumper line, the cap closes on a small face
        k = e ** 1.8
        yc = 0.40 * H
        pts = [(x, y + (yc - y) * 0.30 * k) for (x, y) in pts]
    return pts, gh


def sedan(name, size, paint, style, lod=0):
    W, H, L = size
    sh = SHAPES[style]
    M = K.materials(paint)
    g0, g1 = sh["g0"], sh["g1"]
    fzs = sorted({0.5, 0.496, 0.488, 0.474, 0.455, 0.43, 0.38, 0.32, g0, (g0 + sh["ws_top"]) / 2, sh["ws_top"], -0.05,
                  -0.15, sh["rg_start"], (sh["rg_start"] + g1) / 2, g1, -0.43, -0.455, -0.474, -0.488, -0.496, -0.5},
                 reverse=True)
    stations = []
    for fz in fzs:
        pts, gh = sedan_profile(sh, W, H, fz)
        stations.append((fz * L, pts, gh))
    mid = [(a + b) / 2 for a, b in zip(fzs, fzs[1:])]

    def segmat(i, j):
        if j <= 2:
            return "D"
        gh = stations[i][2] and stations[i + 1][2]
        if not gh or j <= 6:
            return "P"
        m = mid[i]
        if j == 7:
            return sh["frame"]           # window frame / beltline trim (chrome on the Model S)
        if j == 8:
            return "G"
        if j == 9:
            return "T"
        return "G"                       # windshield, glass roof, rear glass (all dark glass on these Teslas)
    corner = {fzs.index(g0), fzs.index(sh["ws_top"]), fzs.index(g1)}
    jcrease = {1: 1.0, 2: 0.8, 3: 1.0, 4: 0.0, 5: 0.45, 6: 0.3, 7: 1.0, 8: 1.0, 9: 1.0, 10: 1.0}
    bm = K.loft_cage(stations, segmat, jcrease, corner)
    bm = K.subdivide(bm, 2 if lod == 0 else 1)
    K.close_ends(bm, "P")
    body = K.body_object(name + "_body", bm, M)
    r = sh["r"]
    zf, zr = sh["wb"] / 2 + 0.06, -sh["wb"] / 2 + 0.06
    hw = W / 2
    xw = hw - 0.10 - sh["tw"] / 2 + 0.11
    centres = [(xw, r, zf), (-xw, r, zf), (xw, r, zr), (-xw, r, zr)]

    def prof_at(z):
        return sedan_profile(sh, W, H, z / L)[0]
    cutters = [K.arch_cutter(M, centres, r + 0.032)]
    zd0 = zf - r - 0.10
    zd1 = zd0 - 1.06
    zd2 = zr + r + 0.06
    for z in (zd0, zd1, zd2):
        cutters.append(K.gap_cutter(M, prof_at, z, 3, 7, name="door"))
    cutters.append(K.cross_gap_cutter(M, 0.43 * L, hw * 0.62, interp(sh["top"], 0.43) * H, name="hood"))
    cutters.append(K.cross_gap_cutter(M, -0.455 * L, hw * 0.60, interp(sh["top"], -0.455) * H, crown=0.01, name="trunk"))
    K.shell(body, M, cutters)
    objs = [body, K.wheel_liners(M, centres, r + 0.03)]
    for c in centres:
        objs.append(K.wheel_mesh(M, c, r, sh["tw"], style="spoke", spokes=5, seg=56 if lod == 0 else 32))
    # flush door handles just below the beltline, near the rear edge of each door (front and rear)
    for zh in (zd0 - 0.30, zd1 - 0.28):
        yb = interp(sh["belt"], zh / L) * H
        objs += K.side_patch(M, body, zh, yb - 0.075, 0.17, 0.028, sh["handle"], name="handle")
    # lights projected onto the finished body
    yh = interp(sh["top"], 0.485) * H
    yh = 0.47 * H
    head = [(0.40 * hw, yh + 0.035), (0.86 * hw, yh - 0.02), (0.90 * hw, yh + 0.03), (0.50 * hw, yh + 0.075)]
    for sgn in (1, -1):
        outline = [(sgn * x, y) for (x, y) in head]
        objs += K.projected_patch(M, body, outline, "HL", True, name="head", housing=(1.18, "T"))
    if sh["light_bar"]:
        objs += K.projected_patch(M, body, [(-0.42 * hw, yh + 0.062), (0.42 * hw, yh + 0.062), (0.42 * hw, yh + 0.07),
                                            (-0.42 * hw, yh + 0.07)], "HL", True, name="bar")
    # intake (dark, slightly proud) in the lower fascia
    objs += K.projected_patch(M, body, [(-0.55 * hw, 0.17 * H), (0.55 * hw, 0.17 * H), (0.48 * hw, 0.27 * H), (-0.48 * hw, 0.27 * H)],
                              "D", True, name="intake")
    yt_ = 0.66 * H
    tail = [(0.45 * hw, yt_ + 0.02), (0.88 * hw, yt_ + 0.0), (0.88 * hw, yt_ - 0.075), (0.60 * hw, yt_ - 0.05)]
    for sgn in (1, -1):
        outline = [(sgn * x, y) for (x, y) in tail]
        objs += K.projected_patch(M, body, outline, "TL", False, name="tail", housing=(1.12, "T"))
    if sh["light_bar"]:
        objs += K.projected_patch(M, body, [(-0.5 * hw, yt_ - 0.045), (0.5 * hw, yt_ - 0.045), (0.5 * hw, yt_ - 0.035),
                                            (-0.5 * hw, yt_ - 0.035)], "TL", False, name="rbar")
    objs += K.projected_patch(M, body, [(-0.62 * hw, 0.17 * H), (0.62 * hw, 0.17 * H), (0.6 * hw, 0.25 * H), (-0.6 * hw, 0.25 * H)],
                              "D", False, name="diffuser")
    finish(objs, name, size)


# ---------------------------------------------------------------- Cybertruck (faceted, no subdivision)
def cybertruck(size, lod=0):
    W, H, L = size
    hw0 = W / 2
    M = K.materials((0.62, 0.63, 0.64), 1.0, 0.36, coat=0.0)       # brushed stainless
    zh = L / 2
    # (z, top, belt) -> straight lines between key stations; side wall tumbles in below the belt
    keys = [(zh, 1.04, 1.04), (zh - 0.05, 1.08, 1.06), (1.62, 1.33, 1.17), (0.18, H, 1.17), (-0.55, 1.62, 1.18),
            (-1.15, 1.52, 1.18), (-zh + 0.05, 1.30, 1.20), (-zh, 1.27, 1.18)]
    stations = []
    for i, (z, top, belt) in enumerate(keys):
        end = i in (0, len(keys) - 1)
        hw = hw0 * (0.95 if end else 1.0)
        lo = {0: 0.74, 1: 0.66, len(keys) - 1: 0.55, len(keys) - 2: 0.50}.get(i, 0.30)
        gh = 1.55 >= z >= -0.60
        y4 = max(0.62, lo + 0.26)
        pts = [(0, lo), (0.86 * hw, lo), (0.94 * hw, lo + 0.06), (0.965 * hw, lo + 0.18), (0.985 * hw, y4),
               (hw, max(0.95, y4 + 0.08)), (hw, belt - 0.03), (0.99 * hw, belt)]
        if gh and top > belt + 0.1:
            pts += [(0.97 * hw, belt + 0.015), (0.80 * hw, top - 0.06), (0.74 * hw, top - 0.035), (0.37 * hw, top - 0.01), (0, top)]
        else:
            pts += [(0.97 * hw, min(top, belt + 0.03)), (0.85 * hw, top - 0.02), (0.74 * hw, top - 0.012), (0.37 * hw, top - 0.004), (0, top)]
        stations.append((z, pts, gh))

    def segmat(i, j):
        if j <= 3:
            return "D"
        z0, z1 = stations[i][0], stations[i + 1][0]
        if j == 8 and stations[i][2] and stations[i + 1][2]:
            return "G"
        if j >= 9 and z0 <= 1.62 + 1e-6 and z1 >= 0.18 - 1e-6:   # windshield panel
            return "G"
        return "P"
    jc = {j: 1.0 for j in range(1, 12)}
    bm = K.loft_cage(stations, segmat, jc, set(range(len(stations))))
    bm = K.subdivide(bm, 0)
    K.close_ends(bm, "P")
    body = K.body_object("ct_body", bm, M)
    r = 0.43
    zf, zr = 1.84, -1.97
    xw = hw0 - 0.16
    centres = [(xw, r, zf), (-xw, r, zf), (xw, r, zr), (-xw, r, zr)]
    cutters = [K.arch_cutter(M, centres, r + 0.07, seg=6)]   # angular arches

    def prof_at(z):
        for (za, pa, _), (zb, pb, _) in zip(stations, stations[1:]):
            if zb <= z <= za:
                t = (za - z) / (za - zb)
                return [(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) for a, b in zip(pa, pb)]
        return stations[0][1]
    for z in (1.30, 0.05, -1.05):
        cutters.append(K.gap_cutter(M, prof_at, z, 4, 7, name="door"))
    K.shell(body, M, cutters, bevel_w=0.004, segs=2)
    objs = [body, K.wheel_liners(M, centres, r + 0.06)]
    for c in centres:
        objs.append(K.wheel_mesh(M, c, r, 0.29, style="aero", spokes=6, seg=56 if lod == 0 else 28))
    objs += K.projected_patch(M, body, [(-0.96 * hw0, 0.975), (0.96 * hw0, 0.975), (0.96 * hw0, 1.0), (-0.96 * hw0, 1.0)],
                              "HL", True, name="bar")
    objs += K.projected_patch(M, body, [(-0.96 * hw0, 1.13), (0.96 * hw0, 1.13), (0.96 * hw0, 1.16), (-0.96 * hw0, 1.16)],
                              "TL", False, name="rbar")
    finish(objs, "cybertruck", size)


# ---------------------------------------------------------------- Tesla Semi (cab-over tractor)
def semi(size, lod=0):
    W, H, L = size
    hw0 = W / 2
    M = K.materials((0.88, 0.89, 0.90), 0.0, 0.28, coat=0.8, coat_rough=0.06)
    zh = L / 2
    top = [(zh, 1.05), (zh - 0.03, 1.40), (zh - 0.10, 1.75), (zh - 0.25, 1.98), (zh - 0.40, 2.08), (2.25, 3.05),
           (1.8, 3.55), (1.2, 3.95), (0.6, H), (0.0, H), (-0.30, H - 0.04), (-0.34, H - 0.12)]
    zs = [k[0] for k in top]
    ws0, ws1 = zh - 0.40, 2.25
    stations = []
    for z, yt in top:
        edge = max(0.0, (z - (zh - 0.45)) / 0.45)
        hw = hw0 * (1 - 0.06 * edge ** 2)
        lo = 0.38 if z > 2.0 else 0.55
        belt = 2.05
        side_glass = 1.35 <= z <= ws0 + 1e-6
        pts = [(0, lo), (0.85 * hw, lo), (0.97 * hw, lo + 0.08), (hw, lo + 0.40), (hw, 1.25), (hw, 1.65)]
        if yt > belt + 0.1:
            wtop = min(yt - 0.30, belt + 0.85)
            pts += [(0.995 * hw, belt - 0.05), (0.99 * hw, belt), (0.98 * hw, belt + 0.02), (0.95 * hw, wtop),
                    (0.88 * hw, yt - 0.22), (0.60 * hw, yt - 0.03), (0, yt)]
        else:
            pts += [(0.995 * hw, yt - 0.20), (0.97 * hw, yt - 0.08), (0.90 * hw, yt - 0.03), (0.70 * hw, yt - 0.012),
                    (0.45 * hw, yt - 0.004), (0.22 * hw, yt - 0.001), (0, yt)]
        stations.append((z, pts, side_glass))

    def segmat(i, j):
        if j <= 2:
            return "D"
        za, zb = stations[i][0], stations[i + 1][0]
        if za <= ws0 + 1e-6 and zb >= ws1 - 1e-6 and j >= 8:      # wrap-around windshield
            return "G"
        if j == 8 and stations[i][2] and stations[i + 1][2]:
            return "G"
        return "P"
    corner = {zs.index(ws0), zs.index(ws1)}
    jc = {1: 1.0, 2: 0.8, 3: 1.0, 4: 0.0, 5: 0.0, 6: 0.3, 7: 1.0, 8: 1.0, 9: 1.0, 10: 0.4}
    bm = K.loft_cage(stations, segmat, jc, corner)
    bm = K.subdivide(bm, 2 if lod == 0 else 1)
    K.close_ends(bm, "P")
    cab = K.body_object("semi_cab", bm, M)
    r = 0.52
    xf = hw0 - 0.22
    cutters = [K.arch_cutter(M, [(xf, r, 2.35), (-xf, r, 2.35)], r + 0.05, inner=0.3, outer=0.6)]

    def prof_at(z):
        for (za, pa, _), (zb, pb, _) in zip(stations, stations[1:]):
            if zb <= z <= za:
                t = (za - z) / (za - zb)
                return [(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) for a, b in zip(pa, pb)]
        return stations[0][1]
    cutters.append(K.gap_cutter(M, prof_at, 1.30, 3, 9, name="door_rear"))
    K.shell(cab, M, cutters, bevel_w=0.004)
    objs = [cab, K.wheel_liners(M, [(xf, r, 2.35), (-xf, r, 2.35)], r + 0.045, inner=0.3)]

    def box(name, cx, cy, cz, sx, sy, sz, key, bev=0.02):
        v = [(cx + dx * sx / 2, cy + dy * sy / 2, cz + dz * sz / 2) for dx in (-1, 1) for dy in (-1, 1) for dz in (-1, 1)]
        f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        ob = C.mesh_object(name, C.to_blender(v), f, [M[k] for k in K.KEYS], [K.KEYS.index(key)] * 6)
        bm_ = bmesh.new(); bm_.from_mesh(ob.data)
        bmesh.ops.recalc_face_normals(bm_, faces=bm_.faces[:])
        bm_.to_mesh(ob.data); bm_.free()
        if bev > 0:
            C.bevel(ob, bev, 2, 30, harden=True)
        return ob
    # chassis behind the cab: frame rails, fifth wheel, aero side skirts over the battery packs, mud flaps
    objs.append(box("frame", 0, 0.95, -1.85, 0.95, 0.28, 2.9, "D", 0.01))
    objs.append(box("fifth", 0, 1.13, -2.1, 1.5, 0.08, 1.2, "X", 0.01))
    objs.append(box("deckplate", 0, 1.10, -1.0, 2.2, 0.05, 1.2, "D", 0.005))
    for sgn in (1, -1):
        objs.append(box("skirt", sgn * (hw0 - 0.10), 0.85, 0.35, 0.18, 1.0, 2.3, "P", 0.03))
        objs.append(box("skirt_lo", sgn * (hw0 - 0.11), 0.40, 0.35, 0.16, 0.12, 2.3, "D", 0.01))
        objs.append(box("flap", sgn * (hw0 - 0.30), 0.55, -3.30, 0.55, 0.75, 0.02, "D", 0.0))
        objs.append(box("step", sgn * (hw0 - 0.05), 0.75, 1.55, 0.12, 0.08, 0.45, "D", 0.005))
    rr = 0.52
    seg = 44 if lod == 0 else 24
    objs.append(K.wheel_mesh(M, (xf, rr, 2.35), rr, 0.32, truck=True, seg=seg))
    objs.append(K.wheel_mesh(M, (-xf, rr, 2.35), rr, 0.32, truck=True, seg=seg))
    for z in (-1.55, -2.80):
        for sgn in (1, -1):
            objs.append(K.wheel_mesh(M, (sgn * (hw0 - 0.18), rr, z), rr, 0.30, truck=True, seg=seg))
            objs.append(K.wheel_mesh(M, (sgn * (hw0 - 0.52), rr, z), rr, 0.30, truck=True, seg=seg))
    objs += K.projected_patch(M, cab, [(-0.92 * hw0, 1.28), (0.92 * hw0, 1.28), (0.92 * hw0, 1.30), (-0.92 * hw0, 1.30)],
                              "HL", True, name="bar")
    for sgn in (1, -1):
        objs += K.projected_patch(M, cab, [(sgn * 0.60 * hw0, 1.12), (sgn * 0.92 * hw0, 1.12), (sgn * 0.92 * hw0, 1.20),
                                           (sgn * 0.60 * hw0, 1.20)], "HL", True, name="head", housing=(1.2, "T"))
    objs += K.projected_patch(M, cab, [(-0.7 * hw0, 0.55), (0.7 * hw0, 0.55), (0.7 * hw0, 0.95), (-0.7 * hw0, 0.95)],
                              "D", True, name="grille")
    finish(objs, "semi", size)


def main():
    args = C.args_after_dashdash()
    only = args[args.index("--only") + 1].split(",") if "--only" in args else None
    read_track_sizes()
    jobs = {
        "model3": lambda: sedan("model3", SIZES["model3"], (0.02, 0.07, 0.20), "model3"),   # deep blue metallic
        "modelY": lambda: sedan("modelY", SIZES["modelY"], (0.42, 0.015, 0.02), "modelY"),  # ultra red
        "modelS": lambda: sedan("modelS", SIZES["modelS"], (0.015, 0.015, 0.018), "modelS"),  # solid black
        "cybertruck": lambda: cybertruck(SIZES["cybertruck"]),
        "semi": lambda: semi(SIZES["semi"]),
    }
    for name, job in jobs.items():
        if only and name not in only:
            continue
        C.reset_scene()
        job()


if __name__ == "__main__":
    main()
