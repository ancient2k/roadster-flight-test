"""asset pipeline Umgebungs-Assets: gemeinsame Helfer für die Blender-Build-Skripte (Blender 5.2, headless).

Koordinaten: Alle Geometrie wird im glTF-/three.js-Rahmen geschrieben (Meter, +Y oben, +Z = "Front",
also die Seite, die zur Strecke / zum Publikum zeigt; renderer dreht per `headingDeg` um +Y).
`G(x, y, z)` wandelt in Blender-Welt (x, -z, y). Der glTF-Exporter (export_yup) macht daraus wieder (x, y, z).
Probe-Export (docs/RENDERING.md): Blender-lokal +Y eines Objekts = glTF-lokal -Z.
`aim_empty()` richtet daher Blender-lokal +Y entlang der gewünschten Richtung aus.

Texturen: CC0 von Poly Haven (fetch_cc0.sh -> cc0/), aufbereitet mit numpy nach build_tex/ (<= 1k).
"""
from __future__ import annotations

import hashlib
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
CC0 = os.path.join(HERE, "cc0")
TEX = os.path.join(HERE, "build_tex")
OUT = os.path.join(ROOT, "public", "assets", "env-models")


def G(x: float, y: float, z: float) -> Vector:
    """glTF-Rahmen (x, y oben, z Front) -> Blender (x, -z, y)."""
    return Vector((x, -z, y))


def args() -> list[str]:
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def lod_arg() -> int:
    a = args()
    return int(a[a.index("--lod") + 1]) if "--lod" in a else 0


def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def link(ob, parent=None):
    bpy.context.scene.collection.objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


def empty(name: str, pos=(0, 0, 0), parent=None, size=0.3):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = size
    e.location = G(*pos)
    return link(e, parent)


def aim_empty(name: str, pos, direction, parent=None, size=0.4):
    """Empty bei pos (glTF-Rahmen), dessen glTF-lokale -Z-Achse entlang `direction` (glTF-Rahmen) zeigt."""
    e = empty(name, pos, parent, size)
    d = G(*direction).normalized()
    e.rotation_mode = "QUATERNION"
    e.rotation_quaternion = d.to_track_quat("Y", "Z")
    e.empty_display_type = "SINGLE_ARROW"
    return e


# ------------------------------------------------------------------ texture preparation (numpy)
def _load(path: str) -> np.ndarray:
    img = bpy.data.images.load(path, check_existing=True)
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)


def _save(arr: np.ndarray, path: str, fmt: str = "JPEG", quality: int = 88) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    h, w = arr.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=(fmt == "PNG"))
    img.pixels.foreach_set(np.ascontiguousarray(arr, dtype=np.float32).ravel())
    img.filepath_raw = path
    img.file_format = fmt
    sc = bpy.context.scene
    sc.render.image_settings.quality = quality
    img.save(filepath=path, quality=quality) if fmt == "JPEG" else img.save()
    bpy.data.images.remove(img)
    return path


