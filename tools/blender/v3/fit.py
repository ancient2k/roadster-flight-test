"""Silhouette fit of the v3 body cage to the reference photos (Gauss-Newton "silhouette ICP").

Per iteration and view:
  1. evaluate the B-spline body (surface.py) on its dense grid, rasterise body + contract wheels;
  2. find contour-generator samples (grid edges between front- and back-facing quads) whose
     projection lies on the model's silhouette boundary;
  3. residual = signed distance of that projection to the photo silhouette (distance transform of
     the reference mask, + outside), ignored where the reference is marked "ignore";
  4. Jacobian = grad(SDF) . d(projection)/d(surface point) . d(surface point)/d(cage table)
     (B-spline basis weights are exact, the cage table is the parameter vector).
Regularisers: second differences along z per design line (fairness), closeness to the start shape,
fixed floor/underbody rows. Steps are accepted only if the mean IoU over all views improves.

Usage: python3 fit.py [--iters 12] [--views d_007,...] -> body_spec.json (table updated in place,
       previous version kept as body_spec.prev.json)
"""
import json, os, shutil, sys, time
import cv2
import numpy as np

import calib as C
import surface as S
import preview as PV

HERE = C.HERE
VIEWS = ["d_039", "d_033", "d_007", "d_014", "d_021", "d_006"]
# v2 baseline (iou.py on public/assets/car/roadster.glb, same cameras/masks); v3 must beat every view
V2_IOU = {"d_039": 0.9240, "d_033": 0.8722, "d_006": 0.8733, "d_007": 0.8973, "d_014": 0.9332, "d_021": 0.8693}
MARGIN = 0.01


class Model:
    def __init__(self, spec, per=4):
        self.spec = spec
        self.body = S.Body(spec)
        self.per = per
        ns, npf = self.body.ns, self.body.np_
        # parameter map over the cage table (x, yg) of non-collapsed stations
        self.idx = -np.ones((ns, npf, 2), int)
        k = 0
        fixed = set(tuple(x) for x in spec.get("fit_fixed", []))  # [station, profile, coord]
        for s in range(1, ns - 1):
            for j in range(npf):
                for c in range(2):
                    if c == 0 and j in (0, npf - 1):
                        continue
                    if (s, j, c) in fixed or (-1, j, c) in fixed:
                        continue
                    self.idx[s, j, c] = k; k += 1
        self.iz = -np.ones(ns, int)
        if spec.get("fit_z", True):
            for st in range(1, ns - 1):
                if st in spec.get("fit_z_fixed", []):
                    continue
                self.iz[st] = k; k += 1
        self.nparam = k
        self._prepare_basis()

    def _prepare_basis(self):
        b = self.body
        ring, umult = b.control_points()
        _, uid = S.expand(ring, umult, axis=1, closed=True)
        nu = len(uid)
        nvx = sum(b.smult) + 4
        su, tu = S.eval_curve_samples(nu, True, self.per)
        sv, tv = S.eval_curve_samples(nvx, False, self.per)
        self.Bu, self.Bv = S.basis(tu), S.basis(tv)
        self.iu = (su[:, None] + np.arange(4)[None]) % nu
        self.iv = sv[:, None] + np.arange(4)[None]
        _, vid = S.expand(np.zeros((b.ns, 1)), b.smult, axis=0, closed=False)
        self.vid_full = np.concatenate([[vid[0]] * 2, vid, [vid[-1]] * 2])
        self.uid = uid
        npf = b.np_
        r = uid[self.iu]                                   # (Nu,4) ring index
        self.uj = np.where(r <= npf - 1, r, 2 * (npf - 1) - r)
        self.us = np.where(r <= npf - 1, 1.0, -1.0)
        self.vs = self.vid_full[self.iv]                   # (Nv,4) station index

    def table(self):
        return np.array(self.spec["table"], float)

    def set_params(self, theta):
        T = self.table()
        m = self.idx >= 0
        T[m] = theta[self.idx[m]]
        for st in range(self.body.ns):
            if self.iz[st] >= 0:
                self.spec["stations"][st]["z"] = float(theta[self.iz[st]])
        self.spec["stations"][0]["z"] = self.spec["stations"][1]["z"]
        self.spec["stations"][-1]["z"] = self.spec["stations"][-2]["z"]
        self.body = S.Body(self.spec)
        T[..., 0] = np.minimum(T[..., 0], self.spec.get("x_max", 9.0))
        # collapsed end stations follow their rim stations (x -> 0)
        T[0, :, 1] = T[1, :, 1]; T[-1, :, 1] = T[-2, :, 1]
        T[0, :, 0] = 0; T[-1, :, 0] = 0
        self.spec["table"] = T.tolist()

    def get_params(self):
        T = self.table()
        th = np.zeros(self.nparam)
        m = self.idx >= 0
        th[self.idx[m]] = T[m]
        for st in range(self.body.ns):
            if self.iz[st] >= 0:
                th[self.iz[st]] = self.spec["stations"][st]["z"]
        return th

    def surface(self):
        S_, U, V = self.body.grid(self.spec["table"], self.per, self.per)
        return S_

    def jac_samples(self, a, b):
        """d(surface xyz)/d(theta) for samples (a: v index, b: u index): returns 3 dense (n, nparam)."""
        n = len(a)
        J = np.zeros((3, n, self.nparam))
        ns = self.body.ns
        for p in range(4):
            st = self.vs[a, p]
            collapsed = (st == 0) | (st == ns - 1)
            st_eff = np.where(st == 0, 1, np.where(st == ns - 1, ns - 2, st))
            for q in range(4):
                w = self.Bv[a, p] * self.Bu[b, q]
                j = self.uj[b, q]; sd = self.us[b, q]
                ix = self.idx[st_eff, j, 0]; iy = self.idx[st_eff, j, 1]
                okx = (ix >= 0) & ~collapsed
                np.add.at(J[0], (np.where(okx)[0], ix[okx]), (w * sd)[okx])
                oky = iy >= 0
                np.add.at(J[1], (np.where(oky)[0], iy[oky]), w[oky])
                izz = self.iz[st_eff]; okz = izz >= 0
                np.add.at(J[2], (np.where(okz)[0], izz[okz]), w[okz])
        return J


