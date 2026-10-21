// Moves images that several GLBs of one folder embed byte-identically (the Giza pyramids share one limestone set)
// into <folder>/tex/<sha1>.<ext> and references them by URI, so the browser downloads them once (HTTP cache).
// Works on finished GLBs (also meshopt-compressed ones): only image buffer views are dropped and the BIN chunk is
// repacked, geometry bytes are copied unchanged. Run after tools/compress-assets.mjs.
//
//   node tools/share-textures.mjs [--dry] <folder>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error('usage: node tools/share-textures.mjs [--dry] <folder>'); process.exit(1); }

function parse(buf) {
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
  const bl = buf.length > 28 + jl ? buf.readUInt32LE(20 + jl) : 0;
  return { json, bin: buf.subarray(28 + jl, 28 + jl + bl) };
}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 16);
const imageBytes = (g, img) => { const bv = g.json.bufferViews[img.bufferView]; return g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength); };

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.glb')).sort();
const glbs = new Map(files.map((f) => [f, parse(fs.readFileSync(path.join(dir, f)))]));

// images embedded by at least two GLBs of the folder
const users = new Map(), sizes = new Map();
for (const [f, g] of glbs) for (const img of g.json.images ?? []) {
  if (img.bufferView === undefined) continue;
  const b = imageBytes(g, img), h = sha(b);
  sizes.set(h, b.length);
  (users.get(h) ?? users.set(h, new Set()).get(h)).add(f);
}
// … or already in tex/ (one model rebuilt and re-embedded)
const texDir = path.join(dir, 'tex');
const existing = fs.existsSync(texDir) ? fs.readdirSync(texDir).map((f) => f.split('.')[0]) : [];
const shared = new Set([...users].filter(([h, s]) => s.size > 1 || existing.includes(h)).map(([h]) => h));

let saved = 0;
for (const [f, g] of glbs) {
  const drop = new Map(); // bufferView index -> uri
  for (const img of g.json.images ?? []) {
    if (img.bufferView === undefined) continue;
    const bytes = imageBytes(g, img), h = sha(bytes);
    if (!shared.has(h)) continue;
    const uri = `tex/${h}.${EXT[img.mimeType] ?? 'bin'}`;
    if (!dry) {
      fs.mkdirSync(path.join(dir, 'tex'), { recursive: true });
      if (!fs.existsSync(path.join(dir, uri))) fs.writeFileSync(path.join(dir, uri), bytes);
    }
    drop.set(img.bufferView, uri);
    delete img.bufferView; img.uri = uri;
  }
  if (!drop.size) continue;
  // repack buffer 0: every remaining view keeps its bytes, in the original order; meshopt views live in
  // extension ranges of buffer 0 while the view itself points at the (empty) fallback buffer
  const remap = new Map(), views = [], parts = [];
  let size = 0;
  const put = (b) => { const off = size; parts.push(b); size += b.length; const pad = (4 - (size % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); size += pad; } return off; };
  g.json.bufferViews.forEach((bv, i) => {
    if (drop.has(i)) return;
    const mo = bv.extensions?.EXT_meshopt_compression;
    if (mo && mo.buffer === 0) mo.byteOffset = put(g.bin.subarray(mo.byteOffset ?? 0, (mo.byteOffset ?? 0) + mo.byteLength));
    if (bv.buffer === 0) bv.byteOffset = put(g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
    remap.set(i, views.length); views.push(bv);
  });
  g.json.bufferViews = views;
  for (const a of g.json.accessors ?? []) {
    if (a.bufferView !== undefined) a.bufferView = remap.get(a.bufferView);
    if (a.sparse) { a.sparse.indices.bufferView = remap.get(a.sparse.indices.bufferView); a.sparse.values.bufferView = remap.get(a.sparse.values.bufferView); }
  }
  for (const img of g.json.images ?? []) if (img.bufferView !== undefined) img.bufferView = remap.get(img.bufferView);
  g.json.buffers[0].byteLength = size;

  let js = Buffer.from(JSON.stringify(g.json), 'utf8');
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + size, 8);
  jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  bh.writeUInt32LE(size, 0); bh.writeUInt32LE(0x004e4942, 4);
  const out = Buffer.concat([head, jh, js, bh, ...parts]);
  const before = fs.statSync(path.join(dir, f)).size;
  saved += before - out.length;
  console.log(`${(before / 1e6).toFixed(2)} → ${(out.length / 1e6).toFixed(2)} MB  ${f} (${drop.size} shared images)`);
  if (!dry) fs.writeFileSync(path.join(dir, f), out);
}
const texBytes = [...shared].reduce((a, h) => a + sizes.get(h), 0);
console.log(`GLBs −${(saved / 1e6).toFixed(1)} MB, shared images ${shared.size} (${(texBytes / 1e6).toFixed(1)} MB, loaded once)`);
