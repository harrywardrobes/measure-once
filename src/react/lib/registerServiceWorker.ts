/**
 * Clear all offline data — the Workbox CacheStorage caches and the IndexedDB
 * store — so cached customer/finance data does not persist for the next person
 * on a shared browser profile. Call this on logout before navigating away.
 *
 * Best-effort and bounded: never throws, and resolves even if the platform
 * lacks CacheStorage / IndexedDB. `offlineDb` (and its `idb` dependency) is
 * dynamically imported so it stays out of the always-loaded main bundle.
 */
export async function clearOfflineData(): Promise<void> {
  const clearDb = import('./offlineDb')
    .then((m) => m.clearOfflineDb())
    .catch(() => {});
  const tasks: Array<Promise<unknown>> = [clearDb];
  try {
    if (typeof caches !== 'undefined') {
      tasks.push(
        caches.keys().then((keys) =>
          Promise.all(keys.filter((k) => k.startsWith('measure-once') || k.startsWith('mo-')).map((k) => caches.delete(k))),
        ),
      );
    }
  } catch {
    /* best-effort */
  }
  try {
    await Promise.all(tasks);
  } catch {
    /* best-effort */
  }
}

/**
 * Registers the Workbox service worker (public/sw.js) at the site root.
 *
 * Skipped under the Vite dev server (`import.meta.env.DEV`) so Hot Module
 * Replacement isn't intercepted by a precaching SW. In every production-style
 * build (served by Express on port 5000 or in deployment) it registers on load.
 *
 * The SW itself uses skipWaiting + clientsClaim, so a new build activates as
 * soon as it installs; we also reload once on controller change so the freshly
 * activated SW serves the current page's assets without a manual refresh.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const isDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  if (isDev) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => {
        // Registration failures must never break the app — it just won't be
        // offline-capable on this load.
        console.warn('[sw] registration failed:', err);
      });
  });

  // When a new SW takes control (after an update), reload once so the page runs
  // against the new precached bundle. Guard against reload loops.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}
