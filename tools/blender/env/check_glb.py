#!/usr/bin/env python3
"""Automatic check of the environment GLBs (no dependencies).

Prints per file: size, node tree (name, position, mesh), materials (emission, strength, alphaMode,
textures + resolution), world bounding box (from accessor min/max x node transform), triangles per mesh
and in total, light empties (world position + light direction = local -Z).
Checks rules (exit code 1 on violation): origin bottom centre (minY ~ 0, |centre XZ| small),
triangle budget, textures <= 2048, required nodes/materials, instancing assets = 1 mesh/1 material.

  python3 tools/blender/env/check_glb.py [file.glb ...]   (no arguments: all in public/assets/env-models)
"""
from __future__ import annotations

import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DIR = os.path.join(ROOT, "public", "assets", "env-models")

# rules per asset: max. triangles (LOD0), required materials, required node prefixes, instancing (1 mesh/1 mat)
RULES = {
    "light_tower": dict(tris=40000, mats=["Lamp_Emissive"], nodes=["Light_"], min_lights=12),
    "stage": dict(tris=60000, mats=["Screen_Emissive", "LED_Red"]),
    "grandstand": dict(tris=60000),
    "crowd_person": dict(tris=6000, inst=True, variants=4, mesh_tris=1500),
    "ramp_truss": dict(tris=8000, inst=True),
    "raptor_stand": dict(tris=30000),
    "led_fixture": dict(tris=600, inst=False),
    "barrier": dict(tris=2500, inst=True),
    "gate60": dict(tris=30000),
    "crowd_fence": dict(tris=1500, inst=True),
    "ramp_truss_cap": dict(tris=1000, inst=True),
    "grass_clump": dict(tris=400, inst=True, alpha="MASK"),
    "shrub": dict(tris=2500, inst=True, alpha="MASK"),
}


def read_glb(path):
    b = open(path, "rb").read()
    assert struct.unpack("<I", b[0:4])[0] == 0x46546C67, "kein glTF"
    n = struct.unpack("<I", b[12:16])[0]
    j = json.loads(b[20:20 + n])
    binoff = 20 + n + 8
    return j, b[binoff:], len(b)


def qmat(q):
    x, y, z, w = q
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]


def local_m(nd):
    if "matrix" in nd:
        m = nd["matrix"]
        return [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]], [0, 0, 0, 1]]
    t = nd.get("translation", [0, 0, 0])
    r = qmat(nd.get("rotation", [0, 0, 0, 1]))
    s = nd.get("scale", [1, 1, 1])
    return [[r[i][0] * s[0], r[i][1] * s[1], r[i][2] * s[2], t[i]] for i in range(3)] + [[0, 0, 0, 1]]


def mm(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def xf(m, p, w=1.0):
    return [m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3] * w for i in range(3)]


def png_jpg_size(data: bytes):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    i = 2
    while i < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        mk = data[i + 1]
        ln = struct.unpack(">H", data[i + 2:i + 4])[0]
        if mk in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + ln
    return (0, 0)