def _resize(a: np.ndarray, size: int) -> np.ndarray:
    h, w = a.shape[:2]
    if w <= size:
        return a
    f = w // size
    return a[: h - h % f, : w - w % f].reshape(h // f, f, w // f, f, 4).mean(axis=(1, 3))


def _keyed(name: str, *params) -> str:
    """Cache-Dateiname mit Parameter-Hash: Änderungen an Farbe/Rauheit erzeugen automatisch neue Texturen."""
    root, ext = os.path.splitext(name)
    return f"{root}_{hashlib.md5(repr(params).encode()).hexdigest()[:6]}{ext}"


def prep_tex(src: str, dst_name: str, *, tint=(1, 1, 1), gain=1.0, gamma=1.0, desat=0.0,
             size=1024, alpha_src: str | None = None, fmt="JPEG") -> str:
    """Kopie einer CC0-Textur mit Farbkorrektur (für Base Color: sRGB-Werte) nach build_tex/."""
    dst = os.path.join(TEX, _keyed(dst_name, src, tint, gain, gamma, desat, size, alpha_src))
    if os.path.exists(dst) and os.path.getmtime(dst) > os.path.getmtime(__file__):
        return dst
    a = _resize(_load(src), size)
    rgb = a[..., :3]
    if desat:
        lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        rgb = rgb * (1 - desat) + lum[..., None] * desat
    rgb = np.clip((rgb ** gamma) * gain * np.array(tint, dtype=np.float32), 0, 1)
    a[..., :3] = rgb
    if alpha_src:
        al = _resize(_load(alpha_src), size)
        a[..., 3] = al[..., 0]
        fmt = "PNG"
    return _save(a, dst, fmt)


def prep_data(src: str, dst_name: str, size=1024, rough_scale=1.0, rough_add=0.0, metal=None) -> str:
    """ARM/Normal-Textur verkleinern; optional Rauheit (G) / Metall (B) anpassen."""
    dst = os.path.join(TEX, _keyed(dst_name, src, size, rough_scale, rough_add, metal))
    if os.path.exists(dst) and os.path.getmtime(dst) > os.path.getmtime(__file__):
        return dst
    a = _resize(_load(src), size)
    if rough_scale != 1.0 or rough_add:
        a[..., 1] = np.clip(a[..., 1] * rough_scale + rough_add, 0.02, 1)
    if metal is not None:
        a[..., 2] = metal
    return _save(a, dst, "JPEG", 92)


# ------------------------------------------------------------------ materials
TILE: dict[str, float] = {}   # Material -> Meter pro Texturkachel (UV-Generierung im MeshBuilder)


def _bsdf(m):
    return next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def _img_node(nt, path, non_color=False, x=-700, y=0):
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = bpy.data.images.load(path, check_existing=True)
    if non_color:
        n.image.colorspace_settings.name = "Non-Color"
    n.location = (x, y)
    return n


def material(name: str, color=(0.5, 0.5, 0.5), metallic=0.0, roughness=0.5, *, diff=None, nor=None,
             arm=None, normal_strength=1.0, emission=None, strength=0.0, alpha_mask=False,
             alpha_cutoff=0.5, double_sided=False, tile=1.0, coat=0.0, emission_tex=None):
    """Principled-Material, das der glTF-Exporter sauber abbildet.
    diff: sRGB-Bild (Base Color, ggf. mit Alpha), arm: AO/Rough/Metal-Bild, nor: OpenGL-Normal.
    emission/strength: emissiveFactor + KHR_materials_emissive_strength."""
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = _bsdf(m)
    TILE[name] = tile
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Roughness"].default_value = roughness
    if coat:
        p.inputs["Coat Weight"].default_value = coat
        p.inputs["Coat Roughness"].default_value = 0.08
    if diff:
        t = _img_node(nt, diff, y=300)
        nt.links.new(t.outputs["Color"], p.inputs["Base Color"])
        if alpha_mask:
            # Alpha-Test: Math(GREATER_THAN) -> glTF alphaMode MASK (+ alphaCutoff)
            gt = nt.nodes.new("ShaderNodeMath")
            gt.operation = "GREATER_THAN"
            gt.inputs[1].default_value = alpha_cutoff
            gt.location = (-300, 100)
            nt.links.new(t.outputs["Alpha"], gt.inputs[0])
            nt.links.new(gt.outputs[0], p.inputs["Alpha"])
    if arm:
        t = _img_node(nt, arm, True, y=0)
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        sep.location = (-400, 0)
        nt.links.new(t.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], p.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], p.inputs["Metallic"])
    if nor:
        t = _img_node(nt, nor, True, y=-300)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = normal_strength
        nm.location = (-300, -300)
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])
    if emission is not None:
        p.inputs["Emission Color"].default_value = (*emission, 1.0)
        p.inputs["Emission Strength"].default_value = strength
    if emission_tex:
        t = _img_node(nt, emission_tex, y=600)
        nt.links.new(t.outputs["Color"], p.inputs["Emission Color"])
        p.inputs["Emission Strength"].default_value = strength
    if alpha_mask:
        try:
            m.surface_render_method = "DITHERED"
        except Exception:
            pass
    m.use_backface_culling = not double_sided
    return m


