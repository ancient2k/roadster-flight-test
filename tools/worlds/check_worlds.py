#!/usr/bin/env python3
"""asset pipeline Welten: automatische Prüfung je Ort (public/assets/worlds/<ort>/).

Prüft meta.json (Pflichtfelder, Spawn in der Kachel, Sonnenvektor normiert), Heightmaps (16 Bit, quadratisch,
Auflösung wie angegeben, Höhenbereich plausibel, Spawn-Höhe ~0), Albedo/Normal/Splat (Größe <= 4096),
Wahrzeichen-GLBs (vorhanden, Ursprung unten, Dreiecke/Größe über tools/blender/env/check_glb.py) und Dateigröße.

    python3 tools/worlds/check_worlds.py [ort ...]
"""
import json
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
W = os.path.join(ROOT, "public", "assets", "worlds")
CHECK_GLB = os.path.join(ROOT, "tools", "blender", "env", "check_glb.py")


def check(site):
    d = os.path.join(W, site)
    errs = []
    print(f"\n=== {site}")
    mp = os.path.join(d, "meta.json")
    if not os.path.exists(mp):
        print("  !! meta.json fehlt")
        return ["meta"]
    m = json.load(open(mp))
    need = ("site", "body", "name", "sources") if m.get("body") == "space" else ("site", "body", "name", "frame", "spawn", "sun", "sources", "tiles")
    for k in need:
        if k not in m:
            errs.append(f"meta.{k} fehlt")
    if m.get("body") == "space":
        for f in m.get("files", []):
            if not os.path.exists(os.path.join(d, f)):
                errs.append(f"fehlt: {f}")
        size = sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d))
        print(f"  Himmel/Sonne: {len(m.get('files', []))} Dateien, {size / 1e6:.1f} MB")
        return report(errs)
    sv = m["sun"]["direction"]
    if abs(math.sqrt(sum(c * c for c in sv)) - 1) > 1e-3:
        errs.append("Sonnenvektor nicht normiert")
    print(f"  {m['name']} ({m['body']}), Sonne Az {m['sun']['azimuthDeg']}° / El {m['sun']['elevationDeg']}°")
    for key, t in m["tiles"].items():
        p = os.path.join(d, t["heightmap"])
        im = Image.open(p)
        a = np.array(im)
        ok16 = a.dtype in (np.uint16, np.int32) and im.mode.startswith("I")
        if not ok16 or a.shape != (t["resolution"], t["resolution"]):
            errs.append(f"{t['heightmap']}: Modus {im.mode} {a.shape}")
        h = t["heightMinM"] + a.astype(np.float64) / 65535 * (t["heightMaxM"] - t["heightMinM"])
        mpp = t["sizeM"] / (t["resolution"] - 1)
        if abs(mpp - t["metersPerPixel"]) > 1e-3:
            errs.append(f"{key}: metersPerPixel inkonsistent")
        gy, gx = np.gradient(h, mpp)
        slope = np.degrees(np.arctan(np.hypot(gx, gy)))
        print(f"  {key}: {t['resolution']}² / {t['sizeM']:.0f} m ({mpp:.2f} m/px), h {h.min():.1f} .. {h.max():.1f} m, "
              f"Hang p50 {np.percentile(slope, 50):.1f}° p99 {np.percentile(slope, 99):.1f}°, {os.path.getsize(p) / 1e6:.1f} MB")
        if key == "near":
            sx, sz = m["spawn"]["x"], m["spawn"]["z"]
            if max(abs(sx), abs(sz)) > t["sizeM"] / 2 - 50:
                errs.append("Spawn außerhalb/am Rand der Nahkachel")
            c = int(round(sx / mpp + (t["resolution"] - 1) / 2))
            r = int(round(sz / mpp + (t["resolution"] - 1) / 2))
            if abs(h[r, c] - m["spawn"]["y"]) > 0.5:
                errs.append(f"Spawn-Höhe {h[r, c]:.2f} m != spawn.y {m['spawn']['y']}")
            ctr = h[(t["resolution"] - 1) // 2, (t["resolution"] - 1) // 2]
            if abs(ctr) > 0.01:
                errs.append(f"Kachelmitte {ctr:.3f} m != 0")
            for f in ("albedo", "normalMap", "splat"):
                if f in t:
                    fp = os.path.join(d, t[f])
                    if not os.path.exists(fp):
                        errs.append(f"fehlt: {t[f]}")
                        continue
                    s = Image.open(fp).size
                    print(f"    {t[f]}: {s[0]}x{s[1]}, {os.path.getsize(fp) / 1e6:.1f} MB")
                    if max(s) > 4096:
                        errs.append(f"{t[f]} > 4096")
    for lm in m.get("landmarks", []):
        fp = os.path.join(d, lm["file"])
        if not os.path.exists(fp):
            errs.append(f"Wahrzeichen fehlt: {lm['file']}")
            continue
        out = subprocess.run([sys.executable, CHECK_GLB, fp], capture_output=True, text=True).stdout
        line = [l for l in out.splitlines() if "BBox" in l or "Dreiecke gesamt" in l]
        print(f"  {lm['file']} @ ({lm['x']:.1f}, {lm['y']:.1f}, {lm['z']:.1f}), Kurs {lm['compassDeg']}°: "
              + " | ".join(l.strip() for l in line))
        import re
        mm = re.search(r"minY=(-?[0-9.]+)", out)
        if mm and float(mm.group(1)) < -1.0:      # bis 1 m eingegrabene Fundamente/Steine sind gewollt
            errs.append(f"{lm['file']}: Ursprung nicht unten (minY {mm.group(1)})")
    rk = m.get("rocks", {}).get("file")
    if rk and not os.path.exists(os.path.join(d, rk)) and not os.path.exists(os.path.join(W, "_shared", rk)):
        errs.append(f"Felsen-Set fehlt: {rk}")
    total = sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d))
    print(f"  Ordner gesamt: {total / 1e6:.1f} MB")
    return report(errs)


def report(errs):
    for e in errs:
        print(f"  !! {e}")
    if not errs:
        print("  OK")
    return errs


if __name__ == "__main__":
    sites = sys.argv[1:] or sorted(s for s in os.listdir(W) if os.path.isdir(os.path.join(W, s)) and not s.startswith("_"))
    bad = sum(bool(check(s)) for s in sites)
    print(f"\n{len(sites)} Orte, {bad} mit Fehlern")
    sys.exit(1 if bad else 0)
