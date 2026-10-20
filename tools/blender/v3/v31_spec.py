"""v3.1 body cage: the fitted v3 cage (body_spec.json) plus the nose details the silhouette fit cannot see.

The silhouette/landmark fit (fit.py) holds the hood rows of the nose (stations 1-5, profiles 8-12)
fixed, so the horns came out as a raised outer fender only: the inner horn edge sat 1-2 cm above the
hood. In the front still d_039 (tele, ~510 px/m) the horns are pyramids:
  * the upper horn facet is almost level across (outer crest and inner horn edge at about the same
    height, 0.30 m above the LED bar at the cowl), a sharp crease on both sides;
  * from the inner edge a steep face falls ~6-7 cm inward to the hood, which runs down to the LED
    groove between the horns.
This script edits only those fixed nose rows (the fit never touches them, so all silhouette numbers
of the fit stay valid) and writes body_spec_v31.json:
  horn_in (8):  height = crest height - FALL_TOP (level facet), x unchanged
  glass_base (9): becomes the foot of the inner horn wall: x = horn_in.x - WALL_DX, height = hood + 0.005
Usage: python3 tools/blender/v3/v31_spec.py
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
FALL_TOP = [0.035, 0.02, 0.014, 0.012, 0.012]   # stations 1..5 (nose -> cowl): inward fall of the top facet
WALL_DX = 0.035                                   # width of the steep inner wall in plan (m)
CREST, HORN, GBASE, RAIL = 7, 8, 9, 10


def main():
    spec = json.load(open(os.path.join(HERE, "body_spec.json")))
    T = spec["table"]
    log = []
    for k, st in enumerate(range(1, 6)):
        crest, horn, gb, rail = T[st][CREST], T[st][HORN], T[st][GBASE], T[st][RAIL]
        h_top = crest[1] - FALL_TOP[k]
        new_horn = [horn[0], h_top]
        new_gb = [horn[0] - WALL_DX, rail[1] + 0.005]
        log.append((spec["stations"][st]["z"], horn, new_horn, gb, new_gb))
        T[st][HORN] = new_horn
        T[st][GBASE] = new_gb
    # the collapsed nose centre station (0) mirrors station 1 heights
    T[0][HORN] = [0.0, T[1][HORN][1]]
    T[0][GBASE] = [0.0, T[1][GBASE][1]]
    spec["_doc"] = spec.get("_doc", "") + " v3.1: horn facets and inner horn wall (v31_spec.py)."
    json.dump(spec, open(os.path.join(HERE, "body_spec_v31.json"), "w"), indent=1)
    for z, h0, h1, g0, g1 in log:
        print(f"z {z:5.2f}: horn_in {h0[0]:.3f}/{h0[1]:.3f} -> {h1[0]:.3f}/{h1[1]:.3f}   "
              f"glass_base {g0[0]:.3f}/{g0[1]:.3f} -> {g1[0]:.3f}/{g1[1]:.3f}")


if __name__ == "__main__":
    main()
