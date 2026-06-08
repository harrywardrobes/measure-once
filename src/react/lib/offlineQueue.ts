/**
 * Offline write queue (Offline Phase 2).
 *
 * A structured, IndexedDB-backed outbox that captures create/update actions for
 * the three target areas — Customer details, Visits & schedule, and Photo
 * capture/upload — while the device is offline (or a write fails with a
 * network/server error). The sync engine (`syncEngine.ts`) drains it on the
 * `online` event.
 *
 * Responsibilities of this module:
 *  - Domain-typed queue entries with explicit status tracking
 *    (`pending` → `syncing` → `synced` | `failed`).
 *  - Enqueue with optional **dedupe**: repeated edits to the same record
 *    (e.g. flipping a lead status twice offline) collapse to the latest write.
 *  - A tiny pub/sub so the header indicator / per-item UI re-renders when the
 *    queue changes, without a shared React tree.
 *  - A durable conflict log for the Phase 3 conflicts view.
 *
 * The raw IndexedDB primitives live in `offlineDb.ts`; this module never touches
 * `idb` directly. Both modules are loaded only via dynamic `import()` so the
 * `idb` dependency stays out of the always-loaded main bundle.
 */

import {
  outboxAdd,
  outboxGetAll,
  outboxPut,
  outboxDelete,
  conflictAdd,
  conflictGetAll,
  conflictDelete,
  getMeta,
  setMeta,
} from './offlineDb';

// ── Types ─────────────────────────────────────────────────────────────────────

/** The three offline-syncable areas. */
export type OfflineArea = 'customer' | 'visit' | 'photo';

/** HTTP verbs the queue can replay. */
export type QueueMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Per-item lifecycle status. */
export type QueueStatus = 'pending' | 'syncing' | 'synced' | 'failed';

/**
 * A serialized multipart field. Files are stored as `Blob`s, which IndexedDB
 * persists via structured clone, so photo uploads survive a refresh/restart and
 * can be rebuilt into a `FormData` on replay.
 */
export interface QueuedFormField {
  name: string;
  /** Present for file parts. */
  blob?: Blob;
  /** Original filename for file parts. */
  filename?: string;
  /** Present for plain text parts. */
  value?: string;
}

export interface QueueEntry {
  /** Auto-increment primary key; assigned on persist. */
  id: number;
  area: OfflineArea;
  /** Short human-readable summary for the pending-sync UI. */
  label: string;
  method: QueueMethod;
  url: string;
  /** JSON body for `application/json` writes. Omitted for multipart. */
  body?: unknown;
  /** When set, the entry is replayed as `multipart/form-data`. */
  formFields?: QueuedFormField[];

  // ── Conflict-detection inputs (optional) ──
  /** GET URL used to read the current server record before an update replays. */
  conflictCheckUrl?: string;
  /** Cached `version` the edit was based on. */
  baseVersion?: number | null;
  /** Cached `updated_at`/`updatedAt` the edit was based on (ISO string). */
  baseUpdatedAt?: string | null;
  /** Stable record key (e.g. `dv:123`) — links the entry to a conflict row. */
  recordKey?: string;

  // ── Lifecycle bookkeeping ──
  status: QueueStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  /** Earliest time (epoch ms) the entry may be retried (backoff scheduling). */
  nextAttemptAt: number;
  lastError?: string;
  /**
   * When set, a newer enqueue for the same key replaces this entry instead of
   * appending a second one — so a queue never accumulates N stale edits of one
   * field.
   */
  dedupeKey?: string;
}

/** Input accepted by {@link enqueue}; bookkeeping fields are filled in here. */
export interface EnqueueInput {
  area: OfflineArea;
  label: string;
  method: QueueMethod;
  url: string;
  body?: unknown;
  formFields?: QueuedFormField[];
  conflictCheckUrl?: string;
  baseVersion?: number | null;
  baseUpdatedAt?: string | null;
  recordKey?: string;
  dedupeKey?: string;
}

export interface ConflictEntry {
  id: number;
  area: OfflineArea;
  label: string;
  url: string;
  method: QueueMethod;
  recordKey?: string;
  attemptedBody?: unknown;
  baseVersion?: number | null;
  baseUpdatedAt?: string | null;
  serverVersion?: number | null;
  serverUpdatedAt?: string | null;
  /** Snapshot of the server record at conflict time, for the Phase 3 view. */
  serverData?: unknown;
  /** How the engine handled it: applied anyway, or held for manual review. */
  resolution: 'last_write_wins' | 'flagged';
  detectedAt: number;
}

// ── Pub/sub ────────────────────────────────────────────────────────────────────
// Module-level singleton so the header indicator and any per-item UI re-render
// when the queue changes, mirroring the pattern in ConnectionToastContext.

const _subscribers = new Set<() => void>();

/** Subscribe to queue changes. Returns an unsubscribe function. */
export function subscribe(cb: () => void): () => void {
  _subscribers.add(cb);
  return () => { _subscribers.delete(cb); };
}

