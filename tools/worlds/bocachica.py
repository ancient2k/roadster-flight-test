#!/usr/bin/env python3
"""Asset pipeline worlds: Boca Chica (Starbase, Texas) for the level editor (docs/EDITOR.md).

    python3 tools/worlds/bocachica.py

Like terrain.py, but with sources that terrain.py does not cover:
  - USGS 3DEP 1 m lidar DTM and NAIP colour orthoimagery through the National Map ImageServers (exportImage,
    WGS 84 GeoTIFF), public domain;
  - sea and lagoons: the lidar DTM is hydro-flattened at the water surface, so the water bodies get a shallow
    basin below the water plane (meta.water.levelY) instead of an inpainted surface;
  - the build area: a graded, exactly flat field of 48 x 36 tiles of 20 m on the beach-ridge plain north-west of the
    launch site (meta.buildArea), graded after the curvature correction so that it stays flat;
  - the fenced launch site (OpenStreetMap fence) is painted as caliche in the albedo, so that the tower shadows and
    old tank layouts of the orthoimage do not lie under the 3D models.

Frames: the pipeline works in the REF frame (origin = OSM reference point 25.997 N, 97.157 W, the frame of
tools/worlds/data/starbase_osm.json and the Starbase models; +X east, +Y up, -Z north). The game's world origin is the
centre of the near tile, 400 m west and 250 m north of REF, as for every site (physics and renderer assume a centred
near tile); meta.refOrigin is where REF lies in world coordinates. Heights are relative to the tile centre
(decodeHeightmap: centre = 0).
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geo  # noqa: E402
from terrain import save_h16, splat_map, curvature_drop, gauss_blur  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SITE = "earth_bocachica"
DL = os.path.join(HERE, "downloads", SITE)
OUT = os.path.join(ROOT, "public", "assets", "worlds", SITE)
UA = {"User-Agent": "RoadsterFlightTest-asset pipeline/1.0 (github.com/ancient2k/roadster-flight-test)"}

R = 6371000.0
REF = (25.997, -97.157)                       # OSM reference point = world origin
NEAR = {"size": 4000.0, "n": 2049, "cx": -400.0, "cz": -250.0, "px": 4100}
FAR = {"size": 30000.0, "n": 1025, "cx": -400.0, "cz": -250.0, "px": 3000}
ALBEDO_N = 2048
# build area in world coordinates (x east, z = -north): 48 x 36 tiles of 20 m, west/south corner
BUILD = {"minX": -1440.0, "minZ": -700.0, "tileM": 20.0, "nx": 48, "nz": 36, "marginM": 25.0, "raiseM": 0.25}
WATER_LEVEL_ELEV = 0.10                       # m above NAVD88: mean water surface of the hydro-flattened DTM
SEA_DEPTH = {"shoreM": 0.25, "deepM": 2.5, "rampM": 150.0}

DEM = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
NAIP = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"
SOURCES = [
    {"use": "near + far height", "url": DEM, "credit": "U.S. Geological Survey, 3D Elevation Program (3DEP) 1 m lidar DTM / 1/3 arc-second",
     "license": "Public Domain (USGS)"},
    {"use": "albedo", "url": NAIP, "credit": "USDA Farm Service Agency, National Agriculture Imagery Program (NAIP), via USGS The National Map",
     "license": "Public Domain"},
    {"use": "launch site outline, roads", "url": "https://www.openstreetmap.org", "credit": "© OpenStreetMap contributors",
     "license": "ODbL 1.0"},
]


def bbox_for(tile, pad=1.03):
    """lat/lon bounding box (W, S, E, N) of a tile with a small margin."""
    half = tile["size"] / 2 * pad
    lats, lons = [], []
    for e in (tile["cx"] - half, tile["cx"] + half):
        for n in (-tile["cz"] - half, -tile["cz"] + half):
            la, lo = geo.enu_to_latlon(REF[0], REF[1], R, np.array([e]), np.array([n]))
            lats.append(float(la[0])); lons.append(float(lo[0]))
    return min(lons), min(lats), max(lons), max(lats)


def export(name, url, bbox, px, k=1, **extra):
    """Download an exportImage window as WGS 84 GeoTIFFs (k x k pieces, cached in tools/worlds/downloads)."""
    if k > 1:
        w, s, e, n = bbox
        out = []
        for i in range(k):
            for j in range(k):
                sub = (w + (e - w) * i / k, s + (n - s) * j / k, w + (e - w) * (i + 1) / k, s + (n - s) * (j + 1) / k)
                out += export(name.replace(".tif", f"_{i}{j}.tif"), url, sub, px // k + 8, 1, **extra)
        return out
    os.makedirs(DL, exist_ok=True)
    p = os.path.join(DL, name)
    if not os.path.exists(p):
        w, s, e, n = bbox
        aspect = (e - w) * math.cos(math.radians((s + n) / 2)) / (n - s)
        q = {"bbox": f"{w},{s},{e},{n}", "bboxSR": 4326, "imageSR": 4326, "size": f"{px},{int(round(px / aspect))}",
             "format": "tiff", "f": "image", **extra}
        full = url + "?" + urllib.parse.urlencode(q)
        print(f"  ↓ {name}")
        for attempt in range(6):                      # the ImageServers answer 500/502 under load now and then
            try:
                with urllib.request.urlopen(urllib.request.Request(full, headers=UA), timeout=900) as r, open(p + ".part", "wb") as f:
                    f.write(r.read())
                break
            except urllib.error.HTTPError as e:
                if attempt == 5 or e.code < 500:
                    raise
                print(f"    HTTP {e.code}, retry in {10 * 2 ** attempt} s")
                time.sleep(10 * 2 ** attempt)
        os.replace(p + ".part", p)
    return [p]


def sample(paths, lat, lon):
    """Bilinear samples of geographic GeoTIFF pieces on a lat/lon grid; returns (values [..., bands], valid)."""
    acc, okacc = None, None
    for path in paths:
        v, o = _sample1(path, lat, lon)
        if acc is None:
            acc, okacc = np.where(o[..., None], v, 0), o
        else:
            take = o & ~okacc
            acc = np.where(take[..., None], v, acc)
            okacc |= o
    return acc, okacc


def _sample1(path, lat, lon):
    import tifffile
    t = tifffile.TiffFile(path)
    g = t.geotiff_metadata
    sx, sy = g["ModelPixelScale"][:2]
    tx, ty = g["ModelTiepoint"][3:5]
    img = t.asarray()
    col = (lon - tx) / sx - 0.5
    row = (ty - lat) / sy - 0.5
    planes = img[..., None] if img.ndim == 2 else (img if img.shape[-1] <= 4 else np.moveaxis(img, 0, -1))
    vals, ok = [], None
    for b in range(planes.shape[-1]):
        v, o = geo.bilinear(planes[..., b].astype(np.float32), col, row)
        vals.append(v)
        ok = o if ok is None else ok & o
    return np.stack(vals, -1), ok


def water_basins(h, mpp):
    """Hydro-flattened water (≈ the water surface) -> shallow basins below the water level, deeper away from shore."""
    wet = h <= WATER_LEVEL_ELEV - 0.02
    wet = ndimage.binary_opening(wet, iterations=1)
    dist = ndimage.distance_transform_edt(wet) * mpp
    s = np.clip(dist / SEA_DEPTH["rampM"], 0, 1)
    s = s * s * (3 - 2 * s)
    depth = SEA_DEPTH["shoreM"] + (SEA_DEPTH["deepM"] - SEA_DEPTH["shoreM"]) * s
    return np.where(wet, np.minimum(h, WATER_LEVEL_ELEV - depth), h), wet


def grade_build_area(h, size, n, cx, cz):
    """Exactly flat field (median natural height + raise) with an embankment over marginM."""
    t = (np.arange(n) / (n - 1) - 0.5) * size
    X = cx + t[None, :] + 0 * t[:, None]
    Z = cz + t[:, None] + 0 * t[None, :]
    b = BUILD
    x0, x1 = b["minX"], b["minX"] + b["nx"] * b["tileM"]
    z0, z1 = b["minZ"], b["minZ"] + b["nz"] * b["tileM"]
    inside = (X >= x0) & (X <= x1) & (Z >= z0) & (Z <= z1)
    y = float(np.median(h[inside])) + b["raiseM"]
    dx = np.maximum(np.maximum(x0 - X, X - x1), 0)
    dz = np.maximum(np.maximum(z0 - Z, Z - z1), 0)
    d = np.hypot(dx, dz)
    w = np.clip(d / b["marginM"], 0, 1)
    w = w * w * (3 - 2 * w)
    return y * (1 - w) + h * w, y


# Fenced launch site, east/north metres from REF, traced along the OSM perimeter fence (way 1223387300 and its
# neighbours; the fence is split into many ways in OSM) with the notch of the southern flame-trench outlet.
LAUNCH_SITE = [(-190, 140), (-190, -225), (90, -225), (95, -312), (155, -312), (160, -225), (415, -225), (420, 60),
               (380, 100), (150, 128)]


def launch_site_polygon():
    return LAUNCH_SITE


def grade_launch_site(h, size, n, cx, cz, margin=15.0):
    """The fenced launch site as one graded pad (median height inside the fence), soft edge over `margin` m."""
    m = Image.new("L", (n, n), 0)
    ImageDraw.Draw(m).polygon([((e - (cx - size / 2)) / size * (n - 1), ((-nn) - (cz - size / 2)) / size * (n - 1)) for e, nn in LAUNCH_SITE], fill=255)
    inside = np.array(m) > 127
    y = float(np.median(h[inside]))
    d = ndimage.distance_transform_edt(~inside) * (size / (n - 1))
    w = np.clip(d / margin, 0, 1)
    w = w * w * (3 - 2 * w)
    return y * (1 - w) + h * w, y


def albedo(lat, lon, X, Z, h):
    p = export("naip_near.tif", NAIP, bbox_for(NEAR, 1.01), 4096, 3, bandIds="0,1,2", pixelType="U8")
    v, ok = sample(p, lat, lon)
    rgb = np.clip(v[..., :3], 0, 255)
    for c in range(3):
        rgb[..., c] = geo.inpaint(rgb[..., c], ok)
    # orthoimage -> albedo: NAIP is bright and contrasty; scale to a sand albedo (~0.30 linear) and soften
    lin = (rgb / 255.0) ** 2.2
    lin *= 0.30 / max(float(np.median(lin.mean(-1))), 1e-3)
    out = np.clip(lin, 0, 1) ** (1 / 2.2)
    # launch site and build area: caliche / concrete instead of the photographed structures
    rng = np.random.default_rng(7)
    noise = ndimage.gaussian_filter(rng.standard_normal(X.shape), 3) * 0.6 + ndimage.gaussian_filter(rng.standard_normal(X.shape), 0.8) * 0.25
    poly = launch_site_polygon()
    n = X.shape[0]
    mask = Image.new("L", (n, n), 0)
    if poly:
        size, cx, cz = NEAR["size"], NEAR["cx"], NEAR["cz"]
        pix = [((e - (cx - size / 2)) / size * (n - 1), ((-nn) - (cz - size / 2)) / size * (n - 1)) for e, nn in poly]
        ImageDraw.Draw(mask).polygon(pix, fill=255)
    site = np.array(mask, np.float32) / 255
    b = BUILD
    field = ((X >= b["minX"]) & (X <= b["minX"] + b["nx"] * b["tileM"]) & (Z >= b["minZ"]) & (Z <= b["minZ"] + b["nz"] * b["tileM"])).astype(np.float32)
    caliche = np.stack([0.66, 0.62, 0.55], -1)[None, None, :] * (1 + 0.05 * noise[..., None])
    concrete = np.stack([0.58, 0.57, 0.55], -1)[None, None, :] * (1 + 0.04 * noise[..., None])
    site = ndimage.gaussian_filter(site, 1.5)[..., None]
    field = ndimage.gaussian_filter(field, 1.0)[..., None]
    out = out * (1 - site) + caliche * site
    out = out * (1 - field) + concrete * field
    return (np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)


def build():
    os.makedirs(OUT, exist_ok=True)
    meta = {
        "site": SITE, "body": "earth", "name": "Boca Chica (Starbase)",
        "description": "Starbase, Texas: launch site of the Starship test flights on the Gulf coast, beach-ridge plain, tidal "
                       "flats and lagoons of the Rio Grande delta. Graded build field for the level editor.",
        "frame": "+X = east, +Y = up, -Z = north; origin = centre of the near tile; refOrigin = the OSM reference point 25.997 N, "
                 "97.157 W (tools/worlds/data/starbase_osm.json, Starbase models); heights relative to the near tile centre (decodeHeightmap).",
        "geo": {"refLat": REF[0], "refLon": REF[1], "radiusM": R},
        "sources": SOURCES, "tiles": {},
    }
    h0 = None
    for key, T in (("near", NEAR), ("far", FAR)):
        n, size, cx, cz = T["n"], T["size"], T["cx"], T["cz"]
        lat, lon = geo.local_grid(REF[0], REF[1], R, size, n, cx, cz)
        p = export(f"dem_{key}.tif", DEM, bbox_for(T), T["px"], 3, pixelType="F32", interpolation="RSP_BilinearInterpolation")
        v, ok = sample(p, lat, lon)
        h = v[..., 0].astype(np.float64)
        ok &= np.isfinite(h) & (h > -50) & (h < 500)
        print(f"  {key}: valid {ok.mean() * 100:.1f} %")
        h = np.where(ok, h, WATER_LEVEL_ELEV - 0.02)         # outside the lidar: open water
        mpp = size / (n - 1)
        h, wet = water_basins(h, mpp)
        if key == "far":
            h = gauss_blur(h, 1.0)
        # curvature relative to the build area centre (where the player is), then grade the field flat
        bx = BUILD["minX"] + BUILD["nx"] * BUILD["tileM"] / 2
        bz = BUILD["minZ"] + BUILD["nz"] * BUILD["tileM"] / 2
        h -= curvature_drop(n, size, R, cx, cz, bx, bz)
        h, site_elev = grade_launch_site(h, size, n, cx, cz)
        if key == "near":
            h, pad_elev = grade_build_area(h, size, n, cx, cz)
            site_elev_near = site_elev
            h0 = float(h[(n - 1) // 2, (n - 1) // 2])
            hn, X, Z, latn, lonn = h, None, None, lat, lon
        h = h - h0
        hmin, hmax = float(np.floor(h.min() * 10) / 10), float(np.ceil(h.max() * 10) / 10)
        fn = "terrain_h16.png" if key == "near" else "terrain_far_h16.png"
        save_h16(os.path.join(OUT, fn), h, hmin, hmax)
        meta["tiles"][key] = {"heightmap": fn, "resolution": n, "sizeM": size, "metersPerPixel": round(mpp, 4),
                              "centerX": 0.0, "centerZ": 0.0, "heightMinM": hmin, "heightMaxM": hmax,
                              "decode": "h = heightMinM + v / 65535 * (heightMaxM - heightMinM)"}
        print(f"  {fn}: {n}², {size} m, height {hmin} .. {hmax} m, water {wet.mean() * 100:.0f} %")
        if key == "near":
            hn_rel, mpp_n = h, mpp
    # albedo + splat on the near tile
    lat_a, lon_a = geo.local_grid(REF[0], REF[1], R, NEAR["size"], ALBEDO_N, NEAR["cx"], NEAR["cz"])
    t = (np.arange(ALBEDO_N) / (ALBEDO_N - 1) - 0.5) * NEAR["size"]
    X = NEAR["cx"] + t[None, :] + 0 * t[:, None]
    Z = NEAR["cz"] + t[:, None] + 0 * t[None, :]
    alb = albedo(lat_a, lon_a, X, Z, hn_rel)
    Image.fromarray(alb).save(os.path.join(OUT, "albedo.jpg"), quality=88, optimize=True)
    meta["tiles"]["near"]["albedo"] = "albedo.jpg"
    meta["tiles"]["near"]["albedoNote"] = "NAIP colour orthoimage scaled to a sand albedo; launch site (OSM fence) painted as caliche, build field as concrete."
    # splat: R ("rock" layer) = concrete on the build field and the launch site, G = sand elsewhere
    b = BUILD
    sp = splat_map(hn_rel, mpp_n, alb, {"rockSlopeDeg": 60}).astype(np.float32)
    ns = sp.shape[0]
    ts = (np.arange(ns) / (ns - 1) - 0.5) * NEAR["size"]
    Xs, Zs = NEAR["cx"] + ts[None, :] + 0 * ts[:, None], NEAR["cz"] + ts[:, None] + 0 * ts[None, :]
    hard = ((Xs >= b["minX"]) & (Xs <= b["minX"] + b["nx"] * b["tileM"]) & (Zs >= b["minZ"]) & (Zs <= b["minZ"] + b["nz"] * b["tileM"])).astype(np.float32)
    m = Image.new("L", (ns, ns), 0)
    ImageDraw.Draw(m).polygon([((e - (NEAR["cx"] - NEAR["size"] / 2)) / NEAR["size"] * (ns - 1), ((-nn) - (NEAR["cz"] - NEAR["size"] / 2)) / NEAR["size"] * (ns - 1)) for e, nn in LAUNCH_SITE], fill=255)
    hard = np.clip(ndimage.gaussian_filter(np.maximum(hard, np.array(m, np.float32) / 255), 1.0), 0, 1)[..., None]
    sp = sp * (1 - hard) + np.array([255, 0, 0], np.float32) * hard
    Image.fromarray((sp + 0.5).astype(np.uint8)).save(os.path.join(OUT, "splat.png"), optimize=True)
    meta["tiles"]["near"]["splat"] = "splat.png"
    b = BUILD
    ox, oz = -NEAR["cx"], -NEAR["cz"]                     # REF frame -> world (origin = near tile centre)
    meta["refOrigin"] = {"x": ox, "y": 0.0, "z": oz, "note": "position of the REF point (OSM / Starbase model origin) in world coordinates"}
    meta["buildArea"] = {"minX": b["minX"] + ox, "minZ": b["minZ"] + oz, "tileM": b["tileM"], "nx": b["nx"], "nz": b["nz"],
                         "y": round(pad_elev - h0, 3), "note": "graded flat field; tile (i, j) covers x = minX + i·tileM, z = minZ + j·tileM"}
    meta["noScatter"] = [[[round(e + ox, 1), round(-n + oz, 1)] for e, n in LAUNCH_SITE]]
    meta["water"] = {"levelY": round(WATER_LEVEL_ELEV - h0, 3), "note": "sea, lagoons and tidal channels (hydro-flattened lidar)"}
    sx, sz = b["minX"] + 3 * b["tileM"] + ox, b["minZ"] + b["nz"] * b["tileM"] / 2 + oz
    meta["spawn"] = {"x": sx, "y": meta["buildArea"]["y"], "z": sz, "headingDeg": 90.0, "compassDeg": 90.0,
                     "note": "west end of the build field, facing east towards the launch towers"}
    sun = {"azimuthDeg": 140.0, "elevationDeg": 45.0, "note": "late morning in autumn (Starship launch window)",
           "illuminanceLux": 100000, "colorTempK": 5600}
    meta["sun"] = {**sun, "direction": geo.sun_vector(sun["azimuthDeg"], sun["elevationDeg"])}
    meta["detailTextures"] = {"fine": "sand", "rock": "sand", "dark": "grass_chalk"}
    # Starbase (tools/worlds/blender/build_starbase.py, build_starship.py): models in the REF frame
    lay = json.load(open(os.path.join(OUT, "starbase_layout.json")))
    pad_y = round(site_elev_near - h0, 3)                 # the graded launch pad (all structures stand on it)
    lms = [{"file": "starbase.glb", "x": ox, "y": pad_y, "z": oz, "headingDeg": 0.0, "bake": False,
            "note": "launch site structures, model origin = REF point"}]
    # towers and stack: the _lod1 variants (25 % triangles) keep the world switch as fast as Giza; the full models
    # stay for close-ups of the launch
    lod = lambda f: f.replace(".glb", "_lod1.glb")
    for t in lay["towers"]:
        x, z = t["x"] + ox, t["z"] + oz
        lms.append({"file": lod(t["file"]), "x": round(x, 2), "y": pad_y, "z": round(z, 2), "headingDeg": round(t["headingDeg"], 3),
                    "collider": "box", "bake": False,
                    "note": f"integration tower (OSM {t['osmId']}), articulated catch arms"})
    st = lay["stackOnMount"]
    x, z = st["x"] + ox, st["z"] + oz
    lms.append({"file": lod(st["file"]), "x": round(x, 2), "y": round(pad_y + st["y"], 3), "z": round(z, 2), "headingDeg": round(st["headingDeg"], 3),
                "collider": "box", "bake": False,
                "note": "Super Heavy + Starship on launch mount " + st["mount"]})
    meta["landmarks"] = lms
    meta["rocks"] = {}
    meta["license"] = "USGS 3DEP and NAIP: public domain; OpenStreetMap: © OpenStreetMap contributors, ODbL"
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=2, ensure_ascii=False)
    print(f"  meta.json: build field y = {meta['buildArea']['y']} m, water y = {meta['water']['levelY']} m")


if __name__ == "__main__":
    build()
