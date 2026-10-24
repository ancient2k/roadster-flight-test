// Service worker registration (installable app + offline start; worker: tools/pwa/sw.template.js).
// Only in production builds served over http(s); `?nosw` removes the worker and its caches (debugging).

const SW_URL = './sw.js'; // relative to the page: works in any sub-folder (GitHub Pages, web ZIP)
const RELOAD_KEY = 'rft.swReload';

const supported = (): boolean =>
  !!import.meta.env?.PROD && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol);

/**
 * At page start: a new build that installed during an earlier visit is waiting. Activate it and reload
 * once, so this start already runs the new version (the old page has not loaded much yet).
 */
export async function applyPendingUpdate(): Promise<void> {
  if (!supported()) return;
  if (new URLSearchParams(location.search).has('nosw')) { await removeServiceWorker(); return; }
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  if (!reg?.waiting || !navigator.serviceWorker.controller) return;
  try { if (sessionStorage.getItem(RELOAD_KEY)) return; sessionStorage.setItem(RELOAD_KEY, '1'); } catch { return; }
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  reg.waiting.postMessage({ type: 'skip-waiting' });
}

/** How often a running game asks the server for a new build (ms); also on returning to the tab. */
const UPDATE_CHECK_MS = 15 * 60 * 1000;

/**
 * After the game is ready (so the shell precache does not compete with the start-up downloads). `onUpdate` is
 * called when a new build has installed in the background while this page runs (the page itself was served from
 * the cache, so a deploy only showed up on the start after next); `apply()` activates it and reloads.
 */
export async function registerServiceWorker(onUpdate?: (apply: () => void) => void): Promise<void> {
  if (!supported() || new URLSearchParams(location.search).has('nosw')) return;
  try { sessionStorage.removeItem(RELOAD_KEY); } catch { /* blocked */ }
  const reg = await navigator.serviceWorker.register(SW_URL).catch((e) => { console.warn('service worker:', e); return undefined; });
  if (!reg) return;
  // first visit: the page loaded its assets before any worker controlled it; hand the list over
  await navigator.serviceWorker.ready;
  const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.includes('/assets/'));
  reg.active?.postMessage({ type: 'warm', urls });
  if (!onUpdate) return;
  let told = false;
  const tell = (w: ServiceWorker | null) => {
    // (no controller: first visit – the new worker simply takes over, nothing to announce)
    if (!w || told || !navigator.serviceWorker.controller) return;
    told = true;
    onUpdate(() => {
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      w.postMessage({ type: 'skip-waiting' });
    });
  };
  if (reg.waiting) tell(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => { if (w.state === 'installed') tell(w); });
  });
  const check = () => { void reg.update().catch(() => { /* offline */ }); };
  setInterval(check, UPDATE_CHECK_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
}

async function removeServiceWorker(): Promise<void> {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) if (k.startsWith('rft-')) await caches.delete(k);
}