def zbasis(zs, nk=6, z0=-2.15, z1=2.35):
    """Cubic B-spline basis (clamped, nk functions) evaluated at station z values -> (ns, nk)."""
    from scipy.interpolate import BSpline
    deg = 3
    inner = np.linspace(z0, z1, nk - deg + 1)
    t = np.concatenate([[z0] * deg, inner, [z1] * deg])
    out = np.zeros((len(zs), nk))
    for k in range(nk):
        c = np.zeros(nk); c[k] = 1
        out[:, k] = BSpline(t, c, deg, extrapolate=True)(np.clip(zs, z0, z1))
    return out


def smooth_map(model, nk=6):
    """A: (nparam, nphi). Every (profile, coord) design line moves as a smooth function of z;
    station z parameters move individually (A has identity columns for them)."""
    zs = np.array([s["z"] for s in model.spec["stations"]], float)
    N = zbasis(zs, nk)
    cols = []
    for j in range(model.body.np_):
        for c in range(2):
            ids = model.idx[:, j, c]
            if (ids >= 0).sum() == 0:
                continue
            for k in range(nk):
                col = np.zeros(model.nparam)
                m = ids >= 0
                col[ids[m]] = N[m, k]
                cols.append(col)
    for st in range(model.body.ns):
        if model.iz[st] >= 0:
            col = np.zeros(model.nparam); col[model.iz[st]] = 1.0; cols.append(col)
    return np.array(cols).T


def load_views(views):
    cj = json.load(open(os.path.join(HERE, "cameras.json")))
    out = {}
    for v in views:
        ref = cv2.imread(os.path.join(HERE, "masks", v + ".png"), cv2.IMREAD_GRAYSCALE)
        inside = (ref == 255).astype(np.uint8)
        d_out = cv2.distanceTransform(1 - inside, cv2.DIST_L2, 5)
        d_in = cv2.distanceTransform(inside, cv2.DIST_L2, 5)
        sdf = d_out - d_in                                       # + outside the photo silhouette
        gy, gx = np.gradient(cv2.GaussianBlur(sdf, (0, 0), 1.0))
        out[v] = dict(cam=np.array(cj["cams"][v], float), ref=ref, sdf=sdf, gx=gx, gy=gy)
    return out


