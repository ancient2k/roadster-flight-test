"""Reference reconstruction: joint bundle adjustment of reference-still cameras and design landmarks.

Known 3D anchors are ONLY contract quantities: wheel centres (ROADSTER.wheels), their spin axis,
the ground plane under the tyres, plus the stage floor (two orthogonal families of tile seams lie
in the ground plane -> vanishing points fix camera tilt/roll/focal). Rim lip radius/offset, front
steer angle, the floor grid direction and every body landmark are unknowns, so no v2 geometry
leaks into the cameras. Landmarks named *_L / *_R share one 3D point mirrored in x (car
symmetry); *_C lie on the centreline (x = 0).

Camera: pinhole, principal point = image centre, square pixels, no distortion.
World = car frame (x left, y up, z forward, origin dry CoG). OpenCV camera (x right, y down, z fwd).

Usage: python3 tools/blender/v3/calib.py [--fresh] -> tools/blender/v3/cameras.json
"""
import json, os, sys
import cv2
import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1280, 720
WHEELS = {"FL": (0.85, -0.095, 1.40, 0.345, 0.295), "FR": (-0.85, -0.095, 1.40, 0.345, 0.295),
          "RL": (0.86, -0.085, -1.25, 0.355, 0.345), "RR": (-0.86, -0.085, -1.25, 0.355, 0.345)}
GROUND_Y = -0.44
NV = 9   # per view: f, rvec(3), t(3), floor angle, front steer
NG = 4   # global: rim r front, rim r rear, rim face offset, ground y
SIG = {"rim": 1.5, "ground": 10.0, "lm": 2.0, "floor": 1.5}


def rodrigues(r):
    return cv2.Rodrigues(np.asarray(r, float))[0]


def project(cam, X):
    f = cam[0]; R = rodrigues(cam[1:4]); t = cam[4:7]
    Xc = (np.asarray(X, float).reshape(-1, 3) @ R.T) + t
    z = np.maximum(Xc[:, 2], 1e-3)
    return np.stack([f * Xc[:, 0] / z + W / 2, f * Xc[:, 1] / z + H / 2], 1)


def rim_circle(wid, r, off, n=180, steer=0.0):
    x, y, z, _, _ = WHEELS[wid]
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    P = np.stack([np.full(n, np.sign(x) * off), r * np.cos(a), r * np.sin(a)], 1)
    if wid[0] == "F" and steer:
        c, s = np.cos(steer), np.sin(steer)
        P = P @ np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]).T
    return P + [x, y, z]


def lm_key(name):
    if name.endswith("_L") or name.endswith("_R"):
        return name[:-2], (1 if name.endswith("_L") else -1)
    if name.endswith("_C"):
        return name[:-2], 0
    return name, 0


def lm_point(L, name):
    b, s = lm_key(name)
    X = np.array(L[b], float)
    X[0] = 0.0 if s == 0 else s * abs(X[0])
    return X


