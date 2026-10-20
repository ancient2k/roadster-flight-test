"""asset pipeline Welten: space_sun — Sternenhimmel, Sonnenscheibe, Referenzdaten (public/assets/worlds/space_sun/).

  Blender -b --factory-startup -P tools/worlds/blender/build_space.py

Quellen (tools/worlds/downloads/space_sun/, per curl):
  starmap_2020_8k.exr  NASA/Goddard SVS Deep Star Maps 2020 (svs.gsfc.nasa.gov/4851), äquatoriale Koordinaten
                       (ICRF/J2000), plate carrée, RA 0h in der Bildmitte, RA nimmt nach links zu, Dec +90° oben.
  sdo_hmi_intensitygram_1024.jpg  NASA/SDO HMI Kontinuum (Quick-Look vom 18.10.2026) -> Sonnenscheibe.
Ausgabe: stars_8k.jpg / stars_4k.jpg (sRGB, log-tonemapped), stars_2k.hdr (Radiance, linear),
  sun_disk_1024.png (Graustufen-Helligkeit inkl. Randverdunkelung + Flecken, Alpha = Scheibe), meta.json.
"""
import json
import math
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DL = os.path.join(HERE, "..", "downloads", "space_sun")
OUT = os.path.join(ROOT, "public", "assets", "worlds", "space_sun")


def load(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)


def save(arr, path, fmt, quality=90, float_buf=False):
    h, w = arr.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True, float_buffer=float_buf)
    img.pixels.foreach_set(np.ascontiguousarray(arr, np.float32).ravel())
    img.filepath_raw = path
    img.file_format = fmt
    if fmt == "JPEG":
        bpy.context.scene.render.image_settings.quality = quality
        img.save(filepath=path, quality=quality)
    else:
        img.save()
    bpy.data.images.remove(img)


