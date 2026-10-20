"""Asset pipeline worlds: read windows from large (Geo)TIFFs — locally or via HTTP range directly from the server.

Only the strips/tiles that are needed are loaded and stored as raw bytes under downloads/<site>/.cache/
(re-runs work offline). Decoding via tifffile (uncompressed, LZW, Deflate, …).

    from rtiff import open_tiff
    t = open_tiff(url_or_path, cache_dir)
    arr = t.window(x0, y0, w, h)          # numpy (h, w) in pixel coordinates of the full resolution
    t.shape, t.dtype, t.geo                # geo: ModelPixelScale / ModelTiepoint, if present
"""
from __future__ import annotations

import hashlib
import io
import os
import urllib.request
import zlib

import numpy as np
import tifffile

UA = {"User-Agent": "RoadsterFlightTest-asset pipeline/1.0 (terrain preprocessing)"}


def urlopen_retry(req, timeout=120, tries=8):
    """urlopen with exponential backoff (429/5xx/network errors), honours Retry-After."""
    import time
    import urllib.error
    for k in range(tries):
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or k == tries - 1:
                raise
            try:
                wait = min(float(e.headers.get("Retry-After", 0) or 0), 60.0) or min(2 ** k, 60)
            except ValueError:
                wait = min(2 ** k, 60)
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if k == tries - 1:
                raise
            wait = min(2 ** k, 60)
        time.sleep(wait)


def get_bytes(req, timeout=120, tries=8) -> bytes:
    """Request including the read, with backoff (also timeouts/aborts while reading)."""
    import time
    for k in range(tries):
        try:
            with urlopen_retry(req, timeout=timeout) as r:
                return r.read()
        except OSError:
            if k == tries - 1:
                raise
            time.sleep(min(2 ** k, 60))


def resolve(url: str) -> str:
    """Resolve server redirects up front (urllib loses the Range headers on cookie/cloud redirects):
    planetarymaps.usgs.gov -> USGS S3 mirror, pds.lroc.im-ldi.com -> NASA PDS Cloud (pds.mcp.nasa.gov)."""
    url = url.replace("https://planetarymaps.usgs.gov/mosaic/", "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/")
    url = url.replace("https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/",
                      "https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/lro-l-lroc-5-rdr/")
    return url


class HttpFile(io.RawIOBase):
    """Seekable file object over HTTP range requests with a block cache (memory + disk)."""

    BLOCK = 1 << 20

    def __init__(self, url: str, cache_dir: str):
        # planetarymaps.usgs.gov redirects via a Cloudflare cookie to the S3 mirror (urllib loop) -> go to S3 directly
        url = resolve(url)
        self.url, self.pos = url, 0
        # the NASA PDS Cloud throttles parallel access (HTTP 429) -> only 2 connections there
        self.threads = 2 if "nasa.gov" in url else 8
        self.cache_dir = os.path.join(cache_dir, hashlib.md5(url.encode()).hexdigest()[:12])
        os.makedirs(self.cache_dir, exist_ok=True)
        meta = os.path.join(self.cache_dir, "size")
        if os.path.exists(meta):
            self.size = int(open(meta).read())
        else:
            req = urllib.request.Request(url, method="HEAD", headers=UA)
            with urlopen_retry(req, timeout=60) as r:
                self.size = int(r.headers["Content-Length"])
            open(meta, "w").write(str(self.size))
        self.mem: dict[int, bytes] = {}

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def _block(self, i: int) -> bytes:
        if i in self.mem:
            return self.mem[i]
        p = os.path.join(self.cache_dir, f"{i}.bin")
        if os.path.exists(p):
            b = open(p, "rb").read()
        else:
            a = i * self.BLOCK
            e = min(a + self.BLOCK, self.size) - 1
            req = urllib.request.Request(self.url, headers={**UA, "Range": f"bytes={a}-{e}"})
            b = get_bytes(req)
            open(p, "wb").write(b)
        if len(self.mem) > 256:
            self.mem.clear()
        self.mem[i] = b
        return b

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = max(0, min(n, self.size - self.pos))
        out = bytearray()
        while n > 0:
            i, o = divmod(self.pos, self.BLOCK)
            b = self._block(i)[o:o + n]
            out += b
            self.pos += len(b)
            n -= len(b)
        return bytes(out)

    def read_range(self, a: int, n: int) -> bytes:
        """Exact byte range via its own range request (for narrow windows in wide rows), with disk cache."""
        p = os.path.join(self.cache_dir, f"r{a}_{n}.bin")
        if os.path.exists(p):
            return open(p, "rb").read()
        req = urllib.request.Request(self.url, headers={**UA, "Range": f"bytes={a}-{a + n - 1}"})
        b = get_bytes(req)
        open(p, "wb").write(b)
        return b

    def readinto(self, buf):
        d = self.read(len(buf))
        buf[:len(d)] = d
        return len(d)