class Problem:
    def __init__(self, refs, views, lms=None):
        self.refs, self.views = refs, views
        self.nv = len(views)
        if lms is None:
            lms = sorted({lm_key(n)[0] for v in views for n in refs[v].get("lm", {})})
        self.lms = lms
        self.prepare()

    @property
    def npar(self):
        return NV * self.nv + NG + 3 * len(self.lms)

    def split(self, p):
        cams = p[:NV * self.nv].reshape(self.nv, NV)
        g = p[NV * self.nv:NV * self.nv + NG]
        L = p[NV * self.nv + NG:].reshape(-1, 3)
        return cams, g, L

    def prepare(self):
        self.obs = []
        rows = []
        gc = list(range(NV * self.nv, NV * self.nv + NG))
        for vi, v in enumerate(self.views):
            R = self.refs[v]
            cc = list(range(NV * vi, NV * vi + NV))
            rims = [(wid, np.asarray(pts, float)) for wid, pts in R.get("rim", {}).items()]
            gr = [(wid, np.asarray(q, float)) for wid, q in R.get("ground", {}).items()]
            names = [n for n in R.get("lm", {}) if lm_key(n)[0] in self.lms]
            idx = np.array([self.lms.index(lm_key(n)[0]) for n in names], int)
            sgn = np.array([lm_key(n)[1] for n in names], float)
            q = np.asarray([R["lm"][n] for n in names], float).reshape(-1, 2)
            wts = np.array([R.get("lm_w", {}).get(n, 1.0) for n in names], float)
            fp = R.get("f_prior")
            fl = [(0, np.asarray(l, float)) for l in R.get("floorA", [])] + [(1, np.asarray(l, float)) for l in R.get("floorB", [])]
            self.obs.append((rims, gr, names, idx, sgn, q, fl, wts, fp))
            for wid, pts in rims:
                rows += [cc + gc] * len(pts)
            rows += [cc + gc] * (2 * len(gr))
            for i in idx:
                rows += [cc + list(range(NV * self.nv + NG + 3 * i, NV * self.nv + NG + 3 * i + 3))] * 2
            for fam, l in fl:
                rows += [cc] * len(l)
            rows.append(cc)  # roll prior
            rows.append(cc)  # steer prior
            rows.append(cc)  # focal prior
        rows.append([gc[2]]); rows.append([gc[3]]); rows.append([gc[0]]); rows.append([gc[1]])
        S = lil_matrix((len(rows), self.npar), dtype=int)
        for r, cols in enumerate(rows):
            S[r, cols] = 1
        self.sparsity = S

    def residuals(self, p, detail=False):
        cams, g, LA = self.split(p)
        res, info = [], []
        for vi, v in enumerate(self.views):
            cam = cams[vi]
            rims, gr, names, idx, sgn, q, fl, wts, fp = self.obs[vi]
            for wid, pts in rims:
                r = g[0] if wid[0] == "F" else g[1]
                C = project(cam, rim_circle(wid, r, g[2], 180, cam[8]))
                d = np.sqrt(np.min(((pts[:, None, :] - C[None]) ** 2).sum(-1), axis=1))
                res.append(d / SIG["rim"]); info += [(v, "rim_" + wid, x) for x in d]
            for wid, qq in gr:
                x, y, z, rad, _ = WHEELS[wid]
                P = project(cam, [[x, g[3], z]])[0]
                res.append((P - qq) / SIG["ground"]); info += [(v, "ground_" + wid, np.linalg.norm(P - qq))] * 2
            if len(names):
                X = LA[idx].copy()
                X[:, 0] = np.where(sgn == 0, 0.0, sgn * np.abs(X[:, 0]))
                P = project(cam, X)
                res.append(((P - q) * wts[:, None] / SIG["lm"]).ravel())
                for n, x in zip(names, np.linalg.norm(P - q, axis=1)):
                    info += [(v, n, x)] * 2
            if fl:
                Rm = rodrigues(cam[1:4]); K = np.array([[cam[0], 0, W / 2], [0, cam[0], H / 2], [0, 0, 1]])
                th = cam[7]
                dirs = [np.array([np.cos(th), 0, np.sin(th)]), np.array([-np.sin(th), 0, np.cos(th)])]
                for fam, l in fl:
                    vp = K @ (Rm @ dirs[fam])
                    c = np.array([l[:, 0].mean(), l[:, 1].mean(), 1.0])
                    ln = np.cross(vp, c); ln /= np.hypot(ln[0], ln[1]) + 1e-12
                    d = np.c_[l, np.ones(len(l))] @ ln
                    res.append(d / SIG["floor"]); info += [(v, "floor%d" % fam, abs(x)) for x in d]
            Rm = rodrigues(cam[1:4])
            res.append(np.array([Rm[0, 1] / 0.08])); info.append((v, "roll", Rm[0, 1]))
            res.append(np.array([cam[8] / 0.25])); info.append((v, "steer", cam[8]))
            res.append(np.array([(cam[0] - fp[0]) / fp[1] if fp else 0.0])); info.append((v, "steer", 0))
        res.append(np.array([(g[2] - 0.15) / 0.02])); info.append(("g", "rim_off", g[2]))
        res.append(np.array([(g[3] - GROUND_Y) / 0.005])); info.append(("g", "ground", g[3]))
        res.append(np.array([(g[0] - 0.27) / 0.05])); info.append(("g", "rf", g[0]))
        res.append(np.array([(g[1] - 0.28) / 0.05])); info.append(("g", "rr", g[1]))
        r = np.concatenate(res)
        return (r, info) if detail else r

    def solve(self, p0, mask=None, nfev=300):
        """mask: boolean array of free parameters."""
        if mask is None:
            mask = np.ones(len(p0), bool)
        p0 = np.asarray(p0, float).copy()

        def f(x):
            p = p0.copy(); p[mask] = x
            return self.residuals(p)
        S = self.sparsity[:, np.where(mask)[0]]
        s = least_squares(f, p0[mask], loss="soft_l1", f_scale=2.0, max_nfev=nfev, x_scale="jac", jac_sparsity=S)
        p = p0.copy(); p[mask] = s.x
        return p, s.cost


