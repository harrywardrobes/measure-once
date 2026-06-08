/**
 * React hook exposing the persisted offline sync conflicts (Offline Phase 3).
 *
 * When a queued write replays onto a record that changed on the server, the sync
 * engine applies last-write-wins-with-warning and persists a row in the
 * IndexedDB `conflicts` store. This hook surfaces that store to the review UI
 * (`ConflictsReview`). Like `useOfflineQueue`, the queue module (and its `idb`
 * dependency) is **dynamically imported** so it never enters the always-loaded
 * main bundle — only the erased `import type` is used at module scope.
 *
 * Returns an empty list until the queue module resolves and on platforms
 * without IndexedDB. `dismiss` clears a single conflict; `dismissAll` clears
 * every persisted conflict.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConflictEntry } from '../lib/offlineQueue';

export interface UseOfflineConflicts {
  conflicts: ConflictEntry[];
  count: number;
  dismiss: (id: number) => Promise<void>;
  dismissAll: () => Promise<void>;
}

export function useOfflineConflicts(): UseOfflineConflicts {
  const [conflicts, setConflicts] = useState<ConflictEntry[]>([]);
  const modRef = useRef<typeof import('../lib/offlineQueue') | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};

    const refresh = () => {
      modRef.current?.getConflicts()
        .then((list) => { if (!cancelled) setConflicts(list); })
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
    window.addEventListener('mo:offline-sync-conflict', onSyncEvent);
    window.addEventListener('online', onSyncEvent);

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('mo:offline-sync-conflict', onSyncEvent);
      window.removeEventListener('online', onSyncEvent);
    };
  }, []);

  const dismiss = useCallback(async (id: number) => {
    await modRef.current?.clearConflict(id);
  }, []);

  const dismissAll = useCallback(async () => {
    const mod = modRef.current;
    if (!mod) return;
    const list = await mod.getConflicts();
    await Promise.all(list.map((c) => mod.clearConflict(c.id)));
  }, []);

  return { conflicts, count: conflicts.length, dismiss, dismissAll };
}
