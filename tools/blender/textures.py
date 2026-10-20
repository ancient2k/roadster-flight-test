"""Procedural, tileable PBR textures generated with numpy inside Blender (no external assets).

All functions return bpy Images packed into the .blend so the glTF exporter embeds them.
Sizes are kept moderate (<= 2k) since every map tiles; physical scale is applied per material via
a Mapping node (exported as KHR_texture_transform).
"""
from __future__ import annotations

import bpy
import numpy as np


def _image(name: str, rgba: np.ndarray, non_color: bool) -> bpy.types.Image:
    h, w, _ = rgba.shape
    img = bpy.data.images.get(name)
    if img is not None:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, width=w, height=h, alpha=False, float_buffer=False)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.clip(rgba, 0, 1).astype(np.float32).ravel())
    img.file_format = "PNG"
    img.pack()
    return img


def _rgba(r, g=None, b=None):
    g = r if g is None else g
    b = r if b is None else b
    return np.stack([r, g, b, np.ones_like(r)], axis=-1)


def _normal_from_height(hgt: np.ndarray, strength: float) -> np.ndarray:
    """Tangent-space normal map (OpenGL / glTF convention, +Y up) from a tileable height field."""
    dx = (np.roll(hgt, -1, axis=1) - np.roll(hgt, 1, axis=1)) * 0.5
    dy = (np.roll(hgt, -1, axis=0) - np.roll(hgt, 1, axis=0)) * 0.5
    nx, ny, nz = -dx * strength, -dy * strength, np.ones_like(hgt)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    return _rgba(nx / ln * 0.5 + 0.5, ny / ln * 0.5 + 0.5, nz / ln * 0.5 + 0.5)


def _tile_noise(n: int, cells: int, seed: int) -> np.ndarray:
    """Tileable value noise (bicubic-ish via smoothstep) in [0,1]."""
    rng = np.random.default_rng(seed)
    g = rng.random((cells, cells))
    t = np.arange(n) / n * cells
    i0 = np.floor(t).astype(int)
    f = t - i0
    f = f * f * (3 - 2 * f)
    i1 = (i0 + 1) % cells
    a = g[np.ix_(i0, i0)]; b = g[np.ix_(i0, i1)]; c = g[np.ix_(i1, i0)]; d = g[np.ix_(i1, i1)]
    fx = f[None, :]; fy = f[:, None]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(n: int, seed: int, octaves=(4, 8, 16, 32, 64), gains=(0.5, 0.25, 0.13, 0.07, 0.04)) -> np.ndarray:
    out = np.zeros((n, n))
    for k, (c, gn) in enumerate(zip(octaves, gains)):
        out += _tile_noise(n, c, seed + k) * gn
    return (out - out.min()) / (np.ptp(out) + 1e-9)


# ---------------------------------------------------------------- carbon fibre 2x2 twill
def carbon(n: int = 1024, tows: int = 8):
    """Returns (base_color, normal, roughness) images. One tile = `tows` x `tows` tows."""
    y, x = np.mgrid[0:n, 0:n] / n * tows
    i, j = np.floor(x).astype(int), np.floor(y).astype(int)
    u, v = x - i, y - j                       # position inside the cell
    warp = ((i + j) % 4) < 2                  # 2/2 twill: which tow is on top
    across = np.where(warp, u, v) * 2 - 1     # across the visible tow
    along = np.where(warp, v, u) * 2 - 1
    bulge = np.sqrt(np.clip(1 - across ** 2, 0, 1))
    ends = 1 - 0.35 * along ** 4              # tow dips under at the cell ends
    fibre = 0.06 * np.sin((np.where(warp, x, y)) * 2 * np.pi * 22)  # fine fibre striations
    hgt = bulge * ends + fibre * bulge
    rng = np.random.default_rng(3)
    tone = 0.022 + 0.020 * bulge * (0.6 + 0.4 * np.where(warp, 1.0, 0.55))
    tone += (rng.random((n, n)) - 0.5) * 0.004
    base = _rgba(tone, tone * 1.02, tone * 1.08)
    rough = 0.32 + 0.12 * (1 - bulge)
    return (_image("T_Carbon_BaseColor", base, False), _image("T_Carbon_Normal", _normal_from_height(hgt, 6.0), True),
            _image("T_Carbon_Roughness", _rgba(rough), True))


# ---------------------------------------------------------------- clear-coat micro variation
def paint_roughness(n: int = 1024, base: float = 0.46, var: float = 0.06):
    """Roughness map: low-frequency orange-peel/cloud variation + sparse fine micro-scratches."""
    r = base + (fbm(n, 11) - 0.5) * var
    rng = np.random.default_rng(5)
    yy, xx = np.mgrid[0:n, 0:n]
    scratch = np.zeros((n, n))
    for _ in range(140):
        x0, y0 = rng.random(2) * n
        ang = rng.random() * np.pi
        length = rng.random() * n * 0.25 + 20
        ca, sa = np.cos(ang), np.sin(ang)
        dxs, dys = (xx - x0 + n / 2) % n - n / 2, (yy - y0 + n / 2) % n - n / 2
        along = dxs * ca + dys * sa
        dist = np.abs(-dxs * sa + dys * ca)
        scratch = np.maximum(scratch, np.where((np.abs(along) < length / 2) & (dist < 0.8), rng.random() * 0.6 + 0.4, 0))
    r = r - scratch * 0.12
    return _image("T_Paint_Roughness", _rgba(r), True)