function _notify(): void {
  for (const cb of _subscribers) {
    try { cb(); } catch { /* a subscriber error must not break the queue */ }
  }
}

// ── Queue operations ────────────────────────────────────────────────────────────

/**
 * Add a write to the queue. If `dedupeKey` is supplied and a non-syncing entry
 * with the same key already exists, it is replaced in place (keeping its id and
 * `createdAt`) so only the latest edit of that record is ever replayed.
 */
export async function enqueue(input: EnqueueInput): Promise<QueueEntry | null> {
  const now = Date.now();

  if (input.dedupeKey) {
    const existing = (await outboxGetAll<QueueEntry>()).find(
      (e) => e.dedupeKey === input.dedupeKey && e.status !== 'syncing',
    );
    if (existing) {
      const merged: QueueEntry = {
        ...existing,
        ...input,
        id: existing.id,
        status: 'pending',
        attempts: 0,
        createdAt: existing.createdAt,
        updatedAt: now,
        nextAttemptAt: now,
        lastError: undefined,
      };
      await outboxPut(merged as unknown as Record<string, unknown>);
      _notify();
      return merged;
    }
  }

  const record = {
    area: input.area,
    label: input.label,
    method: input.method,
    url: input.url,
    body: input.body,
    formFields: input.formFields,
    conflictCheckUrl: input.conflictCheckUrl,
    baseVersion: input.baseVersion ?? null,
    baseUpdatedAt: input.baseUpdatedAt ?? null,
    recordKey: input.recordKey,
    status: 'pending' as QueueStatus,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    dedupeKey: input.dedupeKey,
  };
  const id = await outboxAdd(record);
  if (id === null) return null;
  const entry: QueueEntry = { ...record, id };
  _notify();
  return entry;
}

/** All queue entries, oldest first. */
export async function getEntries(): Promise<QueueEntry[]> {
  return outboxGetAll<QueueEntry>();
}

/** Patch an entry by id and notify subscribers. */
export async function updateEntry(id: number, patch: Partial<QueueEntry>): Promise<void> {
  const all = await outboxGetAll<QueueEntry>();
  const current = all.find((e) => e.id === id);
  if (!current) return;
  const next: QueueEntry = { ...current, ...patch, id, updatedAt: Date.now() };
  await outboxPut(next as unknown as Record<string, unknown>);
  _notify();
}

/** Remove an entry (e.g. after a successful sync). */
export async function removeEntry(id: number): Promise<void> {
  await outboxDelete(id);
  _notify();
}

/**
 * Counts by lifecycle bucket for the pending-sync indicator. `pending` includes
 * entries awaiting their first attempt or a backoff retry; `failed` are those
 * that exhausted their retry budget and need attention.
 */
export interface QueueCounts {
  total: number;
  pending: number;
  syncing: number;
  failed: number;
}

export async function getCounts(): Promise<QueueCounts> {
  const all = await outboxGetAll<QueueEntry>();
  let pending = 0, syncing = 0, failed = 0;
  for (const e of all) {
    if (e.status === 'pending') pending++;
    else if (e.status === 'syncing') syncing++;
    else if (e.status === 'failed') failed++;
  }
  return { total: all.length, pending, syncing, failed };
}

// ── Conflict log ────────────────────────────────────────────────────────────────

/** Persist a detected conflict for the Phase 3 conflicts view. */
export async function recordConflict(input: Omit<ConflictEntry, 'id' | 'detectedAt'>): Promise<void> {
  await conflictAdd({ ...input, detectedAt: Date.now() });
  _notify();
}

/** All persisted conflicts, oldest first. */
export async function getConflicts(): Promise<ConflictEntry[]> {
  return conflictGetAll<ConflictEntry>();
}

// ── sendOrQueue ──────────────────────────────────────────────────────────────────

export interface SendOrQueueResult {
  /** True when the write was parked in the offline queue instead of sent now. */
  queued: boolean;
  /** True when the write was sent and the server returned 2xx. */
  ok: boolean;
  /** Status code (0 on network error / when queued offline). */
  status: number;
  /** Parsed JSON response when the write was sent. */
  data?: unknown;
}

/**
 * Offline-aware write. Sends immediately when online; on a network error (or
 * while offline) the write is parked in the queue and replayed later. Transient
 * server errors (5xx / 429 / 408) are also queued for retry. Permanent client
 * errors (4xx) are returned to the caller — they would never succeed on retry,
 * so the caller surfaces them as it would for a normal failed request.
 */
