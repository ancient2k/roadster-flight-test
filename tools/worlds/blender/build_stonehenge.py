"""asset pipeline Welten: Stonehenge im heutigen Zustand (public/assets/worlds/earth_stonehenge/stonehenge.glb).

  Blender -b --factory-startup -P tools/worlds/blender/build_stonehenge.py

Grundriss nach den Vermessungen von Cleal, Walker & Montague (1995) / English Heritage (Petrie-Nummerierung):
  Sarsen-Kreis: 30 Positionen, Außen-Ø 33 m, Steine ~2,1 x 1,1 m, 4,1 m hoch, Decksteine 3,2 x 1,0 x 0,8 m.
    Stein 1 und 30 flankieren die Sonnwendachse (Azimut 49,9°), Zählung im Uhrzeigersinn.
    Heute stehend: 1–7, 10, 11, 16, 21, 23, 27–30; Stümpfe: 9, 12, 14, 15, 19, 22, 25, 26; umgestürzt: 8, 20.
    Decksteine in situ: 130, 101, 102, 105, 106 (+ 122 restauriert).
  Trilithen-Hufeisen (Öffnung nach NO): 51/52, 53/54, 55/56 (Großer Trilith, 7,3 m), 57/58, 59/60.
    Heute: 51–54 und 57/58 mit Deckstein; 56 stehend, 55 + Deckstein 156 liegend; 60 stehend, 59 liegend.
  Blausteinkreis (r ~11,5 m, ~30 sichtbare Steine) und -hufeisen (r ~6 m), Altarstein (liegend unter 55/56),
  Slaughter Stone (liegend, Eingang), Heel Stone (77 m auf Azimut ~51°, geneigt), Station Stones 91 und 93.
glTF-Rahmen: Ursprung = Kreismitte auf Bodenhöhe, +X = Ost, -Z = Nord (Modell nicht drehen: meta compassDeg 180).
Alle Steine EIN Mesh, zwei Materialien (Sarsen, Bluestone).
Steine als gerundete Quader-Gitter mit Verjüngung, Schiefe, Bruchflächen, großen Fehlstellen, Rinnen, Zapfen
auf freien Pfeilern; tragende Pfeiler mit ebener Oberkante; Kreis-Decksteine gebogen; UVs je Würfelseite;
Flechten in der Textur + Vertexfarben. Lage/Maße (STONES) unverändert -> stonehenge_stones.json und die
88 Steinkörper in meta.json bleiben gültig (python3 tools/worlds/check_prop_regions.py). Liegende Steine liegen
jetzt mittig auf ihrer Kollisionsbox (um die halbe Länge versetzt).
  Blender -b --factory-startup -P tools/worlds/blender/build_stonehenge.py [-- --out <dir>]
"""
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "blender", "env"))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector, noise  # noqa: E402

import env_common as E  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT = os.path.join(ROOT, "public", "assets", "worlds", "earth_stonehenge")
if "--out" in E.args():                # Probe-Builds außerhalb von public/
    OUT = os.path.abspath(E.args()[E.args().index("--out") + 1])
CC = os.path.join(HERE, "..", "downloads", "_cc0")
AXIS = 49.9


def cc(name, m):
    return os.path.join(CC, name, f"{name}_{m}_2k.jpg")


def polar(az_deg, r):
    """Azimut (von Nord über Ost) + Radius -> glTF (x, z) mit -Z = Nord."""
    a = math.radians(az_deg)
    return r * math.sin(a), -r * math.cos(a)


STONES = []   # (bmesh-fähige Beschreibung)


def stone(pos, size, yaw_deg, mat, seed, lie=False, tilt=(0.0, 0.0), taper=0.85, rough=1.0, bury=0.25):
    """Stein als verformter Quader. pos (x, z), size (Breite, Höhe, Dicke); yaw = Azimut-Winkel, bei dem die
    Breitseite tangential zum Kreis liegt (Breitenrichtung (cos yaw, sin yaw) in glTF x/z). lie=True: liegend."""
    STONES.append(dict(pos=pos, size=size, yaw=yaw_deg, mat=mat, seed=seed, lie=lie, tilt=tilt, taper=taper, rough=rough, bury=bury))


