"""asset pipeline Welten: Kartenprojektionen und Resampling für DTM-/Orthobild-Ausschnitte.

Lokales Spielkoordinatensystem je Ort (siehe docs/RENDERING.md):
  +X = Ost, +Y = oben, -Z = Nord (three.js-Konvention), Ursprung = Kachelmitte, y = 0 am Spawn-Boden.
  Bildzeile 0 = Nordrand (z = -size/2), Spalte 0 = Westrand (x = -size/2).
Kleine Kacheln (<= 50 km): lokale Tangentialebene, lat = lat0 + n/R, lon = lon0 + e/(R cos lat0).
"""
from __future__ import annotations

import math

import numpy as np


class Proj:
    """Vorwärtsprojektion lat/lon (Grad) -> Pixel (col, row) eines Rasters, aus GeoTIFF-GeoKeys oder PDS3-Label."""

    def __init__(self, kind: str, R: float, scale: tuple[float, float], tie: tuple[float, float],
                 clon: float = 0.0, clat_ts: float = 0.0, south: bool = False, plat: float = 90.0):
        self.kind, self.R, self.scale, self.tie = kind, R, scale, tie
        self.clon, self.clat_ts, self.south = clon, clat_ts, south

    @classmethod
    def from_tiff(cls, tiff) -> "Proj":
        g = tiff.tf.geotiff_metadata
        sx, sy = g["ModelPixelScale"][:2]
        tx, ty = g["ModelTiepoint"][3:5]
        R = g.get("GeogSemiMajorAxisGeoKey", 6378137.0)
        mt = str(g.get("GTModelTypeGeoKey"))
        if "Geographic" in mt:
            return cls("geographic", R, (sx, sy), (tx, ty))
        ct = str(g.get("ProjCoordTransGeoKey"))
        if "Equirectangular" in ct:
            return cls("eqc", R, (sx, sy), (tx, ty), g.get("ProjCenterLongGeoKey", 0.0), g.get("ProjStdParallel1GeoKey", 0.0))
        if "Orthographic" in ct:
            o = cls("ortho", R, (sx, sy), (tx, ty), g.get("ProjCenterLongGeoKey", 0.0))
            o.clat = g.get("ProjCenterLatGeoKey", 0.0)
            return o
        if "Polar" in ct or "Stereographic" in ct:
            lat0 = g.get("ProjNatOriginLatGeoKey", g.get("ProjCenterLatGeoKey", -90.0))
            lon0 = g.get("ProjStraightVertPoleLongGeoKey", g.get("ProjCenterLongGeoKey", g.get("ProjNatOriginLongGeoKey", 0.0)))
            return cls("polar", R, (sx, sy), (tx, ty), lon0, south=lat0 < 0)
        raise ValueError(f"Projektion nicht unterstützt: {ct} / {mt}")

    def xy(self, lat, lon):
        """lat/lon (Grad, Arrays) -> projizierte Meter (bzw. Grad bei geographic)."""
        lat = np.asarray(lat, np.float64)
        lon = np.asarray(lon, np.float64)
        if self.kind == "geographic":
            return lon, lat
        if self.kind == "eqc":
            dl = (lon - self.clon + 180.0) % 360.0 - 180.0
            return self.R * np.radians(dl) * math.cos(math.radians(self.clat_ts)), self.R * np.radians(lat)
        if self.kind == "ortho":
            la, lo, la0 = np.radians(lat), np.radians(lon - self.clon), math.radians(self.clat)
            return (self.R * np.cos(la) * np.sin(lo),
                    self.R * (math.cos(la0) * np.sin(la) - math.sin(la0) * np.cos(la) * np.cos(lo)))
        # polare stereographische Projektion (Kugel)
        la, lo = np.radians(lat), np.radians(lon - self.clon)
        if self.south:
            rho = 2 * self.R * np.tan(np.pi / 4 + la / 2)
            return rho * np.sin(lo), rho * np.cos(lo)
        rho = 2 * self.R * np.tan(np.pi / 4 - la / 2)
        return rho * np.sin(lo), -rho * np.cos(lo)

    def pix(self, lat, lon):
        x, y = self.xy(lat, lon)
        return (x - self.tie[0]) / self.scale[0] - 0.5, (self.tie[1] - y) / self.scale[1] - 0.5


def _frame(lat0, lon0):
    la, lo = math.radians(lat0), math.radians(lon0)
    c = np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])
    e = np.array([-math.sin(lo), math.cos(lo), 0.0])
    n = np.cross(c, e)
    return c, e, n


def enu_to_latlon(lat0, lon0, R, east, north):
    """Exakt (Kugel): Punkt in Entfernung/Richtung (east, north) entlang der Oberfläche vom Ursprung (lat0, lon0)
    -> lat/lon. Gilt auch an den Polen (Shackleton)."""
    c, e, n = _frame(lat0, lon0)
    east, north = np.asarray(east, np.float64), np.asarray(north, np.float64)
    d = np.hypot(east, north)
    ang = d / R
    with np.errstate(invalid="ignore", divide="ignore"):
        ue = np.where(d > 0, east / d, 0.0)
        un = np.where(d > 0, north / d, 0.0)
    v = (np.cos(ang)[..., None] * c + np.sin(ang)[..., None] * (ue[..., None] * e + un[..., None] * n))
    lat = np.degrees(np.arcsin(np.clip(v[..., 2], -1, 1)))
    lon = np.degrees(np.arctan2(v[..., 1], v[..., 0]))
    return lat, lon