def emissive(name: str, color, strength: float, base=(0.02, 0.02, 0.02), tex=None):
    """Leuchtmaterial (z. B. Lamp_Emissive, Screen_Emissive, LED_Red)."""
    if tex:
        return material(name, base, 0.0, 0.3, emission_tex=tex, strength=strength)
    return material(name, base, 0.0, 0.35, emission=color, strength=strength)


def cc0(*parts) -> str:
    return os.path.join(CC0, *parts)


def fbm(n: int, beta: float = 2.0, seed: int = 0) -> np.ndarray:
    """Kachelbares 1/f^beta-Rauschen (FFT), normiert auf 0..1."""
    r = np.random.default_rng(seed)
    w = r.standard_normal((n, n))
    fy = np.fft.fftfreq(n)[:, None]
    fx = np.fft.fftfreq(n)[None, :]
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1
    out = np.real(np.fft.ifft2(np.fft.fft2(w) / f ** (beta / 2)))
    out -= out.min()
    return (out / out.max()).astype(np.float32)


def _proc_metal(prefix: str, base: float, var: float, rough: float, rvar: float, metal: float, seed: int, tint=(1, 1, 1), streak=0.0):
    """Prozedurale Metall-/Lackoberfläche: Fleckigkeit (Verzinkung/Patina), Rauheitsvariation, Laufspuren."""
    key = (base, var, rough, rvar, metal, seed, tuple(tint), streak)
    dpath = os.path.join(TEX, _keyed(prefix + "_diff.jpg", *key))
    apath = os.path.join(TEX, _keyed(prefix + "_arm.jpg", *key))
    if os.path.exists(dpath) and os.path.getmtime(dpath) > os.path.getmtime(__file__):
        return dpath, apath
    n = 512
    a = fbm(n, 2.2, seed)
    b = fbm(n, 1.2, seed + 1)
    c = fbm(n, 3.0, seed + 2)
    v = base + var * ((a - 0.5) * 1.2 + (b - 0.5) * 0.5)
    if streak:   # vertikale Laufspuren (Regen): Rauschen in Y gestreckt
        st = fbm(n, 2.0, seed + 3)
        st = np.repeat(st[:: 8, :], 8, axis=0)[:n]
        v = v - streak * np.clip(st - 0.55, 0, 1)
    img = np.ones((n, n, 4), np.float32)
    for k in range(3):
        img[..., k] = np.clip(v * tint[k], 0, 1)
    _save(img, dpath, "JPEG", 90)
    arm = np.ones((n, n, 4), np.float32)
    arm[..., 1] = np.clip(rough + rvar * ((c - 0.5) * 1.5 + (a - 0.5) * 0.6), 0.05, 1)
    arm[..., 2] = metal
    _save(arm, apath, "JPEG", 92)
    return dpath, apath


def mat_galv(name="Steel_Galv", tile=1.5):
    """Feuerverzinkter Stahl (Masten, Gerüst): hell, fleckig, metallisch."""
    d, a = _proc_metal("galv", 0.62, 0.22, 0.42, 0.22, 1.0, 11, tint=(0.97, 0.985, 1.0), streak=0.12)
    return material(name, diff=d, arm=a, tile=tile)


def mat_black_steel(name="Steel_Black", tile=1.5):
    """Schwarz pulverbeschichteter Stahl (Bühnen-/Rampengerüst, Traversen)."""
    d, a = _proc_metal("blacksteel", 0.075, 0.05, 0.55, 0.2, 0.0, 21, streak=0.03)
    return material(name, diff=d, arm=a, tile=tile)