def _smooth(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def box_grid(dims, spacing):
    """Quaderoberfläche als Gitter (Einheitswürfel -0,5..0,5, Kantenteilung nach Maß dims / spacing).
    Liefert bmesh, je Fläche die Würfelachse (für die UV-Projektion ohne Zickzack-Nähte)."""
    W, T, H = dims
    n = [max(3, round(W / spacing)), max(2, round(T / spacing)), max(3, round(H / spacing))]
    bm = bmesh.new()
    lay = bm.faces.layers.int.new("axis")   # Würfelachse je Fläche (vor dem Anlegen der Flächen erzeugen)
    for a in range(3):
        b, c = [k for k in range(3) if k != a]
        for s in (-1, 1):
            grid = []
            for j in range(n[c] + 1):
                row = []
                for i in range(n[b] + 1):
                    p = [0.0, 0.0, 0.0]
                    p[a] = 0.5 * s
                    p[b] = -0.5 + i / n[b]
                    p[c] = -0.5 + j / n[c]
                    row.append(bm.verts.new(p))
                grid.append(row)
            for j in range(n[c]):
                for i in range(n[b]):
                    q = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]]
                    f = bm.faces.new(q if s > 0 else q[::-1])
                    f[lay] = a
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm, lay


def make_stone(d):
    """Stein als gerundeter Quader mit Verjüngung, Bruchflächen (ebene Abschläge), Großbeulen, Rinnen
    (senkrechte Verwitterungsrillen bei Sarsen), Zapfen auf freistehenden Pfeilern, gebogene Kreis-Decksteine.
    UVs: Projektion je ursprünglicher Würfelseite in Metern (Kachel 3 m bzw. 2 m), je Stein versetzt."""
    r = random.Random(d["seed"])
    w, h, t = d["size"]
    sarsen = d["mat"] == "Sarsen"
    rough = d["rough"] * (1.0 if d["mat"] == "Sarsen" else 1.35)
    lintel_like = d["bury"] < 0 and not d["lie"]
    spacing = 0.19 if sarsen else 0.14
    bm, lay = box_grid((w, t, h), spacing)
    off = Vector((d["seed"] * 1.37, d["seed"] * 0.71, d["seed"] * 0.29))
    rad = 0.14 if sarsen else 0.1                       # Kantenradius
    if lintel_like:
        rad = 0.12
    # Bruchflächen: zufällige Ebenen, die 3-12 cm (Stümpfe/Heel: mehr) von Kanten und Ecken abschlagen
    cuts = []
    ncut = r.randint(4, 8) if sarsen else r.randint(3, 6)
    for _ in range(ncut):
        nx, ny, nz = r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-0.6, 0.9)
        n = Vector((nx, ny, nz)).normalized()
        depth = r.uniform(0.04, 0.16) * rough
        cuts.append((n, depth))
    top_cut = None
    if not lintel_like and not d["lie"] and not d.get("bearing"):
        # freie Oberkante: schräge Bruch-/Verwitterungsfläche, senkt eine Seite um bis zu ~20 cm
        top_cut = (Vector((r.uniform(-0.25, 0.25), r.uniform(-0.25, 0.25), 1.0)).normalized(), r.uniform(0.0, 0.12) * min(rough, 1.4))
    tenons = d.get("tenons", [])
    # Individualität je Stein: seitliche Neigung der Flanken (Schiefe), ungleiche Verjüngung links/rechts,
    # Bauch in halber Höhe, ein bis zwei große Fehlstellen an Kanten (nicht an tragenden Oberkanten)
    skew = r.uniform(-0.07, 0.07) * w if not lintel_like else 0.0
    asym = r.uniform(-0.7, 0.7)
    belly = r.uniform(-0.03, 0.07)
    if sarsen and not lintel_like:
        for _ in range(r.randint(1, 2)):
            a = r.uniform(0, 2 * math.pi)
            nz = r.uniform(-0.5, 0.35 if d.get("bearing") else 0.8)
            n = Vector((math.cos(a), math.sin(a) * 0.8, nz)).normalized()
            cuts.append((n, r.uniform(0.15, 0.32) * min(rough, 1.3)))
    hb = Vector((w / 2, t / 2, h / 2))                   # Stützmaß der Abschlagebenen (ohne Verjüngung)
    for v in bm.verts:
        p = v.co.copy()
        u = p.z + 0.5
        side_k = 1.0 + asym * (1 if p.x > 0 else -1)
        k = (1.0 - (1.0 - d["taper"]) * u ** 1.3 * max(0.2, side_k)) * (1 + belly * math.sin(math.pi * u))
        half = Vector((w * k / 2, t * (0.88 + 0.12 * k) / 2, h / 2))
        ps = Vector((p.x * w * k, p.y * t * (0.88 + 0.12 * k), p.z * h))
        q = Vector((max(-half.x + rad, min(half.x - rad, ps.x)), max(-half.y + rad, min(half.y - rad, ps.y)),
                    max(-half.z + rad, min(half.z - rad, ps.z))))
        nd = ps - q
        nrm = nd.normalized() if nd.length > 1e-9 else Vector((0, 0, 1))
        s = q + nrm * rad
        # Abschläge
        for n, depth in cuts:
            ext = abs(n.x) * hb.x + abs(n.y) * hb.y + abs(n.z) * hb.z
            dd = s.dot(n) - (ext - depth)
            if dd > 0:
                s -= n * dd
        if top_cut is not None:
            n, depth = top_cut
            ext = abs(n.x) * hb.x + abs(n.y) * hb.y + abs(n.z) * hb.z
            dd = s.dot(n) - (ext - depth)
            if dd > 0:
                s -= n * dd
        sp = s + Vector((0, 0, h / 2))
        wp = sp * 0.9 + off
        disp = (noise.noise(wp * 0.5) * 0.095 + noise.noise(wp * 1.6) * 0.035 + noise.noise(wp * 4.5) * 0.012
                + noise.noise(wp * 11.0) * 0.004) * rough
        if sarsen and not d["lie"] and not lintel_like:
            # senkrechte Rinnen, nach oben stärker (Regenablauf)
            g = abs(noise.noise(Vector((sp.x * 3.2, sp.y * 3.2, sp.z * 0.25)) + off))
            disp -= (0.035 * (1 - min(g * 3.0, 1.0)) * (0.3 + 0.7 * u * u)) * rough
        if d.get("bearing") and u > 0.97:
            disp = min(disp, 0.0) * 0.3                  # tragende Oberkante bleibt eben (Deckstein liegt auf)
        s += nrm * disp
        if d.get("bearing") and u > 0.999:
            s.z = h / 2                                  # Oberkante exakt auf Sollhöhe
        # Zapfen (Tenons): flache Kuppen auf der Oberseite
        if u > 0.99:
            for tx, tr, th in tenons:
                dist = math.hypot(s.x - tx * w, s.y)
                s.z += th * (1 - _smooth(tr * 0.5, tr, dist))
        v.co = Vector((s.x + skew * u, s.y, s.z + h / 2))
    # UVs je Würfelseite (Meter / Kachel) + Versatz je Stein
    uvl = bm.loops.layers.uv.new("UVMap")
    tile = 3.0 if sarsen else 2.0
    ou, ov = r.random(), r.random()
    dims = (w, t, h)
    for f in bm.faces:
        a = f[lay]
        b, c = [kk for kk in range(3) if kk != a]
        for lp in f.loops:
            # Würfelkoordinaten zurückrechnen ist nach der Verformung nicht mehr möglich -> verformte Lage nutzen
            co = lp.vert.co
            lp[uvl].uv = (co[b] / tile + ou, co[c] / tile + ov)
    me = bpy.data.meshes.new("s")
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new("s", me)
    E.link(ob)
    x, z = d["pos"]
    if d["lie"]:
        # liegend: um die Längsachse kippen, halb eingesunken, um die Länge zentriert wie die Kollisionsbox
        # (früher überschrieb ein Zwischenstand die Verschiebung -h/2 mit ob.location -> Stein lag um h/2 neben seiner Box)
        rot = Matrix.Rotation(math.radians(90), 4, "X")
        ob.matrix_world = Matrix.Translation(E.G(x, t * 0.32, z)) @ Matrix.Rotation(math.radians(-d["yaw"]), 4, "Z") @ rot \
            @ Matrix.Translation((0, 0, -h / 2))
    else:
        tx, tz = d["tilt"]
        ob.matrix_world = (Matrix.Translation(E.G(x, -d["bury"], z)) @ Matrix.Rotation(math.radians(-d["yaw"]), 4, "Z")
                           @ Matrix.Rotation(math.radians(tx), 4, "X") @ Matrix.Rotation(math.radians(tz), 4, "Y"))
    me.materials.append(bpy.data.materials[d["mat"]])
    sa = me.attributes.new("stone_seed", "INT", "FACE")
    sa.data.foreach_set("value", [d["seed"]] * len(me.polygons))
    if d.get("bend"):
        # Kreis-Deckstein folgt dem Kreisbogen: Enden um x²/(2R) zur Kreismitte versetzt
        ob.data.transform(ob.matrix_world)
        ob.matrix_world = Matrix.Identity(4)
        R = d["bend"]
        cx, cz = d["pos"]
        c = E.G(cx, 0, cz)
        radial = Vector((c.x, c.y, 0)).normalized()
        tang = Vector((-radial.y, radial.x, 0))
        for v in ob.data.vertices:
            s = (v.co - c).dot(tang)
            v.co -= radial * (s * s / (2 * R))
    return ob


