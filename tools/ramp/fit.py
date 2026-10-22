"""Fit the wall-ramp profile and the stream cameras to the stream frames (R15).

  python3 tools/ramp/masks.py <video.mp4> <workdir>
  python3 tools/ramp/fit.py <workdir> [one|free] [restarts]

Residuals (soft-L1 least squares, several random restarts):
- silhouette edges: two-way chamfer distance between the projected ramp outline and the mask contour in the
  frames 700 s and 674 s (wide camera A) and 720 s (launch camera B);
- car at the ramp foot (674 s in A, 720 s in B), rear three-quarter view: rear width, visible side length and
  rear-centre pixel of a 1.94 m wide, 4.35 m long car (fixes each camera's scale and angle);
- car roof centroid in A at 14 HUD pitch readings (camera A is locked off from 688 to 710 s): the profile
  point with that tangent angle, 0.8 m out along the normal (170°: anywhere on the straight);
- HUD scale: the car hangs `u` metres onto the straight at a surface height of 21.95 m (69.1 ft settled
  altitude + CoG offset).
Model 'one': arc R from 0° to 170°, straight Ld (the HUD pitch rate is constant from the floor to 166°);
'free': three arcs (Ra to ta, Rb to tb, Rc to 170°) + straight. Cameras have no roll (the tower is vertical).
Result (R15): 'one' gives R 10.94 in every restart; the straight Ld sits in a flat valley (10–13 m, costs within
0.3 %; both cameras look along it), so the drone replay (753–755 s, 8–11 m in wheelbases) picks 10 m; width 4.0–4.4.
IoU ≈ 0.93 / 0.91 / 0.91. 'free' fits no better (cost 1159–1425 against 1248–1266).
"""
import json
import math
import os
import sys

import cv2
import numpy as np
from scipy.ndimage import map_coordinates
from scipy.optimize import least_squares

from ramp import D, H, W, Cam, at_theta, iou, render, sample

TC = 170.0
NOFF = 0.8          # roof-glass centroid above the surface [m]
HANG_Y = 21.95      # surface height at the hang point [m]
# (HUD pitch, x, y) of the car's roof centroid in camera A (676 s + k/2, frames 31–63)
CAR_PTS = [(169, 991, 334), (170, 989, 327), (170, 980, 313), (170, 1004, 351), (168, 1007, 355), (152, 1015, 433),
           (142, 1021, 458), (132, 1026, 483), (123, 1029, 509), (114, 1032, 536), (104, 1033, 563), (95.4, 1034, 590),
           (86.5, 1033, 617), (77.3, 1031, 643)]
HANG_PX = (980, 313)
# car at the ramp foot: rear width px, visible side length px, rear-centre x, bumper bottom y
FOOT = {'A': (44, 29, 950.6, 804), 'B': (46, 30, 986.9, 821)}
ZR, ZF, HW, YB = -3.57, 0.78, 0.97, 0.25


