"""Comparison board: photo | v2 | v3 rendered in the same reconstructed camera, with the photo
silhouette outline (yellow) on the renders and the silhouette IoU per model.

Usage: python3 board.py --v2 dir/r4_v2_ --v3 dir/r4_v3_ --iou iou.json -o out/renders/r4_compare.png [--tags v3,v31]
"""
import json, os, sys
import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
import iou as IO


def outline(img, mask, color=(0, 220, 255)):
    cnt, _ = cv2.findContours((mask == 255).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(img, cnt, -1, color, 1, cv2.LINE_AA)
    return img


def label(img, text, sub=None):
    cv2.rectangle(img, (0, 0), (img.shape[1], 26 if sub is None else 46), (0, 0, 0), -1)
    cv2.putText(img, text, (8, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    if sub:
        cv2.putText(img, sub, (8, 39), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (120, 230, 255), 1, cv2.LINE_AA)
    return img


def main():
    a = sys.argv[1:]
    p2 = a[a.index("--v2") + 1]; p3 = a[a.index("--v3") + 1]
    # --tags a,b: labels / IoU keys of the two models (default v2,v3; R7 uses v3,v31)
    t2, t3 = a[a.index("--tags") + 1].split(",") if "--tags" in a else ("v2", "v3")
    ious = json.load(open(a[a.index("--iou") + 1]))
    out = a[a.index("-o") + 1]
    w = int(a[a.index("--w") + 1]) if "--w" in a else 560
    h = w * 9 // 16
    rows = []
    for v in IO.VIEWS:
        ph = cv2.imread(os.path.join(ROOT, "research/frames/design", v + ".jpg"))
        m = cv2.imread(os.path.join(HERE, "masks", v + ".png"), 0)
        tiles = [label(cv2.resize(ph, (w, h)), f"Foto {v} ({IO.LABEL[v]})")]
        for tag, pref in ((t2, p2), (t3, p3)):
            r = cv2.imread(pref + v + ".png")
            if r is None:
                r = np.zeros_like(ph)
            r = outline(r, m)
            sub = f"Silhouetten-IoU {ious[tag][v]:.3f}" + (" (Front: Massstab je Modell ausgerichtet)" if v in IO.ALIGN else "")
            tiles.append(label(cv2.resize(r, (w, h)), f"Modell {tag.replace('v31', 'v3.1')}", sub))
        rows.append(np.hstack(tiles))
    cv2.imwrite(out, np.vstack(rows))
    print("wrote", out)


if __name__ == "__main__":
    main()
