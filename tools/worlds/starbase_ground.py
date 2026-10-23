"""Roads and paved slabs of the Starbase site for the terrain shader (src/render/worlds/pavedGround.ts).

The Blender model (tools/worlds/blender/build_starbase.py) used to carry them as boxes per road segment and flat
prisms; on the ungraded terrain those stood out as steps, jagged joints and flickering plates. They are now painted
into the terrain instead. Same feature selection as build_site() there.

Output: public/assets/worlds/earth_bocachica/starbase_ground.json, in the model frame of starbase.glb
(east/north metres from the OSM reference point; the landmark pose in meta.json places it).
Run: python3 tools/worlds/starbase_ground.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'tools/worlds/data/starbase_osm.json'
OUT = ROOT / 'public/assets/worlds/earth_bocachica/starbase_ground.json'


def points(f):
    p = f['eastNorthM']
    return p[:-1] if len(p) > 1 and p[0] == p[-1] else p


def main():
    roads, slabs = [], []
    for f in json.loads(DATA.read_text())['features']:
        t = f['tags']
        # skipped or built as structures by build_site(), in its order
        if t.get('man_made') == 'tower' or 'building:part' in t or 'natural' in t or t.get('layer') == '-1':
            continue
        if t.get('man_made') in ('gantry', 'storage_tank', 'pipeline') or 'building' in t or 'barrier' in t:
            continue
        p = [[round(x, 2), round(y, 2)] for x, y in points(f)]
        kind = 'asphalt' if t.get('surface') == 'asphalt' else 'concrete'
        if 'highway' in t:
            w = 9 if t['highway'] in ('tertiary', 'unclassified') else 5 if t['highway'] == 'service' else 2.5
            roads.append({'kind': kind, 'w': w, 'pts': p})
        elif f['closed'] and ('surface' in t or t.get('aeroway') == 'apron' or t.get('industrial') == 'depot'):
            slabs.append({'kind': kind, 'pts': p})
    OUT.write_text(json.dumps({
        'frame': 'starbase.glb model frame: [east, north] m from the OSM reference point',
        'source': 'OpenStreetMap (ODbL), tools/worlds/data/starbase_osm.json',
        'roads': roads, 'slabs': slabs,
    }, separators=(',', ':')))
    print(f'{len(roads)} roads, {len(slabs)} slabs -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
