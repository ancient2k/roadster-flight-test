import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSwManifest, renderServiceWorker } from '../../tools/pwa/plugin';

function site(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rft-sw-'));
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body); }
  return dir;
}

describe('service worker manifest (tools/pwa/plugin.ts)', () => {
  const files = {
    'index.html': '<html>', 'manifest.json': '{}', 'icons/icon-192.png': 'png',
    'assets/index-abc.js': 'js', 'assets/index-abc.js.map': 'map', 'assets/index-def.css': 'css',
    'assets/fonts/rft-display-400.woff': 'woff',
    'assets/car/roadster.glb': 'car-v1', 'assets/worlds/moon/terrain.bin': 'terrain',
    'LIESMICH.txt': 'readme', '.htaccess': 'x', 'THIRD_PARTY_LICENSES/three.txt': 'MIT',
  };

  it('precaches the shell and leaves large assets to runtime caching', () => {
    const m = buildSwManifest(site(files));
    expect(m.precache).toEqual(['assets/fonts/rft-display-400.woff', 'assets/index-abc.js', 'assets/index-def.css', 'icons/icon-192.png', 'index.html', 'manifest.json']);
    expect(Object.keys(m.assets).sort()).toEqual(['assets/car/roadster.glb', 'assets/worlds/moon/terrain.bin']);
  });

  it('versions per file: a changed asset changes only its own hash, the shell version follows the shell', () => {
    const a = buildSwManifest(site(files));
    const b = buildSwManifest(site({ ...files, 'assets/car/roadster.glb': 'car-v2' }));
    expect(b.assets['assets/car/roadster.glb']).not.toBe(a.assets['assets/car/roadster.glb']);
    expect(b.assets['assets/worlds/moon/terrain.bin']).toBe(a.assets['assets/worlds/moon/terrain.bin']);
    expect(b.version).toBe(a.version);
    expect(buildSwManifest(site({ ...files, 'assets/index-abc.js': 'js2' })).version).not.toBe(a.version);
  });

  it('renders a worker without placeholders, relative to its scope', () => {
    const tpl = readFileSync(new URL('../../tools/pwa/sw.template.js', import.meta.url), 'utf8');
    const sw = renderServiceWorker(buildSwManifest(site(files)), tpl);
    expect(sw).not.toMatch(/__RFT_/);
    expect(sw).toContain('"./"');
    expect(sw).not.toMatch(/["']\/assets/); // no absolute paths: works in any sub-folder
    expect(() => new Function(sw.replace(/self\.registration\.scope/, "'https://x.test/a/'").replace(/self\.addEventListener/g, '(() => {})'))).not.toThrow();
  });
});