export async function sendOrQueue(input: EnqueueInput): Promise<SendOrQueueResult> {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;

  if (!offline) {
    try {
      const init: RequestInit = { method: input.method, credentials: 'same-origin' };
      if (input.formFields && input.formFields.length) {
        const fd = new FormData();
        for (const f of input.formFields) {
          if (f.blob) fd.append(f.name, f.blob, f.filename);
          else fd.append(f.name, f.value ?? '');
        }
        init.body = fd;
      } else if (input.body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(input.body);
      }
      const r = await fetch(input.url, init);
      const data = await r.json().catch(() => ({}));
      if (r.ok) return { queued: false, ok: true, status: r.status, data };
      if (r.status >= 500 || r.status === 429 || r.status === 408) {
        await enqueue(input);
        return { queued: true, ok: false, status: r.status, data };
      }
      return { queued: false, ok: false, status: r.status, data };
    } catch {
      await enqueue(input);
      return { queued: true, ok: false, status: 0 };
    }
  }

  await enqueue(input);
  return { queued: true, ok: false, status: 0 };
}

// ── Calendar follow-up for offline visit edits ──────────────────────────────────
// When a visit edit is queued offline, its linked Google Calendar event can't be
// updated then (Calendar needs a live Google session). Queue the calendar PATCH
// as its own entry so the sync engine replays it on reconnect — keeping the
// calendar in step with the visit instead of silently drifting. If the Google
// session is gone at replay time the endpoint returns 401, which the sync engine
// surfaces as a failed change the user can see and retry.

export interface CalendarUpdateInput {
  /** Google Calendar event id to patch. */
  googleEventId: string;
  summary: string;
  description: string;
  location: string;
  /** Event start as an ISO 8601 string. */
  startISO: string;
  /** Event end as an ISO 8601 string. */
  endISO: string;
  /** Short human-readable summary for the pending-sync UI. */
  label: string;
}

/**
 * Queue a Google Calendar event update to replay after an offline visit edit.
 * Replayed in insertion order, so it runs after the visit edit it follows. No
 * conflict base is attached — last-write-wins mirrors the visit edit it tracks.
 */
export async function queueCalendarUpdate(input: CalendarUpdateInput): Promise<void> {
  await enqueue({
    area: 'visit',
    label: input.label,
    method: 'PATCH',
    url: `/api/events/${input.googleEventId}`,
    body: {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startISO },
      end: { dateTime: input.endISO },
    },
  });
}

/** Clear a single conflict (used by the future Phase 3 review UI). */
export async function clearConflict(id: number): Promise<void> {
  await conflictDelete(id);
  _notify();
}

// ── Conflict resolution ──────────────────────────────────────────────────────────
// A persisted conflict starts out resolved last-write-wins: the queued edit has
// already overwritten the server copy. The review UI lets the user revisit that
// choice per conflict (or per field):
//  - "Keep my edit"      → just clear the conflict (`resolvedBody === null`).
//  - "Restore server copy" / per-field selection → replay a write that re-applies
//    the chosen server values, then clear the conflict.
//
// The restore write is offline-aware (`sendOrQueue`): when offline it is parked
// in the outbox and replayed on reconnect, so the user's resolution is never
// lost. The conflict is cleared once the restore is sent (2xx) or queued; a
// genuine server rejection (4xx) leaves the conflict in place so the user can
// retry.

export interface ResolveConflictResult {
  /** True when the restore write was accepted by the server (2xx). */
  ok: boolean;
  /** True when the restore write was parked offline for later replay. */
  queued: boolean;
  /** Status code (0 when queued offline / on a network error). */
  status: number;
}

/**
 * Resolve a persisted conflict.
 *
 * Pass `resolvedBody === null` to keep the queued edit (just clears the
 * conflict). Pass a body object to restore server values: it is replayed with
 * the conflict's original `method`/`url`, and the conflict is cleared once the
 * write succeeds or is queued offline.
 */
export async function resolveConflict(
  conflict: ConflictEntry,
  resolvedBody: Record<string, unknown> | null,
): Promise<ResolveConflictResult> {
  if (resolvedBody === null) {
    await clearConflict(conflict.id);
    return { ok: true, queued: false, status: 0 };
  }
  const res = await sendOrQueue({
    area: conflict.area,
    label: conflict.label,
    method: conflict.method,
    url: conflict.url,
    body: resolvedBody,
    recordKey: conflict.recordKey,
  });
  if (res.ok || res.queued) {
    await clearConflict(conflict.id);
  }
  return { ok: res.ok, queued: res.queued, status: res.status };
}

// ── Last successful sync bookkeeping ─────────────────────────────────────────────
// A small `meta` timestamp the sync engine stamps after every confirmed (2xx)
// replay, so the Phase 3 Offline Support admin view can show when the queue last
// drained successfully. Stored as epoch ms.

const LAST_SYNC_META_KEY = 'lastSuccessfulSyncAt';

/** Record that a queued write just replayed successfully (epoch ms). */
export async function markSynced(at: number = Date.now()): Promise<void> {
  await setMeta(LAST_SYNC_META_KEY, at);
  _notify();
}

/** Epoch-ms timestamp of the last successful sync, or null if none recorded. */
export async function getLastSyncAt(): Promise<number | null> {
  const v = await getMeta<number>(LAST_SYNC_META_KEY);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
