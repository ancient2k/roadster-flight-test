"""Annotation helper: crop a reference still and overlay a labelled pixel grid.

Usage: python3 tools/blender/v3/grid.py d_039 [x0 y0 x1 y1] [--step 20] [--scale 2] [--pts file.json key] -o out.png
Coordinates printed on the grid are ORIGINAL image pixels (1280x720), so points read off the
overlay can be pasted directly into refs.json.
"""
import argparse, json, os
import cv2
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("img"); ap.add_argument("box", nargs="*", type=int)
    ap.add_argument("--step", type=int, default=20); ap.add_argument("--scale", type=float, default=2)
    ap.add_argument("--poly", action="append", default=[], help="json file:key to draw (list of [x,y])")
    ap.add_argument("-o", required=True)
    a = ap.parse_args()
    im = cv2.imread(os.path.join(ROOT, "research/frames/design", a.img + ".jpg"))
    h, w = im.shape[:2]
    x0, y0, x1, y1 = a.box if a.box else (0, 0, w, h)
    s = a.scale
    crop = cv2.resize(im[y0:y1, x0:x1], None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    for spec in a.poly:
        f, k = spec.split(":")
        d = json.load(open(f))
        for kk in k.split(","):
            obj = d[a.img][kk] if a.img in d else d[kk]
            pts = obj if isinstance(obj[0], (list, tuple)) else [obj]
            P = np.array([[(p[0] - x0) * s, (p[1] - y0) * s] for p in pts], np.int32)
            cv2.polylines(crop, [P], kk.startswith("sil"), (0, 255, 255), 1, cv2.LINE_AA)
            for p in P: cv2.circle(crop, tuple(int(v) for v in p), 2, (0, 0, 255), -1)
    st = a.step
    for gx in range((x0 // st + 1) * st, x1, st):
        X = int((gx - x0) * s); major = gx % (st * 5) == 0
        cv2.line(crop, (X, 0), (X, crop.shape[0]), (0, 200, 0) if major else (0, 90, 0), 1)
        if major: cv2.putText(crop, str(gx), (X + 2, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 0), 1)
    for gy in range((y0 // st + 1) * st, y1, st):
        Y = int((gy - y0) * s); major = gy % (st * 5) == 0
        cv2.line(crop, (0, Y), (crop.shape[1], Y), (0, 200, 0) if major else (0, 90, 0), 1)
        if major: cv2.putText(crop, str(gy), (2, Y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 0), 1)
    cv2.imwrite(a.o, crop)

main()
