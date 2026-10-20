#!/usr/bin/env python3
"""asset pipeline Welten: Gelände-Kacheln aus offiziellen DTMs/Orthobildern erzeugen.

    python3 tools/worlds/terrain.py moon_tranquility [weitere Orte ...]   (ohne Argument: alle)

Je Ort nach public/assets/worlds/<ort>/:
  terrain_h16.png   Höhenmodell Nahbereich (16 Bit Graustufen, n x n, Zeile 0 = Nord, Spalte 0 = West)
  terrain_far_h16.png  Horizont-Kachel (größer, gröber; optional)
  albedo.jpg        Farbe/Albedo der Nahkachel (sRGB, schattenarm), gleiche Ausdehnung
  normal.png        Tangentenraum-Normalenkarte (OpenGL, +Y = Nord-Hang? siehe meta) der Nahkachel
  splat.png         Gewichte für Detailtexturen (RGB: R = Fels/Steil, G = Feinmaterial, B = dunkel/Auswurf), 1024²
  meta.json         Ausdehnung, Höhenbereich, Spawn, Sonne, Quellen, Wahrzeichen
Quellen werden nach tools/worlds/downloads/<ort>/ geladen (Range-Requests für große Dateien).
Höhen: lokale kartesische Höhe über der Tangentialebene am Spawn (Krümmung d²/2R eingerechnet), Spawn-Boden = 0.
"""
from __future__ import annotations

import json
import math
import os
import sys
import urllib.request

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo  # noqa: E402
import rtiff  # noqa: E402
from sites import SITES  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DL = os.path.join(HERE, "downloads")
OUT = os.path.join(ROOT, "public", "assets", "worlds")


def fetch(site: str, url: str) -> str:
    """Datei komplett laden (für kleine/mittlere Quellen), sonst Pfad für Range-Zugriff zurückgeben."""
    d = os.path.join(DL, site)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, os.path.basename(url.split("?")[0]))
    if not os.path.exists(p):
        print(f"  ↓ {url}")
        req = urllib.request.Request(rtiff.resolve(url), headers=rtiff.UA)
        with rtiff.urlopen_retry(req, timeout=600) as r, open(p + ".part", "wb") as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
        os.replace(p + ".part", p)
    return p


def source(site: str, src: dict):
    """Rasterquelle öffnen: {'url':..., 'mode': 'full'|'range'}."""
    path = fetch(site, src["url"]) if src.get("mode", "full") == "full" else src["url"]
    return rtiff.open_tiff(path, os.path.join(DL, site, ".cache"))


def sample_raster(site, src, lat, lon, kind="height"):
    """Raster an lat/lon-Gitter abtasten. Liest nur das benötigte Fenster."""
    T = source(site, src)
    P = geo.Proj.from_tiff(T)
    col, row = P.pix(lat, lon)
    pad = 2
    x0, y0 = int(math.floor(col.min())) - pad, int(math.floor(row.min())) - pad
    x1, y1 = int(math.ceil(col.max())) + pad, int(math.ceil(row.max())) + pad
    # Quellauflösung deutlich feiner als Ziel -> vor dem Sampling box-filtern (Aliasing vermeiden)
    tgt_step = max(abs(col[0, 1] - col[0, 0]), abs(row[1, 0] - row[0, 0]))
    f = max(1, int(tgt_step + 0.25))
    # große Fenster: Zeilen/Spalten dezimiert lesen (spart Download), sonst voll lesen + box-filtern
    decim = src.get("decimate", (x1 - x0) * (y1 - y0) > 40e6 or src.get("mode") == "range")
    if f > 1 and decim:
        win = T.window(x0, y0, x1 - x0, y1 - y0, step=f).astype(np.float64)
    else:
        win = T.window(x0, y0, x1 - x0, y1 - y0).astype(np.float64)
    nod = src.get("nodata")
    if nod is None and "GDAL_NODATA" in T.geo:
        try:
            nod = float(T.geo["GDAL_NODATA"])
        except ValueError:
            nod = None
    bad = ~np.isfinite(win)
    if nod is not None:
        bad |= np.isclose(win, nod, rtol=1e-6) | (win < -1e30)
    if kind == "image":
        bad |= win <= 0
    if f > 1 and decim:
        col, row = (col - x0) / f, (row - y0) / f
    elif f > 1:
        okf = geo.box_down((~bad).astype(np.float64), f)
        win = geo.box_down(np.where(bad, 0, win), f) / np.maximum(okf, 1e-6)
        bad = okf < 0.25
        col, row = (col - x0 - (f - 1) / 2) / f, (row - y0 - (f - 1) / 2) / f
    else:
        col, row = col - x0, row - y0
    if kind == "height" and tgt_step < 0.9 and not bad.any():
        v, ok = geo.cubic(win, col, row)          # grobe Quelle hochrechnen: glatt statt facettiert
    else:
        v, ok = geo.bilinear(win, col, row, bad)
    print(f"    {os.path.basename(src['url'])}: Fenster {x1 - x0}x{y1 - y0} px (f={f}{', dezimiert' if f > 1 and decim else ''}), gültig {ok.mean() * 100:.1f} %")
    return v, ok


