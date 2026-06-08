/**
 * React hook exposing queued **design-visit** writes for a single contact
 * (Offline Phase 2 — per-visit pending/synced state).
 *
 * The design-visit wizard records create/edit writes in the offline outbox
 * (`offlineQueue.ts`) via `sendOrQueue` when the device is offline or a write
 * fails transiently. The customer detail page's design-visit list fetches from
 * the server, so a visit captured offline is invisible until it syncs. This
 * hook surfaces those queued writes so the list can show a pending card (for a
 * new visit) or a "pending sync" badge (for an edit) until the sync engine
 * drains them.
 *
 * The queue module (and its `idb` dependency) is **dynamically imported** so it
 * never enters the always-loaded main bundle — only the erased `import type` is
 * used at module scope.
 */

import { useEffect, useState } from 'react';
import type { QueueEntry, QueueStatus } from '../lib/offlineQueue';

export interface PendingVisitEntry {
  /** Outbox entry id. */
  id: number;
  status: QueueStatus;
  /** True when this entry edits an existing server visit (vs. a brand-new one). */
  isEdit: boolean;
  /** Server visit id this edit targets, or null for a create. */
  editVisitId: number | null;
  contactId: string | null;
  contactName: string | null;
  visitDate: string | null;
  /** When the write was first queued (epoch ms). */
  createdAt: number;
  /** Estimate total derived from the queued room lines, in pence. */
  estimateTotalPence: number;
  lastError?: string;
  /**
   * The raw queued request body (the wizard's submit payload). Exposed so an
   * edit can be resumed from the user's unsynced changes rather than the stale
   * server copy. `null` when the entry carries no JSON body (e.g. multipart).
   */
  queuedBody: Record<string, unknown> | null;
  /** Server `version` this queued edit was based on (for conflict detection). */
  baseVersion: number | null;
  /** Server `updated_at` this queued edit was based on (ISO string). */
  baseUpdatedAt: string | null;
}

function parseEntry(e: QueueEntry): PendingVisitEntry | null {
  // Only design-visit writes — arrange-visit outcomes also use area 'visit' but
  // post to a different URL.
  if (e.area !== 'visit') return null;
  if (!e.url.startsWith('/api/design-visits')) return null;

  // Preserve raw-body semantics: `rawBody` is null when the entry carries no
  // readable JSON body (e.g. a multipart write), so resume can fall back to the
  // server copy rather than prefilling from an empty object. `body` is a safe
  // accessor only for deriving the summary fields below.
  const rawBody = e.body && typeof e.body === 'object' ? (e.body as Record<string, unknown>) : null;
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const rooms = Array.isArray(body.rooms) ? (body.rooms as Array<Record<string, unknown>>) : [];
  const estimateTotalPence = rooms.reduce(
    (s, r) => s + (Number(r.unitPricePence) || 0) * (Number(r.unitCount) || 0),
    0,
  );

  let editVisitId: number | null = null;
  if (e.recordKey && e.recordKey.startsWith('design-visit:')) {
    const n = Number(e.recordKey.slice('design-visit:'.length));
    editVisitId = Number.isFinite(n) ? n : null;
  }

  return {
    id: e.id,
    status: e.status,
    isEdit: editVisitId != null,
    editVisitId,
    contactId: typeof body.contactId === 'string' ? body.contactId : null,
    contactName: typeof body.contactName === 'string' ? body.contactName : null,
    visitDate: typeof body.visitDate === 'string' ? body.visitDate : null,
    createdAt: e.createdAt,
    estimateTotalPence,
    lastError: e.lastError,
    queuedBody: rawBody,
    baseVersion: typeof e.baseVersion === 'number' ? e.baseVersion : null,
    baseUpdatedAt: typeof e.baseUpdatedAt === 'string' ? e.baseUpdatedAt : null,
  };
}

/** Queued design-visit writes for `contactId`, oldest first. */
export function useOfflineVisitEntries(contactId: string): PendingVisitEntry[] {
  const [entries, setEntries] = useState<PendingVisitEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    let mod: typeof import('../lib/offlineQueue') | null = null;

    const refresh = () => {
      mod?.getEntries()
        .then((list) => {
          if (cancelled) return;
          const parsed = list
            .map(parseEntry)
            .filter((x): x is PendingVisitEntry => !!x && x.contactId === contactId);
          setEntries(parsed);
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
