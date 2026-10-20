// Minimal PNG decoder for 16-bit greyscale heightmaps (terrain_h16.png). Browsers' <img>/canvas
// path quantises to 8 bit, so we inflate the IDAT stream ourselves (DecompressionStream, also in Node ≥ 18)
// and undo the scanline filters. Supports colour type 0 (grey) with bit depth 8/16, non-interlaced.

export interface PngImage { width: number; height: number; bitDepth: number; channels: number; data: Uint16Array }

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export function parseChunks(buf: Uint8Array): { ihdr: DataView; idat: Uint8Array } {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('kein PNG');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8;
  let ihdr: DataView | null = null;
  const parts: Uint8Array[] = [];
  let total = 0;
  while (p + 8 <= buf.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = new DataView(body.buffer, body.byteOffset, body.byteLength);
    else if (type === 'IDAT') { parts.push(body); total += body.length; }
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error('PNG ohne IHDR');
  const idat = new Uint8Array(total);
  let o = 0;
  for (const c of parts) { idat.set(c, o); o += c.length; }
  return { ihdr, idat };
}

async function inflate(z: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([z as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Undo PNG scanline filters in place (raw = height × (1 + stride) bytes). Returns the unfiltered pixel bytes. */
export function unfilter(raw: Uint8Array, height: number, stride: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = x >= bpp && y > 0 ? out[up + x - bpp] : 0;
      let r: number;
      switch (ft) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error(`PNG-Filter ${ft} unbekannt`);
      }
      out[dst + x] = r & 255;
    }
  }
  return out;
}

export async function decodePngGrey(buffer: ArrayBuffer | Uint8Array): Promise<PngImage> {
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const { ihdr, idat } = parseChunks(buf);
  const width = ihdr.getUint32(0), height = ihdr.getUint32(4);
  const bitDepth = ihdr.getUint8(8), colorType = ihdr.getUint8(9), interlace = ihdr.getUint8(12);
  if (interlace !== 0) throw new Error('PNG interlaced nicht unterstützt');
  const channels = colorType === 0 ? 1 : colorType === 4 ? 2 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels || (bitDepth !== 8 && bitDepth !== 16)) throw new Error(`PNG-Format ${colorType}/${bitDepth} nicht unterstützt`);
  const bpp = channels * (bitDepth / 8);
  const stride = width * bpp;
  const raw = await inflate(idat);
  if (raw.length < height * (stride + 1)) throw new Error('PNG-Daten zu kurz');
  const px = unfilter(raw, height, stride, bpp);
  const n = width * height;
  const data = new Uint16Array(n);
  // first channel only (grey); 16 bit is big-endian
  if (bitDepth === 16) for (let i = 0; i < n; i++) data[i] = (px[i * bpp] << 8) | px[i * bpp + 1];
  else for (let i = 0; i < n; i++) data[i] = px[i * bpp] * 257;
  return { width, height, bitDepth, channels, data };
}
