"""Silhouette IoU of exported GLBs against the reference masks, in the reconstructed cameras.

IoU = |model & photo| / |model | photo| over pixels that are not marked "ignore" (people, frame-cut
dark undercarriage, ...). Wheels follow the photo's front steer angle (reconstructed per view).
Usage: python3 iou.py public/assets/car/roadster.glb [other.glb ...] [--png outdir]
"""
import json, os, sys
import cv2
import numpy as np

import calib as C
import glbmask as G

HERE = C.HERE
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
VIEWS = ["d_039", "d_033", "d_006", "d_007", "d_014", "d_021"]
LABEL = {"d_039": "Front", "d_033": "Heck", "d_006": "Heck-hoch", "d_007": "Heck-3/4", "d_014": "Seite-3/4", "d_021": "Seite"}


def steer_tris(tris, steer):
    """Rotate front wheel/caliper triangles about their hub's y axis by the photo's steer angle."""
    out = []
    for name, T, mat in tris:
        for wid in ("FL", "FR"):
            if name in (f"Wheel_{wid}", f"Caliper_{wid}") or name.startswith(f"Wheel_{wid}"):
                x, y, z, _, _ = C.WHEELS[wid]
                c, s = np.cos(steer), np.sin(steer)
                Rm = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
                T = (T - [x, y, z]) @ Rm.T + [x, y, z]
        out.append((name, T, mat))
    return out


# Views without a metric anchor (no wheel visible): the front still (tele lens, f ~ 2600 px) has only
# symmetric landmarks, so its camera distance is not determined. There every model gets its own best
# image similarity (scale + shift) before IoU, i.e. the number measures proportions, not size.
ALIGN = {"d_039"}


def align_mask(m, ref):
    from scipy.optimize import minimize
    ys, xs = np.nonzero(m)
    if len(xs) == 0:
        return m, (1, 0, 0)
    cx, cy = xs.mean(), ys.mean()

    def warp(p):
        s, tx, ty = p
        A = np.float32([[s, 0, (1 - s) * cx + tx], [0, s, (1 - s) * cy + ty]])
        return cv2.warpAffine(m, A, (m.shape[1], m.shape[0]), flags=cv2.INTER_NEAREST)
    best = None
    for s in np.linspace(0.85, 1.2, 8):
        for tx in (-30, 0, 30):
            for ty in (-30, 0, 30):
                v = iou(warp((s, tx, ty)), ref, raw=True)
                if best is None or v > best[0]:
                    best = (v, (s, tx, ty))
    r = minimize(lambda p: -iou(warp(p), ref, raw=True), best[1], method="Nelder-Mead",
                 options=dict(xatol=1e-3, fatol=1e-5, initial_simplex=np.array(best[1]) + np.array([[0, 0, 0], [0.02, 0, 0], [0, 6, 0], [0, 0, 6]])))
    p = r.x if -r.fun > best[0] else best[1]
    return warp(p), tuple(p)


def iou(model_mask, ref, raw=False):
    valid = ref != 128
    a = (model_mask > 0) & valid
    b = (ref == 255) & valid
    return (a & b).sum() / max((a | b).sum(), 1)


def evaluate(glb, views=VIEWS, pngdir=None, tag=None):
    cj = json.load(open(os.path.join(HERE, "cameras.json")))
    tris = G.load_glb(glb)
    res = {}
    evaluate.sims = {}
    for v in views:
        cam = np.array(cj["cams"][v], float)
        ref = cv2.imread(os.path.join(HERE, "masks", v + ".png"), cv2.IMREAD_GRAYSCALE)
        m = G.mask_from_tris(steer_tris(tris, cam[8]), cam)
        if v in ALIGN:
            ys, xs = np.nonzero(m)
            c = (float(xs.mean()), float(ys.mean())) if len(xs) else (C.W / 2, C.H / 2)
            m, p = align_mask(m, ref)
            evaluate.sims[v] = {"p": [float(x) for x in p], "c": list(c)}
        res[v] = iou(m, ref)
        if pngdir:
            im = cv2.imread(os.path.join(ROOT, "research/frames/design", v + ".jpg"))
            o = (im * 0.55).astype(np.uint8)
            valid = ref != 128
            fp = (m > 0) & (ref == 0); fn = (m == 0) & (ref == 255)
            o[fp & valid] = (0.4 * o[fp & valid] + [0, 0, 200]).astype(np.uint8)        # model only: red
            o[fn & valid] = (0.4 * o[fn & valid] + [200, 120, 0]).astype(np.uint8)      # photo only: blue
            cnt, _ = cv2.findContours((m > 0).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(o, cnt, -1, (0, 255, 255), 1)
            cv2.putText(o, f"{tag or os.path.basename(glb)} {LABEL[v]} ({v}) IoU {res[v]:.3f}", (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
            cv2.imwrite(os.path.join(pngdir, f"iou_{tag or 'm'}_{v}.jpg"), o)
    return res


if __name__ == "__main__":
    png = sys.argv[sys.argv.index("--png") + 1] if "--png" in sys.argv else None
    glbs = [a for a in sys.argv[1:] if a.endswith(".glb")]
    tags = sys.argv[sys.argv.index("--tags") + 1].split(",") if "--tags" in sys.argv else [os.path.splitext(os.path.basename(g))[0] for g in glbs]
    allr, sims = {}, {}
    for g, t in zip(glbs, tags):
        r = evaluate(g, pngdir=png, tag=t)
        allr[t] = r; sims[t] = dict(evaluate.sims)
        print(t, " ".join(f"{LABEL[v]}={r[v]:.4f}" for v in VIEWS), " mean=%.4f" % np.mean(list(r.values())))
    if "--json" in sys.argv:
        json.dump(allr, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1)
        for t in tags:
            json.dump(sims[t], open(sys.argv[sys.argv.index("--json") + 1].replace(".json", f"_sim_{t}.json"), "w"), indent=1)
