"""v3 start cage from measured design points (replaces the v2-derived table of make_init.py).

Every design line (profile row) is given by a few (z, x, height-above-ground) support points taken
from the photo reconstruction and interpolated (PCHIP) to the stations:
  * triangulated landmarks (cameras.json lm3): side glass front corner (0.76 / 0.78 @ z 1.55) and
    rear tip (0.56 / 1.02 @ -0.88), deck edge / tail band (0.825 / 0.85, 0.77, 0.72 @ -1.93),
    plate, side marker, fender port;
  * back-projections of silhouette / crease pixels onto x = const planes (measure.py, d_007, d_014,
    d_021): fender crest rising from 0.62 (z 1.9) to 0.82 (z 1.4) and 0.88 (z 1.0); sill split
    0.22 (z 1.0) -> 0.29 (0.2) -> 0.35 (-0.34) -> 0.41 (-0.77); roof crown ~1.05 (z 0.5 .. -0.06);
  * front still proportions (tele lens, ~510 px/m): hood width +-0.68 at the nose, +-0.50 at the
    cowl, LED bar ~0.34 m above the lip, horn top ~0.64 m above the lip.
fit.py then refines all rows against the silhouettes with a smooth z basis.
Usage: python3 design_table.py -> body_spec.json
"""
import json, os
import numpy as np
from scipy.interpolate import PchipInterpolator

HERE = os.path.dirname(os.path.abspath(__file__))

Z = [2.25, 2.15, 2.05, 1.82, 1.60, 1.40, 0.92, 0.50, 0.08, -0.40, -0.62, -0.90, -1.25, -1.42, -1.58, -1.72, -1.84, -1.93]

# design lines: name -> [(z, x, yg), ...]   (yg = height above ground)
LINES = {
    "bottom_c":   [(2.25, 0.0, 0.16), (1.9, 0.0, 0.11), (1.5, 0.0, 0.10), (-1.3, 0.0, 0.10), (-1.7, 0.0, 0.14), (-1.93, 0.0, 0.20)],
    "floor_edge": [(2.25, 0.62, 0.16), (1.9, 0.68, 0.11), (1.5, 0.70, 0.10), (-1.3, 0.70, 0.10), (-1.7, 0.64, 0.14), (-1.93, 0.56, 0.20)],
    "rocker_bot": [(2.25, 0.86, 0.17), (1.9, 0.90, 0.14), (1.4, 0.92, 0.14), (0.0, 0.92, 0.15), (-1.0, 0.92, 0.16), (-1.42, 0.88, 0.17), (-1.72, 0.76, 0.20), (-1.93, 0.66, 0.24)],
    "sill":       [(2.25, 0.87, 0.24), (1.9, 0.91, 0.23), (1.4, 0.93, 0.22), (1.0, 0.925, 0.22), (0.2, 0.915, 0.29), (-0.34, 0.915, 0.35), (-0.77, 0.93, 0.41), (-1.25, 0.97, 0.45), (-1.58, 0.93, 0.47), (-1.84, 0.80, 0.44), (-1.93, 0.72, 0.40)],
    "lower_side": [(2.25, 0.90, 0.36), (1.9, 0.94, 0.38), (1.4, 0.96, 0.40), (0.9, 0.94, 0.42), (0.1, 0.915, 0.44), (-0.6, 0.93, 0.46), (-1.25, 1.00, 0.50), (-1.58, 0.98, 0.54), (-1.84, 0.86, 0.56), (-1.93, 0.80, 0.56)],
    "waist":      [(2.25, 0.92, 0.47), (1.9, 0.96, 0.52), (1.4, 0.985, 0.57), (0.9, 0.965, 0.60), (0.1, 0.95, 0.61), (-0.6, 0.97, 0.62), (-1.25, 1.00, 0.64), (-1.58, 0.99, 0.66), (-1.84, 0.90, 0.70), (-1.93, 0.836, 0.724)],
    "shoulder":   [(2.25, 0.89, 0.58), (1.9, 0.94, 0.66), (1.4, 0.965, 0.72), (0.9, 0.965, 0.75), (0.1, 0.96, 0.76), (-0.6, 0.975, 0.77), (-1.25, 0.99, 0.80), (-1.58, 0.97, 0.80), (-1.84, 0.88, 0.78), (-1.93, 0.829, 0.769)],
    "crest":      [(2.25, 0.86, 0.66), (2.05, 0.885, 0.72), (1.82, 0.89, 0.77), (1.6, 0.895, 0.80), (1.4, 0.90, 0.83), (0.9, 0.905, 0.86), (0.1, 0.91, 0.87), (-0.6, 0.93, 0.88), (-1.25, 0.95, 0.90), (-1.58, 0.93, 0.90), (-1.84, 0.87, 0.87), (-1.93, 0.825, 0.849)],
    "horn_in":    [(2.25, 0.68, 0.50), (2.05, 0.65, 0.56), (1.82, 0.60, 0.63), (1.6, 0.53, 0.71), (1.4, 0.80, 0.81), (0.9, 0.80, 0.84), (0.1, 0.79, 0.86), (-0.6, 0.79, 0.88), (-0.9, 0.80, 0.89), (-1.25, 0.86, 0.90), (-1.58, 0.86, 0.89), (-1.84, 0.83, 0.86), (-1.93, 0.80, 0.85)],
    "glass_base": [(2.25, 0.66, 0.49), (2.05, 0.62, 0.55), (1.82, 0.57, 0.62), (1.6, 0.50, 0.70), (1.4, 0.74, 0.80), (0.92, 0.70, 0.86), (0.5, 0.67, 0.90), (0.08, 0.64, 0.94), (-0.4, 0.60, 0.98), (-0.62, 0.58, 1.00), (-0.9, 0.56, 1.016), (-1.25, 0.74, 0.92), (-1.58, 0.75, 0.89), (-1.84, 0.76, 0.86), (-1.93, 0.75, 0.85)],
    "rail":       [(2.25, 0.60, 0.48), (2.05, 0.56, 0.54), (1.82, 0.50, 0.61), (1.6, 0.44, 0.69), (1.4, 0.70, 0.85), (0.92, 0.66, 0.97), (0.5, 0.63, 1.03), (0.08, 0.61, 1.045), (-0.4, 0.595, 1.04), (-0.62, 0.585, 1.03), (-0.9, 0.56, 1.016), (-1.25, 0.60, 0.94), (-1.58, 0.60, 0.90), (-1.84, 0.60, 0.865), (-1.93, 0.60, 0.85)],
    "glass_inner":[(2.25, 0.30, 0.48), (2.05, 0.27, 0.545), (1.82, 0.24, 0.61), (1.6, 0.22, 0.69), (1.4, 0.55, 0.86), (0.92, 0.50, 0.99), (0.5, 0.47, 1.045), (0.08, 0.46, 1.06), (-0.4, 0.45, 1.055), (-0.9, 0.42, 1.02), (-1.25, 0.38, 0.97), (-1.58, 0.36, 0.92), (-1.84, 0.36, 0.865), (-1.93, 0.36, 0.85)],
    "top_c":      [(2.25, 0.0, 0.48), (2.05, 0.0, 0.545), (1.82, 0.0, 0.61), (1.6, 0.0, 0.69), (1.4, 0.0, 0.87), (0.92, 0.0, 1.00), (0.5, 0.0, 1.052), (0.08, 0.0, 1.065), (-0.4, 0.0, 1.06), (-0.9, 0.0, 1.025), (-1.25, 0.0, 0.975), (-1.58, 0.0, 0.925), (-1.84, 0.0, 0.865), (-1.93, 0.0, 0.85)],
}
MULT = {"bottom_c": 1, "floor_edge": 3, "rocker_bot": 3, "sill": 3, "lower_side": 1, "waist": 2, "shoulder": 3,
        "crest": 3, "horn_in": 3, "glass_base": 3, "rail": 3, "glass_inner": 3, "top_c": 1}