def mat_tread(name="Steel_Tread", tile=1.0, gain=0.55):
    """Riffelblech (Böden, Podeste) aus Poly Haven metal_plate."""
    d = prep_tex(cc0("metal_plate", "metal_plate_diff_1k.jpg"), f"tread_diff_{int(gain*100)}.jpg", desat=0.85, gain=gain, size=512)
    a = prep_data(cc0("metal_plate", "metal_plate_arm_1k.jpg"), "tread_arm.jpg", size=512, rough_scale=0.8, rough_add=0.1, metal=1.0)
    n = prep_data(cc0("metal_plate", "metal_plate_nor_gl_1k.jpg"), "tread_nor.jpg", size=512)
    return material(name, diff=d, arm=a, nor=n, normal_strength=0.8, tile=tile)


def mat_concrete(name="Concrete", tile=2.5, gain=0.9):
    d = prep_tex(cc0("concrete_wall_008", "concrete_wall_008_diff_1k.jpg"), f"concrete_diff_{int(gain*100)}.jpg", gain=gain, desat=0.3)
    a = prep_data(cc0("concrete_wall_008", "concrete_wall_008_arm_1k.jpg"), "concrete_arm.jpg", metal=0.0)
    n = prep_data(cc0("concrete_wall_008", "concrete_wall_008_nor_gl_1k.jpg"), "concrete_nor.jpg")
    return material(name, diff=d, arm=a, nor=n, normal_strength=0.8, tile=tile)


def mat_painted(name, color, rough=0.45, metal=0.0, tile=1.5, seed=31, var=0.18):
    """Lackiertes Blech/Aluminium mit leichter Gebrauchsspur (prozedural)."""
    lum = max(color) or 1e-3
    d, a = _proc_metal(f"paint_{name}", 1.0, var, rough, 0.18, metal, seed, tint=(color[0], color[1], color[2]), streak=0.08)
    return material(name, diff=d, arm=a, tile=tile)


def save_rgba(arr: np.ndarray, name: str, fmt="PNG") -> str:
    """Prozedural erzeugte Textur (H x W x 4, linear 0..1, Zeile 0 = unten) speichern."""
    return _save(arr, os.path.join(TEX, name), fmt)


