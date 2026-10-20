"""Prairie vegetation for instancing — grass_clump.glb, shrub.glb (alpha test, 1 mesh / 1 material each).

  Blender -b --factory-startup -P tools/blender/env/build_vegetation.py

Textures are painted procedurally (no third-party sources):
  grass_clump  dry bunch grasses like the McGregor prairie in October (little bluestem / buffalograss):
               straw yellow to grey-brown, seed heads; 10 curved cross cards, ~0.65 m tall, Ø ~0.8 m.
  shrub        low mesquite/sage shrub, olive grey-green with dark twigs; 22 cards in a
               hemispherical arrangement, ~1.3 m tall, Ø ~1.8 m.
The card normals are tilted towards the hemisphere normal (soft, even lighting without dark
back faces). Material: alphaMode MASK (cutoff 0.5), doubleSided.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import env_common as E  # noqa: E402


def stamp_line(img, cov, pts, widths, col):
    """Draw a polyline as a sequence of soft discs into an RGBA image (row 0 = bottom)."""
    h, w = cov.shape
    for (x, y), r in zip(pts, widths):
        r = max(r, 0.6)
        x0, x1 = int(max(x - r - 1, 0)), int(min(x + r + 2, w))
        y0, y1 = int(max(y - r - 1, 0)), int(min(y + r + 2, h))
        if x0 >= x1 or y0 >= y1:
            continue
        yy, xx = np.mgrid[y0:y1, x0:x1]
        d = np.sqrt((xx - x) ** 2 + (yy - y) ** 2)
        a = np.clip(r + 0.5 - d, 0, 1)
        sel = a > cov[y0:y1, x0:x1] * 0.0
        img[y0:y1, x0:x1, :3] = np.where(a[..., None] > 0, img[y0:y1, x0:x1, :3] * (1 - a[..., None]) + np.array(col) * a[..., None], img[y0:y1, x0:x1, :3])
        cov[y0:y1, x0:x1] = np.maximum(cov[y0:y1, x0:x1], a)


def grass_atlas(n=512, seed=1):
    r = np.random.default_rng(seed)
    img = np.zeros((n, n, 4), np.float32)
    cov = np.zeros((n, n), np.float32)
    pal = [(0.78, 0.66, 0.44), (0.70, 0.56, 0.36), (0.62, 0.52, 0.38), (0.52, 0.45, 0.35), (0.80, 0.72, 0.52), (0.44, 0.42, 0.28)]
    for k in range(170):
        bx = n * (0.5 + r.normal(0, 0.12))
        ang = r.normal(0, 0.28)
        L = n * r.uniform(0.45, 0.97)
        bend = r.normal(0, 0.5)
        col = np.array(pal[r.integers(len(pal))]) * r.uniform(0.8, 1.1)
        m = 70
        t = np.linspace(0, 1, m)
        xs = bx + np.sin(ang) * L * t + bend * (t ** 2) * L * 0.35
        ys = 2 + np.cos(ang) * L * t - abs(bend) * (t ** 2) * L * 0.12
        wd = 3.2 * (1 - t) ** 0.8 + 0.4
        shade = 0.55 + 0.45 * t                      # darker at the bottom (self-shadowing)
        for i in range(0, m, 1):
            stamp_line(img, cov, [(xs[i], ys[i])], [wd[i]], np.clip(col * shade[i], 0, 1))
        if r.random() < 0.18:                         # seed head (fluffy, lighter)
            for j in range(10):
                tt = 1 - j * 0.03
                x = bx + np.sin(ang) * L * tt + bend * tt * tt * L * 0.35 + r.normal(0, 2.2)
                y = 2 + np.cos(ang) * L * tt - abs(bend) * tt * tt * L * 0.12
                stamp_line(img, cov, [(x, y)], [2.0], np.clip(np.array((0.74, 0.68, 0.55)) * r.uniform(0.85, 1.05), 0, 1))
    img[..., 3] = cov
    # bleed the colour into the transparent margins (against dark fringes when mipmapping)
    mean = img[cov > 0.5, :3].mean(axis=0)
    img[..., :3] = np.where(cov[..., None] > 0.02, img[..., :3], mean)
    return E.save_rgba(img, "grass_clump.png")


def shrub_atlas(n=512, seed=2):
    r = np.random.default_rng(seed)
    img = np.zeros((n, n, 4), np.float32)
    cov = np.zeros((n, n), np.float32)
    twig = (0.16, 0.12, 0.09)
    leaf_pal = [(0.36, 0.38, 0.27), (0.42, 0.44, 0.33), (0.30, 0.33, 0.23), (0.50, 0.50, 0.40), (0.38, 0.36, 0.24)]

    def branch(x, y, a, L, wdt, depth):
        m = max(int(L / 3), 2)
        pts, ws = [], []
        for i in range(m):
            t = i / (m - 1)
            a2 = a + r.normal(0, 0.05)
            x += math.sin(a2) * L / m
            y += math.cos(a2) * L / m
            pts.append((x, y))
            ws.append(wdt * (1 - 0.6 * t))
        stamp_line(img, cov, pts, ws, twig)
        if depth > 0:
            for _ in range(r.integers(2, 4)):
                k = r.integers(len(pts) // 3, len(pts))
                branch(pts[k][0], pts[k][1], a + r.normal(0, 0.7), L * r.uniform(0.45, 0.7), wdt * 0.6, depth - 1)
        else:
            for _ in range(int(L / 4)):   # leaf clusters at the twig ends
                px, py = pts[r.integers(len(pts))]
                for _ in range(4):
                    lx, ly = px + r.normal(0, 7), py + r.normal(0, 7)
                    la = r.uniform(0, math.pi)
                    c = np.array(leaf_pal[r.integers(len(leaf_pal))]) * r.uniform(0.8, 1.15)
                    stamp_line(img, cov, [(lx, ly), (lx + math.cos(la) * 3, ly + math.sin(la) * 3), (lx + math.cos(la) * 6, ly + math.sin(la) * 6)],
                               [1.6, 2.2, 1.4], np.clip(c, 0, 1))

    for _ in range(5):
        branch(n * 0.5 + r.normal(0, 18), 2, r.normal(0, 0.45), n * 0.5, 7.0, 3)
    img[..., 3] = cov
    mean = img[cov > 0.5, :3].mean(axis=0)
    img[..., :3] = np.where(cov[..., None] > 0.02, img[..., :3], mean)
    return E.save_rgba(img, "shrub.png")


def bent_card(mb, angle, width, height, lean, mat, segs=4, base=(0, 0, 0), uv_rect=(0, 0, 1, 1)):
    """Vertical card (width along local x), leaning outwards at the top (lean in rad at the upper end)."""
    R = Matrix.Translation(base) @ Matrix.Rotation(angle, 4, "Y")
    mb.push(R)
    u0, v0, u1, v1 = uv_rect
    rows = []
    for i in range(segs + 1):
        t = i / segs
        y = height * t * math.cos(lean * t * 0.6)
        z = height * math.sin(lean * t) * t * 0.6
        rows.append([mb.add_v((-width / 2, y, z)), mb.add_v((width / 2, y, z))])
    for i in range(segs):
        va, vb = v0 + (v1 - v0) * i / segs, v0 + (v1 - v0) * (i + 1) / segs
        mb.face((rows[i][0], rows[i][1], rows[i + 1][1], rows[i + 1][0]), [(u0, va), (u1, va), (u1, vb), (u0, vb)], mat, True)
    mb.pop()


def soft_normals(ob, center: Vector, up_bias=0.6):
    """Custom normals = mix of the hemisphere normal (away from the centre) and +Y (glTF) = +Z (Blender)."""
    me = ob.data
    ns = []
    for loop in me.loops:
        p = me.vertices[loop.vertex_index].co
        d = (p - center)
        d.z = max(d.z, 0.0)
        d = d.normalized() if d.length > 1e-6 else Vector((0, 0, 1))
        ns.append((d * (1 - up_bias) + Vector((0, 0, 1)) * up_bias).normalized())
    me.normals_split_custom_set(ns)


def grass():
    E.reset()
    tex = grass_atlas()
    E.material("Grass_Dry", (1, 1, 1), 0.0, 0.85, diff=tex, alpha_mask=True, double_sided=True)
    mb = E.MB()
    r = np.random.default_rng(11)
    n = 10
    for k in range(n):
        a = k * math.pi / n + r.normal(0, 0.15)
        off = (r.normal(0, 0.06), 0, r.normal(0, 0.06))
        h = r.uniform(0.5, 0.72)
        bent_card(mb, a, r.uniform(0.6, 0.85), h, r.uniform(0.15, 0.45) * (1 if k % 2 else -1), "Grass_Dry", 3, off)
    ob = mb.build("GrassClump")
    soft_normals(ob, E.G(0, -0.3, 0), 0.55)
    print(f"[ws-f] grass_clump: {mb.tri_count()} tris")
    E.export_glb("grass_clump")


def shrub():
    E.reset()
    tex = shrub_atlas()
    E.material("Shrub_Leaves", (1, 1, 1), 0.0, 0.8, diff=tex, alpha_mask=True, double_sided=True)
    mb = E.MB()
    r = np.random.default_rng(12)
    # inner ring of upright cards + outer ring of flatter tilted cards (hemispherical silhouette)
    for k in range(10):
        a = k * math.pi / 10 + r.normal(0, 0.1)
        bent_card(mb, a, r.uniform(1.3, 1.7), r.uniform(1.1, 1.35), r.normal(0, 0.15), "Shrub_Leaves", 3,
                  (r.normal(0, 0.1), 0, r.normal(0, 0.1)))
    for k in range(12):
        a = k * 2 * math.pi / 12 + r.normal(0, 0.1)
        base = (math.sin(a) * 0.45, 0.0, math.cos(a) * 0.45)
        bent_card(mb, a, r.uniform(0.9, 1.2), r.uniform(0.75, 0.95), 0.9, "Shrub_Leaves", 3, base)
    ob = mb.build("Shrub")
    soft_normals(ob, E.G(0, 0.1, 0), 0.35)
    print(f"[ws-f] shrub: {mb.tri_count()} tris")
    E.export_glb("shrub")


grass()
shrub()
