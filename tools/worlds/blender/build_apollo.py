"""Worlds: Apollo LM descent stage (after ascent) + experiments.

  Blender -b --factory-startup -P tools/worlds/blender/build_apollo.py -- --mission 11|15 [--out <dir>]

Dimensions (NASA LM Apollo Operations Handbook / Grumman LM News Reference): octagonal descent stage, width across
flats 4.22 m, body height 1.65 m, lower edge ~1.5 m above the footpads, footpad circle 9.45 m (pads Ø 0.94 m),
descent engine nozzle Ø 1.51 m, contact probes 1.7 m (on 3 legs, bent over at touchdown), ladder on the
front leg (+Z, 9 rungs), plaque 22.9 x 19.4 cm on the ladder strut. Thermal protection: crinkled Kapton foil
(gold/amber), black H-film, aluminised Mylar foil.
padded foil panels with seam tapes and a jagged skirt, frame profiles, landing gear with primary strut
(foil + piston), secondary struts, deployment truss, footpads with ball joint, porch, upper deck with fittings and
RCS deflectors, quads (MESA folded down, SEQ bay open, empty LRV bay on Apollo 15), new crinkle maps.
Respect the part regions (meta.json `dynamic`, src/shared/props.ts): legs |across| <= 2.3 m, radial 2.25..5.3 m,
y < 3.6 m; engine |x|,|z| <= 0.8 m, y 0.45..1.51 m; everything else belongs to the body. Check with:
python3 tools/worlds/check_prop_regions.py <glb> public/assets/worlds/<site>/meta.json
glTF frame: origin = centre between the footpads at ground level, +Z = front (hatch/ladder).
Apollo 11: additionally EASEP (seismometer PSEP, laser reflector LRRR) and the fallen flag.
Apollo 15: additionally the Lunar Roving Vehicle (simplified) and the ALSEP central station.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "blender", "env"))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import env_common as E  # noqa: E402

A = E.args()
MISSION = int(A[A.index("--mission") + 1]) if "--mission" in A else 11
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT = os.path.join(ROOT, "public", "assets", "worlds", "moon_tranquility" if MISSION == 11 else "moon_hadley")
if "--out" in A:                       # test builds outside public/
    OUT = os.path.abspath(A[A.index("--out") + 1])


def crinkle_textures(n=2048, seed=5):
    """Crinkle foil (Kapton/H-film over aluminium), tileable, 1 tile = 1 m.

    Height field from three levels: (1) long, straight creases (periodic ridge lines with integer
    wave vectors, cut into sections), (2) facets ~6-15 cm (Voronoi, one tilted plane per cell),
    (3) micro crinkles (fBm). From it a normal, an ARM (roughness per facet, AO in the creases) and a
    brightness map (base colour multiplier: facets of different brightness, creases darker).
    """
    r = np.random.default_rng(seed)
    y, x = np.mgrid[0:n, 0:n].astype(np.float32) / n
    # (2) facets: Voronoi on the torus, random tilt per cell
    m = 150
    pts = r.random((m, 2)).astype(np.float32)
    tilt = r.normal(0, 1, (m, 2)).astype(np.float32)
    lum = r.uniform(0.0, 1.0, m).astype(np.float32)
    d1 = np.full((n, n), 9.0, np.float32)
    d2 = np.full((n, n), 9.0, np.float32)
    cid = np.zeros((n, n), np.int32)
    dxc = np.zeros((n, n), np.float32)
    dyc = np.zeros((n, n), np.float32)
    W = int(0.22 * n)                                    # window around each point (torus: indices wrap around)
    for i, (px, py) in enumerate(pts):
        cx, cy = int(px * n), int(py * n)
        gx_ = np.arange(cx - W, cx + W)
        gy_ = np.arange(cy - W, cy + W)
        ix, iy = gx_ % n, gy_ % n
        blk = np.ix_(iy, ix)
        ddx = (gx_[None, :] / n - px).astype(np.float32) + np.zeros((len(gy_), 1), np.float32)
        ddy = (gy_[:, None] / n - py).astype(np.float32) + np.zeros((1, len(gx_)), np.float32)
        d = np.sqrt(ddx * ddx + ddy * ddy)
        b1, b2 = d1[blk], d2[blk]
        closer = d < b1
        d2[blk] = np.where(closer, b1, np.minimum(b2, d))
        d1[blk] = np.where(closer, d, b1)
        cid[blk] = np.where(closer, i, cid[blk])
        dxc[blk] = np.where(closer, ddx, dxc[blk])
        dyc[blk] = np.where(closer, ddy, dyc[blk])
    edge = np.clip((d2 - d1) * 28, 0, 1)                 # 0 on the cell border
    facet = (tilt[cid, 0] * dxc + tilt[cid, 1] * dyc) * 1.6
    # (1) creases: ridge |sin| with integer wave vector (tileable), faded out in sections
    fold = np.zeros((n, n), np.float32)
    seg = E.fbm(n, 2.6, seed + 7)
    for k in range(26):
        kx, ky = int(r.integers(-4, 5)), int(r.integers(-4, 5))
        if kx == 0 and ky == 0:
            continue
        ph = r.uniform(0, 2 * np.pi)
        s = np.abs(np.sin(np.pi * (kx * x + ky * y) + ph))
        ridge = (1 - s) ** 6                             # sharp ridge
        gate = np.clip((np.roll(seg, (int(r.integers(n)), int(r.integers(n))), (0, 1)) - 0.45) * 5, 0, 1)
        fold += ridge * gate * r.uniform(0.4, 1.0) * (1 if r.random() < 0.6 else -1)
    micro = E.fbm(n, 1.5, seed + 1)
    big = E.fbm(n, 2.4, seed + 2)
    h = facet * 0.007 + (1 - edge) ** 2 * 0.003 + fold * 0.014 + (micro - 0.5) * 0.0012 + (big - 0.5) * 0.03
    gy, gx = np.gradient(h * n)                          # height in metres -> slope per metre
    nrm = np.stack([-gx, -gy, np.ones_like(h)], -1)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    img = np.ones((n, n, 4), np.float32)
    img[..., :3] = nrm * 0.5 + 0.5
    img = (img[0::2, 0::2] + img[1::2, 0::2] + img[0::2, 1::2] + img[1::2, 1::2]) * 0.25   # 2x2 mean -> 1024²
    nor = E._save(img, os.path.join(E.TEX, "lm_crinkle2_nor.jpg"), "JPEG", 92)
    q = n // 2                                           # ARM and brightness are fine at half resolution
    crease = np.clip((1 - edge) * 0.6 + np.abs(fold) * 0.8, 0, 1)
    arm = np.ones((n, n, 4), np.float32)
    arm[..., 0] = 1 - 0.35 * crease                      # AO in the creases
    # smooth, specular islands (large cells without creases) next to more matte crinkle zones
    arm[..., 1] = np.clip(0.14 + 0.34 * lum[cid] ** 2 + 0.26 * crease + 0.06 * (micro - 0.5), 0.08, 0.85)
    arm[..., 2] = 1.0
    armp = E._save(arm[::2, ::2], os.path.join(E.TEX, "lm_crinkle2_arm.jpg"), "JPEG", 92)
    v = np.clip(0.80 + 0.22 * (lum[cid] - 0.5) - 0.22 * crease + 0.10 * (big - 0.5), 0.45, 1.0)
    col = np.ones((n, n, 4), np.float32)
    col[..., 0] = v
    col[..., 1] = v * (0.97 + 0.03 * lum[cid])           # Kapton: dark creases slightly redder
    col[..., 2] = v * (0.93 + 0.07 * lum[cid])
    var = E._save(col[::2, ::2], os.path.join(E.TEX, "lm_crinkle2_var.jpg"), "JPEG", 90)
    return nor, armp, var, q


def plaque_texture(n=256):
    """Plaque Apollo 11/15 (stainless steel): two Earth hemispheres as outlines, text lines hinted as engraving
    (no lettering reproduced); brushed rim."""
    y, x = np.mgrid[0:n, 0:n].astype(np.float32) / n
    v = 0.72 + 0.06 * E.fbm(n, 1.0, 3)
    for cx in (0.3, 0.7):
        d = np.sqrt((x - cx) ** 2 + (y - 0.72) ** 2)
        v -= 0.25 * (np.abs(d - 0.16) < 0.006)
        v -= 0.08 * ((d < 0.16) & (E.fbm(n, 2.5, 9 + int(cx * 10)) > 0.55))
    for k, (yy, w) in enumerate(((0.42, 0.7), (0.36, 0.62), (0.30, 0.66), (0.20, 0.5), (0.14, 0.5), (0.08, 0.5))):
        on = (np.abs(y - yy) < 0.012) & (np.abs(x - 0.5) < w / 2) & (np.sin(x * 160 + k) > -0.4)
        v -= 0.22 * on
    v -= 0.15 * ((x < 0.03) | (x > 0.97) | (y < 0.03) | (y > 0.97))
    img = np.ones((n, n, 4), np.float32)
    img[..., :3] = np.clip(v, 0, 1)[..., None]
    return E._save(img, os.path.join(E.TEX, "lm_plaque.jpg"), "JPEG", 90)


def foil(name, color, nor, arm, var, rough_bias=0.0, tile=1.0, strength=1.0):
    # glTF: roughness = factor x ARM.g -> the factor carries the offset; base colour = colour x brightness map.
    # Metallic (>= 0.9 with a normal map): landmarks.ts foilAA raises the roughness with distance.
    m = E.material(name, color, 1.0, 1.0 + rough_bias, diff=var, nor=nor, arm=arm, normal_strength=strength, tile=tile)
    # image x colour as Mix(MULTIPLY): the glTF exporter turns it into baseColorTexture + baseColorFactor
    nt = m.node_tree
    p = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    img = next(n for n in nt.nodes if n.type == "TEX_IMAGE" and n.outputs["Color"].links and n.outputs["Color"].links[0].to_socket == p.inputs["Base Color"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    nt.links.new(img.outputs["Color"], mix.inputs[6])
    mix.inputs[7].default_value = (*color, 1.0)
    nt.links.new(mix.outputs[2], p.inputs["Base Color"])
    return m


def blanket(mb, a, b, y0, y1, mat, rng, nu=10, nv=8, bulge=0.06, inset=0.0, quilt=0):
    """Thermal blanket between the corners a, b (x, z) from y0 to y1: taped down at the edge, padded in between,
    with random bulges (two frequencies) and optional quilt seams (quilt = number of vertical seams)."""
    ax, az = a
    bx, bz = b
    nx, nz = (bz - az), -(bx - ax)
    L = math.hypot(nx, nz) or 1.0
    nx, nz = nx / L, nz / L
    ph = [rng.uniform(0, 6.3) for _ in range(4)]
    P = []
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            u, v = i / nu, j / nv
            edge = math.sin(math.pi * u) ** 0.7 * math.sin(math.pi * v) ** 0.7
            lump = 0.5 + 0.25 * math.sin(7.0 * u + ph[0]) * math.sin(5.0 * v + ph[1]) + 0.25 * math.sin(13.0 * u + ph[2] + 9 * v) * math.cos(11.0 * v + ph[3])
            if quilt:
                lump *= 0.55 + 0.45 * abs(math.sin(math.pi * u * (quilt + 1)))
            d = inset + bulge * edge * (0.45 + 0.55 * lump) * (0.8 + 0.4 * rng.random())
            row.append((ax + (bx - ax) * u + nx * d, y0 + (y1 - y0) * v, az + (bz - az) * u + nz * d))
        P.append(row)
    for j in range(nv):
        for i in range(nu):
            mb.poly([P[j][i], P[j][i + 1], P[j + 1][i + 1], P[j + 1][i]][::-1], mat, smooth=True)


def strip(mb, a, b, y0, y1, out, mat, w=0.05):
    """Tape/seam strip, vertical, at the position a->b (width w, offset outwards by `out`)."""
    ax, az = a
    bx, bz = b
    nx, nz = (bz - az), -(bx - ax)
    L = math.hypot(nx, nz) or 1.0
    tx, tz = (bx - ax) / L, (bz - az) / L
    nx, nz = nx / L, nz / L
    cx, cz = ax + nx * out, az + nz * out
    mb.poly([(cx - tx * w / 2, y0, cz - tz * w / 2), (cx + tx * w / 2, y0, cz + tz * w / 2),
             (cx + tx * w / 2, y1, cz + tz * w / 2), (cx - tx * w / 2, y1, cz - tz * w / 2)][::-1], mat)


R_FLAT = 2.11                  # half the width across flats of the descent stage (4.22 m across the faces)
Y0, Y1 = 1.52, 3.17            # lower edge / upper deck
PAD_R = 4.72                   # footpad centre (footpad circle 9.45 m)


def oct_ring(r_flat):
    oct_r = r_flat / math.cos(math.pi / 8)
    return [(oct_r * math.cos(math.pi / 8 + k * math.pi / 4), oct_r * math.sin(math.pi / 8 + k * math.pi / 4)) for k in range(8)]


def face_frame(k):
    """Side k of the octagonal shell (centre at angle k*45° from +X towards +Z): centre, normal, tangent (x, z)."""
    a = k * math.pi / 4
    n = (math.cos(a), math.sin(a))
    t = (-math.sin(a), math.cos(a))
    return (n[0] * R_FLAT, n[1] * R_FLAT), n, t


def body_shell(mb, quads):
    """Octagonal frame with foil panels. quads: side k -> 'gold' | 'black' | 'mesa' | 'bay' | 'seq'."""
    ring = oct_ring(R_FLAT)
    # corner i lies at 22.5° + i*45°; the side centred at k*45° lies between corners k-1 and k
    for k in range(8):
        a, b = ring[(k - 1) % 8], ring[k]
        kind = quads.get(k, "gold")
        main = k % 2 == 0
        if kind in ("mesa", "bay", "seq"):
            open_bay(mb, k, a, b, kind)
            continue
        # two to three panels per side, with seam tape in between
        nb = 3 if main else 2
        for s in range(nb):
            u0, u1 = s / nb, (s + 1) / nb
            pa = (a[0] + (b[0] - a[0]) * u0, a[1] + (b[1] - a[1]) * u0)
            pb = (a[0] + (b[0] - a[0]) * u1, a[1] + (b[1] - a[1]) * u1)
            if kind == "black":
                mat = "Hfilm_Black" if s != 1 or nb == 2 else "Mylar_Silver"
            else:
                mat = "Kapton_Gold" if (s + k) % 3 else "Kapton_Amber"
            # lower band (bottom area) black, gold above (photos Apollo 11/15)
            yb = Y0 + 0.32 if main else Y0 + 0.22
            blanket(mb, pa, pb, Y0, yb, "Hfilm_Black", RNG, nu=6, nv=2, bulge=0.025, inset=0.01)
            blanket(mb, pa, pb, yb, Y1, mat, RNG, nu=8, nv=8, bulge=0.085 if main else 0.06, inset=0.01, quilt=1 if main else 0)
            if s:
                strip(mb, pa, pa, Y0, Y1, 0.055, "Tape_Gold", w=0.06)
            # foil skirt below the lower edge (jagged, standing off slightly): breaks up the straight box edge
            m_ = 4
            nx_, nz_ = (pb[1] - pa[1]), -(pb[0] - pa[0])
            L_ = math.hypot(nx_, nz_) or 1.0
            nx_, nz_ = nx_ / L_, nz_ / L_
            for q_ in range(m_):
                f0, f1 = q_ / m_, (q_ + 1) / m_
                a0 = (pa[0] + (pb[0] - pa[0]) * f0 + nx_ * 0.02, Y0 + 0.06, pa[1] + (pb[1] - pa[1]) * f0 + nz_ * 0.02)
                a1 = (pa[0] + (pb[0] - pa[0]) * f1 + nx_ * 0.02, Y0 + 0.06, pa[1] + (pb[1] - pa[1]) * f1 + nz_ * 0.02)
                o = RNG.uniform(0.01, 0.06)
                b1 = (a1[0] + nx_ * o, Y0 - RNG.uniform(0.02, 0.12), a1[2] + nz_ * o)
                b0 = (a0[0] + nx_ * o, Y0 - RNG.uniform(0.02, 0.12), a0[2] + nz_ * o)
                mb.poly([a0, a1, b1, b0][::-1], "Hfilm_Black")
    # ring beams top/bottom (aluminium profile) along the edges
    for i in range(8):
        p, q = ring[i], ring[(i + 1) % 8]
        for y in (Y0 + 0.02, Y1 - 0.02):
            mb.tube((p[0], y, p[1]), (q[0], y, q[1]), 0.022, "Frame_Alu", seg=4, square=True)
        mb.tube((p[0], Y0, p[1]), (p[0], Y1, p[1]), 0.026, "Frame_Alu", seg=4, square=True)   # corner posts
    # bottom: heat shield (H-film), upper deck
    mb.poly([(p[0], Y0, p[1]) for p in ring], "Hfilm_Black")
    mb.poly([(p[0], Y1, p[1]) for p in ring][::-1], "Deck_Grey")


def open_bay(mb, k, a, b, kind):
    """Open equipment bay in a corner side (quad): frame, dark back wall, compartments.
    mesa = MESA (quad IV) folded down; bay = empty LRV bay (quad I, Apollo 15); seq = SEQ bay (quad II)."""
    (cx, cz), n, t = face_frame(k)
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    depth = {"mesa": 0.55, "bay": 0.9, "seq": 0.45}[kind]
    # border (foil) around the opening
    m = 0.14 if kind != "seq" else 0.38
    pa = (a[0] + (b[0] - a[0]) * m / L, a[1] + (b[1] - a[1]) * m / L)
    pb = (b[0] - (b[0] - a[0]) * m / L, b[1] - (b[1] - a[1]) * m / L)
    blanket(mb, a, pa, Y0, Y1, "Kapton_Gold", RNG, nu=2, nv=6, bulge=0.03)
    blanket(mb, pb, b, Y0, Y1, "Kapton_Gold", RNG, nu=2, nv=6, bulge=0.03)
    yb, yt = (Y0 + 0.12, Y1 - 0.18) if kind != "seq" else (Y0 + 0.35, Y1 - 0.3)
    blanket(mb, pa, pb, Y0, yb, "Hfilm_Black", RNG, nu=4, nv=1, bulge=0.02)
    blanket(mb, pa, pb, yt, Y1, "Kapton_Gold", RNG, nu=6, nv=2, bulge=0.04)
    # interior: back wall + side walls + floor/ceiling (dark foil), shelves
    ia = (pa[0] - n[0] * depth, pa[1] - n[1] * depth)
    ib = (pb[0] - n[0] * depth, pb[1] - n[1] * depth)
    back = {"bay": "Mylar_Silver", "seq": "Kapton_Amber", "mesa": "Bay_Dark"}[kind]
    blanket(mb, ib, ia, yb, yt, back, RNG, nu=6, nv=5, bulge=0.03)
    mb.poly([(pa[0], yb, pa[1]), (ia[0], yb, ia[1]), (ia[0], yt, ia[1]), (pa[0], yt, pa[1])], "Bay_Dark")
    mb.poly([(pb[0], yt, pb[1]), (ib[0], yt, ib[1]), (ib[0], yb, ib[1]), (pb[0], yb, pb[1])], "Bay_Dark")
    mb.poly([(pa[0], yb, pa[1]), (pb[0], yb, pb[1]), (ib[0], yb, ib[1]), (ia[0], yb, ia[1])], "Bay_Dark")
    mb.poly([(ia[0], yt, ia[1]), (ib[0], yt, ib[1]), (pb[0], yt, pb[1]), (pa[0], yt, pa[1])], "Bay_Dark")
    # frame profiles at the opening (SEQ bay: foil-lined, no visible frame)
    for p in ((pa, pb) if kind == "mesa" else ()):
        mb.tube((p[0], yb, p[1]), (p[0], yt, p[1]), 0.025, "Frame_Alu", seg=4, square=True)
    for y in ((yb, yt) if kind == "mesa" else ()):
        mb.tube((pa[0], y, pa[1]), (pb[0], y, pb[1]), 0.025, "Frame_Alu", seg=4, square=True)
    mid = lambda f, d, y: (pa[0] + (pb[0] - pa[0]) * f - n[0] * d, y, pa[1] + (pb[1] - pa[1]) * f - n[1] * d)
    if kind != "mesa":
        # foil flaps hanging from the top edge of the opening (irregular, bulging slightly outwards)
        nl = 5
        for i in range(nl):
            f0, f1 = i / nl, (i + 1) / nl
            drop = RNG.uniform(0.08, 0.35)
            out = RNG.uniform(0.0, 0.06)
            p0, p1 = mid(f0, -0.02, yt), mid(f1, -0.02, yt)
            q1 = (p1[0] + n[0] * out, yt - drop * RNG.uniform(0.6, 1.0), p1[2] + n[1] * out)
            q0 = (p0[0] + n[0] * out, yt - drop, p0[2] + n[1] * out)
            mat = "Kapton_Gold" if i % 2 else "Kapton_Amber"
            mb.poly([p0, p1, q1, q0][::-1], mat)
            mb.poly([p0, p1, q1, q0], mat)
    if kind == "mesa":
        # shelves with mounts (camera, tools removed) and the folded-down MESA pallet
        for y in (yb + 0.45, yb + 0.95):
            mb.poly([mid(0, 0.02, y), mid(1, 0.02, y), mid(1, depth - 0.02, y), mid(0, depth - 0.02, y)][::-1], "Metal_Grey")
        for f in (0.25, 0.55, 0.8):
            mb.box(mid(f, depth * 0.55, yb + 0.6), (0.2, 0.25, 0.2), "Mylar_Silver")
        # pallet: hinged at the lower edge, folded 35° below the horizontal
        hinge_y = yb
        reach = 0.5
        ang = math.radians(35)
        w2 = 0.55
        o = (cx + n[0] * 0.02, cz + n[1] * 0.02)
        e = (o[0] + n[0] * reach * math.cos(ang), hinge_y - reach * math.sin(ang), o[1] + n[1] * reach * math.cos(ang))
        c0 = (o[0] - t[0] * w2, hinge_y, o[1] - t[1] * w2)
        c1 = (o[0] + t[0] * w2, hinge_y, o[1] + t[1] * w2)
        c2 = (e[0] + t[0] * w2, e[1], e[2] + t[1] * w2)
        c3 = (e[0] - t[0] * w2, e[1], e[2] - t[1] * w2)
        mb.poly([c0, c1, c2, c3], "Mylar_Silver")
        mb.poly([c3, c2, c1, c0], "Kapton_Gold")
        for p, q in ((c0, c3), (c1, c2), (c3, c2)):
            mb.tube(p, q, 0.02, "Frame_Alu", seg=4, square=True)
        for f in (0.3, 0.7):   # retaining cables
            p0 = (c0[0] + (c1[0] - c0[0]) * f, yt - 0.05, c0[2] + (c1[2] - c0[2]) * f)
            p1 = (c3[0] + (c2[0] - c3[0]) * f, c3[1], c3[2] + (c2[2] - c3[2]) * f)
            mb.tube(p0, p1, 0.006, "Metal_Grey", seg=4, caps=False)
    elif kind == "bay":
        # empty LRV bay: cross braces, hinges and deployment tapes (Apollo 15)
        for f in (0.33, 0.66):   # frames on the back wall
            mb.tube(mid(f, depth - 0.06, yb), mid(f, depth - 0.06, yt), 0.03, "Frame_Alu", seg=4, square=True)
        mb.tube(mid(0, depth * 0.5, yb + 0.6), mid(1, depth * 0.5, yb + 0.6), 0.02, "Metal_Grey", seg=6)
        for f in (0.2, 0.8):
            mb.box(mid(f, 0.06, yb + 0.06), (0.12, 0.12, 0.12), "Metal_Grey")
            mb.tube(mid(f, 0.06, yb + 0.1), (mid(f, 0, 0)[0] + n[0] * 0.9, 0.02, mid(f, 0, 0)[2] + n[1] * 0.9), 0.01, "Tape_Gold", seg=4)
    else:   # SEQ bay: door folded up, shelf, mounts of the removed ALSEP/EASEP packages
        for f in (0.3, 0.7):
            mb.tube(mid(f, depth - 0.06, yb + 0.02), mid(f, depth - 0.06, yt - 0.02), 0.012, "Metal_Grey", seg=4)
        mb.poly([mid(0, 0.02, yb + 0.5), mid(1, 0.02, yb + 0.5), mid(1, depth - 0.02, yb + 0.5), mid(0, depth - 0.02, yb + 0.5)][::-1], "Metal_Grey")
        d0, d1 = mid(0, -0.02, yt), mid(1, -0.02, yt)
        out = (n[0] * 0.75, n[1] * 0.75)
        mb.poly([d0, d1, (d1[0] + out[0], yt + 0.08, d1[2] + out[1]), (d0[0] + out[0], yt + 0.08, d0[2] + out[1])][::-1], "Kapton_Gold")
        mb.poly([d0, d1, (d1[0] + out[0], yt + 0.08, d1[2] + out[1]), (d0[0] + out[0], yt + 0.08, d0[2] + out[1])], "Hfilm_Black")


def top_deck(mb):
    """Upper deck after ascent: cross beams, four attachment fittings with remains of the explosive bolts,
    cable stubs of the umbilical, shredded foil, RCS plume deflectors at the corners."""
    y1 = Y1
    for ax in ((1, 0), (0, 1)):
        mb.box((0, y1 + 0.06, 0), (3.9 if ax[0] else 0.25, 0.12, 0.25 if ax[0] else 3.9), "Metal_Grey")
    for sx in (-1, 1):
        for sz in (-1, 1):
            c = (sx * 1.1, y1, sz * 1.1)
            mb.box((c[0], y1 + 0.13, c[2]), (0.22, 0.26, 0.22), "Frame_Alu")
            mb.tube((c[0], y1 + 0.26, c[2]), (c[0], y1 + 0.34, c[2]), 0.045, "Metal_Grey", seg=8)       # bolt remains
            mb.tube((c[0] - sx * 0.1, y1 + 0.2, c[2]), (c[0] - sx * 0.55, y1 + 0.12, c[2]), 0.03, "Metal_Grey", seg=6)
            # RCS plume deflector (conical shell) at the corner, pointing outwards and up
            ex, ez = sx * 1.42, sz * 1.42
            mb.lathe([(0.03, 0.0), (0.1, 0.07), (0.15, 0.16), (0.14, 0.17), (0.02, 0.01)], "Mylar_Silver", seg=12,
                     axis_a=(ex, y1 + 0.05, ez), axis_b=(ex + sx * 0.8, y1 + 0.45, ez + sz * 0.8))
            mb.tube((ex, y1, ez), (ex, y1 + 0.12, ez), 0.025, "Frame_Alu", seg=6)
    # cable bundles / lines on the deck
    for k in range(6):
        a = RNG.uniform(0, 2 * math.pi)
        r0 = RNG.uniform(0.2, 0.7)
        p0 = (math.cos(a) * r0, y1 + 0.05, math.sin(a) * r0)
        p1 = (p0[0] + RNG.uniform(-0.3, 0.3), y1 + RNG.uniform(0.15, 0.35), p0[2] + RNG.uniform(-0.3, 0.3))
        mb.tube(p0, p1, RNG.uniform(0.012, 0.025), "Hfilm_Black" if k % 2 else "Metal_Grey", seg=6)
    # foil shredded by the ascent: flat flaps and raised tatters
    for k in range(22):
        cx, cz = RNG.uniform(-1.75, 1.75), RNG.uniform(-1.75, 1.75)
        if abs(cx) + abs(cz) > 2.45:
            continue
        w, d = RNG.uniform(0.15, 0.6), RNG.uniform(0.12, 0.45)
        h = y1 + 0.02 + RNG.uniform(0, 0.08)
        lift = RNG.uniform(0.0, 0.35) if k % 4 == 0 else RNG.uniform(0, 0.1)
        mat = ("Kapton_Gold", "Mylar_Silver", "Hfilm_Black", "Kapton_Amber")[k % 4]
        q = [(cx - w / 2, h, cz - d / 2), (cx + w / 2, h + lift, cz - d / 2 + RNG.uniform(-0.1, 0.1)),
             (cx + w / 2 + RNG.uniform(-0.1, 0.1), h + lift * 0.5, cz + d / 2), (cx - w / 2, h + RNG.uniform(0, 0.08), cz + d / 2)]
        mb.poly(q[::-1], mat)
        mb.poly(q, mat)


def nozzle(mb, mission):
    """Descent engine (DPS): nozzle exit Ø 1.51 m; niobium extension with stiffening rings.
    Apollo 15 (J mission): nozzle extended by 10 in (0.25 m) (here 8 cm lower: the engine region ends at 0.45 m)."""
    ext = 0.08 if mission == 15 else 0.0
    exit_y = 0.57 - ext                     # exit (stays inside the engine region y >= 0.45)
    top = Y0
    v0 = len(mb.v)
    Ld = top - exit_y
    prof = []
    for i in range(13):
        f = i / 12
        r = 0.36 + (0.755 - 0.36) * (1 - (1 - f) ** 1.7)
        prof.append((r, f * Ld))
    inner = [(r - 0.012, z) for r, z in reversed(prof)]
    mb.lathe(prof + [(0.755, Ld + 0.004)] + inner, "Nozzle", seg=40, axis_a=(0, top, 0), axis_b=(0, top - 1, 0))
    for f in (0.35, 0.6, 0.82):             # stiffening rings
        z = f * Ld
        r = 0.36 + (0.755 - 0.36) * (1 - (1 - f) ** 1.7)
        mb.lathe([(r, z - 0.025), (r + 0.018, z - 0.015), (r + 0.018, z + 0.015), (r, z + 0.025)], "Nozzle_Ring", seg=40,
                 axis_a=(0, top, 0), axis_b=(0, top - 1, 0))
    # combustion chamber/throat (visible above the lower edge through the heat-shield cut-out)
    mb.lathe([(0.36, -0.02), (0.30, -0.12), (0.24, -0.2), (0.0, -0.21)], "Nozzle_Inner", seg=24, axis_a=(0, top, 0), axis_b=(0, top - 1, 0))
    if mission == 15:
        # Falcon: nozzle extension crumpled at touchdown (landing report) -> two dents on the exit rim
        for i in range(v0, len(mb.v)):
            v = mb.v[i]
            low = max(0.0, (exit_y + 0.3 - v.y) / 0.3)
            if low <= 0:
                continue
            th = math.atan2(v.z, v.x)
            dent = 0.09 * max(0.0, math.cos(th - 0.7)) ** 6 + 0.05 * max(0.0, math.cos(th + 2.2)) ** 8
            k = 1 - dent * low * low
            mb.v[i] = Vector((v.x * k, v.y + 0.04 * dent / 0.09 * low * low, v.z * k))


def leg(mb, lx, lz, probe, ladder):
    """Landing leg: primary strut (foil at the top, piston below), two secondary struts, deployment/downlock truss,
    footpad Ø 0.94 m with ball joint, contact probe 1.7 m (bent over)."""
    d = Vector((lx, 0, lz))
    side = Vector((lz, 0, -lx))
    top = d * (R_FLAT + 0.15) + Vector((0, Y1 - 0.15, 0))
    pad = d * PAD_R + Vector((0, 0.32, 0))
    up = Vector((0, 1, 0))
    # outrigger at the top edge of the main side up to the strut head
    mb.tube(tuple(d * (R_FLAT - 0.05) + up * (Y1 - 0.12)), tuple(d * (R_FLAT + 0.08) + up * (Y1 - 0.12)), 0.11, "Kapton_Gold", seg=4, square=True)
    mb.box(tuple(top + up * 0.04), (0.26 if lz else 0.2, 0.3, 0.2 if lz else 0.26), "Frame_Alu")
    # primary strut: outer cylinder (foil) up to 62 %, the bare piston below, a collar in between
    k = top.lerp(pad, 0.62)
    mb.tube(tuple(top), tuple(k), 0.082, "Strut_Gold", seg=14)
    mb.tube(tuple(k - (k - top).normalized() * 0.08), tuple(k + (pad - top).normalized() * 0.05), 0.095, "Hfilm_Black", seg=14)
    mb.tube(tuple(k), tuple(pad + (top - pad).normalized() * 0.1), 0.055, "Piston", seg=12)
    # secondary struts from the strut point (55 %) to the lower body corners, plus truss (downlock)
    mid = top.lerp(pad, 0.6)                 # attachment of the secondary struts at the lower end of the outer cylinder
    mb.box(tuple(mid), (0.16, 0.16, 0.16), "Frame_Alu")
    feet = []
    for s in (-1, 1):
        base = d * R_FLAT + side * 1.05 * s + up * (Y0 + 0.08)
        feet.append(base)
        mb.tube(tuple(base), tuple(mid), 0.05, "Strut_Silver", seg=10)
        mb.box(tuple(base), (0.12, 0.12, 0.12), "Frame_Alu")
    # deployment truss: two rods from the lower body centre to the locking point + cross rod
    lock = mid.lerp(d * R_FLAT + up * Y0, 0.45)
    for s in (-1, 1):
        mb.tube(tuple(d * R_FLAT + side * 0.45 * s + up * (Y0 + 0.02)), tuple(lock), 0.03, "Strut_Silver", seg=8)
    mb.tube(tuple(feet[0].lerp(mid, 0.5)), tuple(feet[1].lerp(mid, 0.5)), 0.018, "Metal_Grey", seg=6)
    mb.tube(tuple(lock), tuple(mid), 0.035, "Metal_Grey", seg=8)
    mb.box(tuple(lock), (0.1, 0.1, 0.1), "Metal_Grey")
    # footpad: flat dish with beaded rim, slightly sunk in; ball joint + cover cone
    pc = Vector((pad.x, -0.03, pad.z))
    mb.lathe([(0.0, 0.0), (0.30, 0.0), (0.40, 0.025), (0.465, 0.08), (0.47, 0.15), (0.455, 0.19), (0.42, 0.205),
              (0.36, 0.21), (0.17, 0.27), (0.09, 0.31), (0.0, 0.32)], "Pad_Foil", seg=28,
             axis_a=tuple(pc), axis_b=tuple(pc + up))
    mb.lathe([(0.0, -0.05), (0.07, -0.03), (0.085, 0.0), (0.07, 0.04), (0.0, 0.06)], "Metal_Grey", seg=12,
             axis_a=tuple(pad), axis_b=tuple(pad + up))
    if probe:
        s0 = Vector((pad.x, 0.08, pad.z)) - d * 0.2
        kink = s0 + side * 0.28 + d * 0.18 + Vector((0, -0.04, 0))
        end = kink + side * 1.2 - d * 0.42
        mb.tube(tuple(s0), tuple(kink), 0.014, "Metal_Grey", seg=6)
        mb.tube(tuple(kink), tuple(Vector((end.x, 0.03, end.z))), 0.014, "Metal_Grey", seg=6)
        mb.lathe([(0.0, 0.0), (0.04, 0.02), (0.035, 0.05), (0.0, 0.06)], "Metal_Grey", seg=8,
                 axis_a=tuple(Vector((end.x, 0.0, end.z))), axis_b=tuple(Vector((end.x, 1.0, end.z))))
    if ladder:
        ladder_porch(mb, top, pad)


def ladder_porch(mb, top, pad):
    """Ladder (9 rungs) on the front primary strut, exit platform ("porch") with handrails,
    plaque on the strut behind the ladder."""
    off = Vector((0, 0.1, 0.13))
    bot = pad.lerp(top, 0.18)
    for sx in (-0.25, 0.25):
        mb.tube(tuple(top + off + Vector((sx, 0.02, 0))), tuple(bot + off + Vector((sx, 0, 0))), 0.02, "Frame_Alu", seg=4, square=True)
    for k in range(9):
        p = top.lerp(bot, (k + 0.5) / 9) + off
        mb.tube(tuple(p + Vector((-0.25, 0, 0))), tuple(p + Vector((0.25, 0, 0))), 0.017, "Frame_Alu", seg=6)
    for f in (0.15, 0.5, 0.85):   # bracket to the strut
        p = top.lerp(bot, f)
        for sx in (-0.2, 0.2):
            mb.tube(tuple(p + Vector((sx * 0.4, 0, 0))), tuple(p + off + Vector((sx, 0, 0))), 0.012, "Metal_Grey", seg=4)
    # plaque (22.9 x 19.4 cm, stainless steel) between the rails, with frame
    p = top.lerp(bot, 0.42) + Vector((0, 0.08, 0.1))
    n = (pad - top).normalized()          # strut direction (downwards and outwards)
    ang = math.atan2(-n.y, n.z)           # inclination of the strut against the horizontal
    M = Matrix.Translation(p) @ Matrix.Rotation(-(math.pi / 2 - ang), 4, "X")
    mb.push(M)
    mb.box((0, 0, -0.006), (0.27, 0.23, 0.012), "Metal_Grey")
    mb.quad((-0.115, -0.097, 0.001), (0.115, -0.097, 0.001), (0.115, 0.097, 0.001), (-0.115, 0.097, 0.001), "Steel_Plaque")
    mb.pop()
    # porch: platform in front of the (missing) hatch, z >= 2.27 (belongs to the front outrigger)
    yP = Y1 - 0.04
    z0, z1, w = 2.27, 2.85, 0.46
    mb.box((0, yP, (z0 + z1) / 2), (2 * w, 0.04, z1 - z0), "Porch")
    for sx in (-1, 1):
        mb.tube((sx * w, yP, z0), (sx * w, yP, z1), 0.02, "Frame_Alu", seg=4, square=True)
    mb.tube((-w, yP, z1), (w, yP, z1), 0.02, "Frame_Alu", seg=4, square=True)


def lm(mb):
    # quads (sides in 45° steps from +X towards +Z; +Z = front/ladder, seen from outside +X is on the right):
    # 1 = front right (quad I: LRV on Apollo 15), 3 = front left (quad IV: MESA), 5 = rear left (quad III),
    # 7 = rear right (quad II: SEQ bay with ALSEP/EASEP)
    quads = {3: "mesa", 7: "seq", 5: "black", 1: "bay" if MISSION == 15 else "black"}
    body_shell(mb, quads)
    top_deck(mb)
    nozzle(mb, MISSION)
    # landing radar antenna (underside, rear left) [EST: position]
    mb.box((-1.25, Y0 - 0.09, -0.95), (0.62, 0.16, 0.5), "Hfilm_Black")
    mb.box((-1.25, Y0 - 0.18, -0.95), (0.56, 0.02, 0.44), "Metal_Grey")
    pads = []
    for lx, lz in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        # contact probes on three legs (not on the ladder leg)
        leg(mb, lx, lz, probe=lz != 1, ladder=lz == 1)
        pads.append(Vector((lx, 0, lz)) * PAD_R)
    return pads


def easep(mb, ox, oz):
    """PSEP (seismometer with 2 solar wings) and LRRR (laser reflector) — Apollo 11, ~15–20 m south-west."""
    # PSEP
    mb.box((ox, 0.35, oz), (0.6, 0.6, 0.5), "Mylar_Silver")
    mb.box((ox, 0.68, oz), (0.62, 0.06, 0.52), "Metal_Grey")
    for s in (-1, 1):
        mb.box((ox + s * 0.95, 0.62, oz), (1.25, 0.03, 0.55), "Solar_Cells")
    mb.tube((ox, 0.7, oz), (ox, 1.2, oz), 0.012, "Metal_Grey", seg=6)
    # LRRR: reflector array 0.46 m, tilted
    lx, lz = ox - 4.5, oz + 3.0
    M = Matrix.Translation((lx, 0.35, lz)) @ Matrix.Rotation(math.radians(-25), 4, "X")
    mb.push(M)
    mb.box((0, 0, 0), (0.46, 0.46, 0.08), "Metal_Grey")
    mb.box((0, 0, 0.042), (0.42, 0.42, 0.005), "Reflector")
    mb.pop()
    for s in (-1, 1):
        mb.tube((lx + s * 0.2, 0.0, lz), (lx + s * 0.2, 0.3, lz), 0.015, "Metal_Grey", seg=6)


def flag_fallen(mb, x, z):
    mb.tube((x, 0.03, z), (x + 1.9, 0.05, z + 0.6), 0.016, "Metal_Grey", seg=6)
    M = Matrix.Translation((x + 1.2, 0.04, z + 0.25)) @ Matrix.Rotation(math.radians(17), 4, "Y")
    mb.push(M)
    mb.poly([(-0.45, 0.0, -0.7), (0.45, 0.0, -0.7), (0.45, 0.02, 0.0), (-0.45, 0.02, 0.0)], "Flag", uvs=[(0, 0), (1, 0), (1, 1), (0, 1)])
    mb.pop()


def lrv(mb, ox, oz, yaw=0.0):
    """Lunar Roving Vehicle (Apollo 15), simplified: chassis 3.1 x 2.3 m, 4 wire-mesh wheels Ø 0.82 m,
    seats, control console, high-gain antenna (dish Ø 0.9 m), TV camera."""
    M = Matrix.Translation((ox, 0, oz)) @ Matrix.Rotation(yaw, 4, "Y")
    mb.push(M)
    mb.box((0, 0.62, 0), (1.15, 0.12, 2.95), "Metal_Grey")
    for sx in (-1, 1):
        for sz in (-1, 1):
            c = Vector((sx * 0.92, 0.41, sz * 1.1))
            mb.lathe([(0.0, -0.12), (0.41, -0.11), (0.41, 0.11), (0.0, 0.12)], "Wheel_Mesh", seg=16,
                     axis_a=tuple(c - Vector((0.12 * sx, 0, 0))), axis_b=tuple(c + Vector((0.12 * sx, 0, 0))))
            mb.box((sx * 0.95, 0.85, sz * 1.1), (0.45, 0.05, 0.85), "Fender")        # fenders
            mb.tube((sx * 0.55, 0.62, sz * 1.1), (sx * 0.8, 0.45, sz * 1.1), 0.03, "Metal_Grey", seg=6)
    for sx in (-1, 1):   # seats
        mb.box((sx * 0.32, 0.8, -0.1), (0.5, 0.1, 0.5), "Seat_Web")
        mb.box((sx * 0.32, 1.05, -0.35), (0.5, 0.45, 0.06), "Seat_Web")
    mb.box((0, 1.05, 0.45), (0.35, 0.35, 0.15), "Metal_Grey")                    # console
    mb.tube((0.45, 0.7, 0.9), (0.45, 1.95, 0.9), 0.02, "Metal_Grey", seg=6)       # antenna mast
    mb.lathe([(0.0, 0.0), (0.2, 0.03), (0.45, 0.14), (0.44, 0.15), (0.0, 0.02)], "Mylar_Silver", seg=20,
             axis_a=(0.45, 1.95, 0.9), axis_b=(0.45, 2.3, 1.3))
    mb.box((-0.3, 1.25, 1.2), (0.2, 0.15, 0.3), "Metal_Grey")                    # TV camera
    mb.pop()



RNG = None


def build():
    global RNG
    import random
    RNG = random.Random(11 + MISSION)
    E.reset()
    nor, arm, var, _ = crinkle_textures()
    foil("Kapton_Gold", (0.78, 0.50, 0.15), nor, arm, var)       # Kapton (amber) over aluminium
    foil("Kapton_Amber", (0.70, 0.38, 0.09), nor, arm, var)      # older/thicker layers: darker, redder
    foil("Tape_Gold", (0.55, 0.33, 0.08), nor, arm, var, rough_bias=0.15, tile=0.3)
    foil("Hfilm_Black", (0.035, 0.03, 0.025), nor, arm, var, rough_bias=0.1)
    foil("Mylar_Silver", (0.66, 0.66, 0.67), nor, arm, var, rough_bias=0.1)
    foil("Strut_Gold", (0.72, 0.48, 0.15), nor, arm, var, tile=0.4)
    foil("Strut_Silver", (0.70, 0.70, 0.72), nor, arm, var, tile=0.4)
    foil("Pad_Foil", (0.74, 0.70, 0.62), nor, arm, var, rough_bias=0.25, tile=0.6)
    E.material("Frame_Alu", (0.4, 0.4, 0.41), 1.0, 0.6)
    E.material("Piston", (0.78, 0.78, 0.8), 1.0, 0.22)
    E.mat_tread("Porch", tile=0.5, gain=0.6)
    E.material("Bay_Dark", (0.04, 0.04, 0.045), 0.3, 0.7)
    E.material("Deck_Grey", (0.22, 0.21, 0.2), 0.3, 0.75)
    E.material("Metal_Grey", (0.35, 0.35, 0.36), 0.8, 0.45)
    E.material("Nozzle", (0.11, 0.105, 0.115), 0.7, 0.5)          # niobium extension (dark, slightly bluish)
    E.material("Nozzle_Ring", (0.16, 0.15, 0.15), 0.8, 0.45)
    E.material("Nozzle_Inner", (0.05, 0.045, 0.04), 0.2, 0.85)
    E.material("Steel_Plaque", (1.0, 1.0, 1.0), 1.0, 0.35, diff=plaque_texture())
    E.material("Solar_Cells", (0.02, 0.03, 0.08), 0.3, 0.2)
    E.material("Reflector", (0.6, 0.62, 0.7), 1.0, 0.18)
    E.material("Flag", (0.75, 0.72, 0.68), 0.0, 0.8)
    E.material("Wheel_Mesh", (0.5, 0.48, 0.42), 0.7, 0.5)
    E.material("Fender", (0.85, 0.83, 0.75), 0.0, 0.5)
    E.material("Seat_Web", (0.6, 0.6, 0.62), 0.0, 0.7)
    root = E.empty("ApolloSite", (0, 0, 0), size=1)
    mb = E.MB()
    lm(mb)
    # load time: merge similar materials (every material = its own shader pipeline on the first frame).
    # The UVs are already computed with the tile size of the original material, so the look stays almost the same.
    alias = {"Strut_Gold": "Kapton_Gold", "Tape_Gold": "Kapton_Amber", "Strut_Silver": "Mylar_Silver",
             "Pad_Foil": "Mylar_Silver", "Nozzle_Ring": "Nozzle", "Nozzle_Inner": "Bay_Dark", "Porch": "Metal_Grey"}
    mb.faces = [(i, uv, alias.get(m, m), sm) for i, uv, m, sm in mb.faces]
    mb.build("LM_Descent", root)
    print(f"[ws-f] LM: {mb.tri_count()} tris")
    mb2 = E.MB()
    if MISSION == 11:
        # model frame: +Z = front. At compass 270° (front facing west) world east = -z_model,
        # world south = +x_model. EASEP ~15 m SSW -> model (13, 10); flag ~6 m W -> model (-2, 6).
        easep(mb2, 13.0, 10.0)
        flag_fallen(mb2, -2.0, 6.0)
    else:
        lrv(mb2, 9.0, -88.0, math.radians(20))   # LRV ~90 m east (model -z = world east at compass 270°)
    mb2.build("Experiments", root)
    print(f"[ws-f] Extras: {mb2.tri_count()} tris")
    E.empty("Ladder_Foot", (0, 0.3, 4.72), root)
    E.export_glb("apollo_lm_descent", out_dir=OUT)


build()
