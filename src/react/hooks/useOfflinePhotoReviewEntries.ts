/**
 * React hook exposing queued **photo-review** outcomes for a single contact
 * (Offline Phase 2 — per-submission pending/synced state).
 *
 * The "Review customer photos" drawer records a `not_suitable` / `rough_estimate`
 * outcome in the offline outbox (`offlineQueue.ts`) via `sendOrQueue` (area
 * `'photo'`) when the device is offline or a write fails transiently. The
 * customer-info submissions rail fetches from the server, so a queued review is
 * invisible until it replays. This hook surfaces those queued writes keyed by
 * submission id so the rail can badge the matching submission card with a
 * pending / syncing / failed pill until the sync engine drains them.
 *
 * Mirrors `useOfflineVisitEntries.ts`. The queue module (and its `idb`
 * dependency) is **dynamically imported** so it never enters the always-loaded
 * main bundle — only the erased `import type` is used at module scope.
 */

import { useEffect, useState } from 'react';
import type { QueueEntry, QueueStatus } from '../lib/offlineQueue';

export interface PendingPhotoReviewEntry {
  /** Outbox entry id. */
  id: number;
  status: QueueStatus;
  /** Submission id this review targets (from the `customer-info:<id>` recordKey). */
  submissionId: number | null;
  contactId: string | null;
  /** The queued outcome (`not_suitable` / `rough_estimate_sent`), if present. */
  outcome: string | null;
  /** When the write was first queued (epoch ms). */
  createdAt: number;
  lastError?: string;
}

function parseEntry(e: QueueEntry): PendingPhotoReviewEntry | null {
  if (e.area !== 'photo') return null;
  if (!e.url.startsWith('/api/card-actions/review-customer-photos')) return null;

  const body = e.body && typeof e.body === 'object' ? (e.body as Record<string, unknown>) : {};

  let submissionId: number | null = null;
  if (e.recordKey && e.recordKey.startsWith('customer-info:')) {
    const n = Number(e.recordKey.slice('customer-info:'.length));
    submissionId = Number.isFinite(n) ? n : null;
  }

  return {
    id: e.id,
    status: e.status,
    submissionId,
    contactId: typeof body.contactId === 'string' ? body.contactId : null,
    outcome: typeof body.outcome === 'string' ? body.outcome : null,
    createdAt: e.createdAt,
    lastError: e.lastError,
  };
}

/**
 * Queued photo-review outcomes for `contactId`, keyed by the targeted
 * submission id. A submission with no queued review is simply absent from the
 * map. The entry clears once the sync engine drains the outbox (the queue's
 * pub/sub and the `mo:offline-sync-ok` event both trigger a refresh).
 */
export function useOfflinePhotoReviewEntries(
  contactId: string,
): Map<number, PendingPhotoReviewEntry> {
  const [entries, setEntries] = useState<Map<number, PendingPhotoReviewEntry>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    let mod: typeof import('../lib/offlineQueue') | null = null;

    const refresh = () => {
      mod?.getEntries()
        .then((list) => {
          if (cancelled) return;
          const map = new Map<number, PendingPhotoReviewEntry>();
          for (const raw of list) {
            const parsed = parseEntry(raw);
            if (!parsed) continue;
            if (parsed.contactId !== contactId) continue;
            if (parsed.submissionId == null) continue;
            map.set(parsed.submissionId, parsed);
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
  }, [contactId]);

  return entries;
}
