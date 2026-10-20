"""Fast numpy/cv2 preview of the body surface (painter's algorithm, headlight Lambert + crease edges)
in a reconstructed reference camera, blended next to the photo. For shape iteration only; the
proof renders come from Blender (render_compare.py).
"""
import json, os, sys
import cv2
import numpy as np

import calib as C
import surface as S
import glbmask as G

HERE = C.HERE
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


def shade(tris_world, cam, img=None, base=(200, 200, 205), alpha=1.0, edges=False):
    """tris_world: (N,3,3). Draw into img (BGR) back-to-front."""
    if img is None:
        img = np.zeros((C.H, C.W, 3), np.uint8)
    R = C.rodrigues(cam[1:4]); t = cam[4:7]
    X = tris_world.reshape(-1, 3) @ R.T + t
    z = X[:, 2].reshape(-1, 3)
    ok = (z > 0.05).all(1)
    P = (cam[0] * X[:, :2] / np.maximum(X[:, 2:3], 1e-3) + [C.W / 2, C.H / 2]).reshape(-1, 3, 2)
    Tc = X.reshape(-1, 3, 3)
    n = np.cross(Tc[:, 1] - Tc[:, 0], Tc[:, 2] - Tc[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    vdir = Tc.mean(1); vdir /= np.linalg.norm(vdir, axis=1, keepdims=True)
    lam = np.abs((n * vdir).sum(1))
    key = np.array([0.3, -0.8, 0.5]); key /= np.linalg.norm(key)
    lam = 0.35 + 0.45 * lam + 0.25 * np.abs(n @ key)
    order = np.argsort(-z.mean(1))
    order = order[ok[order]]
    layer = img.copy()
    for i in order:
        c = tuple(int(min(255, b * lam[i])) for b in base)
        cv2.fillConvexPoly(layer, np.int32(np.round(P[i] * 4)), c, lineType=cv2.LINE_AA, shift=2)
    return cv2.addWeighted(layer, alpha, img, 1 - alpha, 0) if alpha < 1 else layer


def design_lines(spec, cam, img, per=4, color=(40, 40, 40)):
    """Overlay the cage rows (design lines) and station rings, hidden-line removal by depth test
    against a coarse z-buffer of the body."""
    b = S.Body(spec)
    G, U, V = b.grid(per_u=per, per_v=per)
    pp, side = b.profile_param(U)
    R = C.rodrigues(cam[1:4]); t = cam[4:7]
    X = G.reshape(-1, 3) @ R.T + t
    z = X[:, 2].reshape(G.shape[:2])
    P = (cam[0] * X[:, :2] / np.maximum(X[:, 2:3], 1e-3) + [C.W / 2, C.H / 2]).reshape(G.shape[:2] + (2,))
    # z-buffer from quads (min depth)
    zb = np.full((C.H // 2, C.W // 2), np.inf, np.float32)
    tris = body_tris(spec, per)
    Xt = tris.reshape(-1, 3) @ R.T + t
    Pt = (cam[0] * Xt[:, :2] / np.maximum(Xt[:, 2:3], 1e-3) + [C.W / 2, C.H / 2]).reshape(-1, 3, 2) / 2
    zt = Xt[:, 2].reshape(-1, 3).mean(1)
    for i in np.argsort(-zt):
        cv2.fillConvexPoly(zb, np.int32(Pt[i]), float(zt[i]))
    def vis(p, zz):
        x, y = int(p[0] / 2), int(p[1] / 2)
        if not (0 <= x < zb.shape[1] and 0 <= y < zb.shape[0]):
            return False
        return zz <= zb[y, x] + 0.04
    cols = [k for k in range(len(U)) if abs(pp[k] - round(pp[k])) < 1e-6]
    for k in cols:
        for a in range(G.shape[0] - 1):
            if vis(P[a, k], z[a, k]) and vis(P[a + 1, k], z[a + 1, k]):
                cv2.line(img, tuple(np.int32(P[a, k])), tuple(np.int32(P[a + 1, k])), color, 1, cv2.LINE_AA)
    rows = [a for a in range(len(V)) if abs(V[a] - round(V[a])) < 1e-6]
    for a in rows:
        for k in range(G.shape[1]):
            k2 = (k + 1) % G.shape[1]
            if vis(P[a, k], z[a, k]) and vis(P[a, k2], z[a, k2]):
                cv2.line(img, tuple(np.int32(P[a, k])), tuple(np.int32(P[a, k2])), (90, 60, 30), 1, cv2.LINE_AA)
    return img


def body_tris(spec, per=4):
    b = S.Body(spec)
    v, q, *_ = b.mesh(per_u=per, per_v=per)
    return np.concatenate([v[q[:, [0, 1, 2]]], v[q[:, [0, 2, 3]]]])


def wheel_tris(glb=os.path.join(ROOT, "public/assets/car/roadster.glb")):
    T = G.load_glb(glb)
    return np.concatenate([t for n, t, m in T if n.startswith("Wheel_") or n.startswith("Caliper_")])


if __name__ == "__main__":
    out = sys.argv[sys.argv.index("-o") + 1]
    spec = S.load_spec(sys.argv[sys.argv.index("--spec") + 1] if "--spec" in sys.argv else None)
    cj = json.load(open(os.path.join(HERE, "cameras.json")))
    views = [a for a in sys.argv[1:] if a.startswith("d_")]
    tris = np.concatenate([body_tris(spec), wheel_tris()])
    rows = []
    for v in views:
        cam = np.array(cj["cams"][v])
        ph = cv2.imread(os.path.join(ROOT, "research/frames/design", v + ".jpg"))
        r = shade(tris, cam)
        r = design_lines(spec, cam, r)
        m = cv2.imread(os.path.join(HERE, "masks", v + ".png"), 0)
        cnt, _ = cv2.findContours((m == 255).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(r, cnt, -1, (0, 200, 255), 1)
        if "--blend" in sys.argv:
            mm = (cv2.cvtColor(r, cv2.COLOR_BGR2GRAY) > 8)[..., None]
            bl = np.where(mm, (0.55 * r + 0.45 * ph).astype(np.uint8), ph)
            rows.append(np.hstack([cv2.resize(ph, (640, 360)), cv2.resize(bl, (640, 360))]))
        else:
            rows.append(np.hstack([cv2.resize(ph, (640, 360)), cv2.resize(r, (640, 360))]))
    cv2.imwrite(out, np.vstack(rows))