def init_from_wheels(refs, v, f):
    R = refs[v]
    obj, img = [], []
    for wid, pts in R.get("rim", {}).items():
        x, y, z, rad, _ = WHEELS[wid]
        P = np.asarray(pts)
        e = cv2.fitEllipse(np.float32(P)) if len(P) >= 5 else (tuple(P.mean(0)),)
        obj.append([x + np.sign(x) * 0.12, y, z]); img.append(e[0])
        obj.append([x + np.sign(x) * 0.12, y + 0.27, z]); img.append(P[np.argmin(P[:, 1])])
        obj.append([x + np.sign(x) * 0.12, y - 0.27, z]); img.append(P[np.argmax(P[:, 1])])
    for wid, q in R.get("ground", {}).items():
        x, y, z, rad, _ = WHEELS[wid]
        obj.append([x, GROUND_Y, z]); img.append(q)
    K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]], float)
    ok, rv, tv = cv2.solvePnP(np.float64(obj), np.float64(img), K, None, flags=cv2.SOLVEPNP_SQPNP)
    return np.concatenate([[f], rv.ravel(), tv.ravel(), [0.0, 0.0]])


def look_cam(pos, target, f):
    """OpenCV camera at pos looking at target (world y up, no roll)."""
    pos = np.asarray(pos, float); fwd = np.asarray(target, float) - pos; fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    Rm = np.stack([right, down, fwd])  # world -> camera rows
    rv = cv2.Rodrigues(Rm)[0].ravel()
    return np.concatenate([[f], rv, -Rm @ pos, [0.0, 0.0]])


def init_from_landmarks(refs, v, L3):
    R = refs[v]
    if "cam_init" in R:
        c = R["cam_init"]
        return look_cam(c["pos"], c["target"], c["f"])
    names = [n for n in R["lm"] if lm_key(n)[0] in L3]
    obj = [lm_point(L3, n) for n in names]; img = [R["lm"][n] for n in names]
    best = None
    for f in [700, 900, 1200, 1600, 2000, 2600, 3400, 4500]:
        K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]], float)
        ok, rv, tv = cv2.solvePnP(np.float64(obj), np.float64(img), K, None, flags=cv2.SOLVEPNP_SQPNP)
        pr, _ = cv2.projectPoints(np.float64(obj), rv, tv, K, None)
        e = np.sum((pr.reshape(-1, 2) - np.asarray(img)) ** 2)
        if best is None or e < best[0]:
            best = (e, np.concatenate([[f], rv.ravel(), tv.ravel(), [0.0, 0.0]]))
    return best[1]


def triangulate(refs, views, cams, g, lms):
    """Landmarks only, cameras fixed (stage 2)."""
    pr = Problem(refs, views, lms)
    p = np.concatenate([np.concatenate(cams), g, np.tile([0.6, 0.2, 0.0], (len(lms), 1)).ravel()])
    pr.prepare()
    best = None
    # multi-start depth: a few initial guesses per landmark block, keep the best joint solution
    for init in ([0.6, 0.3, -1.0], [0.8, 0.3, 1.0]):
        p[NV * len(views) + NG:] = np.tile(init, len(lms))
        mask = np.zeros(len(p), bool); mask[NV * len(views) + NG:] = True
        q, c = pr.solve(p, mask, nfev=200)
        if best is None or c < best[1]:
            best = (q, c)
    return best[0][NV * len(views) + NG:].reshape(-1, 3)