# ------------------------------------------------------------------ mesh builder
class MB:
    """Sammelt Polygone (glTF-Rahmen) mit Materialindex, UVs (Meter/TILE) und Glättung,
    erzeugt daraus EIN Blender-Mesh. Transformationsstapel via push()/pop()."""

    def __init__(self):
        self.v: list[Vector] = []
        self.faces: list[tuple] = []          # (idx tuple, uv list, mat name, smooth)
        self.M = [Matrix.Identity(4)]

    # ---- transforms
    def push(self, M: Matrix):
        self.M.append(self.M[-1] @ M)

    def pop(self):
        self.M.pop()

    def P(self, p) -> Vector:
        return (self.M[-1] @ Vector((p[0], p[1], p[2], 1.0))).to_3d()

    def add_v(self, p) -> int:
        self.v.append(self.P(p))
        return len(self.v) - 1

    def face(self, idx, uvs, mat, smooth=False):
        self.faces.append((tuple(idx), uvs, mat, smooth))

    # ---- planar UV for a polygon given in world space (box projection by normal)
    def _auto_uv(self, idx, mat):
        pts = [self.v[i] for i in idx]
        n = (pts[1] - pts[0]).cross(pts[2] - pts[0])
        ax = max(range(3), key=lambda k: abs(n[k]))
        u_ax, v_ax = [(2, 1), (0, 2), (0, 1)][ax]
        s = 1.0 / TILE.get(mat, 1.0)
        return [(p[u_ax] * s, p[v_ax] * s) for p in pts]

    def poly(self, pts, mat, smooth=False, uvs=None):
        idx = [self.add_v(p) for p in pts]
        self.face(idx, uvs or self._auto_uv(idx, mat), mat, smooth)
        return idx

    def box(self, c, size, mat, bevel=0.0):
        """Achsparalleler Quader (im aktuellen Transform) Mitte c, Kantenlängen size."""
        hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
        cx, cy, cz = c
        C = [(cx + sx * hx, cy + sy * hy, cz + sz * hz) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
        I = [self.add_v(p) for p in C]
        F = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        for f in F:
            idx = [I[k] for k in f]
            self.face(idx, self._auto_uv(idx, mat), mat, False)

    def frame(self, a, b, up=(0, 1, 0)):
        """Matrix: lokales +Z von a nach b, Ursprung a."""
        a, b = Vector(a), Vector(b)
        z = (b - a)
        L = z.length
        z.normalize()
        u = Vector(up)
        if abs(z.dot(u)) > 0.99:
            u = Vector((1, 0, 0))
        x = u.cross(z).normalized()
        y = z.cross(x)
        M = Matrix((x, y, z)).transposed().to_4x4()
        M.translation = a
        return M, L

    def tube(self, a, b, r, mat, seg=8, caps=True, r2=None, square=False):
        """Rohr/Zylinder von a nach b (Radius r -> r2). square=True: Vierkantprofil."""
        M, L = self.frame(a, b)
        r2 = r if r2 is None else r2
        if square:
            seg = 4
        self.push(M)
        ring0, ring1 = [], []
        off = math.pi / 4 if square else 0.0
        rr0, rr1 = (r * math.sqrt(2), r2 * math.sqrt(2)) if square else (r, r2)
        for i in range(seg):
            t = 2 * math.pi * i / seg + off
            ring0.append(self.add_v((math.cos(t) * rr0, math.sin(t) * rr0, 0)))
            ring1.append(self.add_v((math.cos(t) * rr1, math.sin(t) * rr1, L)))
        s = 1.0 / TILE.get(mat, 1.0)
        circ = 2 * math.pi * max(r, r2)
        for i in range(seg):
            j = (i + 1) % seg
            u0, u1 = i / seg * circ * s, (i + 1) / seg * circ * s
            self.face((ring0[i], ring0[j], ring1[j], ring1[i]), [(u0, 0), (u1, 0), (u1, L * s), (u0, L * s)], mat, not square)
        if caps:
            self.face(tuple(reversed(ring0)), [(math.cos(2 * math.pi * k / seg) * r * s, math.sin(2 * math.pi * k / seg) * r * s) for k in reversed(range(seg))], mat)
            self.face(tuple(ring1), [(math.cos(2 * math.pi * k / seg) * r2 * s, math.sin(2 * math.pi * k / seg) * r2 * s) for k in range(seg)], mat)
        self.pop()

    def lathe(self, prof, mat, seg=16, axis_a=(0, 0, 0), axis_b=(0, 0, 1), smooth=True, cap_start=False, cap_end=False):
        """Rotationskörper: prof = [(radius, z), ...] entlang der Achse a->b (z in Metern ab a)."""
        M, _ = self.frame(axis_a, axis_b)
        self.push(M)
        rings = []
        for r, z in prof:
            rings.append([self.add_v((math.cos(2 * math.pi * i / seg) * r, math.sin(2 * math.pi * i / seg) * r, z)) for i in range(seg)])
        s = 1.0 / TILE.get(mat, 1.0)
        acc = 0.0
        vs = [0.0]
        for k in range(1, len(prof)):
            acc += math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1])
            vs.append(acc * s)
        circ = 2 * math.pi * max(p[0] for p in prof) * s
        for k in range(len(prof) - 1):
            for i in range(seg):
                j = (i + 1) % seg
                self.face((rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]),
                          [(i / seg * circ, vs[k]), ((i + 1) / seg * circ, vs[k]), ((i + 1) / seg * circ, vs[k + 1]), (i / seg * circ, vs[k + 1])], mat, smooth)
        if cap_start:
            self.face(tuple(reversed(rings[0])), [(0.5 + 0.5 * math.cos(2 * math.pi * i / seg), 0.5 + 0.5 * math.sin(2 * math.pi * i / seg)) for i in reversed(range(seg))], mat)
        if cap_end:
            self.face(tuple(rings[-1]), [(0.5 + 0.5 * math.cos(2 * math.pi * i / seg), 0.5 + 0.5 * math.sin(2 * math.pi * i / seg)) for i in range(seg)], mat)
        self.pop()

    def disk(self, c, r, mat, normal=(0, 0, 1), seg=16, uv_full=True):
        """Kreisscheibe (n-Eck) mit Normale `normal` (UV 0..1 über die Scheibe)."""
        c = Vector(c)
        M, _ = self.frame(c, c + Vector(normal))
        self.push(M)
        idx = [self.add_v((math.cos(2 * math.pi * i / seg) * r, math.sin(2 * math.pi * i / seg) * r, 0)) for i in range(seg)]
        self.pop()
        self.face(idx, [(0.5 + 0.5 * math.cos(2 * math.pi * i / seg), 0.5 + 0.5 * math.sin(2 * math.pi * i / seg)) for i in range(seg)], mat)

    def quad(self, p0, p1, p2, p3, mat, uvs=None, smooth=False):
        return self.poly([p0, p1, p2, p3], mat, smooth, uvs or [(0, 0), (1, 0), (1, 1), (0, 1)])

    # ---- output
    def build(self, name: str, parent=None, mat_order=None):
        me = bpy.data.meshes.new(name)
        verts = [G(*p) for p in self.v]
        mats = mat_order or []
        for _, _, m, _ in self.faces:
            if m not in mats:
                mats.append(m)
        me.from_pydata([tuple(p) for p in verts], [], [f[0] for f in self.faces])
        uvl = me.uv_layers.new(name="UVMap")
        li = 0
        for pi, (idx, uvs, m, sm) in enumerate(self.faces):
            poly = me.polygons[pi]
            poly.material_index = mats.index(m)
            poly.use_smooth = sm
            for k in range(poly.loop_total):
                uvl.data[poly.loop_start + k].uv = uvs[k]
        for m in mats:
            me.materials.append(bpy.data.materials[m])
        me.validate(clean_customdata=False)
        me.update()
        ob = bpy.data.objects.new(name, me)
        link(ob, parent)
        # merge coincident verts only within same face groups is not needed; keep hard edges explicit
        return ob

    def box_truss(self, a, b, w, mat, chord_r=0.025, lace_r=0.01, seg=6, lace_seg=4, up=(0, 1, 0), ends=True):
        """Vierpunkt-Traverse (z. B. 40-cm-Alu-Traverse) von a nach b, Querschnitt w x w.
        Gurtrohre in den Ecken, Zickzack-Diagonalen auf allen vier Seiten, Endrahmen."""
        M, L = self.frame(a, b, up)
        self.push(M)
        h = w / 2 - chord_r
        cs = [(-h, -h), (h, -h), (h, h), (-h, h)]
        for x, y in cs:
            self.tube((x, y, 0), (x, y, L), chord_r, mat, seg=seg, caps=True)
        n = max(1, round(L / w))
        dz = L / n
        for k in range(4):
            p, q = cs[k], cs[(k + 1) % 4]
            for i in range(n):
                z0, z1 = i * dz, (i + 1) * dz
                if i % 2:
                    self.tube((p[0], p[1], z0), (q[0], q[1], z1), lace_r, mat, seg=lace_seg, caps=False)
                else:
                    self.tube((q[0], q[1], z0), (p[0], p[1], z1), lace_r, mat, seg=lace_seg, caps=False)
        if ends:
            for z in (0.02, L - 0.02):
                for k in range(4):
                    p, q = cs[k], cs[(k + 1) % 4]
                    self.tube((p[0], p[1], z), (q[0], q[1], z), lace_r * 1.4, mat, seg=lace_seg, caps=False)
        self.pop()

    def tri_count(self) -> int:
        return sum(len(f[0]) - 2 for f in self.faces)