def prep(path, ybot):
    m = (cv2.imread(path, 0) > 127).astype(np.uint8)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cnts, key=len)[:, 0, :].astype(float)
    c = c[c[:, 1] < ybot]
    c = c[::max(1, len(c) // 400)]
    edge = np.full_like(m, 255)
    for p in c.astype(int):
        edge[p[1], p[0]] = 0
    return dict(m=m, c=c, dt=cv2.distanceTransform(edge, cv2.DIST_L2, 5), ybot=ybot)


def outline(segs, w, cam):
    P = sample(segs, 240)
    L = cam(np.stack([np.full(len(P), -w / 2), P[:, 1], P[:, 2]], 1))
    R = cam(np.stack([np.full(len(P), w / 2), P[:, 1], P[:, 2]], 1))
    t = np.linspace(0, 1, 25)[:, None]
    return np.vstack([L, R, L[-1] * (1 - t) + R[-1] * t])


def chamfer(segs, w, cam, V):
    M = outline(segs, w, cam)
    ok = M[:, 1] < V['ybot']
    r1 = map_coordinates(V['dt'], [np.clip(M[:, 1], 0, H - 1), np.clip(M[:, 0], 0, W - 1)], order=1, mode='nearest') * ok
    Mk = M[ok] if ok.sum() > 5 else M
    r2 = np.linalg.norm(V['c'][:, None, :] - Mk[None, :, :], axis=2).min(1)
    return np.concatenate([r1[::2], r2]) / 4


def profile(p, mode):
    if mode == 'one':
        return [('arc', abs(p[0]), 0, TC), ('line', abs(p[1]))]
    Ra, ta, Rb, tb, Rc, Ld = np.abs(p[:6])
    return [('arc', Ra, 0, ta), ('arc', Rb, ta, tb), ('arc', Rc, tb, TC), ('line', Ld)]


def split(x, mode):
    n = 4 if mode == 'one' else 8
    p = x[:n]
    w, u = p[-2], p[-1]
    A = Cam(np.r_[x[n:n + 5], 0, x[n + 5]])
    B = Cam(np.r_[x[n + 6:n + 11], 0, x[n + 11]])
    return profile(p, mode), w, u, A, B


def on_normal(row, n=NOFF):
    s, y, z, th = row
    return np.array([0, y + n * math.cos(th), z - n * math.sin(th)])


def foot_res(cam, m):
    P1, P2, P3 = cam(np.array([HW, YB, ZR])), cam(np.array([-HW, YB, ZR])), cam(np.array([-HW, YB, ZF]))
    rw, side, cx, by = m
    return [(P2[0] - P1[0] - rw) / 1.5, (P3[0] - P2[0] - side) / 1.5, ((P1[0] + P2[0]) / 2 - cx) / 4, ((P1[1] + P2[1]) / 2 - by) / 4]


def residuals(x, mode, V):
    segs, w, u, A, B = split(x, mode)
    out = [chamfer(segs, w, A, V['700.0']), 0.5 * chamfer(segs, w, A, V['674.0']), chamfer(segs, w, B, V['720.0'])]
    P = sample(segs, 900)
    Ld = segs[-1][1]
    top = P[P[:, 0] >= P[-1, 0] - Ld - 0.01]
    topi = A(np.array([on_normal(r) for r in top]))
    cr = []
    for th, cx, cy in CAR_PTS:
        if th >= 169.5:
            cr.append(np.linalg.norm(topi - [cx, cy], axis=1).min() / 2)
        else:
            cr.append(np.linalg.norm(A(on_normal(P[np.argmin(abs(P[:, 3] - th * D))])) - [cx, cy]) / 2)
    hang = P[np.argmin(abs(P[:, 0] - (P[-1, 0] - Ld + u)))]
    cr += list((A(on_normal(hang)) - HANG_PX) / 2)
    out += [cr, foot_res(A, FOOT['A']), foot_res(B, FOOT['B'])]
    pen = [(hang[1] - HANG_Y) / 0.1 * 3, max(0, 4 - w) * 30, max(0, w - 6) * 30, max(0, u + 2.4 - Ld) * 20, max(0, -u) * 20]
    if mode == 'free':
        pen += [max(0, x[1] - x[3]) * 10, max(0, x[3] - TC) * 10]
    out.append(pen)
    return np.concatenate([np.atleast_1d(np.asarray(o, float)) for o in out])


def report(x, mode, V):
    segs, w, u, A, B = split(x, mode)
    ious = []
    for k, cam in (('700.0', A), ('674.0', A), ('720.0', B)):
        r = render(segs, w, cam)
        m = V[k]['m'].copy()
        r[V[k]['ybot']:] = 0
        m[V[k]['ybot']:] = 0
        ious.append(round(float(iou(r, m)), 3))
    end = sample(segs, 400)[-1]
    return dict(segs=[(s[0],) + tuple(round(float(v), 2) for v in s[1:]) for s in segs], width=round(float(w), 2), hang_on_straight=round(float(u), 2),
                iou_700_674_720=ious, lip_end_y=round(float(end[1]), 2), lip_end_z=round(float(end[2]), 2),
                y90=round(float(at_theta(segs, 90)[1]), 2), camA=[round(float(v), 3) for v in x[-12:-6]], camB=[round(float(v), 3) for v in x[-6:]])


if __name__ == '__main__':
    wd = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else 'one'
    restarts = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    V = {t: prep(os.path.join(wd, f'm_{t}.png'), yb) for t, yb in (('700.0', 765), ('674.0', 770), ('720.0', 805))}
    rng = np.random.default_rng(1)
    cams = [-13, 5, -48, 17 * D, 7 * D, 1000, -16, 3, -58, 17 * D, 8 * D, 1500]
    best = None
    for k in range(restarts):
        p0 = [11, 8, 4.3, 1.5] if mode == 'one' else [3, rng.uniform(5, 60), 11, 120, 10, 8, 4.3, 1.5]
        x0 = np.array(p0 + cams, float)
        n = len(p0)
        x0[:2] *= rng.uniform(0.8, 1.3, 2)
        for o in (n, n + 6):
            x0[o:o + 3] += rng.normal(0, 5, 3)
            x0[o + 5] *= rng.uniform(0.8, 1.25)
        r = least_squares(residuals, x0, args=(mode, V), loss='soft_l1', f_scale=2, x_scale='jac', max_nfev=2500)
        print(k, 'cost', round(r.cost, 1), json.dumps(report(r.x, mode, V)))
        if best is None or r.cost < best.cost:
            best = r
    print('BEST', round(best.cost, 1), json.dumps(report(best.x, mode, V)))
