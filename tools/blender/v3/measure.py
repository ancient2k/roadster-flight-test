"""Back-project annotated pixels of a calibrated still onto a plane (car frame) -> 3D design points.
Usage (module): bp(view, u, v, plane=("z", 2.2)) -> (x, y, z); heights printed above ground."""
import json, os
import numpy as np
import calib as C

CJ = json.load(open(os.path.join(C.HERE, "cameras.json")))


def ray(view, u, v):
    c = np.array(CJ["cams"][view], float)
    R = C.rodrigues(c[1:4]); t = c[4:7]
    d_cam = np.array([(u - C.W / 2) / c[0], (v - C.H / 2) / c[0], 1.0])
    o = -R.T @ t
    d = R.T @ d_cam
    return o, d / np.linalg.norm(d)


def bp(view, u, v, plane):
    ax, val = plane
    k = "xyz".index(ax)
    o, d = ray(view, u, v)
    s = (val - o[k]) / d[k]
    return o + s * d


if __name__ == "__main__":
    import sys
    v = sys.argv[1]; ax = sys.argv[2]; val = float(sys.argv[3])
    for p in sys.argv[4:]:
        u, w = map(float, p.split(","))
        X = bp(v, u, w, (ax, val))
        print(f"{p:>12} -> x {X[0]:+.3f}  yg {X[1] - C.GROUND_Y:.3f}  z {X[2]:+.3f}")