def fence_panel(mb, x0, z, y0=0.0, L=2.3, mat="Steel_Galv", detail=True):
    """Absperrgitter-Element (Länge L entlang +X ab x0): Rahmenrohr, senkrechte Stäbe, Flachfüße."""
    h = 1.1
    mb.tube((x0, y0 + 0.12, z), (x0, y0 + h, z), 0.019, mat, seg=6)
    mb.tube((x0 + L, y0 + 0.12, z), (x0 + L, y0 + h, z), 0.019, mat, seg=6)
    mb.tube((x0, y0 + h, z), (x0 + L, y0 + h, z), 0.019, mat, seg=6)
    mb.tube((x0, y0 + 0.2, z), (x0 + L, y0 + 0.2, z), 0.019, mat, seg=6)
    n = 14 if detail else 0
    for k in range(1, n):
        x = x0 + L * k / n
        mb.tube((x, y0 + 0.2, z), (x, y0 + h, z), 0.008, mat, seg=4, caps=False)
    for x in (x0 + 0.1, x0 + L - 0.1):
        mb.box((x, y0 + 0.02, z), (0.06, 0.04, 0.7), mat)
        mb.tube((x, y0 + 0.04, z), (x, y0 + 0.14, z), 0.012, mat, seg=4)


# ------------------------------------------------------------------ import / decimate
def import_gltf(path: str):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def decimate(ob, ratio: float):
    if ratio >= 1.0:
        return ob
    mod = ob.modifiers.new("dec", "DECIMATE")
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = ob
    with bpy.context.temp_override(object=ob, active_object=ob):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return ob


