// Vite build plugin: writes <outDir>/sw.js from tools/pwa/sw.template.js after the build.
// The service worker precaches the app shell (index.html, manifest, icons, fonts and the hashed JS/CSS
// directly in assets/) and caches the large assets (assets/<subdir>/…: car, worlds, textures) on first
// use, keyed by a per-file content hash, so a deploy only replaces the files that changed.
// No dependency on vite-plugin-pwa / Workbox; see docs/MOBILE.md ("Install as an app").
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export interface SwManifest {
  /** Shell cache version (hash over the precached files). */
  version: string;
  /** Paths relative to the site root, precached on install. */
  precache: string[];
  /** Large assets cached on first use: path -> content hash (12 hex). */
  assets: Record<string, string>;
}

const hashFile = (f: string) => createHash('sha1').update(readFileSync(f)).digest('hex').slice(0, 12);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/** Splits a built site into precache list and runtime asset map (pure apart from reading files). */
export function buildSwManifest(outDir: string): SwManifest {
  const files = walk(outDir).map((f) => relative(outDir, f).split(sep).join('/'))
    .filter((f) => !f.endsWith('.map') && f !== 'sw.js' && !f.startsWith('.') && !f.includes('/.'))
    .sort();
  const precache: string[] = [];
  const assets: Record<string, string> = {};
  for (const f of files) {
    const top = !f.includes('/');
    const shell = (top && /\.(html|json|ico|svg|png|txt)$/.test(f) && f !== 'LIESMICH.txt')
      || f.startsWith('icons/')
      || f.startsWith('assets/fonts/')
      || /^assets\/[^/]+\.(js|css|wasm)$/.test(f);
    if (shell) precache.push(f);
    else if (f.startsWith('assets/')) assets[f] = hashFile(join(outDir, f));
  }
  const h = createHash('sha1');
  for (const f of precache) h.update(f).update(readFileSync(join(outDir, f)));
  return { version: h.digest('hex').slice(0, 12), precache, assets };
}

export function renderServiceWorker(m: SwManifest, template: string): string {
  return template
    .replace('__RFT_VERSION__', JSON.stringify(m.version))
    .replace('__RFT_PRECACHE__', JSON.stringify(['./', ...m.precache]))
    .replace('__RFT_ASSETS__', JSON.stringify(m.assets));
}

export function serviceWorkerPlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'rft-service-worker',
    apply: 'build',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    closeBundle() {
      const template = readFileSync(fileURLToPath(new URL('./sw.template.js', import.meta.url)), 'utf8');
      const m = buildSwManifest(outDir);
      writeFileSync(join(outDir, 'sw.js'), renderServiceWorker(m, template));
      this.info?.(`sw.js: ${m.precache.length} precached, ${Object.keys(m.assets).length} assets on demand, version ${m.version}`);
    },
  };
}
