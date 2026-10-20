"""Draw the reconstructed cameras' projections over the reference stills (calibration check).

Green: projected rim lip circles and tyre outer circles; red: annotated points; yellow: projected
landmarks (line to annotation). Usage: python3 overlay.py d_007 [more views] -o dir
"""
import json, os, sys
import cv2
import numpy as np
import calib as C

HERE = C.HERE
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


def cam_vec(c):
    return np.array(c, float)


def draw(v, out):
    refs = json.load(open(os.path.join(HERE, "refs.json")))
    cj = json.load(open(os.path.join(HERE, "cameras.json")))
    im = cv2.imread(os.path.join(ROOT, "research/frames/design", v + ".jpg"))
    cam = cam_vec(cj["cams"][v]); g = cj["g"]
    for wid, (x, y, z, rad, w) in C.WHEELS.items():
        for r, off, col in ((g[0] if wid[0] == "F" else g[1], g[2], (0, 255, 0)), (rad, w / 2, (255, 200, 0)), (rad, -w / 2, (255, 120, 0))):
            P = C.project(cam, C.rim_circle(wid, r, off, 180, cam[8]))
            cv2.polylines(im, [np.int32(P)], True, col, 1, cv2.LINE_AA)
    R = refs[v]
    for wid, pts in R.get("rim", {}).items():
        for q in pts:
            cv2.circle(im, (int(q[0]), int(q[1])), 2, (0, 0, 255), -1)
    for n, q in R.get("lm", {}).items():
        X = C.lm_point(cj["lm3"], n)
        P = C.project(cam, [X])[0]
        cv2.circle(im, (int(q[0]), int(q[1])), 3, (0, 0, 255), -1)
        cv2.line(im, (int(q[0]), int(q[1])), (int(P[0]), int(P[1])), (0, 255, 255), 1)
        cv2.circle(im, (int(P[0]), int(P[1])), 2, (0, 255, 255), -1)
    # floor grid in the reconstructed tile direction (should run parallel to the stage seams)
    th = cam[7]; a = np.array([np.cos(th), 0, np.sin(th)]); b = np.array([-np.sin(th), 0, np.cos(th)])
    Rm = C.rodrigues(cam[1:4])
    for k in np.arange(-6, 6.01, 1.0):
        for d1, d2 in ((a, b), (b, a)):
            X = np.array([k * d2 + s * d1 + [0, g[3], 0] for s in np.linspace(-8, 8, 400)])
            Xc = X @ Rm.T + cam[4:7]
            X = X[Xc[:, 2] > 0.3]
            if len(X) > 1:
                P = C.project(cam, X)
                cv2.polylines(im, [np.int32(np.clip(P, -5000, 5000))], False, (255, 0, 255), 1)
    for fam in ("floorA", "floorB"):
        for l in R.get(fam, []):
            cv2.polylines(im, [np.int32(l)], False, (0, 165, 255), 2)
    cv2.imwrite(out, im)


if __name__ == "__main__":
    o = sys.argv[sys.argv.index("-o") + 1]
    for v in sys.argv[1:sys.argv.index("-o")]:
        draw(v, os.path.join(o, f"ov_{v}.jpg"))