def curvature_drop(n, size, R, cx=0.0, cz=0.0, sx=0.0, sz=0.0):
    t = (np.arange(n) / (n - 1) - 0.5) * size
    X = cx + t[None, :] - sx
    Z = cz + t[:, None] - sz
    return (X * X + Z * Z) / (2 * R)


def save_h16(path, h, hmin, hmax):
    q = np.clip(np.round((h - hmin) / max(hmax - hmin, 1e-6) * 65535), 0, 65535).astype(np.uint16)
    Image.fromarray(q).save(path, optimize=True)


def normal_map(h, mpp):
    """Normalenkarte (OpenGL-Konvention, Textur-u = +X/Ost, Textur-v nach oben = Nord)."""
    gy, gx = np.gradient(h, mpp)        # gy: Ableitung nach Zeile (Richtung Süd), gx: nach Ost
    nx, ny, nz = -gx, gy, np.ones_like(h)   # dh/dNord = -gy
    L = np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack([nx / L, ny / L, nz / L], -1) * 0.5 + 0.5
    return (rgb * 255 + 0.5).astype(np.uint8)


def build(site: str):
    S = SITES[site]
    print(f"== {site}: {S['name']}")
    out = os.path.join(OUT, site)
    os.makedirs(out, exist_ok=True)
    R = S["R"]
    lat0, lon0 = S["center"]
    slat, slon = S["spawn"]["latlon"]
    # Spawn in lokalen Koordinaten (Kachelmitte = Ursprung)
    sx, sn = geo.latlon_to_enu(lat0, lon0, R, slat, slon)
    sz = -sn
    meta = {
        "site": site, "body": S["body"], "name": S["name"], "description": S.get("description", ""),
        "frame": "+X = Ost, +Y = oben, -Z = Nord; Bildzeile 0 = Nordrand (z = -size/2), Spalte 0 = Westrand (x = -size/2). "
                 "Ursprung = Mitte der Nahkachel; Höhen in m relativ zum Mittelpunkt der Nahkachel (y = 0, wie decodeHeightmap), "
                 "Planetenkrümmung eingerechnet; Spawn-Bodenhöhe = spawn.y.",
        "geo": {"centerLat": lat0, "centerLon": lon0, "radiusM": R},
        "sources": [], "tiles": {},
    }
    hspawn = None
    for key in ("near", "far"):
        T = S["tiles"].get(key)
        if not T:
            continue
        n, size = T["n"], T["size"]
        cx, cz = T.get("offset", (0.0, 0.0))
        lat, lon = geo.local_grid(lat0, lon0, R, size, n, cx, cz)
        h = np.zeros((n, n))
        ok = np.zeros((n, n), bool)
        for src in T["height"]:            # erste Quelle mit gültigem Wert gewinnt
            v, o = sample_raster(site, src, lat, lon)
            v = v * src.get("scale", 1.0) + src.get("offset", 0.0)
            take = o & ~ok
            h[take] = v[take]
            ok |= o
            meta["sources"].append({k: src[k] for k in ("url", "credit", "license") if k in src} | {"use": f"{key} height"})
        print(f"    Höhe gültig: {ok.mean() * 100:.1f} % -> Lücken füllen")
        h = geo.inpaint(h, ok)
        for fix in T.get("flatten", []):   # z. B. Pyramiden im DSM entfernen
            h = flatten(h, size, n, cx, cz, {**fix, "xz": to_local(fix["latlon"], lat0, lon0, R)})
        if T.get("smoothM"):
            h = gauss_blur(h, T["smoothM"] / (size / (n - 1)))
        if T.get("detail"):
            h = h + detail_noise(n, size, T["detail"], seed=hash(site) % 1000)
        h -= curvature_drop(n, size, R, cx, cz, sx, sz)
        mpp = size / (n - 1)
        if hspawn is None:
            # Bezugshöhe = Mittelpunkt der Nahkachel (Vertrag src/shared/worlds.ts: decodeHeightmap setzt die
            # Mitte auf y = 0). Spawn-Höhe relativ dazu steht in meta.spawn.y.
            hspawn = float(h[(n - 1) // 2, (n - 1) // 2])
            c = (sx - cx) / mpp + (n - 1) / 2
            r = (sz - cz) / mpp + (n - 1) / 2
            spawn_y = float(geo.bilinear(h, np.array([c]), np.array([r]))[0][0]) - hspawn
        h -= hspawn
        hmin, hmax = float(np.floor(h.min() * 10) / 10), float(np.ceil(h.max() * 10) / 10)
        fn = "terrain_h16.png" if key == "near" else "terrain_far_h16.png"
        save_h16(os.path.join(out, fn), h, hmin, hmax)
        meta["tiles"][key] = {
            "heightmap": fn, "resolution": n, "sizeM": size, "metersPerPixel": round(mpp, 4),
            "centerX": cx, "centerZ": cz, "heightMinM": hmin, "heightMaxM": hmax,
            "decode": "h = heightMinM + v / 65535 * (heightMaxM - heightMinM)",
        }
        print(f"    {fn}: {n}², {size} m, Höhe {hmin} .. {hmax} m")
        if key == "near":
            hn, mpp_n = h, mpp
            Image.fromarray(normal_map(h, mpp)).resize((2048, 2048), Image.LANCZOS).save(os.path.join(out, "normal.png"), optimize=True)
            meta["tiles"]["near"]["normalMap"] = "normal.png"
            # Albedo
            A = S.get("albedo")
            na = A["n"] if A else 2048
            lat_a, lon_a = geo.local_grid(lat0, lon0, R, size, na, cx, cz)
            reuse = os.environ.get("REUSE_ALBEDO") == "1" and os.path.exists(os.path.join(out, "albedo.jpg"))
            if reuse:
                # nur Höhen neu berechnen (z. B. geänderter Höhenbezug): vorhandenes Albedo/Quellenangabe behalten
                alb = np.array(Image.open(os.path.join(out, "albedo.jpg")).convert("RGB"))
                if A and A.get("source"):
                    meta["sources"].append({k: A["source"][k] for k in ("url", "credit", "license") if k in A["source"]} | {"use": "albedo"})
            elif A and A.get("source"):
                av, ao = sample_raster(site, A["source"], lat_a, lon_a, kind="image")
                meta["sources"].append({k: A["source"][k] for k in ("url", "credit", "license") if k in A["source"]} | {"use": "albedo"})
                av = geo.inpaint(av, ao)
                alb = tone_albedo(av, A)
            else:
                alb = procedural_albedo(h, mpp, na, A or {})
            if not reuse:
                Image.fromarray(alb).save(os.path.join(out, "albedo.jpg"), quality=88, optimize=True)
            meta["tiles"]["near"]["albedo"] = "albedo.jpg"
            meta["tiles"]["near"]["albedoNote"] = A.get("note", "") if A else ""
            Image.fromarray(splat_map(h, mpp, alb, S)).save(os.path.join(out, "splat.png"), optimize=True)
            meta["tiles"]["near"]["splat"] = "splat.png"
    sy = round(spawn_y, 3)
    cd = S["spawn"].get("compassDeg", 0.0)
    meta["spawn"] = {"x": round(sx, 2), "y": sy, "z": round(sz, 2), "headingDeg": round((180.0 - cd) % 360.0, 3), "compassDeg": cd,
                     "lat": slat, "lon": slon, "note": S["spawn"].get("note", "")}
    sun = S["sun"]
    meta["sun"] = {**sun, "direction": geo.sun_vector(sun["azimuthDeg"], sun["elevationDeg"])}
    meta["detailTextures"] = S.get("detailTextures", [])
    lms = []
    for lm in S.get("landmarks", []):
        x, z = to_local(lm["latlon"], lat0, lon0, R)
        y = height_at(hn, mpp_n, x, z)
        cdl = lm.get("compassDeg", 0.0)
        lms.append({"file": lm["file"], "x": round(x, 2), "y": round(y, 3), "z": round(z, 2),
                    "headingDeg": round((180.0 - cdl) % 360.0, 3),
                    "compassDeg": cdl, "lat": lm["latlon"][0], "lon": lm["latlon"][1], "note": lm.get("note", "")})
    meta["landmarks"] = lms
    meta["rocks"] = S.get("rocks", {})
    meta["license"] = S.get("license", "")
    old = os.path.join(out, "meta.json")
    if os.path.exists(old):     # Einträge anderer Werkzeuge (z. B. footprints.py) erhalten
        prev = json.load(open(old))
        for k in ("footprints",):
            if k in prev:
                meta[k] = prev[k]
    json.dump(meta, open(os.path.join(out, "meta.json"), "w"), indent=2, ensure_ascii=False)
    print(f"    meta.json, Spawn ({sx:.1f}, {sy:.2f}, {sz:.1f})")


def to_local(latlon, lat0, lon0, R):
    e, n = geo.latlon_to_enu(lat0, lon0, R, latlon[0], latlon[1])
    return e, -n


def height_at(h, mpp, x, z):
    n = h.shape[0]
    c = x / mpp + (n - 1) / 2
    r = z / mpp + (n - 1) / 2
    return float(geo.bilinear(h, np.array([c]), np.array([r]))[0][0])


def flatten(h, size, n, cx, cz, fix):
    """Rechteck (x, z, halbe Breite, halbe Tiefe, Rand) aus dem DSM entfernen und glatt füllen."""
    t = (np.arange(n) / (n - 1) - 0.5) * size
    X = cx + t[None, :] + 0 * t[:, None]
    Z = cz + t[:, None] + 0 * t[None, :]
    x, z = fix["xz"]
    if fix.get("radius"):
        # Ebene (Höhe am Mittelpunkt) im Kreis, weicher Übergang über 'margin' (für Anlagen wie Stonehenge)
        X = cx + (np.arange(n) / (n - 1) - 0.5)[None, :] * size + 0 * np.arange(n)[:, None]
        Z = cz + (np.arange(n) / (n - 1) - 0.5)[:, None] * size + 0 * np.arange(n)[None, :]
        d = np.hypot(X - x, Z - z)
        mpp = size / (n - 1)
        c, r = int(round((x - cx) / mpp + (n - 1) / 2)), int(round((z - cz) / mpp + (n - 1) / 2))
        h0 = float(h[r - 2:r + 3, c - 2:c + 3].mean())
        w = np.clip((d - fix["radius"]) / fix.get("margin", 20.0), 0, 1)
        w = w * w * (3 - 2 * w)
        return h0 * (1 - w) + h * w
    hx, hz = fix["half"]
    m = fix.get("margin", 20.0)
    inside = (np.abs(X - x) < hx + m) & (np.abs(Z - z) < hz + m)
    return geo.inpaint(h, ~inside)


def gauss_blur(h, sigma_px):
    """Gauß-Glättung per FFT (Ränder gespiegelt), z. B. gegen DSM-Rauschen grober Quellen."""
    n0, n1 = h.shape
    p = np.pad(h, ((n0 // 4, n0 // 4), (n1 // 4, n1 // 4)), mode="reflect")
    fy = np.fft.fftfreq(p.shape[0])[:, None]
    fx = np.fft.fftfreq(p.shape[1])[None, :]
    g = np.exp(-2 * (np.pi * sigma_px) ** 2 * (fx * fx + fy * fy))
    out = np.real(np.fft.ifft2(np.fft.fft2(p) * g))
    return out[n0 // 4: n0 // 4 + n0, n1 // 4: n1 // 4 + n1]


def detail_noise(n, size, d, seed=0):
    """Feinstruktur unterhalb der Quellauflösung (für 30-m-DEMs): fBm, Amplitude in m, Grenzwellenlänge in m."""
    r = np.random.default_rng(seed)
    w = r.standard_normal((n, n))
    fy = np.fft.fftfreq(n, d=size / (n - 1))[:, None]
    fx = np.fft.fftfreq(n, d=size / (n - 1))[None, :]
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1e9
    lo = 1.0 / d.get("maxWavelengthM", 60.0)
    spec = np.fft.fft2(w) / f ** (d.get("beta", 2.0) / 2) * (f > lo * 0.5) * np.clip((f - lo * 0.5) / (lo * 0.5), 0, 1)
    out = np.real(np.fft.ifft2(spec))
    out = out / (out.std() + 1e-9) * d.get("amplitudeM", 0.3)
    return out


def tone_albedo(v, A):
    """Graustufen-Orthobild -> sRGB-Albedo: Perzentil-Normierung auf Ziel-Albedo (linear), Farbton."""
    lo, hi = np.percentile(v, [0.5, 99.5])
    x = np.clip((v - lo) / max(hi - lo, 1e-6), 0, 1)
    mean_t = A.get("meanAlbedo", 0.12)
    contrast = A.get("contrast", 1.0)
    lin = np.clip(mean_t * (1 + (x - x.mean()) / max(x.std(), 1e-6) * A.get("relStd", 0.18) * contrast), 0.005, 1)
    tint = np.array(A.get("tint", (1.0, 1.0, 1.0)))
    rgb = np.clip(lin[..., None] * tint, 0, 1)
    srgb = np.where(rgb <= 0.0031308, 12.92 * rgb, 1.055 * rgb ** (1 / 2.4) - 0.055)
    return (srgb * 255 + 0.5).astype(np.uint8)


def procedural_albedo(h, mpp, na, A):
    """Albedo ohne Orthobild (Erde): Grundfarbe + Hangneigung (Fels) + Rauschen, in Zielauflösung."""
    from PIL import Image as _I
    hh = np.array(_I.fromarray(h.astype(np.float32)).resize((na, na), _I.BILINEAR))
    gy, gx = np.gradient(hh, mpp * h.shape[0] / na)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    r = np.random.default_rng(7)
    def fbm(beta, s):
        w = np.random.default_rng(s).standard_normal((na, na))
        fy = np.fft.fftfreq(na)[:, None]; fx = np.fft.fftfreq(na)[None, :]
        f = np.sqrt(fx * fx + fy * fy); f[0, 0] = 1
        o = np.real(np.fft.ifft2(np.fft.fft2(w) / f ** (beta / 2)))
        return (o - o.mean()) / o.std()
    n1, n2 = fbm(2.2, 1), fbm(1.4, 2)
    base = np.array(A.get("base", (0.55, 0.47, 0.34)))
    rock = np.array(A.get("rock", (0.62, 0.56, 0.45)))
    ws = np.clip((slope - A.get("rockSlope", 12)) / 10, 0, 1)
    col = base * (1 + 0.08 * n1[..., None] + 0.04 * n2[..., None])
    col = col * (1 - ws[..., None]) + rock * (1 + 0.06 * n2[..., None]) * ws[..., None]
    srgb = np.where(col <= 0.0031308, 12.92 * col, 1.055 * np.clip(col, 0, 1) ** (1 / 2.4) - 0.055)
    return (np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8)


def splat_map(h, mpp, alb, S, na=1024):
    """Gewichte für Detailtexturen in 1024²: R = Fels (Hang), G = Feinmaterial, B = dunkles Material (RGB).
    (Direkt in Zielauflösung berechnet: PIL skaliert RGBA mit vormultipliziertem Alpha.)"""
    from PIL import Image as _I
    hh = np.array(_I.fromarray(h.astype(np.float32)).resize((na, na), _I.BILINEAR))
    gy, gx = np.gradient(hh, mpp * h.shape[0] / na)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    lum = np.array(_I.fromarray(alb).convert("L").resize((na, na), _I.BILINEAR)).astype(np.float32) / 255
    rock = np.clip((slope - S.get("rockSlopeDeg", 18)) / 12, 0, 1)
    dark = np.clip((np.median(lum) - lum) / 0.15, 0, 1) * (1 - rock)
    fine = np.clip(1 - rock - dark, 0, 1)
    out = np.stack([rock, fine, dark], -1)          # RGB (kein Alpha: Browser würden vormultiplizieren)
    return (out * 255 + 0.5).astype(np.uint8)


if __name__ == "__main__":
    for s in sys.argv[1:] or list(SITES):
        build(s)