def stone_colors(ob):
    """Vertexfarben (COLOR_0 x Base Color): Ton je Stein, großflächige Flechtenfelder (graugrün auf Flanken,
    hell gelbgrün auf Oberseiten), dunkle Ablaufspuren unter Oberkanten, Moos-/Feuchtesaum am Boden."""
    me = ob.data
    attr = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    cols = np.zeros((len(me.loops), 4), np.float32)
    me.calc_loop_triangles()
    vpos = [ob.matrix_world @ v.co for v in me.vertices]
    vn = [(ob.matrix_world.to_3x3() @ v.normal).normalized() for v in me.vertices]
    poly_seed = [0] * len(me.polygons)
    me.attributes["stone_seed"].data.foreach_get("value", poly_seed)
    for poly in me.polygons:
        sd = poly_seed[poly.index]
        rs = random.Random(sd)
        tone = rs.uniform(0.74, 0.88)
        warm = rs.uniform(-0.03, 0.03)
        sars = me.materials[poly.material_index].name == "Sarsen"
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            p, n = vpos[vi], vn[vi]
            o = Vector((sd * 3.1, sd * 1.7, 0))
            v = tone * (1 + 0.07 * noise.noise(p * 0.7 + o))
            col = [v * (1 + warm), v, v * (1 - warm)]
            # Flechtenfelder (großräumig): Flanken graugrün, Oberseiten hell gelbgrün
            lic = _smooth(0.0, 0.4, noise.noise(p * 0.9 + o * 2.0) + 0.35 * noise.noise(p * 3.1 + o)) * (0.95 if sars else 0.5)
            if n.z > 0.55:
                tint = (0.97, 1.0, 0.86)               # Oberseiten: hell gelbgrün
                lic = max(lic, 0.7 * _smooth(0.55, 0.95, n.z))
            else:
                tint = (0.93, 0.95, 0.9)               # Flanken: hellgraue Krustenflechten
            col = [c * (1 - lic) + tint[i] * lic for i, c in enumerate(col)]
            # Ablaufspuren: senkrecht gestrecktes Rauschen auf Flanken, oben stärker
            side = 1 - abs(n.z)
            st = max(0.0, noise.noise(Vector((p.x * 3.0, p.y * 3.0, p.z * 0.35)) + o)) * side
            col = [c * (1 - 0.4 * st) for c in col]
            # Bodensaum: feucht/dunkler, grünlich
            gz = p.z
            if gz < 0.45:
                f = 1 - _smooth(0.0, 0.45, gz)
                col = [col[0] * (1 - 0.25 * f), col[1] * (1 - 0.17 * f), col[2] * (1 - 0.3 * f)]
            cols[li, :3] = [min(1.0, max(0.0, c)) for c in col]
            cols[li, 3] = 1.0
    attr.data.foreach_set("color", cols.ravel())
    me.color_attributes.active_color = attr
    return attr


