"""Reference silhouettes: hand polygon (refs.json "sil") refined by GrabCut inside a narrow band.

mask values: 255 car, 0 background, 128 ignore (refs.json "ignore" polygons + frame-cut regions).
Usage: python3 silhouette.py d_007 [...]  -> tools/blender/v3/masks/<view>.png (+ overlay in scratch)
"""
import json, os, sys
import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


def build(v, band=6, use_grabcut=True):
    refs = json.load(open(os.path.join(HERE, "refs.json")))
    R = refs[v]
    im = cv2.imread(os.path.join(ROOT, "research/frames/design", v + ".jpg"))
    h, w = im.shape[:2]
    poly = np.int32(np.round(np.asarray(R["sil"]) ))
    hand = np.zeros((h, w), np.uint8)
    cv2.fillPoly(hand, [poly], 255)
    out = hand.copy()
    if use_grabcut and R.get("grabcut", True):
        k = np.ones((2 * band + 1, 2 * band + 1), np.uint8)
        inner = cv2.erode(hand, k); outer = cv2.dilate(hand, k)
        gm = np.full((h, w), cv2.GC_BGD, np.uint8)
        gm[outer > 0] = cv2.GC_PR_BGD
        gm[hand > 0] = cv2.GC_PR_FGD
        gm[inner > 0] = cv2.GC_FGD
        bg = np.zeros((1, 65), np.float64); fg = np.zeros((1, 65), np.float64)
        cv2.grabCut(im, gm, None, bg, fg, 4, cv2.GC_INIT_WITH_MASK)
        gc = np.where((gm == cv2.GC_FGD) | (gm == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
        # only trust GrabCut where the hand polygon marks the boundary as snappable (default all)
        trust = np.zeros((h, w), np.uint8)
        for tp in R.get("grabcut_zones", [[[0, 0], [w, 0], [w, h], [0, h]]]):
            cv2.fillPoly(trust, [np.int32(tp)], 255)
        out = np.where(trust > 0, gc, hand).astype(np.uint8)
        out = cv2.morphologyEx(out, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    for ig in R.get("ignore", []):
        cv2.fillPoly(out, [np.int32(ig)], 128)
    for pl, wd in R.get("ignore_lines", []):
        cv2.polylines(out, [np.int32(pl)], False, 128, int(wd))
    return im, out


def overlay(im, m):
    o = im.copy()
    car = m == 255; ign = m == 128
    o[car] = (0.6 * o[car] + 0.4 * np.array([0, 0, 255])).astype(np.uint8)
    o[ign] = (0.5 * o[ign] + 0.5 * np.array([255, 0, 255])).astype(np.uint8)
    cnt, _ = cv2.findContours((m == 255).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(o, cnt, -1, (0, 255, 255), 1)
    return o


if __name__ == "__main__":
    os.makedirs(os.path.join(HERE, "masks"), exist_ok=True)
    outdir = sys.argv[sys.argv.index("-o") + 1] if "-o" in sys.argv else None
    views = [a for a in sys.argv[1:] if a.startswith("d_")]
    for v in views:
        im, m = build(v)
        cv2.imwrite(os.path.join(HERE, "masks", v + ".png"), m)
        if outdir:
            cv2.imwrite(os.path.join(outdir, f"sil_{v}.jpg"), overlay(im, m))
