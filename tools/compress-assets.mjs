// Compress the GLB assets for the web: lossless meshopt geometry (EXT_meshopt_compression without filters, the
// decoded vertices are bit-identical) and WebP instead of PNG textures (EXT_texture_webp). Node and material
// names, empty nodes (lamp empties, break-off anchors, Light_* markers) and extras stay untouched – no prune, no join, no instancing – so the game's lookups by name keep working.
//
//   node tools/compress-assets.mjs [--dry] [--quantize] <in.glb|dir> [out dir]
//
// Without an out dir the files are rewritten in place. --quantize also quantizes vertex attributes
// (KHR_mesh_quantization, smaller but moves vertices by up to ~1/16384 of the mesh extent).
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { reorder, quantize, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const args = process.argv.slice(2);
const dry = args.includes('--dry'), doQuant = args.includes('--quantize');
const [src, outDir] = args.filter((a) => !a.startsWith('--'));
if (!src) { console.error('usage: node tools/compress-assets.mjs [--dry] [--quantize] <in.glb|dir> [out dir]'); process.exit(1); }

await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const files = fs.statSync(src).isDirectory()
  ? fs.readdirSync(src, { recursive: true }).filter((f) => String(f).endsWith('.glb')).map((f) => path.join(src, String(f)))
  : [src];

const names = (doc) => doc.getRoot().listNodes().map((n) => n.getName()).sort().join('|')
  + '#' + doc.getRoot().listMaterials().map((m) => m.getName()).sort().join('|');

let before = 0, after = 0;
for (const f of files) {
  const doc = await io.read(f);
  const used = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  if (used.includes('EXT_meshopt_compression')) { console.log(`skip (already compressed) ${f}`); continue; }
  const sig = names(doc);
  await doc.transform(
    reorder({ encoder: MeshoptEncoder }),
    ...(doQuant ? [quantize()] : []),
    // PNG only: colour maps lossy, data maps (normals, metal/rough) lossless. JPEGs stay as they are – re-encoding
    // them to WebP saves ≈ 25 % at the price of a second generation of artefacts.
    textureCompress({ encoder: sharp, targetFormat: 'webp', formats: /png/, slots: /^(baseColor|emissive)/, quality: 90 }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', formats: /png/, lossless: true }),
  );
  doc.createExtension(ALL_EXTENSIONS.find((E) => E.EXTENSION_NAME === 'EXT_meshopt_compression'))
    .setRequired(true).setEncoderOptions({ method: 'quantize' });
  if (names(doc) !== sig) throw new Error(`node/material names changed in ${f}`);
  const bytes = await io.writeBinary(doc);
  const s0 = fs.statSync(f).size;
  before += s0; after += bytes.byteLength;
  console.log(`${(s0 / 1e6).toFixed(2)} → ${(bytes.byteLength / 1e6).toFixed(2)} MB  ${f}`);
  if (!dry) {
    const out = outDir ? path.join(outDir, path.relative(fs.statSync(src).isDirectory() ? src : path.dirname(src), f)) : f;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, bytes);
  }
}
console.log(`total ${(before / 1e6).toFixed(1)} → ${(after / 1e6).toFixed(1)} MB`);