def bil(img, x, y):
    return cv2.remap(img.astype(np.float32), np.float32(x).reshape(-1, 1), np.float32(y).reshape(-1, 1),
                     cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).ravel()


def raster(tris, cam):
    import glbmask as G
    return G.mask_from_tris([("x", tris, "")], cam)


def quads_to_tris(Sg):
    nv, nu = Sg.shape[:2]
    a = Sg[:-1, :]; b = np.roll(Sg, -1, axis=1)[:-1, :]; c = np.roll(Sg, -1, axis=1)[1:, :]; d = Sg[1:, :]
    t1 = np.stack([a, b, c], 2).reshape(-1, 3, 3); t2 = np.stack([a, c, d], 2).reshape(-1, 3, 3)
    return np.concatenate([t1, t2])


def iou_view(mask, ref):
    valid = ref != 128
    A = (mask > 0) & valid; Bm = (ref == 255) & valid
    return (A & Bm).sum() / max((A | Bm).sum(), 1)


def sim_apply(m, sim):
    s, tx, ty = sim["p"]; cx, cy = sim["c"]
    A = np.float32([[s, 0, (1 - s) * cx + tx], [0, s, (1 - s) * cy + ty]])
    return cv2.warpAffine(m, A, (m.shape[1], m.shape[0]), flags=cv2.INTER_NEAREST)


def evaluate(model, V, wheels, realign=False):
    import iou as IO
    Sg = model.surface()
    tris = np.concatenate([quads_to_tris(Sg), wheels])
    out = {}
    for v, d in V.items():
        m = raster(tris, d["cam"])
        if v in IO.ALIGN:
            if realign or "sim" not in d:
                ys, xs = np.nonzero(m)
                _, p = IO.align_mask(m, d["ref"])
                d["sim"] = {"p": p, "c": (xs.mean(), ys.mean())}
            m = sim_apply(m, d["sim"])
        out[v] = iou_view(m, d["ref"])
    return out


