"""Initial v3 cage (deterministic): v2 loft table (build_roadster.ST) converted to a B-spline cage,
one extra profile row (inner horn edge), five extra stations, tail moved to the reconstructed rear
face (band_top z), collapsed end stations for nose/tail faces, landmark ties for fit.py.
Usage: python3 make_init.py -> body_spec.json
"""
import json, os, re
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, "..", "build_roadster.py")).read()
ST = eval("[" + re.search(r"^ST = \[(.*?)^\]", src, re.S | re.M).group(1) + "]")
T = np.array([[[p[0], p[1]] for p in pts] for z, pts in ST], float)
DZ = np.array([[p[2] if len(p) > 2 else 0.0 for p in pts] for z, pts in ST], float)
z = np.array([s[0] for s in ST], float)
names = ["bottom_c", "floor_edge", "rocker_bot", "sill", "lower_side", "waist", "shoulder", "crest", "glass_base", "rail", "glass_inner", "top_c"]
mult = [1, 3, 3, 3, 1, 2, 2, 3, 3, 3, 3, 1]
# inner horn edge between crest and glass_base
T = np.insert(T, 8, (T[:, 7] + T[:, 8]) / 2, axis=1); DZ = np.insert(DZ, 8, (DZ[:, 7] + DZ[:, 8]) / 2, axis=1)
names.insert(8, "horn_in"); mult.insert(8, 3)
for zn in [2.15, 1.60, 0.50, -1.45, -1.80]:
    i = np.where(z > zn)[0].max(); a = (z[i] - zn) / (z[i] - z[i + 1])
    T = np.insert(T, i + 1, (1 - a) * T[i] + a * T[i + 1], axis=0)
    DZ = np.insert(DZ, i + 1, (1 - a) * DZ[i] + a * DZ[i + 1], axis=0)
    z = np.insert(z, i + 1, zn)
# rear face at the reconstructed deck edge (band_top z = -1.93); compress the last stations
zt = {len(z) - 5: -1.42, len(z) - 4: -1.58, len(z) - 3: -1.72, len(z) - 2: -1.84, len(z) - 1: -1.93}
for i, v in zt.items():
    z[i] = v
T[..., 0] = np.minimum(T[..., 0], 1.0)
stations = [{"z": float(z[0])}] + [{"z": float(v)} for v in z] + [{"z": float(z[-1])}]
stations[1]["mult"] = 3; stations[-2]["mult"] = 3
table = np.concatenate([T[:1] * [0, 1], T, T[-1:] * [0, 1]])
dz = np.concatenate([DZ[:1], DZ, DZ[-1:]])
ns = len(stations)
spec = {
    "_doc": "v3 body cage: stations (z, mult) x half-profile points (x, height above ground); B-spline surface (surface.py). Built by make_init.py, fitted by fit.py.",
    "profile": [{"name": n, "mult": m} for n, m in zip(names, mult)],
    "stations": stations, "table": table.tolist(), "dz": dz.tolist(),
    "landmarks": [
        {"name": "band_top", "type": "row", "station": ns - 2, "profile": 7, "w": 1.0},
        {"name": "band_bot", "type": "row", "station": ns - 2, "profile": 6, "w": 1.0},
        {"name": "strip_bot", "type": "row", "station": ns - 2, "profile": 5, "w": 0.7},
        {"name": "sglass_rear", "type": "row", "station": 12, "profile": 9, "w": 0.7},
        {"name": "sglass_rear", "type": "row", "station": 12, "profile": 10, "w": 0.5},
        {"name": "sglass_front", "type": "row", "station": 5, "profile": 9, "w": 0.7},
        {"name": "side_marker", "type": "surf", "w": 0.5},
        {"name": "fender_port", "type": "surf", "w": 0.5},
        {"name": "plate_T", "type": "surf", "w": 0.5},
        {"name": "plate_B", "type": "surf", "w": 0.5}],
    "fit_fixed": [[-1, 0, 1], [-1, 1, 0], [-1, 1, 1]],
    "x_max": 1.0,
}
json.dump(spec, open(os.path.join(HERE, "body_spec.json"), "w"), indent=1)
print("stations", [round(s["z"], 2) for s in stations])