def lichen_texture(diff_path, arm_path, out_diff, out_arm, seed=3, blue=False):
    """Krustenflechten in die Albedo malen (kachelbar): mehrere Arten als Flecken 1-8 cm (graugrün, gelb,
    weißlich, dunkel), Rauheit in den Flecken höher. blue=True: gefleckter Dolerit (helle Feldspat-Tupfen)."""
    a = E._load(diff_path)
    n = a.shape[0]
    arm = E._load(arm_path)
    if arm.shape[0] != n:
        arm = E._resize(arm, n)
    rgb = a[..., :3]
    f1, f2, f3 = E.fbm(n, 1.2, seed), E.fbm(n, 1.6, seed + 1), E.fbm(n, 2.6, seed + 2)
    f4 = E.fbm(n, 0.9, seed + 3)
    def blob(f, thr, soft=0.03):
        return np.clip((f - thr) / soft, 0, 1)
    if blue:
        spots = blob(f1, 0.64, 0.02) * blob(f2, 0.35, 0.2)
        rgb = rgb * (1 - 0.6 * spots[..., None]) + np.array([0.62, 0.64, 0.66], np.float32) * 0.6 * spots[..., None]
        lic = blob(f4, 0.66, 0.04) * blob(f3, 0.5, 0.2)
        rgb = rgb * (1 - lic[..., None]) + np.array([0.55, 0.58, 0.5], np.float32) * lic[..., None]
        arm[..., 1] = np.clip(arm[..., 1] + 0.15 * lic, 0, 1)
    else:
        species = [((0.58, 0.62, 0.52), blob(f1, 0.6) * blob(f3, 0.42, 0.2)),        # graugrün (Parmelia-artig)
                   ((0.80, 0.72, 0.36), blob(f2, 0.7) * blob(f3, 0.55, 0.2)),        # gelb (Candelariella)
                   ((0.80, 0.80, 0.76), blob(f4, 0.68) * blob(f2, 0.4, 0.3)),        # weißlich (Lecanora)
                   ((0.30, 0.31, 0.27), blob(f1, 0.73, 0.02))]                         # dunkle Punkte
        for c, m in species:
            m = m[..., None] * 0.9
            rgb = rgb * (1 - m) + np.array(c, np.float32) * (0.9 + 0.2 * f3[..., None]) * m
            arm[..., 1] = np.clip(arm[..., 1] + 0.2 * m[..., 0], 0, 1)
    a[..., :3] = np.clip(rgb, 0, 1)
    if n > 1024:                                         # ARM genügt in 1024²
        arm = E._resize(arm, 1024)
    return E._save(a, os.path.join(E.TEX, out_diff), "JPEG", 90), E._save(arm, os.path.join(E.TEX, out_arm), "JPEG", 92)