def contour_rows(model, Sg, d, wheels, weight=1.0, clip=30.0):
    cam = d["cam"]
    R = C.rodrigues(cam[1:4]); t = cam[4:7]; f = cam[0]
    nv, nu = Sg.shape[:2]
    # quad normals and facing
    A = Sg[:-1]; Bq = np.roll(Sg, -1, 1)[:-1]; Cq = np.roll(Sg, -1, 1)[1:]; D = Sg[1:]
    n = np.cross(Cq - A, D - Bq)
    camc = -R.T @ t
    cen = (A + Bq + Cq + D) / 4
    facing = np.sign(((camc - cen) * n).sum(-1))                 # (nv-1, nu)
    # edges between front/back facing quads -> sample indices
    pts = set()
    fu = facing != np.roll(facing, -1, 1)                       # vertical grid edge between quad (i,j),(i,j+1): shared samples (i,j+1),(i+1,j+1)
    ii, jj = np.where(fu)
    for di in (0, 1):
        pts.update(zip(ii + di, (jj + 1) % nu))
    fv = facing[:-1] != facing[1:]                              # horizontal edge between quad rows i, i+1: samples (i+1, j), (i+1, j+1)
    ii, jj = np.where(fv)
    for dj in (0, 1):
        pts.update(zip(ii + 1, (jj + dj) % nu))
    if not pts:
        return None
    P = np.array(sorted(pts))
    a, b = P[:, 0], P[:, 1]
    X = Sg[a, b]
    Xc = X @ R.T + t
    z = Xc[:, 2]
    uv = f * Xc[:, :2] / z[:, None] + [C.W / 2, C.H / 2]
    ssc = 1.0
    if "sim" in d:
        ssc = d["sim"]["p"][0]
        uv = ssc * (uv - d["sim"]["c"]) + d["sim"]["c"] + d["sim"]["p"][1:]
    # keep samples on the model silhouette boundary
    tris = np.concatenate([quads_to_tris(Sg), wheels])
    m = raster(tris, cam)
    if "sim" in d:
        m = sim_apply(m, d["sim"])
    edge = cv2.morphologyEx(m, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    edge = cv2.dilate(edge, np.ones((5, 5), np.uint8))
    inb = (uv[:, 0] >= 0) & (uv[:, 0] < C.W) & (uv[:, 1] >= 0) & (uv[:, 1] < C.H)
    ui = np.clip(uv[:, 0].astype(int), 0, C.W - 1); vi = np.clip(uv[:, 1].astype(int), 0, C.H - 1)
    keep = inb & (edge[vi, ui] > 0) & (d["ref"][vi, ui] != 128) & (z > 0.3)
    if keep.sum() == 0:
        return None
    a, b, uv, Xc, z = a[keep], b[keep], uv[keep], Xc[keep], z[keep]
    r = bil(d["sdf"], uv[:, 0], uv[:, 1])
    g = np.stack([bil(d["gx"], uv[:, 0], uv[:, 1]), bil(d["gy"], uv[:, 0], uv[:, 1])], 1)
    g /= np.linalg.norm(g, axis=1, keepdims=True) + 1e-9
    r = np.clip(r, -clip, clip)
    # d(uv)/dX
    du = np.zeros((len(z), 2, 3))
    du[:, 0, 0] = f / z; du[:, 0, 2] = -f * Xc[:, 0] / z ** 2
    du[:, 1, 1] = f / z; du[:, 1, 2] = -f * Xc[:, 1] / z ** 2
    du = ssc * (du @ R)                                          # world
    gw = np.einsum("nk,nkc->nc", g, du)                          # (n,3) d r / dX
    J = model.jac_samples(a, b)                                  # (3, n, P)
    rows = np.einsum("nc,cnp->np", gw, J)
    return rows * weight, r * weight


def landmark_rows(model, Sg, lam=30.0):
    """3D landmarks from the reconstruction (cameras.json lm3) tied to the body.
    spec["landmarks"]: {name, type: "row" (surface point at cage station/profile) | "surf"
    (point-to-surface along the normal), station, profile, w}. Residual in metres * lam."""
    lms = model.spec.get("landmarks", [])
    if not lms:
        return None
    L3 = json.load(open(os.path.join(HERE, "cameras.json")))["lm3"]
    b = model.body
    Sg_, U, V = b.grid(model.spec["table"], model.per, model.per)
    pp, side = b.profile_param(U)
    rows, res = [], []
    nrm = None
    for lm in lms:
        if lm["name"] not in L3:
            continue
        X = np.array(L3[lm["name"]], float); X[0] = abs(X[0])
        X[0] = X[0] if lm.get("side", 1) > 0 else -X[0]
        w = lam * lm.get("w", 1.0)
        if lm["type"] == "row":
            a = int(np.argmin(np.abs(V - lm["station"])))
            cand = np.where(side > 0)[0]
            bidx = cand[int(np.argmin(np.abs(pp[cand] - lm["profile"])))]
            J = model.jac_samples(np.array([a]), np.array([bidx]))
            for c in range(3):
                if lm.get("axes", "xyz").find("xyz"[c]) < 0:
                    continue
                rows.append(J[c, 0] * w); res.append((Sg[a, bidx, c] - X[c]) * w)
        else:
            if nrm is None:
                du = np.roll(Sg, -1, 1) - np.roll(Sg, 1, 1)
                dv = np.gradient(Sg, axis=0)
                nrm = np.cross(dv, du); nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True) + 1e-12
            d = np.linalg.norm(Sg - X, axis=-1)
            a, bidx = np.unravel_index(np.argmin(d), d.shape)
            n = nrm[a, bidx]
            J = model.jac_samples(np.array([a]), np.array([bidx]))
            rows.append(np.einsum("c,cp->p", n, J[:, 0]) * w); res.append(n @ (Sg[a, bidx] - X) * w)
    return np.array(rows), np.array(res)


def smooth_rows(model, lam):
    """Second differences along z of every parameterised (profile, coord) row."""
    T = model.table(); z = np.array([s["z"] for s in model.spec["stations"]])
    rows, rhs = [], []
    ns = model.body.ns
    for j in range(model.body.np_):
        for c in range(2):
            for s in range(2, ns - 2):
                i0, i1, i2 = model.idx[s - 1, j, c], model.idx[s, j, c], model.idx[s + 1, j, c]
                if min(i0, i1, i2) < 0:
                    continue
                h0, h1 = z[s - 1] - z[s], z[s] - z[s + 1]
                if h0 < 1e-3 or h1 < 1e-3:
                    continue
                w = np.zeros(model.nparam)
                w[i0] = 1 / h0; w[i1] = -(1 / h0 + 1 / h1); w[i2] = 1 / h1
                w *= lam * min(h0, h1)
                val = w @ model.get_params()
                rows.append(w); rhs.append(val)
    return np.array(rows), np.array(rhs)