def down(a, f):
    h, w = a.shape[:2]
    return a[: h - h % f, : w - w % f].reshape(h // f, f, w // f, f, a.shape[2]).mean(axis=(1, 3))


def main():
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = load(os.path.join(DL, "starmap_2020_8k.exr"))            # linear, Zeile 0 = unten (Blender)
    rgb = np.clip(s[..., :3], 0, None)
    p50, p999 = np.percentile(rgb.mean(-1), [50, 99.9])
    print(f"[ws-f] Sternkarte {s.shape}, Median {p50:.4g}, p99.9 {p999:.4g}")
    # Log-Tonemapping: Milchstraße sichtbar, helle Sterne gesättigt, Hintergrund nahezu schwarz
    k = 1.0 / max(p999, 1e-6)
    tm = np.log1p(rgb * k * 6.0) / math.log1p(6.0 * 3.0)
    tm = np.clip(tm, 0, 1) ** 1.15
    out = np.ones((*tm.shape[:2], 4), np.float32)
    out[..., :3] = tm
    save(out, os.path.join(OUT, "stars_8k.jpg"), "JPEG", 88)
    save(down(out, 2), os.path.join(OUT, "stars_4k.jpg"), "JPEG", 88)
    hdr = np.ones((s.shape[0] // 4, s.shape[1] // 4, 4), np.float32)
    hdr[..., :3] = down(rgb, 4) * k            # 1.0 ~ p99,9-Helligkeit
    save(hdr, os.path.join(OUT, "stars_2k.hdr"), "HDR", float_buf=True)

    # Sonnenscheibe aus SDO/HMI: Luminanz, Kreis-Maske (entfernt Beschriftung), weiß-gelblich normiert
    sd = load(os.path.join(DL, "sdo_hmi_intensitygram_1024.jpg"))
    lum = sd[..., 0] * 0.2126 + sd[..., 1] * 0.7152 + sd[..., 2] * 0.0722
    n = lum.shape[0]
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    # Scheibenrand automatisch finden (Schwelle)
    disk = lum > 0.15 * lum.max()
    cy, cx = y[disk].mean(), x[disk].mean()
    r = math.sqrt(disk.sum() / math.pi)
    rr = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / r
    alpha = np.clip((1.0 - rr) * r / 1.5, 0, 1)
    v = lum / np.percentile(lum[rr < 0.3], 90)
    disk_img = np.zeros((n, n, 4), np.float32)
    for c, t in enumerate((1.0, 0.97, 0.92)):
        disk_img[..., c] = np.clip(v * t, 0, 1) * (alpha > 0)
    disk_img[..., 3] = alpha
    save(disk_img, os.path.join(OUT, "sun_disk_1024.png"), "PNG")

    eps = math.radians(23.4392911)
    meta = {
        "site": "space_sun", "body": "space", "name": "Sonne (heliozentrischer Raum)",
        "description": "Freier Raum nahe der Sonne: Sternenhimmel, Sonnenscheibe, Referenzdaten für Strahlung/Erhitzung und "
                       "die Bahn von Roadster 1 + Starman (Modell: vehicle models).",
        "frame": "Kein Gelände. Himmelskugel äquatorial (ICRF/J2000); vorgeschlagener Szenenrahmen: siehe stars.suggestedSceneFrame",
        "files": ["stars_8k.jpg", "stars_4k.jpg", "stars_2k.hdr", "sun_disk_1024.png"],
        "stars": {
            "projection": "equirektangulär, äquatorial ICRF/J2000: Bildmitte = RA 0h/Dec 0°, RA nimmt nach LINKS zu, "
                          "oben = Himmelsnordpol (Dec +90°)",
            "toEcliptic": "Rotation um die x-Achse (Frühlingspunkt) um +ε: y_ekl = cosε·y_äq + sinε·z_äq, z_ekl = −sinε·y_äq + cosε·z_äq",
            "obliquityDeg": 23.4392911,
            "matrixEquatorialToEcliptic": [[1, 0, 0], [0, round(math.cos(eps), 9), round(math.sin(eps), 9)],
                                           [0, round(-math.sin(eps), 9), round(math.cos(eps), 9)]],
            "suggestedSceneFrame": "three.js: +X = Frühlingspunkt, +Y = ekliptikaler Nordpol, +Z = X × Y (rechtshändig)",
            "hdrScale": "stars_2k.hdr linear; 1,0 ≈ 99,9-Perzentil-Helligkeit (nur Hintergrund, keine physikalische Einheit)",
        },
        "sun": {
            "radiusM": 6.957e8, "GM_m3s2": 1.32712440018e20, "luminosityW": 3.828e26, "effectiveTempK": 5772,
            "solarConstantWm2At1AU": 1361.0, "AU_m": 149597870700.0,
            "irradiance": "E(r) = 1361 W/m² · (1 AU / r)²",
            "limbDarkening": {"law": "I(μ)/I(1) = 1 − u1(1−μ) − u2(1−μ)²", "u1": 0.47, "u2": 0.23, "band": "~550 nm"},
            "photosphereColorLinear": [1.0, 0.94, 0.88], "angularDiameterDegAt1AU": 0.5332,
            "corona": "nur bei abgedeckter Scheibe sichtbar; Helligkeit ~1e-6 der Scheibe",
            "disk": {"file": "sun_disk_1024.png", "source": "NASA/SDO HMI Continuum Quick-Look 2026-10-18 01:30 UT",
                     "note": "Graustufen-Helligkeit (Flecken + Randverdunkelung), Alpha = Scheibe; mit Sonnenfarbe multiplizieren"},
        },
        "roadster1": {
            "designation": "Tesla Roadster / Starman, NORAD 43205, COSPAR 2018-017A, JPL Horizons ID -143205",
            "elementsApprox": {"a_AU": 1.3245, "e": 0.2559, "i_deg": 1.0759, "Omega_deg": 317.43, "omega_deg": 177.24,
                               "periodDays": 557.0, "perihelionAU": 0.9855, "aphelionAU": 1.664},
            "note": "Näherungswerte (heliozentrisch, ekliptikal J2000); für Datum-genaue Position JPL Horizons -143205 verwenden",
        },
        "heating": {
            "absorbedFlux": "q = α · E(r) · A_proj; Gleichgewicht T = (α E / (ε σ · A_rad/A_proj))^(1/4)",
            "sigma": 5.670374419e-8,
            "aluminiumMeltK": 933, "steelMeltK": 1700, "carbonFiberDegradeK": 700, "lithiumIonRunawayK": 420,
            "note": "Referenz für das Verglühen (Spiel-Logik bei Lead/vehicle physics)",
        },
        "spawn": {"x": 0, "y": 0, "z": 0, "headingDeg": 0, "note": "Spielszene definiert Start relativ zu Roadster 1"},
        "sun_dir_note": "Sonne ist ein Objekt im Raum, keine feste Richtung",
        "sunDirection": None,
        "sources": [
            {"url": "https://svs.gsfc.nasa.gov/4851", "credit": "NASA/Goddard Space Flight Center Scientific Visualization Studio; "
             "Gaia DR2: ESA/Gaia/DPAC", "license": "NASA-Bildrichtlinie (frei, Namensnennung erbeten)", "use": "stars"},
            {"url": "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_HMIIC.jpg", "credit": "NASA/SDO and the HMI science team",
             "license": "NASA-Bildrichtlinie (frei, Namensnennung erbeten)", "use": "sun disk"},
        ],
        "tiles": {},
    }
    meta["sun"]["sunDirectionNote"] = meta.pop("sun_dir_note")
    meta.pop("sunDirection")
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=2, ensure_ascii=False)
    print("[ws-f] space_sun fertig")


main()
