#!/usr/bin/env python3
"""prüft, wie die Dreiecke einer Wahrzeichen-GLB auf die beweglichen Teile (meta.json `dynamic`) verteilt werden.

Bildet `splitDynamicLandmarks` (src/render/worlds/landmarks.ts) nach: Ein Dreieck gehört zum ersten Teil (nach dem
Hauptkörper), dessen Region seinen Schwerpunkt (Objektrahmen) enthält, sonst zum Hauptkörper – hat der Hauptkörper
eine eigene Region (Stonehenge-Steine), nur innerhalb davon; der Rest bleibt statisch.

    python3 tools/worlds/check_prop_regions.py <datei.glb> <meta.json> [--max-static 0.05]

Ausgabe: Dreiecke je Teil, statischer Rest (Anteil), Teile ohne Dreiecke. Exit 1, wenn ein Teil leer ist oder der
statische Anteil der Objekt-Meshes über --max-static liegt.
"""
from __future__ import annotations

import json
import math
import struct
import sys

import numpy as np

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def load_glb(path):
    b = open(path, "rb").read()
    n = struct.unpack_from("<I", b, 12)[0]
    js = json.loads(b[20:20 + n])
    off = 20 + n
    bn = struct.unpack_from("<I", b, off)[0]
    return js, b[off + 8: off + 8 + bn]


def accessor(js, binb, i):
    a = js["accessors"][i]
    bv = js["bufferViews"][a["bufferView"]]
    dt = CT[a["componentType"]]
    nc = NC[a["type"]]
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride", 0)
    if stride and stride != nc * np.dtype(dt).itemsize:
        raw = np.frombuffer(binb, np.uint8, a["count"] * stride, start).reshape(a["count"], stride)
        return raw[:, : nc * np.dtype(dt).itemsize].copy().view(dt).reshape(a["count"], nc)
    return np.frombuffer(binb, dt, a["count"] * nc, start).reshape(a["count"], nc)


def node_matrix(nd):
    if "matrix" in nd:
        return np.array(nd["matrix"], float).reshape(4, 4).T
    t = nd.get("translation", [0, 0, 0])
    x, y, z, w = nd.get("rotation", [0, 0, 0, 1])
    s = nd.get("scale", [1, 1, 1])
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M = np.eye(4)
    M[:3, :3] = R * np.array(s)
    M[:3, 3] = t
    return M


def shape_bounds(s):
    if s["kind"] == "hull":
        p = np.array(s["pts"]).reshape(-1, 3)
        return p.min(0), p.max(0)
    c = np.array(s["c"], float)
    if s["kind"] == "cyl":
        e = np.array([s["r"]] * 3, float)
        e["xyz".index(s["axis"])] = s["hh"]
        return c - e, c + e
    a, b_, g = [math.radians(v) for v in s.get("rotDeg", [0, 0, 0])]
    Rx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    Ry = np.array([[math.cos(b_), 0, math.sin(b_)], [0, 1, 0], [-math.sin(b_), 0, math.cos(b_)]])
    Rz = np.array([[math.cos(g), -math.sin(g), 0], [math.sin(g), math.cos(g), 0], [0, 0, 1]])
    R = Rx @ Ry @ Rz   # three.js 'XYZ'
    h = np.array(s["h"], float)
    corners = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]) * h
    p = corners @ R.T + c
    return p.min(0), p.max(0)


def part_regions(p, margin=0.05):
    if p.get("region"):
        return [(np.array(r["min"], float), np.array(r["max"], float)) for r in p["region"]]
    return [(lo - margin, hi + margin) for lo, hi in map(shape_bounds, p["shapes"])]