def main():
    args = sys.argv[1:]
    iters = int(args[args.index("--iters") + 1]) if "--iters" in args else 10
    views = args[args.index("--views") + 1].split(",") if "--views" in args else VIEWS
    lam_s = float(args[args.index("--smooth") + 1]) if "--smooth" in args else 0.6
    nk = int(args[args.index("--nk") + 1]) if "--nk" in args else 6
    spec_path = os.path.join(HERE, "body_spec.json")
    spec = S.load_spec(spec_path)
    model = Model(spec)
    V = load_views(views)
    wheels = PV.wheel_tris()
    th0 = model.get_params()

    def lm_rms():
        lr = landmark_rows(model, model.surface(), lam=1.0)
        return 0.0 if lr is None else float(np.sqrt(np.mean(lr[1] ** 2)))
    KAPPA = 0.5                                   # 1 cm landmark rms ~ 0.005 IoU
    hist = evaluate(model, V, wheels)
    best = np.mean(list(hist.values())) - KAPPA * lm_rms()
    print("start", " ".join(f"{v}:{x:.4f}" for v, x in hist.items()), "mean %.4f" % best, flush=True)
    mu = 1.0
    for it in range(iters):
        t0 = time.time()
        th = model.get_params()
        Sg = model.surface()
        # the front alignment is fixed once (start shape); re-aligning every iteration lets the
        # fit trade nose size against the free image scale
        Rs, rs = [], []
        for v, d in V.items():
            out = contour_rows(model, Sg, d, wheels)
            if out is None:
                continue
            # each view counts equally, weaker views (vs. v2 + margin) count more
            gap = max(0.0, V2_IOU.get(v, 0) + MARGIN - hist[v])
            w = 1.0 / np.sqrt(max(len(out[1]), 1)) * 20 * (1 + 40 * gap) / max(hist[v], 0.5) ** 2
            if v in ("d_039",):
                continue                                          # front: no metric anchor -> acceptance check only
            Rs.append(out[0] * w); rs.append(out[1] * w)
        lr = landmark_rows(model, Sg)
        if lr is not None:
            Rs.append(lr[0]); rs.append(lr[1])
        Js = np.concatenate(Rs); r = np.concatenate(rs)
        A = smooth_map(model, nk)
        Js = Js @ A
        # damping towards the start shape (metres -> treat 1 cm ~ 1 px), in the reduced space
        lam0 = 3.0
        dphi = np.linalg.lstsq(A, th - th0, rcond=None)[0]
        Jt = np.concatenate([Js, lam0 * np.eye(A.shape[1])])
        rt = np.concatenate([r, lam0 * dphi])
        accepted = False
        for tr in range(4):
            H = Jt.T @ Jt + mu * np.diag(np.diag(Jt.T @ Jt) + 1e-6)
            step = A @ (-np.linalg.solve(H, Jt.T @ rt))
            step = np.clip(step, -0.03, 0.03)
            model.set_params(th + step)
            sc = evaluate(model, V, wheels)
            m = np.mean(list(sc.values())) - KAPPA * lm_rms()
            floor_ok = all(sc[v] >= min(hist[v], V2_IOU.get(v, 0) + MARGIN) - 1e-4 for v in sc)
            if m > best and floor_ok:
                best, hist = m, sc
                mu = max(mu * 0.5, 1e-3)
                accepted = True
                break
            model.set_params(th)
            mu *= 4
        print(f"it {it}: {'ok ' if accepted else 'rej'} score {best:.4f} lm_rms {lm_rms()*100:.1f}cm " +
              " ".join(f"{v}:{x:.4f}" for v, x in hist.items()) + f"  ({time.time() - t0:.1f}s, mu {mu:.3g})", flush=True)
        if not accepted and mu > 1e3:
            break
    shutil.copy(spec_path, spec_path.replace(".json", ".prev.json"))
    json.dump(model.spec, open(spec_path, "w"), indent=1)
    print("saved", spec_path)


if __name__ == "__main__":
    main()