def report(prob, p):
    r, info = prob.residuals(p, detail=True)
    cams, g, LA = prob.split(p)
    print("rim r front/rear %.3f/%.3f  offset %.3f  ground %.3f" % tuple(g))
    for vi, v in enumerate(prob.views):
        c = cams[vi]; Rm = rodrigues(c[1:4]); C = -Rm.T @ c[4:7]
        uniq = {}
        for vv, n, d in info:
            if vv == v and n not in ("roll", "steer"):
                uniq.setdefault(n.split("_")[0] if n.startswith(("rim", "floor")) else n, []).append(d)
        print(f"{v}: f={c[0]:.0f}px cam=({C[0]:.2f},{C[1]:.2f},{C[2]:.2f}) floor={np.degrees(c[7]):.1f} steer={np.degrees(c[8]):.1f}  " +
              " ".join(f"{n}:{np.sqrt(np.mean(np.square(d))):.1f}" for n, d in uniq.items()))
    for i, n in enumerate(prob.lms):
        print(f"  {n:14s} {np.round(LA[i], 3)}")


def main():
    refs = json.load(open(os.path.join(HERE, "refs.json")))
    pc = os.path.join(HERE, "cameras.json")
    prev = json.load(open(pc)) if (os.path.exists(pc) and "--fresh" not in sys.argv) else {}
    views = [v for v in refs if v.startswith("d_")]
    wheel_views = [v for v in views if refs[v].get("rim")]
    g = np.array(prev.get("g", [0.27, 0.28, 0.12, GROUND_Y]))
    cams = {}
    for v in views:
        if v in prev.get("cams", {}):
            cams[v] = np.array(prev["cams"][v], float)
    # stage 1: each wheel view alone (rims + ground + floor), multi-start over focal length
    for v in wheel_views:
        if v in cams:
            continue
        pr = Problem(refs, [v], [])
        best = None
        for f in [900, 1500, 2500]:
            for th in (0.4, -0.4):
                c = init_from_wheels(refs, v, f); c[7] = th
                p, cost = pr.solve(np.concatenate([c, g]), nfev=80)
                if best is None or cost < best[1]:
                    best = (p, cost)
        cams[v] = best[0][:NV]
        print("stage1", v, "cost %.1f f %.0f" % (best[1], cams[v][0]), flush=True)
    # stage 2: landmarks seen in >= 2 calibrated views
    known = [v for v in views if v in cams]
    cnt = {}
    for v in known:
        for n in refs[v].get("lm", {}):
            cnt[lm_key(n)[0]] = cnt.get(lm_key(n)[0], 0) + 1
    L3 = dict(prev.get("lm3", {}))
    lms = sorted(k for k, c in cnt.items() if c >= 2 and k not in L3)
    if lms:
        X = triangulate(refs, known, [cams[v] for v in known], g, lms)
        L3.update({n: list(X[i]) for i, n in enumerate(lms)})
    # stage 3: views without wheels from landmark PnP
    for v in views:
        if v not in cams:
            c0 = init_from_landmarks(refs, v, L3)
            fp = refs[v].get("f_prior")
            if fp:
                c0[0] = fp[0]
            # refine this camera alone against the triangulated landmarks (landmarks fixed)
            lm_v = sorted(n for n in L3 if any(lm_key(k)[0] == n for k in refs[v]["lm"]))
            pr = Problem(refs, [v], lm_v)
            p = np.concatenate([c0, g, np.concatenate([L3[n] for n in lm_v])]) if lm_v else np.concatenate([c0, g])
            mask = np.zeros(len(p), bool); mask[:7] = True
            p, _ = pr.solve(p, mask, nfev=200)
            cams[v] = p[:NV]
            print("stage3", v, "f %.0f" % cams[v][0], flush=True)
    # stage 4: joint
    lms_all = sorted({lm_key(n)[0] for v in views for n in refs[v].get("lm", {})})
    prob = Problem(refs, views, lms_all)
    p0 = np.concatenate([np.concatenate([cams[v] for v in views]), g,
                         np.concatenate([L3.get(n, [0.6, 0.2, 0.0]) for n in lms_all])])
    p, cost = prob.solve(p0, nfev=500)
    report(prob, p)
    cs, g, LA = prob.split(p)
    out = {"cams": {v: list(map(float, cs[i])) for i, v in enumerate(views)}, "g": list(map(float, g)),
           "lm3": {n: list(map(float, LA[i])) for i, n in enumerate(lms_all)},
           "_doc": "cams[view] = [f_px, rvec(3), t(3), floor_angle, front_steer]; g = [rim_r_front, rim_r_rear, rim_offset, ground_y]"}
    json.dump(out, open(pc, "w"), indent=1)


if __name__ == "__main__":
    main()