def main():
    a = sys.argv[1:]
    glb, meta = a[0], a[1]
    max_static = float(a[a.index("--max-static") + 1]) if "--max-static" in a else 0.05
    js, binb = load_glb(glb)
    defs = json.load(open(meta))["landmarks"][0]["dynamic"]
    nodes = js["nodes"]
    parent = {}
    for i, nd in enumerate(nodes):
        for c in nd.get("children", []):
            parent[c] = i

    def world(i):
        M = node_matrix(nodes[i])
        while i in parent:
            i = parent[i]
            M = node_matrix(nodes[i]) @ M
        return M

    def names(i):
        out = [nodes[i].get("name", "")]
        while i in parent:
            i = parent[i]
            out.append(nodes[i].get("name", ""))
        return out

    objs = []
    for d in defs:
        yaw = math.radians(d["yawDeg"])
        O = np.eye(4)
        O[:3, :3] = [[math.cos(yaw), 0, math.sin(yaw)], [0, 1, 0], [-math.sin(yaw), 0, math.cos(yaw)]]
        O[:3, 3] = d["origin"]
        regions = [[] if (pi == 0 and not p.get("region")) else part_regions(p) for pi, p in enumerate(d["parts"])]
        claim_rest = not d["parts"][0].get("region")
        radius = 0.0
        for rs in regions:
            for lo, hi in rs:
                radius = max(radius, float(np.linalg.norm(np.maximum(-lo, hi))))
        objs.append(dict(d=d, Oinv=np.linalg.inv(O), regions=regions, claim_rest=claim_rest,
                         radius=math.inf if claim_rest else radius, origin=np.array(d["origin"], float),
                         count=[0] * len(d["parts"])))
    static = 0
    total = 0
    for i, nd in enumerate(nodes):
        if "mesh" not in nd:
            continue
        nm = names(i)
        mine = [o for o in objs if any(n in o["d"]["meshes"] for n in nm)]
        if not mine:
            continue
        M = world(i)
        for prim in js["meshes"][nd["mesh"]]["primitives"]:
            P = accessor(js, binb, prim["attributes"]["POSITION"]).astype(float)
            idx = accessor(js, binb, prim["indices"]).ravel() if "indices" in prim else np.arange(len(P))
            tri = idx.reshape(-1, 3)
            c = P[tri].mean(1)
            c = c @ M[:3, :3].T + M[:3, 3]
            claimed = np.zeros(len(c), bool)
            for o in mine:
                near = (~claimed) & (np.linalg.norm(c - o["origin"], axis=1) <= o["radius"])
                if not near.any():
                    continue
                co = c @ o["Oinv"][:3, :3].T + o["Oinv"][:3, 3]
                part = np.full(len(c), -1)
                for pi in range(1, len(o["regions"])):
                    inside = np.zeros(len(c), bool)
                    for lo, hi in o["regions"][pi]:
                        inside |= np.all((co >= lo) & (co <= hi), axis=1)
                    part = np.where((part < 0) & near & inside, pi, part)
                if o["claim_rest"]:
                    part = np.where((part < 0) & near, 0, part)
                else:
                    inside = np.zeros(len(c), bool)
                    for lo, hi in o["regions"][0]:
                        inside |= np.all((co >= lo) & (co <= hi), axis=1)
                    part = np.where((part < 0) & near & inside, 0, part)
                for pi in range(len(o["count"])):
                    o["count"][pi] += int(np.sum(part == pi))
                claimed |= part >= 0
            static += int(np.sum(~claimed))
            total += len(c)
    empty = []
    for o in objs:
        for pi, p in enumerate(o["d"]["parts"]):
            if o["count"][pi] == 0:
                empty.append(f'{o["d"]["id"]}:{p["id"]}')
    if len(objs) <= 12:
        for o in objs:
            print(o["d"]["id"], {p["id"]: o["count"][pi] for pi, p in enumerate(o["d"]["parts"])})
    else:
        cs = sorted(sum(o["count"]) for o in objs)
        print(f"{len(objs)} Objekte, Dreiecke je Objekt min {cs[0]} / median {cs[len(cs) // 2]} / max {cs[-1]}")
    frac = static / max(total, 1)
    print(f"Dreiecke der Objekt-Meshes: {total}, statisch (keinem Teil zugeordnet): {static} = {frac * 100:.1f} %")
    if empty:
        print("LEERE TEILE:", ", ".join(empty))
    sys.exit(1 if empty or frac > max_static else 0)


if __name__ == "__main__":
    main()