def latlon_to_enu(lat0, lon0, R, lat, lon):
    """Umkehrung (azimutal äquidistant): lat/lon -> (east, north) in m relativ zu (lat0, lon0)."""
    c, e, n = _frame(lat0, lon0)
    la, lo = math.radians(lat), math.radians(lon)
    v = np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])
    ang = math.acos(max(-1.0, min(1.0, float(v @ c))))
    t = v - (v @ c) * c
    L = np.linalg.norm(t)
    if L < 1e-15:
        return 0.0, 0.0
    return float(R * ang * (t @ e) / L), float(R * ang * (t @ n) / L)


def local_grid(lat0: float, lon0: float, R: float, size: float, n: int, cx: float = 0.0, cz: float = 0.0):
    """lat/lon-Gitter n x n für eine Kachel der Kantenlänge size (m), Mitte bei lokal (cx, cz) relativ zu lat0/lon0.
    Zeile 0 = Norden, Spalte 0 = Westen. Azimutal-äquidistante Tangentialebene (exakt, polfest)."""
    t = (np.arange(n) / (n - 1) - 0.5) * size
    east = cx + t[None, :] + 0 * t[:, None]
    north = -(cz + t[:, None]) + 0 * t[None, :]
    return enu_to_latlon(lat0, lon0, R, east, north)


def bilinear(img: np.ndarray, col: np.ndarray, row: np.ndarray, nodata_mask: np.ndarray | None = None):
    """Bilineares Sampling; liefert (werte, gültig). nodata_mask: True = ungültiges Quellpixel."""
    h, w = img.shape
    c0 = np.floor(col).astype(np.int64)
    r0 = np.floor(row).astype(np.int64)
    fc, fr = col - c0, row - r0
    ok = (c0 >= 0) & (r0 >= 0) & (c0 + 1 < w) & (r0 + 1 < h)
    c0c, r0c = np.clip(c0, 0, w - 2), np.clip(r0, 0, h - 2)
    a = img[r0c, c0c].astype(np.float64)
    b = img[r0c, c0c + 1].astype(np.float64)
    c = img[r0c + 1, c0c].astype(np.float64)
    d = img[r0c + 1, c0c + 1].astype(np.float64)
    v = (a * (1 - fc) + b * fc) * (1 - fr) + (c * (1 - fc) + d * fc) * fr
    if nodata_mask is not None:
        bad = nodata_mask[r0c, c0c] | nodata_mask[r0c, c0c + 1] | nodata_mask[r0c + 1, c0c] | nodata_mask[r0c + 1, c0c + 1]
        ok &= ~bad
    return v, ok


def box_down(img: np.ndarray, f: int) -> np.ndarray:
    if f <= 1:
        return img
    h, w = img.shape[:2]
    return img[: h - h % f, : w - w % f].reshape(h // f, f, w // f, f, *img.shape[2:]).mean(axis=(1, 3))


def inpaint(v: np.ndarray, ok: np.ndarray, iters: int = 400) -> np.ndarray:
    """Lücken (ok == False) per Multigrid-Diffusion füllen (glatte Membran)."""
    v = v.copy()
    if ok.all():
        return v
    if not ok.any():
        return np.zeros_like(v)
    # grobe Ebene zuerst (Pyramide), dann verfeinern
    h, w = v.shape
    if min(h, w) > 64:
        f = 4
        hs, ws = h // f, w // f
        vv = v[: hs * f, : ws * f].reshape(hs, f, ws, f)
        oo = ok[: hs * f, : ws * f].reshape(hs, f, ws, f)
        cnt = oo.sum(axis=(1, 3))
        coarse = np.where(cnt > 0, (vv * oo).sum(axis=(1, 3)) / np.maximum(cnt, 1), 0)
        coarse = inpaint(coarse, cnt > 0, iters)
        up = np.repeat(np.repeat(coarse, f, 0), f, 1)
        up = np.pad(up, ((0, h - up.shape[0]), (0, w - up.shape[1])), mode="edge")
        v = np.where(ok, v, up)
        iters = 60
    for _ in range(iters):
        p = np.pad(v, 1, mode="edge")
        avg = (p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]) / 4
        v = np.where(ok, v, avg)
    return v


def sun_vector(azimuth_deg: float, elevation_deg: float):
    """Richtung ZUR Sonne im lokalen Rahmen (+X Ost, +Y oben, -Z Nord); Azimut von Nord über Ost."""
    a, e = math.radians(azimuth_deg), math.radians(elevation_deg)
    return [round(math.sin(a) * math.cos(e), 6), round(math.sin(e), 6), round(-math.cos(a) * math.cos(e), 6)]


def cubic(img: np.ndarray, col: np.ndarray, row: np.ndarray):
    """Catmull-Rom-Interpolation (C1-stetig) für das Hochrechnen grober DEMs ohne Facetten. Ränder geklemmt."""
    h, w = img.shape
    c0 = np.floor(col).astype(np.int64)
    r0 = np.floor(row).astype(np.int64)
    tx, ty = col - c0, row - r0

    def wts(t):
        t2, t3 = t * t, t * t * t
        return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2]
    wx, wy = wts(tx), wts(ty)
    out = np.zeros(col.shape)
    for j in range(4):
        rr = np.clip(r0 + j - 1, 0, h - 1)
        acc = np.zeros(col.shape)
        for i in range(4):
            cc = np.clip(c0 + i - 1, 0, w - 1)
            acc += wx[i] * img[rr, cc]
        out += wy[j] * acc
    ok = (c0 >= 0) & (r0 >= 0) & (c0 < w - 1) & (r0 < h - 1)
    return out, ok
