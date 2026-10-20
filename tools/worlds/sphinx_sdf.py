#!/usr/bin/env python3
"""Sphinx von Gizeh als Signed-Distance-Feld (glatte Vereinigung von Primitiven) -> Marching
Cubes -> PLY (glTF-Rahmen: Meter, +Y oben, Blick nach +Z, Boden y = 0 = Gehegeboden).

    python3 tools/worlds/sphinx_sdf.py <out.ply>
    (danach: Blender ... build_giza.py -- --only sphinx  liest die PLY)

Maße (Lehner 1991, Hawass): Länge 73 m (Pranken bis Hinterteil), Höhe 20 m, Breite 19 m; Widerrist ~13 m,
Hinterteil ~10 m; Pranken ~15 m vor der Brust; Kopf ~4 m breit mit Nemes (an den Schultern ~9 m breit);
Nase fehlt; Leib horizontal gebändert (Member I–III, weichere Lagen tiefer ausgewittert).
"""
import sys

import numpy as np
from skimage import measure


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b * (1 - h) + a * h - k * h * (1 - h)


def ellipsoid(p, c, r):
    q = [(p[i] - c[i]) / r[i] for i in range(3)]
    k0 = np.sqrt(q[0] ** 2 + q[1] ** 2 + q[2] ** 2)
    k1 = np.sqrt((q[0] / r[0]) ** 2 + (q[1] / r[1]) ** 2 + (q[2] / r[2]) ** 2)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-6)


def roundbox(p, c, h, r):
    q = [np.abs(p[i] - c[i]) - (h[i] - r) for i in range(3)]
    out = np.sqrt(sum(np.maximum(qi, 0) ** 2 for qi in q))
    inn = np.minimum(np.maximum(q[0], np.maximum(q[1], q[2])), 0)
    return out + inn - r


def capsule(p, a, b, r):
    pa = [p[i] - a[i] for i in range(3)]
    ba = [b[i] - a[i] for i in range(3)]
    h = np.clip(sum(pa[i] * ba[i] for i in range(3)) / sum(x * x for x in ba), 0, 1)
    return np.sqrt(sum((pa[i] - ba[i] * h) ** 2 for i in range(3))) - r


def noise3(p, scale, seed):
    """Cheap value-noise sum of sines (deterministic) – enough for weathering."""
    rng = np.random.default_rng(seed)
    acc = 0
    for _ in range(6):
        d = rng.normal(size=3)
        d /= np.linalg.norm(d)
        f = rng.uniform(0.6, 1.6) / scale
        ph = rng.uniform(0, 6.283)
        acc = acc + np.sin((p[0] * d[0] + p[1] * d[1] + p[2] * d[2]) * f + ph)
    return acc / 6


def sphinx(p):
    x, y, z = p
    # body: rounded box with a back sloping from the withers (12.8 m) to the rump (10.2 m)
    body = roundbox(p, (0, 6.2, -9.0), (7.4, 6.2, 21.5), 3.0)
    ytop = 9.6 + (z + 30.0) * 0.055
    cut = y - ytop
    k = 2.0
    hh = np.clip(0.5 - 0.5 * (cut - body) / k, 0, 1)
    body = cut * (1 - hh) + body * hh + k * hh * (1 - hh)      # smooth max: rounded back
    haunch = smin(ellipsoid(p, (6.4, 4.8, -24), (2.8, 4.8, 7.5)), ellipsoid(p, (-6.4, 4.8, -24), (2.8, 4.8, 7.5)), 1.0)
    chest = ellipsoid(p, (0, 8.0, 9.5), (7.2, 7.4, 5.4))
    d = smin(body, haunch, 1.5)
    d = smin(d, chest, 2.5)
    for sx in (-1, 1):
        leg = capsule(p, (sx * 5.6, 6.5, 11.5), (sx * 5.3, 1.6, 17.0), 2.2)
        paw = roundbox(p, (sx * 5.2, 1.55, 25.0), (2.0, 1.55, 8.8), 1.1)
        d = smin(d, smin(leg, paw, 1.2), 1.0)
    d = smin(d, roundbox(p, (0, 3.2, 14.8), (3.2, 3.2, 1.8), 1.0), 1.0)          # chest wall between the legs
    # erosion bands on the body (soft layers recessed); the head is harder limestone
    band = 0.14 * np.clip(np.sin(y * 2.75) * 1.4, -1, 1) + 0.05 * np.sin(y * 7.1 + 1.3)
    wear = 0.18 * noise3(p, 1.6, 3) + 0.07 * noise3(p, 0.45, 5)
    wmask = np.clip((12.0 - y) / 2.0, 0, 1)
    d = d + (band + wear + 0.08) * wmask
    # neck, nemes headdress (trapezoid, wide at the shoulders), lappets, face, head top
    neck = capsule(p, (0, 10.5, 9.4), (0, 14.0, 10.0), 2.4)
    hw = np.clip(5.1 - (y - 12.4) * 0.5, 2.5, 5.2)
    nemes = roundbox((x * 4.7 / hw, y, z), (0, 15.9, 9.1), (4.7, 3.4, 2.0), 0.6)
    lap = smin(roundbox(p, (3.1, 13.6, 10.8), (1.0, 2.5, 0.75), 0.4), roundbox(p, (-3.1, 13.6, 10.8), (1.0, 2.5, 0.75), 0.4), 0.4)
    face = ellipsoid(p, (0, 16.4, 11.6), (2.05, 2.7, 1.55))
    top = ellipsoid(p, (0, 19.0, 9.5), (2.5, 0.9, 2.3))
    head = smin(smin(smin(neck, nemes, 0.6), lap, 0.3), smin(face, top, 0.5), 0.35)
    head = np.maximum(head, -roundbox(p, (0, 16.1, 13.35), (0.6, 0.65, 0.35), 0.25))   # missing nose (flat break)
    head = head + 0.06 * noise3(p, 0.6, 9)
    d = smin(d, head, 0.9)
    return np.maximum(d, -(y + 0.4))       # cut at the enclosure floor


def main(out):
    v = 0.22
    xs = np.arange(-9.6, 9.6 + v, v)
    ys = np.arange(-0.6, 20.6 + v, v)
    zs = np.arange(-33.0, 35.0 + v, v)
    X, Y, Z = np.meshgrid(xs, ys, zs, indexing="ij")
    F = sphinx((X, Y, Z)).astype(np.float32)
    verts, faces, _, _ = measure.marching_cubes(F, 0.0, spacing=(v, v, v))
    verts += np.array([xs[0], ys[0], zs[0]])
    with open(out, "w") as f:
        f.write(f"ply\nformat ascii 1.0\nelement vertex {len(verts)}\nproperty float x\nproperty float y\nproperty float z\n"
                f"element face {len(faces)}\nproperty list uchar int vertex_indices\nend_header\n")
        for a in verts:
            f.write(f"{a[0]:.3f} {a[1]:.3f} {a[2]:.3f}\n")
        for t in faces:
            f.write(f"3 {t[0]} {t[1]} {t[2]}\n")
    print(f"sphinx: {len(verts)} v, {len(faces)} f, bbox {verts.min(0)} {verts.max(0)}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "sphinx.ply")
