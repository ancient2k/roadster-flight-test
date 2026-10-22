"""Wall-ramp profile sampling and a pinhole camera (ramp-local frame: x across, y up, z along the run-up).

Mirrors sampleProfile() in src/shared/track.ts: a profile is a list of ('arc', R, fromDeg, toDeg) and
('line', L) segments, tangent angle 0 = flat, 90 = vertical, 170 = the overhang.
"""
import math

import cv2
import numpy as np

W, H = 1920, 1080
D = math.pi / 180


def seglen(s):
    return s[1] if s[0] == 'line' else s[1] * abs(s[3] - s[2]) * D


def sample(segs, n=160):
    """(s, y, z, theta) at n points along the profile."""
    L = sum(seglen(s) for s in segs)
    out = []
    for si in np.linspace(0, L, n):
        y = z = th = acc = 0.0
        for s in segs:
            ln = seglen(s)
            d = min(max(si - acc, 0), ln)
            if s[0] == 'line':
                y += math.sin(th) * d
                z += math.cos(th) * d
            else:
                t0 = s[2] * D
                t1 = t0 + d / s[1]
                z += s[1] * (math.sin(t1) - math.sin(t0))
                y += s[1] * (math.cos(t0) - math.cos(t1))
                th = t1
            acc += ln
            if si <= acc:
                break
        out.append((si, y, z, th))
    return np.array(out)


def at_theta(segs, deg):
    P = sample(segs, 900)
    return P[np.argmin(abs(P[:, 3] - deg * D))]


class Cam:
    """Pinhole camera: position, yaw (about +y, 0 = looking along +z), pitch, roll, focal length in px."""

    def __init__(self, c):
        cx, cy, cz, yaw, pitch, roll, f = c
        fw = np.array([math.sin(yaw) * math.cos(pitch), math.sin(pitch), math.cos(yaw) * math.cos(pitch)])
        r = np.cross(fw, [0, 1, 0])
        r /= np.linalg.norm(r)
        u = np.cross(r, fw)
        cr, sr = math.cos(roll), math.sin(roll)
        r, u = cr * r + sr * u, -sr * r + cr * u
        self.C, self.r, self.u, self.f, self.fl = np.array([cx, cy, cz]), r, u, fw, f

    def __call__(self, X):
        d = np.asarray(X, float) - self.C
        x, y, z = d @ self.r, d @ self.u, np.maximum(d @ self.f, 0.1)
        return np.stack([W / 2 + self.fl * x / z, H / 2 - self.fl * y / z], -1)


def render(segs, width, cam, sc=1.0):
    """Silhouette mask of the driving surface."""
    P = sample(segs)
    m = np.zeros((int(H * sc), int(W * sc)), np.uint8)
    Lp = cam(np.stack([np.full(len(P), -width / 2), P[:, 1], P[:, 2]], 1)) * sc
    Rp = cam(np.stack([np.full(len(P), width / 2), P[:, 1], P[:, 2]], 1)) * sc
    for i in range(len(P) - 1):
        q = np.array([Lp[i], Lp[i + 1], Rp[i + 1], Rp[i]])
        cv2.fillConvexPoly(m, np.round(q * 16).astype(np.int32), 1, cv2.LINE_8, 4)
    return m


def iou(a, b):
    return (a & b).sum() / max(1, (a | b).sum())
