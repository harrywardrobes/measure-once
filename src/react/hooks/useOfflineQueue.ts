/**
 * React hook exposing the offline write-queue counts (Offline Phase 2).
 *
 * Used by the GlobalHeader pending-sync indicator and any per-item UI. The queue
 * module (and its `idb` dependency) is **dynamically imported** so it never
 * enters the always-loaded main bundle — only the erased `import type` is used at
 * module scope. Returns all-zero counts until the queue module resolves and on
 * platforms without IndexedDB.
 */

import { useEffect, useState } from 'react';
import type { QueueCounts } from '../lib/offlineQueue';

const ZERO: QueueCounts = { total: 0, pending: 0, syncing: 0, failed: 0 };

export function useOfflineQueue(): QueueCounts {
  const [counts, setCounts] = useState<QueueCounts>(ZERO);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    let mod: typeof import('../lib/offlineQueue') | null = null;

    const refresh = () => {
      mod?.getCounts()
        .then((c) => { if (!cancelled) setCounts(c); })
        .catch(() => { /* best-effort */ });
    };

    import('../lib/offlineQueue')
      .then((m) => {
        if (cancelled) return;
        mod = m;
        unsubscribe = m.subscribe(refresh);
        refresh();
      })
      .catch(() => { /* offline queue unavailable — stay at zero */ });

    const onSyncEvent = () => refresh();
    window.addEventListener('mo:offline-sync-failed', onSyncEvent);
    window.addEventListener('mo:offline-sync-conflict', onSyncEvent);
    window.addEventListener('online', onSyncEvent);

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('mo:offline-sync-failed', onSyncEvent);
      window.removeEventListener('mo:offline-sync-conflict', onSyncEvent);
      window.removeEventListener('online', onSyncEvent);
    };
  }, []);

  return counts;
}