def lintel(a_deg, b_deg, r, top, seed, length=3.3):
    """Deckstein zwischen zwei Kreispositionen, leicht gekrümmt (als gerader Quader angenähert)."""
    am = (a_deg + b_deg) / 2
    x, z = polar(am, r)
    STONES.append(dict(pos=(x, z), size=(length, 0.8, 1.0), yaw=am, mat="Sarsen", seed=seed, lie=False,
                       tilt=(0.0, 0.0), taper=0.97, rough=0.6, bury=-(top - 0.22)))


def build():
    E.reset()
    # Sarsen (Silcrete) hellgrau mit Krustenflechten; Blausteine (gefleckter Dolerit) blaugrau
    sd = E.prep_tex(cc("rock_boulder_dry", "diff"), "sarsen_diff.jpg", desat=0.9, gain=1.3, tint=(0.98, 0.98, 0.95), size=2048)
    sa = E.prep_data(cc("rock_boulder_dry", "arm"), "sarsen_arm.jpg", size=2048, rough_scale=0.5, rough_add=0.45, metal=0.0)
    sd, sa = lichen_texture(sd, sa, "sarsen_lichen_diff.jpg", "sarsen_lichen_arm.jpg", seed=3)
    sn = E.prep_data(cc("rock_boulder_dry", "nor_gl"), "sarsen_nor.jpg", size=1024)
    E.material("Sarsen", diff=sd, arm=sa, nor=sn, normal_strength=1.3, tile=3.0)
    bd = E.prep_tex(cc("rock_face_03", "diff"), "bluestone_diff.jpg", desat=0.97, gain=1.05, tint=(0.84, 0.91, 1.0), size=1024)
    ba = E.prep_data(cc("rock_face_03", "arm"), "bluestone_arm.jpg", size=1024, rough_scale=0.6, rough_add=0.3, metal=0.0)
    bd, ba = lichen_texture(bd, ba, "bluestone_spot_diff.jpg", "bluestone_spot_arm.jpg", seed=8, blue=True)
    bn = E.prep_data(cc("rock_face_03", "nor_gl"), "bluestone_nor.jpg", size=1024)
    E.material("Bluestone", diff=bd, arm=ba, nor=bn, normal_strength=1.0, tile=2.0)

    R_S = 15.2                                   # Mittelradius Sarsen-Kreis (Außen-Ø 33 m)
    standing = {1, 2, 3, 4, 5, 6, 7, 10, 11, 16, 21, 23, 27, 28, 29, 30}
    stumps = {9, 12, 14, 15, 19, 22, 25, 26}
    fallen = {8, 20}
    for k in range(1, 31):
        az = AXIS + 12.0 * k - 6.0
        x, z = polar(az, R_S)
        if k in standing:
            stone((x, z), (2.1, 4.1 + 0.25, 1.1), az, "Sarsen", k, tilt=(random.Random(k).uniform(-2, 2), random.Random(k + 50).uniform(-1.5, 1.5)))
        elif k in stumps:
            stone((x, z), (1.9, random.Random(k).uniform(0.4, 1.3), 1.0), az, "Sarsen", k, taper=0.7, rough=1.4)
        elif k in fallen:
            fx, fz = polar(az, R_S + 2.2)
            stone((fx, fz), (2.1, 4.0, 1.1), az, "Sarsen", k, lie=True)
    for a, b, sid in ((30, 1, 130), (1, 2, 101), (2, 3, 102), (5, 6, 105), (6, 7, 106), (22, 23, 122)):
        if sid == 122:
            continue   # 22 ist heute ein Stumpf -> Deckstein 122 nicht auflegen
        lintel(AXIS + 12.0 * a - 6.0, AXIS + 12.0 * b - 6.0 + (360 if b < a else 0), R_S, 4.1, sid)

    # Trilithen (Azimut der Mitte, Radius, Höhe, Zustand)
    tri = [((51, 52), AXIS + 62, 8.6, 6.0, "ok"), ((53, 54), AXIS + 110, 7.6, 6.4, "ok"),
           ((55, 56), AXIS + 180, 7.0, 7.3, "56only"), ((57, 58), AXIS + 250, 7.6, 6.4, "ok"),
           ((59, 60), AXIS + 298, 8.6, 6.0, "60only")]
    for (a, b), az, r, hh, state in tri:
        cx, cz = polar(az, r)
        tang = Vector((math.cos(math.radians(az)), 0, math.sin(math.radians(az))))   # tangential (glTF x, z)
        for s, sid in ((-1, a), (1, b)):
            px, pz = cx + tang.x * s * 1.25, cz + tang.z * s * 1.25
            if state == "56only" and sid == 55:
                fx, fz = polar(az + 12, r + 2.5)
                stone((fx, fz), (2.3, hh, 1.2), az + 40, "Sarsen", sid, lie=True)
                continue
            if state == "60only" and sid == 59:
                fx, fz = polar(az - 8, r + 3.0)
                stone((fx, fz), (2.2, hh, 1.1), az - 30, "Sarsen", sid, lie=True)
                continue
            lean = (4.0, 0.0) if sid == 56 else (0.0, 0.0)
            stone((px, pz), (2.2, hh + 0.4, 1.2), az, "Sarsen", sid, tilt=lean)
        if state == "ok":
            STONES.append(dict(pos=(cx, cz), size=(4.6, 0.9, 1.1), yaw=az, mat="Sarsen", seed=a + 100, lie=False,
                               tilt=(0, 0), taper=0.97, rough=0.6, bury=-(hh - 0.22)))
        if state == "56only":   # Deckstein 156 liegt im Inneren
            fx, fz = polar(az - 15, r - 2.5)
            stone((fx, fz), (4.6, 1.1, 0.9), az + 70, "Sarsen", 156, lie=True)

    # Altarstein (liegend unter dem Großen Trilith), Slaughter Stone, Heel Stone, Station Stones
    ax, az_ = polar(AXIS + 180, 4.6)
    stone((ax, az_), (4.9, 1.0, 0.5), AXIS + 90, "Bluestone", 80, lie=True)
    sx, sz = polar(AXIS - 2, 27.0)
    stone((sx, sz), (2.1, 6.4, 0.8), AXIS + 80, "Sarsen", 95, lie=True)
    hx, hz = polar(51.3, 77.4)
    stone((hx, hz), (2.4, 4.9, 2.1), 51.3, "Sarsen", 96, tilt=(-12.0, 3.0), taper=0.6, rough=1.6, bury=0.6)
    for sid, az, r, h in ((91, AXIS + 76, 40.0, 2.7), (93, AXIS + 256, 40.0, 1.2)):
        x, z = polar(az, r)
        stone((x, z), (1.2, h, 0.8), az, "Sarsen", sid, rough=1.4)

    # Blausteine: Kreis (r 11,5 m) und Hufeisen (r 5,8 m), heute lückenhaft
    rb = random.Random(7)
    for i in range(60):
        if rb.random() < 0.45:
            continue
        az = AXIS + i * 6.0 + rb.uniform(-1.5, 1.5)
        x, z = polar(az, 11.5 + rb.uniform(-0.4, 0.4))
        if rb.random() < 0.35:
            stone((x, z), (0.9, rb.uniform(0.3, 0.8), 0.6), az, "Bluestone", 200 + i, taper=0.7, rough=1.2)
        elif rb.random() < 0.15:
            stone((x, z), (0.7, 2.0, 0.5), az + rb.uniform(0, 180), "Bluestone", 200 + i, lie=True)
        else:
            stone((x, z), (rb.uniform(0.6, 1.0), rb.uniform(1.4, 2.2), 0.5), az, "Bluestone", 200 + i,
                  tilt=(rb.uniform(-6, 6), rb.uniform(-4, 4)), taper=0.8)
    for i in range(19):
        az = AXIS + 50 + i * (260 / 18)
        if rb.random() < 0.35:
            continue
        x, z = polar(az, 5.8 + 0.8 * math.cos(math.radians(az - AXIS - 180)))
        stone((x, z), (0.55, rb.uniform(1.8, 2.4), 0.5), az, "Bluestone", 300 + i, taper=0.75, rough=0.7)

    # Kollisionsboxen je Stein (lokal zum Kreismittelpunkt; headingDeg wie three.js rotation.y, Box-x = Steinbreite)
    import json as _json
    boxes = []
    for d in STONES:
        w, h, t = d["size"]
        x, z = d["pos"]
        if d["lie"]:
            boxes.append({"x": round(x, 2), "z": round(z, 2), "y0": 0.0, "headingDeg": round(-d["yaw"], 1),
                          "size": {"x": round(w, 2), "y": round(t * 0.7, 2), "z": round(h, 2)}})
        else:
            y0 = max(-d["bury"], 0.0)
            boxes.append({"x": round(x, 2), "z": round(z, 2), "y0": round(y0, 2), "headingDeg": round(-d["yaw"], 1),
                          "size": {"x": round(w * 0.95, 2), "y": round(h - max(d["bury"], 0.0), 2), "z": round(t * 0.95, 2)}})
    os.makedirs(OUT, exist_ok=True)
    _json.dump(boxes, open(os.path.join(OUT, "stonehenge_stones.json"), "w"), separators=(",", ":"))
    # tragende Pfeiler (Deckstein liegt auf), Zapfen auf freien Pfeilern, Kreis-Decksteine gebogen
    lintels = [d for d in STONES if d["bury"] < 0 and not d["lie"]]
    for d in STONES:
        if d["lie"] or d["bury"] < 0:
            continue
        top = d["size"][1] - d["bury"]
        for L in lintels:
            dist = math.hypot(d["pos"][0] - L["pos"][0], d["pos"][1] - L["pos"][1])
            if top - 0.45 <= -L["bury"] <= top and dist < L["size"][0] / 2 + 0.3:
                d["bearing"] = True
        if not d.get("bearing") and (d["seed"] <= 30 or d["seed"] in (56, 60)) and d["size"][1] > 3.5:
            # Kreis-Pfeiler: zwei Zapfen (je ein Deckstein-Ende), Trilith-Pfeiler: ein hoher Zapfen (Stein 56)
            d["tenons"] = [(-0.25, 0.24, 0.12), (0.25, 0.24, 0.12)] if d["seed"] <= 30 else [(0.0, 0.32, 0.28 if d["seed"] == 56 else 0.18)]
    for L in lintels:
        if abs(L["size"][0] - 3.3) < 0.01:
            L["bend"] = R_S
    print("[r13c] tragend:", sorted(d["seed"] for d in STONES if d.get("bearing")), "Zapfen:", sorted(d["seed"] for d in STONES if d.get("tenons")))
    objs = [make_stone(d) for d in STONES]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    stone_colors(ob)
    ob.data.attributes.remove(ob.data.attributes["stone_seed"])
    ob.name = "Stonehenge"
    print(f"[ws-f] stonehenge: {len(STONES)} Steine, {E.tris(ob)} tris")
    E.export_glb("stonehenge", out_dir=OUT, vertex_colors=True)


build()
