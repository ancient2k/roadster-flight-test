"""Silhouette rasteriser for GLB files (no Blender): parses the GLB, applies node TRS, projects all
triangles with a reconstructed reference camera and fills them -> binary mask (1280x720).

Used for (a) the v2 baseline and v3 proof (always on the exported GLB) and (b) as the fitness core.
"""
import json, struct
import cv2
import numpy as np
from scipy.spatial.transform import Rotation

import calib as C

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def load_glb(path):
    b = open(path, "rb").read()
    jl = struct.unpack_from("<I", b, 12)[0]
    J = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack_from("<I", b, off)[0]
    BIN = b[off + 8: off + 8 + bl]

    def acc(i):
        a = J["accessors"][i]; bv = J["bufferViews"][a["bufferView"]]
        dt = CT[a["componentType"]]; n = NC[a["type"]]
        o = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride", 0)
        isz = np.dtype(dt).itemsize * n
        if stride and stride != isz:
            raw = np.frombuffer(BIN, np.uint8, a["count"] * stride, o).reshape(a["count"], stride)[:, :isz]
            return np.frombuffer(raw.tobytes(), dt).reshape(a["count"], n)
        return np.frombuffer(BIN, dt, a["count"] * n, o).reshape(a["count"], n)

    tris = []  # list of (name, (N,3,3) world triangles, material)
    def visit(i, M):
        nd = J["nodes"][i]
        T = np.eye(4)
        if "matrix" in nd:
            T = np.array(nd["matrix"]).reshape(4, 4).T
        else:
            t = nd.get("translation", [0, 0, 0]); r = nd.get("rotation", [0, 0, 0, 1]); s = nd.get("scale", [1, 1, 1])
            T[:3, :3] = Rotation.from_quat(r).as_matrix() @ np.diag(s); T[:3, 3] = t
        Mw = M @ T
        if "mesh" in nd:
            for p in J["meshes"][nd["mesh"]]["primitives"]:
                if p.get("mode", 4) != 4:
                    continue
                P = acc(p["attributes"]["POSITION"]).astype(float)
                idx = acc(p["indices"]).ravel() if "indices" in p else np.arange(len(P))
                Pw = P @ Mw[:3, :3].T + Mw[:3, 3]
                mat = J["materials"][p["material"]]["name"] if "material" in p else ""
                tris.append((nd.get("name", ""), Pw[idx.reshape(-1, 3)], mat))
        for c in nd.get("children", []):
            visit(c, Mw)
    for i in J["scenes"][J.get("scene", 0)]["nodes"]:
        visit(i, np.eye(4))
    return tris


def mask_from_tris(tris, cam, exclude=()):
    m = np.zeros((C.H, C.W), np.uint8)
    for name, T, mat in tris:
        if any(e in name for e in exclude):
            continue
        X = T.reshape(-1, 3)
        R = C.rodrigues(cam[1:4]); Xc = X @ R.T + cam[4:7]
        z = Xc[:, 2].reshape(-1, 3)
        ok = (z > 0.05).all(1)
        P = (cam[0] * Xc[:, :2] / np.maximum(Xc[:, 2:3], 1e-3) + [C.W / 2, C.H / 2]).reshape(-1, 3, 2)[ok]
        P = np.clip(P, -4000, 6000)
        # cull triangles fully outside the frame, then fill one by one (fillPoly with many contours
        # uses an even-odd rule and would punch holes where surfaces overlap)
        mn = P.min(1); mx = P.max(1)
        vis = (mx[:, 0] >= 0) & (mn[:, 0] < C.W) & (mx[:, 1] >= 0) & (mn[:, 1] < C.H)
        Q = np.int32(np.round(P[vis] * 4))
        for tri in Q:
            cv2.fillConvexPoly(m, tri, 255, lineType=cv2.LINE_8, shift=2)
    return m


def cam_vec(c):
    return np.array([c["f"]] + c["rvec"] + c["t"], float)
