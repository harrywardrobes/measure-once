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
  evictCachedRecord,
  updateCachedRecord,
  getMeta,
  setMeta,
} from './offlineDb';
import type { CacheStore } from './offlineDb';
import { resolveConflictRoute, resolveQueueEntryRoute } from './conflictRoute';
import { detectConflict } from './conflictDetection';

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
  /**
   * When true, a conflict detected at replay time **aborts** the write instead
   * of applying it last-write-wins. Used by "Restore server copy": a restore
   * must never overwrite a server change that landed after the conflict was
   * detected — the sync engine re-flags a fresh conflict and drops the entry.
   */
  abortOnConflict?: boolean;

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
  abortOnConflict?: boolean;
  dedupeKey?: string;
}

export interface ConflictEntry {
  id: number;
  area: OfflineArea;
  label: string;
  url: string;
  method: QueueMethod;
  recordKey?: string;
  /** GET URL used to re-read the current server record (e.g. before a restore). */
  conflictCheckUrl?: string;
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
    abortOnConflict: input.abortOnConflict,
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
 * Remove every non-syncing queued entry tagged with `dedupeKey`. Used when a
 * write for that record just succeeded directly, so any earlier queued write for
 * the same record is now superseded and must not replay. Entries mid-flight
 * (`syncing`) are left alone — the sync engine owns their lifecycle.
 */
export async function removeQueuedByDedupeKey(dedupeKey: string): Promise<void> {
  const all = await outboxGetAll<QueueEntry>();
  const stale = all.filter((e) => e.dedupeKey === dedupeKey && e.status !== 'syncing');
  if (!stale.length) return;
  for (const e of stale) await outboxDelete(e.id);
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
      if (r.ok) {
        // This write succeeded immediately and supersedes any write already
        // queued for the same record (e.g. resuming a failed/pending edit while
        // back online). Drop those stale entries so they don't replay later and
        // overwrite the copy we just saved.
        if (input.dedupeKey) await removeQueuedByDedupeKey(input.dedupeKey);
        return { queued: false, ok: true, status: r.status, data };
      }
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
  /**
   * True when the restore was **abandoned** because the server advanced again
   * since the conflict was detected — applying it would have clobbered that
   * newer change. A fresh conflict has been re-flagged for the user to review.
   */
  reconflicted?: boolean;
}

/** Fetch the current server record as JSON. Mirrors the sync-engine helper. */
async function fetchServerSnapshot(url: string): Promise<{ ok: boolean; data: unknown }> {
  try {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, data };
  } catch {
    return { ok: false, data: null };
  }
}

/**
 * Window event fired after a conflict is resolved by restoring server values
 * (whole-record or per-field). Open pages listen for it to re-fetch the affected
 * record so the screen reflects the restored values without a manual reload.
 */
export const CONFLICT_RESOLVED_EVENT = 'mo:offline-conflict-resolved';

export interface ConflictResolvedDetail {
  area: OfflineArea;
  recordKey?: string;
  /** The write URL the restore replayed against. */
  url: string;
  /** In-app deep link to the affected record, or null when none can be derived. */
  route: string | null;
}

/**
 * Map a resolved conflict to the structured read-cache entry that still holds
 * the queued edit, so it can be evicted after a restore. Prefers the stable
 * `recordKey` (`contact:`/`visit:`/`design-visit:`/`dv:`) and falls back to
 * parsing the write URL. Returns `null` when no cache entry can be derived.
 */
