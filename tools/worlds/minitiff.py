"""asset pipeline Welten: komprimierte TIFF-Segmente (z. B. LZW) ohne imagecodecs dekodieren.

Die rohen Strips/Tiles werden unverändert in ein minimales TIFF im Speicher verpackt (gleiche Bytereihenfolge,
Kompression, Prädiktor) und von Pillow/libtiff dekodiert.
"""
import io
import struct

import numpy as np
from PIL import Image


def decode(segs, seg_shape, grid, dtype, byteorder, compression, predictor=1):
    """segs: Liste komprimierter Segmente (zeilenweise im Raster grid=(ny, nx)); seg_shape=(h, w) je Segment.
    Liefert Array (ny*h, nx*w)."""
    bo = "<" if byteorder == "<" else ">"
    ny, nx = grid
    sh, sw = seg_shape
    H, W = ny * sh, nx * sw
    dt = np.dtype(dtype)
    tiled = nx > 1 or sw % 16 == 0 and ny > 1 and sh > 1
    tiled = nx > 1 or (sh > 1 and sw < W)
    fmt = 3 if dt.kind == "f" else (2 if dt.kind == "i" else 1)
    data_off = 8
    blob = b"".join(segs)
    offs, o = [], 8
    for s in segs:
        offs.append(o)
        o += len(s)
    ifd_off = o + (o & 1)
    tags = [(256, 4, [W]), (257, 4, [H]), (258, 3, [dt.itemsize * 8]), (259, 3, [compression]), (262, 3, [1]),
            (277, 3, [1]), (284, 3, [1]), (317, 3, [predictor]), (339, 3, [fmt])]
    if tiled:
        tags += [(322, 4, [sw]), (323, 4, [sh]), (324, 4, offs), (325, 4, [len(s) for s in segs])]
    else:
        tags += [(273, 4, offs), (278, 4, [sh]), (279, 4, [len(s) for s in segs])]
    tags.sort()
    n = len(tags)
    extra_off = ifd_off + 2 + n * 12 + 4
    ifd = struct.pack(bo + "H", n)
    extra = b""
    for tag, typ, vals in tags:
        size = 2 if typ == 3 else 4
        cnt = len(vals)
        if cnt * size <= 4:
            v = struct.pack(bo + ("H" if typ == 3 else "I") * cnt, *vals).ljust(4, b"\0")
            ifd += struct.pack(bo + "HHI", tag, typ, cnt) + v
        else:
            ifd += struct.pack(bo + "HHII", tag, typ, cnt, extra_off + len(extra))
            extra += struct.pack(bo + ("H" if typ == 3 else "I") * cnt, *vals)
    ifd += struct.pack(bo + "I", 0)
    head = (b"II*\0" if bo == "<" else b"MM\0*") + struct.pack(bo + "I", ifd_off)
    tif = head + blob + (b"\0" if o & 1 else b"") + ifd + extra
    im = Image.open(io.BytesIO(tif))
    a = np.array(im)
    return a.astype(dt, copy=False).reshape(H, W)
