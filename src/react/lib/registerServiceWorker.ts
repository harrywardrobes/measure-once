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
  // Clear the cached last-known user so the offline cold-start fallback doesn't
  // resurrect the signed-out account on a shared device.
  try {
    const { LAST_KNOWN_USER_KEY } = await import('../constants/localStorageKeys');
    localStorage.removeItem(LAST_KNOWN_USER_KEY);
  } catch { /* best-effort */ }
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

// Set only when the user taps "Refresh" on the update prompt. The SW is built
// with skipWaiting: false, so a new worker never activates on its own — the only
// controllerchange we should reload on is the one we asked for.
let userTriggeredRefresh = false;

// Workers we've already surfaced a prompt for, so a second event for the same
// waiting worker doesn't stack a duplicate toast.
const promptedWorkers = new WeakSet<ServiceWorker>();

/**
 * Show the persistent "A new version is available — Refresh" toast for a waiting
 * service worker. Reuses the app-wide toast shim (window.showToastWithAction,
 * registered by ToastProvider). If the SW update fires before React has mounted
 * the provider, retry briefly until the shim exists.
 */
function promptUpdate(waiting: ServiceWorker): void {
  if (promptedWorkers.has(waiting)) return;

  const tryShow = (): boolean => {
    const w = window as unknown as {
      showToastWithAction?: (
        msg: string,
        action: { label: string; onClick: () => void },
        options?: { duration?: number | null; severity?: string },
      ) => void;
    };
    if (typeof w.showToastWithAction !== 'function') return false;
    promptedWorkers.add(waiting);
    w.showToastWithAction(
      'A new version is available.',
      {
        label: 'Refresh',
        onClick: () => {
          userTriggeredRefresh = true;
          waiting.postMessage({ type: 'SKIP_WAITING' });
        },
      },
      { severity: 'info', duration: null }, // null = persistent (no auto-hide)
    );
    return true;
  };

  if (tryShow()) return;
  let tries = 0;
  const timer = window.setInterval(() => {
    if (tryShow() || ++tries >= 20) window.clearInterval(timer);
  }, 500);
}

/**
 * Registers the Workbox service worker (public/sw.js) at the site root.
 *
 * Skipped under the Vite dev server (`import.meta.env.DEV`) so Hot Module
 * Replacement isn't intercepted by a precaching SW. In every production-style
 * build (served by Express on port 5000 or in deployment) it registers on load.
 *
 * Prompt-to-update flow: the SW is built with skipWaiting: false + clientsClaim,
 * so a new build installs but stays WAITING rather than taking over. When an
 * update is ready we surface a persistent, dismissible toast; only when the user
 * taps "Refresh" do we message the worker to skipWaiting, which triggers a
 * controllerchange — and only that user-initiated change reloads the page.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const isDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  if (isDev) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // An update detected on a previous launch but not yet taken — the key
        // path for iOS home-screen relaunches. controller present ⇒ not the
        // first install.
        if (registration.waiting && navigator.serviceWorker.controller) {
          promptUpdate(registration.waiting);
        }

        // An update that installs while the app is open.
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // 'installed' + an existing controller ⇒ an update is waiting (not
            // the first install). skipWaiting: false means it sits in .waiting.
            if (installing.state === 'installed' && navigator.serviceWorker.controller && registration.waiting) {
              promptUpdate(registration.waiting);
            }
          });
        });
      })
      .catch((err) => {
        // Registration failures must never break the app — it just won't be
        // offline-capable on this load.
        console.warn('[sw] registration failed:', err);
      });
  });

  // Reload once when the worker we activated takes control. Gated on
  // userTriggeredRefresh so the first-install controllerchange (from
  // clientsClaim) never reloads. Guard against reload loops.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!userTriggeredRefresh || reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

/**
 * Boot the offline write-queue sync engine (Offline Phase 2).
 *
 * The engine (and its `idb` dependency, via `offlineQueue`/`offlineDb`) is
 * dynamically imported so it never enters the always-loaded main bundle. Safe to
 * call unconditionally — it no-ops where `window` is unavailable and the engine
 * itself is idempotent.
 */
export function initOfflineSync(): void {
  import('./syncEngine')
    .then((m) => m.initSyncEngine())
    .catch(() => {
      // Offline sync is an enhancement; failure to load it must not break boot.
    });
}