function cacheTargetForConflict(conflict: { recordKey?: string; url: string }): { store: CacheStore; id: string } | null {
  const rk = conflict.recordKey;
  if (rk) {
    const idx = rk.indexOf(':');
    if (idx > 0) {
      const type = rk.slice(0, idx);
      const id = rk.slice(idx + 1).trim();
      if (id) {
        if (type === 'contact' || type === 'customer') return { store: 'customers', id };
        if (type === 'visit') return { store: 'visits', id: `v:${id}` };
        if (type === 'dv' || type === 'design-visit') return { store: 'visits', id: `dv:${id}` };
      }
    }
  }
  const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  const cm = conflict.url.match(/\/api\/contacts\/([^/?#]+)/);
  if (cm) return { store: 'customers', id: decode(cm[1]) };
  const dm = conflict.url.match(/\/api\/design-visits\/([^/?#]+)/);
  if (dm) return { store: 'visits', id: `dv:${decode(dm[1])}` };
  const vm = conflict.url.match(/\/api\/visits\/([^/?#]+)/);
  if (vm) return { store: 'visits', id: `v:${decode(vm[1])}` };
  return null;
}

/** Response-envelope keys a server snapshot may be wrapped in. */
const RESPONSE_ENVELOPE_KEYS = ['visit', 'designVisit', 'submission', 'record', 'data'];

/** Unwrap a server snapshot from its response envelope, if any. */
function unwrapServerData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const obj = data as Record<string, unknown>;
  for (const key of RESPONSE_ENVELOPE_KEYS) {
    const nested = obj[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return obj;
}

/** Convert a write-shape (camelCase) key to its read-shape (snake_case) form. */
function toSnakeKey(key: string): string {
  return key.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`);
}

/** Recursively rewrite an object's keys to snake_case (read shape). */
export function deepSnakeize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSnakeize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[toSnakeKey(k)] = deepSnakeize(v);
    }
    return out;
  }
  return value;
}

/** Read a server value by a write-shape key, falling back to its snake_case form. */
function lookupRead(server: Record<string, unknown>, key: string): unknown {
  if (key in server) return server[key];
  const snake = toSnakeKey(key);
  return snake in server ? server[snake] : undefined;
}

function scalarEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return false;
}

/**
 * Find an element in `arr` whose `id` field equals `id`, or `undefined` when
 * no match is found or `id` is nullish. Used to match rooms by stable identity
 * rather than by array index.
 */
function findByIdIn(arr: unknown[], id: unknown): unknown {
  if (id == null) return undefined;
  return arr.find(
    (el) => el != null && typeof el === 'object' && (el as Record<string, unknown>).id === id,
  );
}

/**
 * True when every leaf in the (write-shape) resolved value matches the
 * corresponding (read-shape) server value, ignoring server-only metadata fields.
 * Used to tell a "restore server copy" field apart from a "keep mine" field so
 * the former can adopt the server snapshot's exact read shape.
 *
 * For arrays whose elements carry an `id` field, each resolved element is
 * matched to its server counterpart by `id` rather than by index, so a server-
 * side room insertion or deletion does not cause a false positive equivalence.
 * Elements without an `id` fall back to index-based comparison.
 */
export function isServerEquivalent(resolved: unknown, server: unknown): boolean {
  if (Array.isArray(resolved)) {
    if (!Array.isArray(server) || server.length !== resolved.length) return false;
    const sArr = server as unknown[];
    return resolved.every((el, i) => {
      const id = el != null && typeof el === 'object'
        ? (el as Record<string, unknown>).id
        : undefined;
      const serverEl = id != null ? findByIdIn(sArr, id) : undefined;
      return isServerEquivalent(el, serverEl !== undefined ? serverEl : sArr[i]);
    });
  }
  if (resolved && typeof resolved === 'object') {
    if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
    const sObj = server as Record<string, unknown>;
    return Object.keys(resolved as Record<string, unknown>).every((k) =>
      isServerEquivalent((resolved as Record<string, unknown>)[k], lookupRead(sObj, k)),
    );
  }
  return scalarEqual(resolved, server);
}

/**
 * Build the read-cache value for a single resolved field.
 *
 * For scalar fields and plain objects, `isServerEquivalent` at the top level
 * already selects the right branch in `buildRestoredCachePatch`. For *arrays*
 * (e.g. the design-visit `rooms` field) a mixed per-room resolve makes the
 * whole array non-equivalent even though individual server-restored rooms *are*
 * equivalent to their server counterparts. This helper applies the equivalence
 * check element-by-element so each server-restored room adopts the full server
 * object (including server-only fields like `door_style_name`), while
 * user-kept rooms are still deep-snake-cased from the write shape.
 *
 * Room matching uses the element's `id` field when available so that a server-
 * side room addition or deletion does not shift the index-to-room mapping and
 * silently apply the wrong server values. Elements without an `id` fall back
 * to index-based comparison.
 */
export function reconcileForCache(resolved: unknown, server: unknown): unknown {
  if (Array.isArray(resolved)) {
    const sArr = Array.isArray(server) ? (server as unknown[]) : [];
    return resolved.map((el, i) => {
      const id = el != null && typeof el === 'object'
        ? (el as Record<string, unknown>).id
        : undefined;
      const serverEl = id != null ? findByIdIn(sArr, id) : undefined;
      const matched = serverEl !== undefined ? serverEl : sArr[i];
      return isServerEquivalent(el, matched) ? matched : deepSnakeize(el);
    });
  }
  return deepSnakeize(resolved);
}

/**
 * Build the read-cache patch that re-applies a resolved conflict's restored
 * values, so an offline read (which can't re-fetch) still shows the restored
 * state. The resolved body is in the *write* shape (camelCase for design
 * visits); the cached record is the server *read* shape (snake_case), so each
 * key is mapped to its read-shape counterpart. Only keys that exist in the
 * server snapshot are applied — that keeps the patch in the cached record's
 * shape and skips write-only payload keys (e.g. a design visit's `handlerConfig`)
 * that don't map onto the cached record. For a field whose resolved value equals
 * the server snapshot (a true "restore"), the exact read-shape server value is
 * used; a "keep mine" value is rewritten to snake_case. For array fields (e.g.
 * `rooms`), the comparison is done element-by-element so server-restored
 * elements adopt the full server object (preserving server-only fields such as
 * `door_style_name`) even when the overall array is not identical to the
 * server's. Returns `null` when nothing maps.
 */
export function buildRestoredCachePatch(
  conflict: ConflictEntry,
  resolvedBody: Record<string, unknown>,
): Record<string, unknown> | null {
  const server = unwrapServerData(conflict.serverData);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(resolvedBody)) {
    const readKey = key in server ? key : (toSnakeKey(key) in server ? toSnakeKey(key) : null);
    if (!readKey) continue;
    const resolvedValue = resolvedBody[key];
    const serverValue = server[readKey];
    patch[readKey] = isServerEquivalent(resolvedValue, serverValue)
      ? serverValue
      : reconcileForCache(resolvedValue, serverValue);
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Resolve a persisted conflict.
 *
 * Pass `resolvedBody === null` to keep the queued edit (just clears the
 * conflict). Pass a body object to restore server values: it is replayed with
 * the conflict's original `method`/`url`, and the conflict is cleared once the
 * write succeeds or is queued offline.
 *
 * **Guard against clobbering a newer server change.** A conflict captures the
 * server snapshot at *detection* time; the user may click "Restore server copy"
 * much later. Before applying the restore we re-read the live record (when
 * online and a `conflictCheckUrl` is known) and compare it to that captured
 * snapshot. If the server has advanced *again*, we do not write — instead we
 * re-flag a fresh conflict (with the newer server state) and return
 * `reconflicted: true`, so the restore can't silently overwrite the newer
 * change. The restore write also carries the conflict-check inputs so the
 * offline-replay path re-checks at sync time too.
 */
export async function resolveConflict(
  conflict: ConflictEntry,
  resolvedBody: Record<string, unknown> | null,
): Promise<ResolveConflictResult> {
  if (resolvedBody === null) {
    await clearConflict(conflict.id);
    return { ok: true, queued: false, status: 0 };
  }

  // The snapshot the user is restoring was the server state at detection time.
  const restoreBase = {
    version: conflict.serverVersion ?? null,
    updatedAt: conflict.serverUpdatedAt ?? null,
  };
  const hasBase = restoreBase.version != null || !!restoreBase.updatedAt;
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;

  // Online re-check: if the server advanced past the snapshot we're restoring,
  // abandon the restore and re-flag rather than overwrite the newer change.
  if (!offline && conflict.conflictCheckUrl && hasBase) {
    const snap = await fetchServerSnapshot(conflict.conflictCheckUrl);
    if (snap.ok) {
      const decision = detectConflict(restoreBase, snap.data);
      if (decision.conflicted) {
        await recordConflict({
          area: conflict.area,
          label: conflict.label,
          url: conflict.url,
          method: conflict.method,
          recordKey: conflict.recordKey,
          conflictCheckUrl: conflict.conflictCheckUrl,
          attemptedBody: conflict.attemptedBody,
          baseVersion: restoreBase.version,
          baseUpdatedAt: restoreBase.updatedAt,
          serverVersion: decision.serverVersion,
          serverUpdatedAt: decision.serverUpdatedAt != null
            ? new Date(decision.serverUpdatedAt).toISOString() : null,
          serverData: snap.data,
          resolution: 'flagged',
        });
        await clearConflict(conflict.id);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('mo:offline-sync-conflict', {
            detail: { area: conflict.area, label: conflict.label, reason: 'record changed on the server again' },
          }));
        }
        return { ok: false, queued: false, status: 0, reconflicted: true };
      }
    }
  }

  const res = await sendOrQueue({
    area: conflict.area,
    label: conflict.label,
    method: conflict.method,
    url: conflict.url,
    body: resolvedBody,
    recordKey: conflict.recordKey,
    // Re-check at replay time too: if queued offline, the sync engine compares
    // the live record against the snapshot being restored and re-flags a stale
    // restore instead of clobbering a newer server change. `abortOnConflict`
    // makes that replay-time check *not* apply the write (unlike a normal
    // last-write-wins edit) so a restore can never overwrite a newer change.
    conflictCheckUrl: hasBase ? conflict.conflictCheckUrl : undefined,
    baseVersion: hasBase ? restoreBase.version : undefined,
    baseUpdatedAt: hasBase ? restoreBase.updatedAt : undefined,
    abortOnConflict: hasBase ? true : undefined,
  });
  if (res.ok || res.queued) {
    await clearConflict(conflict.id);
    // The page the user is looking at (and the structured read cache) still
    // shows the queued edit. Reconcile the read cache so the screen reflects the
    // restored values without a manual reload:
    //  - Sent to the server (online): drop the stale cached copy so the next
    //    fetch repopulates from the server.
    //  - Parked offline: the device can't re-fetch, so apply the restored values
    //    to the cache now — an offline re-read then shows the restored state.
    const target = cacheTargetForConflict(conflict);
    if (target) {
      const patch = res.ok ? null : buildRestoredCachePatch(conflict, resolvedBody);
      if (patch) await updateCachedRecord(target.store, target.id, patch);
      else await evictCachedRecord(target.store, target.id);
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<ConflictResolvedDetail>(CONFLICT_RESOLVED_EVENT, {
        detail: {
          area: conflict.area,
          recordKey: conflict.recordKey,
          url: conflict.url,
          route: resolveConflictRoute(conflict),
        },
      }));
    }
  }
  return { ok: res.ok, queued: res.queued, status: res.status };
}

/**
 * Reconcile the read cache after the sync engine **abandons** a queued restore
 * at replay time (its `abortOnConflict` branch).
 *
 * The cached record still holds the stale restored (older) values the user
 * picked while offline. Because the server has advanced again and a fresh
 * conflict has just been re-flagged, evict that cached copy so the next read
 * repopulates from the newer server state, and point any open page at the record
 * (via {@link CONFLICT_RESOLVED_EVENT}) so it re-fetches without a manual reload.
 *
 * The engine only reaches this path after a successful online conflict-check
 * fetch, so the device is online and eviction (rather than an offline patch) is
 * the correct reconciliation — the next fetch reads the newer server snapshot.
 */
export async function reconcileAbortedRestore(entry: QueueEntry): Promise<void> {
  const target = cacheTargetForConflict(entry);
  if (target) await evictCachedRecord(target.store, target.id);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ConflictResolvedDetail>(CONFLICT_RESOLVED_EVENT, {
      detail: {
        area: entry.area,
        recordKey: entry.recordKey,
        url: entry.url,
        route: resolveQueueEntryRoute(entry),
      },
    }));
  }
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