def paint_normal(n: int = 1024):
    """Very subtle orange-peel normal map for the clear coat."""
    h = fbm(n, 21, octaves=(32, 64, 128), gains=(0.5, 0.3, 0.2))
    return _image("T_Paint_Normal", _normal_from_height(h, 0.6), True)


# ---------------------------------------------------------------- tyre (u = around, v = across profile)
def tire(nu: int = 512, nv: int = 1024, tread_lo: float = 0.30, tread_hi: float = 0.70):
    """One repeat of tread/sidewall detail. v runs across the lathe profile (inner bead -> outer bead)."""
    v, u = np.mgrid[0:nv, 0:nu]
    u = u / nu; v = v / nv
    hgt = np.zeros((nv, nu))
    tread = (v > tread_lo) & (v < tread_hi)
    t = (v - tread_lo) / (tread_hi - tread_lo)
    # asymmetric performance tread: diagonal sipes in the shoulders, plain centre ribs
    sipe = np.abs(((u * 3 + t * 1.6) % 1.0) - 0.5) < 0.035
    shoulder = (t < 0.22) | (t > 0.78)
    hgt -= np.where(tread & shoulder & sipe, 0.8, 0)
    micro = np.abs(((u * 3 + t * 0.4) % 1.0) - 0.5) < 0.012
    hgt -= np.where(tread & ~shoulder & micro, 0.35, 0)
    # sidewall: fine radial ribs on a band + smooth rim protector ring (no lettering)
    side = ~tread
    sv = np.where(v < tread_lo, v / tread_lo, (1 - v) / (1 - tread_hi))  # 0 at bead, 1 at shoulder
    band = (sv > 0.35) & (sv < 0.75)
    hgt += np.where(side & band, 0.18 * (np.sin(u * 2 * np.pi * 60) > 0.6), 0)
    hgt += np.where(side & (sv > 0.10) & (sv < 0.18), 0.5, 0)
    rough = np.where(tread, 0.80, 0.70) + np.where(side & band, -0.08, 0)
    base = np.where(tread, 0.030, 0.036)
    return (_image("T_Tire_Normal", _normal_from_height(hgt, 3.0), True),
            _image("T_Tire_Roughness", _rgba(rough), True), _image("T_Tire_BaseColor", _rgba(base), False))


# ---------------------------------------------------------------- cross-drilled / slotted brake disc (planar UV)
def brake_disc(n: int = 1024, r_in: float = 0.24, r_out: float = 0.98, holes_per_ring: int = 24):
    """UV square maps the disc face (centre 0.5, radius 0.5 = disc outer radius)."""
    y, x = (np.mgrid[0:n, 0:n] + 0.5) / n * 2 - 1
    r = np.sqrt(x * x + y * y)
    a = np.arctan2(y, x)
    hgt = np.zeros((n, n))
    base = np.full((n, n), 0.34)
    for k, rr in enumerate((0.52, 0.66, 0.80)):
        off = k * np.pi / holes_per_ring * 0.66
        ang = (a + off) % (2 * np.pi / holes_per_ring) - np.pi / holes_per_ring
        dx = ang * rr
        dr = r - rr
        d = np.sqrt(dx * dx + dr * dr)
        hole = d < 0.022
        hgt -= hole * 1.0
        base = np.where(hole, 0.03, base)
        base = np.where((d >= 0.022) & (d < 0.03), base * 0.75, base)
    # curved slots between hole rings
    slot = (np.abs(((a * 6 / np.pi + r * 3.0) % 1.0) - 0.5) < 0.02) & (r > 0.45) & (r < 0.92)
    hgt -= slot * 0.4
    base = np.where(slot, 0.18, base)
    # concentric machining grooves + hat (inner) darker
    base = base + 0.02 * np.sin(r * 400)
    base = np.where(r < r_in * 1.6, 0.12, base)
    rough = np.where(r < r_in * 1.6, 0.6, 0.38 + 0.05 * np.sin(r * 400))
    return (_image("T_Disc_BaseColor", _rgba(base), False), _image("T_Disc_Normal", _normal_from_height(hgt, 4.0), True),
            _image("T_Disc_Roughness", _rgba(rough), True))


# ---------------------------------------------------------------- perforated leather (seats)
def leather(n: int = 512):
    h = fbm(n, 31, octaves=(16, 32, 64, 128), gains=(0.4, 0.3, 0.2, 0.1)) * 0.6
    y, x = np.mgrid[0:n, 0:n] / n * 24
    perf = (np.hypot((x % 1) - 0.5, (y % 1) - 0.5) < 0.12)
    h = h - perf * 0.8
    return _image("T_Leather_Normal", _normal_from_height(h, 2.5), True)
