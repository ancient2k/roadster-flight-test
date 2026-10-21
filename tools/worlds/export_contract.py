#!/usr/bin/env python3
"""Asset pipeline worlds: produce the lead's contract format (src/shared/worlds.ts) from the data.

The game itself reads the tiles of meta.json (terrain_h16.png, _shared/detail), not this format, so height.bin, the
detail copies and materials.json go to out/contract/<siteId>/ (not versioned, not deployed); meta.json (TerrainMeta
fields) and landmarks.json are updated in place.

Per site:
  height.bin       Uint16 little-endian, size x size, row-major; row 0 = north (-Z), rows along +Z,
                   columns along +X (east). Content = terrain_h16.png of the close-range tile (identical quantisation).
  meta.json        + top-level TerrainMeta {size, extentM, minM, maxM, source}; all fields are kept.
  landmarks.json   [{glb, pos:{x,y,z}, headingDeg, collider:'box'|'hull', size:{x,y,z}, note}] (y = ground height,
                   same reference as decodeHeightmap: tile centre = 0)
  detail_<name>_{diff,nor,arm}.jpg  copies from _shared/detail (<= 1024², tileable)
  materials.json   albedo/normal/splat + detail channels with tile sizes

    python3 tools/worlds/export_contract.py [site ...]
"""
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
W = os.path.join(ROOT, "public", "assets", "worlds")
SHARED = os.path.join(W, "_shared", "detail")
sys.path.insert(0, os.path.join(ROOT, "tools", "blender", "env"))
import check_glb  # noqa: E402

# collision shape per landmark. Convex hull only where the object is (almost) convex; otherwise a box with dimensions.
COLLIDER = {
    "giza_khufu.glb": ("hull", None), "giza_khafre.glb": ("hull", None), "giza_menkaure.glb": ("hull", None),
    "giza_sphinx.glb": ("hull", None),
    # LM: descent stage + legs only (the GLB also contains the EASEP/flag or the rover at 10–90 m distance)
    "apollo_lm_descent.glb": ("box", {"x": 6.8, "y": 3.3, "z": 6.8}),
    "perseverance.glb": ("box", {"x": 2.7, "y": 2.2, "z": 3.0}),
    # Stonehenge: many single stones -> per-stone boxes in 'stones' (one hull would close the circle)
    "stonehenge.glb": ("box", None),
}


def glb_bbox(path):
    j, _, _ = check_glb.read_glb(path)
    lo, hi = [1e9] * 3, [-1e9] * 3
    nodes, meshes, acc = j["nodes"], j["meshes"], j["accessors"]

    def walk(i, M):
        nd = nodes[i]
        W_ = check_glb.mm(M, check_glb.local_m(nd))
        if "mesh" in nd:
            for pr in meshes[nd["mesh"]]["primitives"]:
                a = acc[pr["attributes"]["POSITION"]]
                for cx in (a["min"][0], a["max"][0]):
                    for cy in (a["min"][1], a["max"][1]):
                        for cz in (a["min"][2], a["max"][2]):
                            q = check_glb.xf(W_, [cx, cy, cz])
                            for k in range(3):
                                lo[k], hi[k] = min(lo[k], q[k]), max(hi[k], q[k])
        for c in nd.get("children", []):
            walk(c, W_)
    I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    for r in j["scenes"][j.get("scene", 0)]["nodes"]:
        walk(r, I)
    return lo, hi


def export(site):
    d = os.path.join(W, site)
    o = os.path.join(ROOT, "out", "contract", site)
    os.makedirs(o, exist_ok=True)
    mp = os.path.join(d, "meta.json")
    m = json.load(open(mp))
    if m.get("body") == "space":
        print(f"{site}: kein Gelände (space) – unverändert")
        return
    t = m["tiles"]["near"]
    a = np.array(Image.open(os.path.join(d, t["heightmap"])))
    assert a.shape == (t["resolution"], t["resolution"])
    a.astype("<u2").tofile(os.path.join(o, "height.bin"))
    src = "; ".join(s["credit"] for s in m["sources"] if s.get("use") == "near height")
    m.update({"size": t["resolution"], "extentM": t["sizeM"], "minM": t["heightMinM"], "maxM": t["heightMaxM"], "source": src})
    # landmarks
    lms = []
    for lm in m.get("landmarks", []):
        kind, size = COLLIDER.get(lm["file"], ("hull", None))
        lo, hi = glb_bbox(os.path.join(d, lm["file"]))
        if size is None:
            size = {"x": round(hi[0] - lo[0], 2), "y": round(hi[1] - max(lo[1], 0), 2), "z": round(hi[2] - lo[2], 2)}
        e = {"glb": lm["file"], "pos": {"x": lm["x"], "y": lm["y"], "z": lm["z"]}, "headingDeg": lm["headingDeg"],
             "collider": kind, "size": size, "note": lm.get("note", "")}
        if lm["file"] == "stonehenge.glb":
            stones = os.path.join(d, "stonehenge_stones.json")
            if os.path.exists(stones):
                e["stones"] = json.load(open(stones))
                e["note"] += "; Kollision: 'stones' (Box je Stein, lokal zum Kreismittelpunkt) statt der Gesamt-Box verwenden"
        lms.append(e)
    json.dump(lms, open(os.path.join(d, "landmarks.json"), "w"), indent=1, ensure_ascii=False)
    # detail textures + materials.json
    det = m.get("detailTextures") or {}
    tiles = json.load(open(os.path.join(SHARED, "detail.json")))
    details = {}
    for ch, name in det.items():
        for k in ("diff", "nor", "arm"):
            shutil.copyfile(os.path.join(SHARED, f"{name}_{k}.jpg"), os.path.join(o, f"detail_{name}_{k}.jpg"))
        details[ch] = {"name": name, "diff": f"detail_{name}_diff.jpg", "nor": f"detail_{name}_nor.jpg",
                       "arm": f"detail_{name}_arm.jpg", "tileM": tiles[name]["tileM"]}
    mat = {"albedo": t.get("albedo"), "albedoCoversM": t["sizeM"], "normal": t.get("normalMap"),
           "splat": {"file": t.get("splat"), "channels": {"r": "rock", "g": "fine", "b": "dark"}},
           "details": details,
           "blend": "albedo_final = albedo · Σ_k splat_k · (detail_k_diff · 2) (linear); Normalen: Kachel-Normal + Detail-Normal (RNM)"}
    json.dump(mat, open(os.path.join(o, "materials.json"), "w"), indent=1, ensure_ascii=False)
    json.dump(m, open(mp, "w"), indent=2, ensure_ascii=False)
    print(f"{site}: height.bin {a.shape[0]}², {len(lms)} Wahrzeichen, {len(details)} Detailkanäle")


for s in sys.argv[1:] or sorted(x for x in os.listdir(W) if os.path.isdir(os.path.join(W, x)) and not x.startswith("_")):
    export(s)
