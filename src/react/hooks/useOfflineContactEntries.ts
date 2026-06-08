/**
 * React hook exposing queued **contact** writes keyed by contact id, for the
 * customers list (Offline Phase 2 — per-card pending/synced state).
 *
 * Lead-status, substatus and rooms/notes (archive) edits are recorded in the
 * offline outbox (`offlineQueue.ts`) via `sendOrQueue` (area `'customer'`) when
 * the device is offline or a write fails transiently. The customers list
 * fetches from the server, so a queued change is invisible until it replays —
 * the card keeps showing the optimistic value with no cue that it is unsynced.
 * This hook surfaces those queued writes keyed by contact id so each card can
 * badge itself with a Pending sync / Sync failed pill until the sync engine
 * drains the outbox.
 *
 * Contact writes don't carry a `recordKey`, so the contact id is parsed from
 * the write URL (`/api/contacts/:id` or `/api/contacts/:id/localdata`). When a
 * contact has several queued writes, the most attention-worthy status wins
 * (failed > syncing > pending) so the badge reflects the worst state.
 *
 * Mirrors `useOfflinePhotoReviewEntries.ts`. The queue module (and its `idb`
 * dependency) is **dynamically imported** so it never enters the always-loaded
 * main bundle — only the erased `import type` is used at module scope.
 */

import { useEffect, useState } from 'react';
import type { QueueEntry, QueueStatus } from '../lib/offlineQueue';

/** Statuses that warrant a per-card badge (a `synced` entry is already gone). */
type BadgeableStatus = Exclude<QueueStatus, 'synced'>;

const STATUS_RANK: Record<BadgeableStatus, number> = {
  failed: 3,
  syncing: 2,
  pending: 1,
};

/** Extract the contact id from a queued customer write URL, or null. */
function contactIdFromUrl(url: string): string | null {
  const m = url.match(/^\/api\/contacts\/([^/?#]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function badgeableStatus(e: QueueEntry): BadgeableStatus | null {
  if (e.area !== 'customer') return null;
  if (e.status === 'synced') return null;
  const id = contactIdFromUrl(e.url);
  if (!id) return null;
  return e.status;
}

/**
 * Aggregated offline-sync state for a single contact's queued writes.
 * `status` is the worst (most attention-worthy) badge to show; `failedIds`
 * lists every queued entry currently `failed`, so the card can offer a
 * Retry / Discard affordance that targets exactly the stuck writes (a mixed
 * pending+failed contact keeps its pending writes when the failed ones are
 * retried or discarded).
 */
export interface ContactSyncState {
  status: BadgeableStatus;
  failedIds: number[];
}

/**
 * Queued contact writes aggregated by contact id. A contact with no queued
 * change is simply absent from the map. The badge clears once the sync engine
 * drains the outbox (the queue's pub/sub and the `mo:offline-sync-ok` event both
 * trigger a refresh).
 */
export function useOfflineContactEntries(): Map<string, ContactSyncState> {
  const [entries, setEntries] = useState<Map<string, ContactSyncState>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    let mod: typeof import('../lib/offlineQueue') | null = null;

    const refresh = () => {
      mod?.getEntries()
        .then((list) => {
          if (cancelled) return;
          const map = new Map<string, ContactSyncState>();
          for (const raw of list) {
            const status = badgeableStatus(raw);
            if (!status) continue;
            const id = contactIdFromUrl(raw.url);
            if (!id) continue;
            const existing = map.get(id);
            if (!existing) {
              map.set(id, {
                status,
                failedIds: status === 'failed' ? [raw.id] : [],
              });
            } else {
              if (STATUS_RANK[status] > STATUS_RANK[existing.status]) {
                existing.status = status;
              }
              if (status === 'failed') existing.failedIds.push(raw.id);
            }
          }
          setEntries(map);
        })
        .catch(() => { /* best-effort */ });
    };

    import('../lib/offlineQueue')
      .then((m) => {
        if (cancelled) return;
        mod = m;
        unsubscribe = m.subscribe(refresh);
        refresh();
      })
      .catch(() => { /* offline queue unavailable — stay empty */ });

    const onSyncEvent = () => refresh();
    window.addEventListener('mo:offline-sync-failed', onSyncEvent);
    window.addEventListener('mo:offline-sync-conflict', onSyncEvent);
    window.addEventListener('mo:offline-sync-ok', onSyncEvent);
    window.addEventListener('online', onSyncEvent);

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('mo:offline-sync-failed', onSyncEvent);
      window.removeEventListener('mo:offline-sync-conflict', onSyncEvent);
      window.removeEventListener('mo:offline-sync-ok', onSyncEvent);
      window.removeEventListener('online', onSyncEvent);
    };
  }, []);

  return entries;
}