def tris(ob) -> int:
    ob.data.calc_loop_triangles()
    return len(ob.data.loop_triangles)


# ------------------------------------------------------------------ export
def export_glb(name: str, objects=None, lod: int = 0, out_dir: str | None = None, vertex_colors: bool = False) -> str:
    od = out_dir or OUT
    os.makedirs(od, exist_ok=True)
    path = os.path.join(od, f"{name}.glb" if lod == 0 else f"{name}_lod{lod}.glb")
    bpy.ops.object.select_all(action="DESELECT")
    if objects is not None:
        for ob in objects:
            ob.select_set(True)
    kw = dict(
        filepath=path, export_format="GLB", export_yup=True, export_apply=True,
        export_texcoords=True, export_normals=True, export_materials="EXPORT",
        export_cameras=False, export_lights=False, export_extras=False,
        export_animations=False, use_selection=objects is not None,
        export_image_format="AUTO", export_jpeg_quality=88,
    )
    if vertex_colors:
        try:
            kw["export_vertex_color"] = "ACTIVE"
        except Exception:
            pass
    bpy.ops.export_scene.gltf(**kw)
    print(f"[ws-f] exported {path} ({os.path.getsize(path) / 1024:.0f} KiB)")
    return path


def weather_colors(ob, seed=0, base=0.92, var=0.12, cell=None, up_tint=(1.04, 0.99, 0.92), up_dot=0.7, macro=0.08):
    """Vertex-Farben (COLOR_0, multipliziert mit Base Color in three.js) für Verwitterung:
    zufällige Helligkeit je Stein/Zelle, großräumige Flecken, Staub auf nach oben zeigenden Flächen."""
    from mathutils import noise as _n
    me = ob.data
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
    r = random.Random(seed)
    cache = {}
    cols = []
    for poly in me.polygons:
        c = ob.matrix_world @ poly.center
        key = tuple(int(v // cell) for v in c) if cell else poly.index
        if key not in cache:
            cache[key] = base + r.uniform(-var, var * 0.5)
        v = cache[key] + macro * _n.noise(c * 0.02 + Vector((seed, 0, 0))) + macro * 0.5 * _n.noise(c * 0.11)
        nz = poly.normal.z
        col = [v, v, v]
        if nz > up_dot:
            col = [v * up_tint[0], v * up_tint[1], v * up_tint[2]]
        for li in poly.loop_indices:
            cols.append((max(col[0], 0), max(col[1], 0), max(col[2], 0), 1.0))
    import numpy as _np
    attr.data.foreach_set("color", _np.array(cols, _np.float32).ravel())
    me.color_attributes.active_color = attr
    return attr


def rng(seed: int) -> random.Random:
    return random.Random(seed)
