/**
 * React hook exposing queued **survey-visit** writes for a single contact
 * (Offline Phase 2 — per-visit pending/synced state).
 *
 * Mirrors `useOfflineVisitEntries` for design visits, but filters the outbox
 * for survey-visit writes (`/api/survey-visits` URL prefix, `sv:` record key).
 *
 * The queue module (and its `idb` dependency) is **dynamically imported** so it
 * never enters the always-loaded main bundle — only the erased `import type` is
 * used at module scope.
 */

import { useEffect, useState } from 'react';
import type { QueueEntry, QueueStatus } from '../lib/offlineQueue';

export interface PendingSurveyVisitEntry {
  id: number;
  status: QueueStatus;
  isEdit: boolean;
  editVisitId: number | null;
  /** True when this entry is a refund request (not a new visit or an edit). */
  isRefund: boolean;
  /**
   * When the refund was triggered from an existing survey visit, the visit's
   * numeric ID. Allows the badge to be shown inline on that visit card rather
   * than as a contact-level banner.
   */
  refundVisitId: number | null;
  contactId: string | null;
  contactName: string | null;
  visitDate: string | null;
  createdAt: number;
  estimateTotalPence: number;
  lastError?: string;
  queuedBody: Record<string, unknown> | null;
  baseVersion: number | null;
  baseUpdatedAt: string | null;
}

function parseEntry(e: QueueEntry): PendingSurveyVisitEntry | null {
  if (e.area !== 'visit') return null;
  if (!e.url.startsWith('/api/survey-visits')) return null;

  const rawBody = e.body && typeof e.body === 'object' ? (e.body as Record<string, unknown>) : null;
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const rooms = Array.isArray(body.rooms) ? (body.rooms as Array<Record<string, unknown>>) : [];
  const estimateTotalPence = rooms.reduce(
    (s, r) => s + (Number(r.unitPricePence) || 0) * (Number(r.unitCount) || 0),
    0,
  );

  const isRefund = e.url === '/api/survey-visits/refund';

  let editVisitId: number | null = null;
  if (!isRefund && e.recordKey && e.recordKey.startsWith('sv:')) {
    const n = Number(e.recordKey.slice('sv:'.length));
    editVisitId = Number.isFinite(n) ? n : null;
  }

  let refundVisitId: number | null = null;
  if (isRefund && typeof body.surveyVisitId === 'number' && Number.isFinite(body.surveyVisitId)) {
    refundVisitId = body.surveyVisitId;
  }

  return {
    id: e.id,
    status: e.status,
    isEdit: editVisitId != null,
    editVisitId,
    isRefund,
    refundVisitId,
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

/** Queued survey-visit writes for `contactId`, oldest first. */
export function useOfflineSurveyVisitEntries(contactId: string): PendingSurveyVisitEntry[] {
  const [entries, setEntries] = useState<PendingSurveyVisitEntry[]>([]);

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
            .filter((x): x is PendingSurveyVisitEntry => !!x && x.contactId === contactId);
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