class Tiff:
    def __init__(self, src: str, cache_dir: str):
        self.fh = HttpFile(src, cache_dir) if src.startswith("http") else open(src, "rb")
        self.tf = tifffile.TiffFile(self.fh)
        self.page = self.tf.pages[0]
        self.shape = self.page.shape[:2]
        self.dtype = self.page.dtype
        tags = self.page.tags
        self.geo = {k: tags[k].value for k in ("ModelPixelScaleTag", "ModelTiepointTag", "GDAL_NODATA") if k in tags}

    def window(self, x0: int, y0: int, w: int, h: int, step: int = 1) -> np.ndarray:
        """Window at full resolution; step > 1: only every step-th row/column (with row strips the
        remaining strips are not loaded at all). Result shape (ceil(h/step), ceil(w/step))."""
        p = self.page
        H, W = self.shape
        out = np.zeros(((h + step - 1) // step, (w + step - 1) // step), dtype=p.dtype)
        x0c, y0c, x1c, y1c = max(x0, 0), max(y0, 0), min(x0 + w, W), min(y0 + h, H)
        if x0c >= x1c or y0c >= y1c:
            return out
        if p.is_tiled:
            th, tw = p.tilelength, p.tilewidth
            ntx = (W + tw - 1) // tw
            tys = range(y0c // th, (y1c - 1) // th + 1)
            txs = range(x0c // tw, (x1c - 1) // tw + 1)
            # tile bands row by row (limits memory)
            for ty in tys:
                idx = [ty * ntx + tx for tx in txs]
                band = self._decode_many(idx, (th, tw), (1, len(idx)))
                ya, yb = max(y0c, ty * th), min(y1c, ty * th + th)
                xa, xb = max(x0c, txs[0] * tw), min(x1c, (txs[-1] + 1) * tw)
                full = np.zeros((yb - ya, w), p.dtype)
                full[:, xa - x0:xb - x0] = band[ya - ty * th:yb - ty * th, xa - txs[0] * tw:xb - txs[0] * tw]
                for r in range(ya, yb):
                    if (r - y0) % step == 0:
                        out[(r - y0) // step] = full[r - ya, ::step]
            return out
        rps = p.rowsperstrip
        rows = [r for r in range(y0c, y1c) if (r - y0) % step == 0]
        if (rps == 1 and int(p.compression) == 1 and isinstance(self.fh, HttpFile)
                and (x1c - x0c) * p.dtype.itemsize < p.databytecounts[0] // 4):
            # narrow window in very wide uncompressed rows: only the bytes needed per row
            from concurrent.futures import ThreadPoolExecutor
            bps = p.dtype.itemsize
            n = (x1c - x0c) * bps
            dt = p.dtype.newbyteorder("<" if self.tf.byteorder == "<" else ">")
            def one(y):
                return y, np.frombuffer(self.fh.read_range(p.dataoffsets[y] + x0c * bps, n), dt)
            with ThreadPoolExecutor(self.fh.threads) as ex:
                for y, r in ex.map(one, rows):
                    self._put(out, (y - y0) // step, r, x0c - x0, w, step)
            return out
        strips = sorted({r // rps for r in rows})
        B = 64
        for k in range(0, len(strips), B):
            ids = strips[k:k + B]
            if rps == 1:
                blk = self._decode_many(ids, (1, W), (len(ids), 1))
                for j, sidx in enumerate(ids):
                    self._put(out, (sidx - y0) // step, blk[j, x0c:x1c], x0c - x0, w, step)
            else:
                for sidx in ids:
                    strip = self._decode_many([sidx], (rps, W), (1, 1))
                    for r in range(sidx * rps, min(sidx * rps + strip.shape[0], H)):
                        if y0c <= r < y1c and (r - y0) % step == 0:
                            self._put(out, (r - y0) // step, strip[r - sidx * rps, x0c:x1c], x0c - x0, w, step)
        return out

    @staticmethod
    def _put(out, k, vals, off, w, step):
        """Write row values (from window column off) into output row k, with a column step."""
        full = np.zeros(w, out.dtype)
        full[off:off + len(vals)] = vals
        out[k] = full[::step]

    def _fetch(self, idx):
        """Raw bytes of several segments (parallel over HTTP, disk cache)."""
        p = self.page
        offs, cnts = p.dataoffsets, p.databytecounts
        if isinstance(self.fh, HttpFile):
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(self.fh.threads) as ex:
                return list(ex.map(lambda i: self.fh.read_range(offs[i], cnts[i]) if cnts[i] else b"", idx))
        res = []
        for i in idx:
            self.fh.seek(offs[i])
            res.append(self.fh.read(cnts[i]))
        return res

    def _decode_many(self, idx, seg_shape, grid):
        p = self.page
        segs = self._fetch(idx)
        comp = int(p.compression)
        if comp == 5:      # LZW: via libtiff (Pillow) instead of imagecodecs
            import minitiff
            return minitiff.decode(segs, seg_shape, grid, p.dtype, self.tf.byteorder, 5, int(p.predictor))
        ny, nx = grid
        sh, sw = seg_shape
        out = np.zeros((ny * sh, nx * sw), p.dtype)
        for k, (i, data) in enumerate(zip(idx, segs)):
            seg = self._decode_bytes(i, data)
            seg = seg.reshape(-1, sw)[:sh]
            r, c = divmod(k, nx)
            out[r * sh:r * sh + seg.shape[0], c * sw:(c + 1) * sw] = seg
        return out

    def _decode_bytes(self, idx, data):
        p = self.page
        if int(p.predictor) == 3 and int(p.compression) in (8, 32946):
            # decode Deflate + floating-point predictor (TIFF Tech Note 3) without imagecodecs
            raw = np.frombuffer(zlib.decompress(data), np.uint8)
            bps = p.dtype.itemsize
            w = p.tilewidth if p.is_tiled else p.imagewidth
            rows = raw.size // (w * bps)
            b = raw[: rows * w * bps].reshape(rows, w * bps).astype(np.uint8)
            b = np.cumsum(b, axis=1, dtype=np.uint64).astype(np.uint8)
            b = b.reshape(rows, bps, w).transpose(0, 2, 1).copy()
            return b.view(">" + p.dtype.str[1:]).reshape(rows, w).astype(p.dtype)
        if int(p.compression) == 1:
            dt = p.dtype.newbyteorder("<" if self.tf.byteorder == "<" else ">")
            return np.frombuffer(data, dt).astype(p.dtype)
        seg, _, _ = p.decode(data, idx)
        return np.asarray(seg).squeeze()


def open_tiff(src: str, cache_dir: str) -> Tiff:
    return Tiff(src, cache_dir)
