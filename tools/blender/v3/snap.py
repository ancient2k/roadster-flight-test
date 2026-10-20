"""Edge snapping for hand-placed annotation points (rim ellipses, silhouette polylines).

Points placed by eye on a gridded crop are accurate to ~2-3 px; snapping moves each sample to the
strongest luminance edge along the local normal (search radius r px), which brings bright-on-dark
boundaries (white body, rim lip) to sub-pixel accuracy. Dark-on-dark boundaries do not snap
reliably; those polylines keep their hand-placed coordinates (flag "nosnap").
"""
import cv2
import numpy as np


def load_gray(path):
    im = cv2.imread(path).astype(np.float32) / 255.0
    g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    return cv2.GaussianBlur(g, (0, 0), 1.0)


def bilinear(img, x, y):
    return cv2.remap(img, np.float32(x).reshape(-1, 1), np.float32(y).reshape(-1, 1), cv2.INTER_LINEAR).ravel()


def resample(poly, step=3.0, closed=False):
    P = np.asarray(poly, float)
    if closed:
        P = np.vstack([P, P[:1]])
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(int(s[-1] / step), 2)
    t = np.linspace(0, s[-1], n, endpoint=not closed)
    return np.stack([np.interp(t, s, P[:, 0]), np.interp(t, s, P[:, 1])], 1)


def normals(P, closed=False):
    if closed:
        d = np.roll(P, -1, 0) - np.roll(P, 1, 0)
    else:
        d = np.gradient(P, axis=0)
    d /= np.linalg.norm(d, axis=1, keepdims=True) + 1e-9
    return np.stack([-d[:, 1], d[:, 0]], 1)


def snap(gray, P, closed=False, r=5.0, smooth=True):
    """Move samples to max |dI/dn| within +-r px along the normal. Returns snapped points."""
    N = normals(P, closed)
    offs = np.linspace(-r, r, int(4 * r) + 1)
    X = P[:, None, 0] + offs[None, :] * N[:, None, 0]
    Y = P[:, None, 1] + offs[None, :] * N[:, None, 1]
    I = bilinear(gray, X.ravel(), Y.ravel()).reshape(X.shape)
    G = np.abs(np.gradient(I, axis=1))
    G *= np.exp(-0.5 * (offs / (0.8 * r)) ** 2)[None, :]  # prefer near the hand-placed point
    k = np.argmax(G, axis=1)
    d = offs[k]
    if smooth and len(d) > 5:
        from scipy.ndimage import median_filter
        d = median_filter(d, size=5, mode="wrap" if closed else "nearest")
    return P + d[:, None] * N


def fit_ellipse_snapped(gray, pts, iters=3, r=4.0):
    """Hand points on an ellipse -> cv2 ellipse refined by edge snapping."""
    e = cv2.fitEllipse(np.float32(pts))
    for _ in range(iters):
        P = cv2.ellipse2Poly((int(e[0][0]), int(e[0][1])), (int(e[1][0] / 2), int(e[1][1] / 2)), int(e[2]), 0, 360, 4)
        P = ellipse_points(e, 120)
        Q = snap(gray, P, closed=True, r=r)
        e = cv2.fitEllipse(np.float32(Q))
    return e


def ellipse_points(e, n=120):
    (cx, cy), (w, h), ang = e
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    a = np.deg2rad(ang)
    x = 0.5 * w * np.cos(t); y = 0.5 * h * np.sin(t)
    return np.stack([cx + x * np.cos(a) - y * np.sin(a), cy + x * np.sin(a) + y * np.cos(a)], 1)
