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

/** After the game is ready (so the shell precache does not compete with the start-up downloads). */
export async function registerServiceWorker(): Promise<void> {
  if (!supported() || new URLSearchParams(location.search).has('nosw')) return;
  try { sessionStorage.removeItem(RELOAD_KEY); } catch { /* blocked */ }
  const reg = await navigator.serviceWorker.register(SW_URL).catch((e) => { console.warn('service worker:', e); return undefined; });
  if (!reg) return;
  // first visit: the page loaded its assets before any worker controlled it; hand the list over
  await navigator.serviceWorker.ready;
  const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.includes('/assets/'));
  reg.active?.postMessage({ type: 'warm', urls });
}

async function removeServiceWorker(): Promise<void> {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) if (k.startsWith('rft-')) await caches.delete(k);
}
