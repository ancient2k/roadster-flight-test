// Reads a GLB for the raw-parsing tests and undoes EXT_meshopt_compression (tools/compress-assets.mjs), so the
// tests can keep reading accessors straight from one plain BIN chunk. Uncompressed files come back unchanged.
import { readFileSync } from 'node:fs';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;

interface MeshoptView { buffer: number; byteOffset?: number; byteLength: number; byteStride: number; count: number; mode: 'ATTRIBUTES' | 'TRIANGLES' | 'INDICES'; filter?: 'NONE' | 'OCTAHEDRAL' | 'QUATERNION' | 'EXPONENTIAL' }
interface View { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: { EXT_meshopt_compression?: MeshoptView } }

export function readGlbFile(path: string): Buffer {
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  if (!(json.extensionsUsed ?? []).includes('EXT_meshopt_compression')) return buf;
  const binLen = buf.readUInt32LE(20 + jsonLen);
  const bin = buf.subarray(28 + jsonLen, 28 + jsonLen + binLen);

  const parts: Uint8Array[] = [];
  let size = 0;
  for (const bv of json.bufferViews as View[]) {
    const ext = bv.extensions?.EXT_meshopt_compression;
    let data: Uint8Array;
    if (ext) {
      data = new Uint8Array(ext.count * ext.byteStride);
      const src = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
      MeshoptDecoder.decodeGltfBuffer(data, ext.count, ext.byteStride, src, ext.mode, ext.filter ?? 'NONE');
      delete bv.extensions!.EXT_meshopt_compression;
    } else {
      data = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    }
    bv.buffer = 0; bv.byteOffset = size; bv.byteLength = data.byteLength;
    parts.push(data);
    size += data.byteLength;
    const pad = (4 - (size % 4)) % 4;
    if (pad) { parts.push(new Uint8Array(pad)); size += pad; }
  }
  json.buffers = [{ byteLength: size }];
  json.extensionsUsed = json.extensionsUsed.filter((e: string) => e !== 'EXT_meshopt_compression');
  json.extensionsRequired = (json.extensionsRequired ?? []).filter((e: string) => e !== 'EXT_meshopt_compression');

  let js = Buffer.from(JSON.stringify(json), 'utf8');
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + size, 8);
  jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  bh.writeUInt32LE(size, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, js, bh, ...parts]);
}