def check(path) -> list[str]:
    name = os.path.basename(path)[:-4]
    base = name.split("_lod")[0]
    rule = RULES.get(base, {})
    errs = []
    j, binb, size = read_glb(path)
    print(f"\n=== {name}.glb  {size / 1024:.0f} KiB")
    nodes = j.get("nodes", [])
    meshes = j.get("meshes", [])
    acc = j.get("accessors", [])
    mats = j.get("materials", [])
    scene = j["scenes"][j.get("scene", 0)]
    lo = [1e9] * 3
    hi = [-1e9] * 3
    tri_total = 0
    lights = []
    mesh_nodes = 0

    def walk(i, parent, depth):
        nonlocal tri_total, mesh_nodes
        nd = nodes[i]
        W = mm(parent, local_m(nd))
        pos = [W[0][3], W[1][3], W[2][3]]
        line = f"{'  ' * depth}- {nd.get('name', '?')}  pos=({pos[0]:.2f}, {pos[1]:.2f}, {pos[2]:.2f})"
        if "mesh" in nd:
            mesh_nodes += 1
            me = meshes[nd["mesh"]]
            t = 0
            for pr in me["primitives"]:
                a = acc[pr["attributes"]["POSITION"]]
                for cx in (a["min"][0], a["max"][0]):
                    for cy in (a["min"][1], a["max"][1]):
                        for cz in (a["min"][2], a["max"][2]):
                            q = xf(W, [cx, cy, cz])
                            for k in range(3):
                                lo[k] = min(lo[k], q[k])
                                hi[k] = max(hi[k], q[k])
                cnt = acc[pr["indices"]]["count"] if "indices" in pr else a["count"]
                t += cnt // 3
            tri_total += t
            pm = [mats[p["material"]].get("name", "?") if "material" in p else "-" for p in me["primitives"]]
            line += f"  mesh={me.get('name')} tris={t} mats={pm}"
        if nd.get("name", "").startswith("Light_"):
            d = xf(W, [0, 0, -1], 0.0)
            L = math.sqrt(sum(c * c for c in d)) or 1
            lights.append((nd["name"], pos, [c / L for c in d]))
        if depth < 3 or "mesh" in nd:
            if not nd.get("name", "").startswith("Light_") or nd["name"] in ("Light_0", "Light_1"):
                print(line)
        for c in nd.get("children", []):
            walk(c, W, depth + 1)

    I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    for r in scene["nodes"]:
        walk(r, I, 0)
    print(f"  BBox: x[{lo[0]:.2f}, {hi[0]:.2f}] y[{lo[1]:.2f}, {hi[1]:.2f}] z[{lo[2]:.2f}, {hi[2]:.2f}]"
          f"  -> {hi[0] - lo[0]:.2f} x {hi[1] - lo[1]:.2f} x {hi[2] - lo[2]:.2f} m")
    print(f"  Dreiecke gesamt: {tri_total}   Mesh-Knoten: {mesh_nodes}   Materialien: {len(mats)}")
    imgs = j.get("images", [])
    texs = j.get("textures", [])
    for m in mats:
        pb = m.get("pbrMetallicRoughness", {})
        e = m.get("emissiveFactor")
        es = m.get("extensions", {}).get("KHR_materials_emissive_strength", {}).get("emissiveStrength")
        tx = []
        for key, slot in (("base", pb.get("baseColorTexture")), ("mr", pb.get("metallicRoughnessTexture")),
                          ("nor", m.get("normalTexture")), ("emi", m.get("emissiveTexture"))):
            if slot:
                im = imgs[texs[slot["index"]]["source"]]
                bv = j["bufferViews"][im["bufferView"]]
                data = binb[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
                w, h = png_jpg_size(data)
                tx.append(f"{key}:{w}x{h}")
                if max(w, h) > 2048:
                    errs.append(f"Textur > 2048 in {m.get('name')}")
        print(f"  Mat {m.get('name'):<18} base={[round(c, 3) for c in pb.get('baseColorFactor', [1, 1, 1, 1])]}"
              f" metal={pb.get('metallicFactor', 1)} rough={pb.get('roughnessFactor', 1)}"
              f"{' emissive=' + str([round(c, 3) for c in e]) if e else ''}{' x' + str(es) if es else ''}"
              f" alpha={m.get('alphaMode', 'OPAQUE')}{' cutoff=' + str(m.get('alphaCutoff')) if m.get('alphaMode') == 'MASK' else ''}"
              f"{' 2side' if m.get('doubleSided') else ''} {' '.join(tx)}")
    if lights:
        print(f"  Licht-Empties: {len(lights)}")
        for n, p, d in lights[:3] + ([lights[-1]] if len(lights) > 3 else []):
            print(f"    {n}: pos=({p[0]:.2f}, {p[1]:.2f}, {p[2]:.2f}) dir(-Z)=({d[0]:.2f}, {d[1]:.2f}, {d[2]:.2f})")
    # ---- rules
    if abs(lo[1]) > 0.05 and base not in ("crowd_person",):
        errs.append(f"Ursprung nicht unten: minY={lo[1]:.3f}")
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    if max(abs(cx), abs(cz)) > 0.25 * max(hi[0] - lo[0], hi[2] - lo[2], 1):
        errs.append(f"Ursprung nicht mittig: center=({cx:.2f}, {cz:.2f})")
    lim = rule.get("tris")
    if lim and "_lod" not in name and tri_total > lim:
        errs.append(f"Dreiecke {tri_total} > Budget {lim}")
    names = [m.get("name") for m in mats]
    for need in rule.get("mats", []):
        if need not in names:
            errs.append(f"Material fehlt: {need}")
    for pre in rule.get("nodes", []):
        if not any(n.get("name", "").startswith(pre) for n in nodes):
            errs.append(f"Knoten fehlt: {pre}*")
    if rule.get("min_lights") and len(lights) < rule["min_lights"]:
        errs.append(f"nur {len(lights)} Licht-Empties")
    for _, _, d in lights:
        if d[2] < 0.2:
            errs.append("Licht zeigt nicht nach vorn (+Z)")
            break
    if rule.get("inst") and (mesh_nodes != rule.get("variants", 1) or len(mats) != 1):
        errs.append(f"Instancing-Asset braucht {rule.get('variants', 1)} Mesh(es)/1 Material (hat {mesh_nodes}/{len(mats)})")
    if rule.get("mesh_tris"):
        for me in meshes:
            t = sum((acc[p["indices"]]["count"] if "indices" in p else acc[p["attributes"]["POSITION"]]["count"]) // 3 for p in me["primitives"])
            if t > rule["mesh_tris"]:
                errs.append(f"Mesh {me.get('name')}: {t} > {rule['mesh_tris']} Dreiecke")
    if rule.get("alpha") and not all(m.get("alphaMode") == rule["alpha"] for m in mats):
        errs.append(f"alphaMode != {rule['alpha']}")
    for e in errs:
        print(f"  !! {e}")
    if not errs:
        print("  OK")
    return errs


def main():
    files = sys.argv[1:] or sorted(os.path.join(DIR, f) for f in os.listdir(DIR) if f.endswith(".glb"))
    bad = 0
    for f in files:
        bad += bool(check(f))
    print(f"\n{len(files)} Dateien, {bad} mit Fehlern")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
