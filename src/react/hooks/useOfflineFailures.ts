/**
 * React hook exposing the offline write-queue entries that permanently failed
 * (Offline Phase 2 — manual retry surface).
 *
 * After the sync engine exhausts an entry's retry budget it parks the entry as
 * `failed` with its `lastError`. This hook surfaces those entries to the header
 * retry UI (`SyncPill`) and provides one-tap `retry` / `discard` actions. Like
 * `useOfflineQueue` / `useOfflineConflicts`, the queue module (and its `idb`
 * dependency) is **dynamically imported** so it never enters the always-loaded
 * main bundle — only the erased `import type` is used at module scope.
 *
 * Returns an empty list until the queue module resolves and on platforms
 * without IndexedDB. `retry` resets a single failed entry to `pending` and kicks
 * a flush; `discard` removes it from the queue entirely.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { QueueEntry } from '../lib/offlineQueue';

export interface UseOfflineFailures {
  failures: QueueEntry[];
  count: number;
  retry: (id: number) => Promise<void>;
  discard: (id: number) => Promise<void>;
}

export function useOfflineFailures(): UseOfflineFailures {
  const [failures, setFailures] = useState<QueueEntry[]>([]);
  const modRef = useRef<typeof import('../lib/offlineQueue') | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};

    const refresh = () => {
      modRef.current?.getEntries()
        .then((list) => {
          if (cancelled) return;
          setFailures(list.filter((e) => e.status === 'failed'));
        })
        .catch(() => { /* best-effort */ });
    };

    import('../lib/offlineQueue')
      .then((m) => {
        if (cancelled) return;
        modRef.current = m;
        unsubscribe = m.subscribe(refresh);
        refresh();
      })
      .catch(() => { /* offline queue unavailable — stay empty */ });

    const onSyncEvent = () => refresh();
    window.addEventListener('mo:offline-sync-failed', onSyncEvent);
    window.addEventListener('online', onSyncEvent);

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('mo:offline-sync-failed', onSyncEvent);
      window.removeEventListener('online', onSyncEvent);
    };
  }, []);

  const retry = useCallback(async (id: number) => {
    const engine = await import('../lib/syncEngine');
    await engine.retryEntry(id);
  }, []);

  const discard = useCallback(async (id: number) => {
    await modRef.current?.removeEntry(id);
  }, []);

  return { failures, count: failures.length, retry, discard };
}