# windshield base / cowl and deck edges are transverse creases
STATION_MULT = {1.40: 2}


def main():
    names = list(LINES)
    T = np.zeros((len(Z), len(names), 2))
    for j, n in enumerate(names):
        pts = sorted(LINES[n])
        zs = np.array([p[0] for p in pts]); xs = np.array([p[1] for p in pts]); ys = np.array([p[2] for p in pts])
        T[:, j, 0] = PchipInterpolator(zs, xs, extrapolate=True)(Z)
        T[:, j, 1] = PchipInterpolator(zs, ys, extrapolate=True)(Z)
    T[:, 0, 0] = 0; T[:, -1, 0] = 0
    stations = [{"z": Z[0]}] + [{"z": z, **({"mult": STATION_MULT[z]} if z in STATION_MULT else {})} for z in Z] + [{"z": Z[-1]}]
    stations[1]["mult"] = 3; stations[-2]["mult"] = 3
    table = np.concatenate([T[:1] * [0, 1], T, T[-1:] * [0, 1]])
    ns = len(stations)
    spec = json.load(open(os.path.join(HERE, "body_spec.json")))
    spec.update({
        "_doc": "v3 body cage from measured design points (design_table.py), refined by fit.py.",
        "profile": [{"name": n, "mult": MULT[n]} for n in names],
        "stations": stations, "table": table.tolist(), "dz": np.zeros(table.shape[:2]).tolist(),
    })
    spec["landmarks"] = [
        {"name": "band_top", "type": "row", "station": ns - 2, "profile": 7, "w": 1.0},
        {"name": "band_bot", "type": "row", "station": ns - 2, "profile": 6, "w": 1.0},
        {"name": "strip_bot", "type": "row", "station": ns - 2, "profile": 5, "w": 0.7},
        {"name": "sglass_rear", "type": "row", "station": 12, "profile": 9, "w": 0.7},
        {"name": "sglass_rear", "type": "row", "station": 12, "profile": 10, "w": 0.5},
        {"name": "side_marker", "type": "surf", "w": 0.5},
        {"name": "fender_port", "type": "surf", "w": 0.5},
        {"name": "plate_T", "type": "surf", "w": 0.5},
        {"name": "plate_B", "type": "surf", "w": 0.5}]
    # fit settings: stations stay where measured; the nose hood rows (stations 1-5, profiles 8-12) are
    # fixed because the front still has no metric anchor; floor rows are invisible in all photos
    spec["fit_z"] = False
    fx = [[-1, 0, 1], [-1, 1, 0], [-1, 1, 1]]
    fx += [[st, j, c] for st in range(1, 6) for j in range(8, 13) for c in (0, 1)]
    spec["fit_fixed"] = fx
    json.dump(spec, open(os.path.join(HERE, "body_spec.json"), "w"), indent=1)
    print("stations", len(stations), "profile", len(names))


if __name__ == "__main__":
    main()
