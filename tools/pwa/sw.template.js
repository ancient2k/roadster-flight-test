/* Roadster Flight Test service worker. Generated at build time by tools/pwa/plugin.ts from
   tools/pwa/sw.template.js; see docs/MOBILE.md ("Install as an app").
   - App shell (index.html, manifest, icons, fonts, hashed JS/CSS): precached on install, one cache per
     build ("rft-shell-<version>"); pages are served from it (cache first), so a start works offline.
   - Large assets (assets/<subdir>/…): cached on first use in "rft-assets", keyed by URL + content hash;
     a new build drops exactly the entries whose file changed.
   - Updates: a new build installs in the background and waits; the next start of the game activates
     it and reloads once, and a running game offers "Reload" as soon as it is ready (src/pwa/register.ts). Everything is relative to the registration scope, so
     the site works in any sub-folder (GitHub Pages, the web ZIP). */
const VERSION = __RFT_VERSION__;
const PRECACHE = __RFT_PRECACHE__;
const ASSETS = __RFT_ASSETS__;
const SIZES = __RFT_SIZES__;

const SHELL = `rft-shell-${VERSION}`;
const ASSET_CACHE = 'rft-assets';
const SCOPE = self.registration.scope; // ends with '/'
const abs = (p) => new URL(p, SCOPE).href;
const assetKey = (rel) => `${abs(rel)}?v=${ASSETS[rel]}`;
/** Site-relative path of a same-scope URL ('' for the scope itself), or null. */
const relPath = (url) => (url.startsWith(SCOPE) ? decodeURI(url.slice(SCOPE.length).split(/[?#]/)[0]) : null);

self.addEventListener('install', (event) => {
  // revalidate against the server (not a stale HTTP-cache copy of index.html)
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE.map((p) => new Request(abs(p), { cache: 'no-cache' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('rft-shell-') && name !== SHELL) await caches.delete(name);
    }
    const ac = await caches.open(ASSET_CACHE);
    const keep = new Set(Object.keys(ASSETS).map(assetKey));
    for (const req of await ac.keys()) if (!keep.has(req.url)) await ac.delete(req);
    await self.clients.claim();
  })());
});

async function fromShell(req) {
  const shell = await caches.open(SHELL);
  // navigations (any query string, e.g. ?lang=de) get the cached index.html
  // ignoreVary: module scripts and CSS are requested with an Origin header (crossorigin), the precache
  // entries without one; servers that answer "Vary: Origin" would otherwise never match offline
  const hit = await shell.match(req.mode === 'navigate' ? abs('./') : req, { ignoreSearch: true, ignoreVary: true });
  if (hit) return hit;
  try { return await fetch(req); } catch (e) {
    if (req.mode === 'navigate') { const idx = await shell.match(abs('index.html'), { ignoreSearch: true, ignoreVary: true }); if (idx) return idx; }
    throw e;
  }
}

async function fromAssets(req, rel) {
  const ac = await caches.open(ASSET_CACHE);
  const key = assetKey(rel);
  const hit = await ac.match(key, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200 && res.type === 'basic') await ac.put(key, res.clone()).catch(() => { /* quota: serve uncached */ });
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const rel = relPath(req.url);
  if (rel === null) return; // other origins / outside the scope
  let res;
  if (ASSETS[rel]) res = fromAssets(req, rel);
  // the game page itself (any query) and the precached shell files; other pages (licence texts) go to the network
  else if (rel === '' || PRECACHE.includes(rel)) res = fromShell(req);
  else return;
  event.respondWith(res);
  // Resource Timing reports 0 bytes for worker responses in WebKit (transferSize 0 everywhere): tell the
  // boot screen of index.html the file size instead
  if (event.clientId && SIZES[rel]) {
    event.waitUntil(res.then(() => self.clients.get(event.clientId))
      .then((c) => c && c.postMessage({ type: 'rft-bytes', url: abs(rel), n: SIZES[rel] })).catch(() => {}));
  }
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'skip-waiting') self.skipWaiting();
  // assets the page loaded before this worker controlled it (first visit): copy them in, mostly from the HTTP cache
  if (msg.type === 'warm' && Array.isArray(msg.urls)) {
    event.waitUntil((async () => {
      const ac = await caches.open(ASSET_CACHE);
      const todo = [...new Set(msg.urls.map(relPath))].filter((r) => r && ASSETS[r]);
      const run = async () => {
        for (let r = todo.shift(); r; r = todo.shift()) {
          if (await ac.match(assetKey(r), { ignoreVary: true })) continue;
          try {
            const res = await fetch(abs(r), { cache: 'force-cache' });
            if (res.ok && res.status === 200) await ac.put(assetKey(r), res);
          } catch { /* offline or quota: next start fills it */ }
        }
      };
      await Promise.all([run(), run(), run()]);
    })());
  }
});
