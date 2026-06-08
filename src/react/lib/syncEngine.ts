/**
 * Offline sync engine (Offline Phase 2).
 *
 * Drains the IndexedDB write queue (`offlineQueue.ts`) against the existing API
 * routes when connectivity returns. Responsibilities:
 *  - Replay queued writes **in insertion order**, marking each `syncing` →
 *    `synced` (removed) or `failed`.
 *  - **Resumability / idempotency:** entries are removed only after a confirmed
 *    2xx, and any entry left `syncing` by an interrupted run is reset to
 *    `pending` at the start of the next flush, so a partial replay resumes
 *    safely without skipping or double-processing.
 *  - **Retry with backoff:** transient failures (network, 5xx, 429, 408) are
 *    rescheduled with exponential backoff; once the retry budget is exhausted
 *    the entry is marked `failed` and surfaced. Permanent client errors (4xx)
 *    fail immediately.
 *  - **Conflict detection:** before an update replays, if the entry carries a
 *    cached `version`/`updated_at` and a `conflictCheckUrl`, the current server
 *    record is fetched and compared. A stale write is logged as a conflict
 *    (last-write-wins-with-warning) and persisted for the Phase 3 view.
 *
 * Loaded only via dynamic `import()` (see `registerServiceWorker.initOfflineSync`)
 * so the `idb` dependency stays out of the always-loaded main bundle.
 */

import {
  getEntries,
  updateEntry,
  removeEntry,
  recordConflict,
  markSynced,
  type QueueEntry,
  type OfflineArea,
  type QueueMethod,
} from './offlineQueue';
import { detectConflict, type ConflictDecision } from './conflictDetection';

// ── Tunables ────────────────────────────────────────────────────────────────────

/** Max replay attempts before an entry is parked as `failed`. */
export const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_FACTOR = 2;
const BACKOFF_MAX_MS = 5 * 60_000;
/** Periodic flush cadence — catches backoff retries while the tab stays open. */
const FLUSH_INTERVAL_MS = 30_000;

// ── Structured client logger (Phase 0 parity on the client) ──────────────────────
// The server uses pino (`logger.js`); on the client the structured equivalent is
// a tagged console payload that is greppable and machine-readable.

type LogLevel = 'info' | 'warn' | 'error';
function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const payload = { scope: 'offline-sync', event, ...fields };
  if (level === 'error') console.error('[offline-sync]', payload);
  else if (level === 'warn') console.warn('[offline-sync]', payload);
  else console.info('[offline-sync]', payload);
}

// ── Backoff ──────────────────────────────────────────────────────────────────────

/** Exponential backoff (with light jitter) for a given attempt count. */
export function backoffMs(attempt: number): number {
  const raw = BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, Math.max(0, attempt - 1));
  const capped = Math.min(raw, BACKOFF_MAX_MS);
  const jitter = capped * 0.2 * Math.random();
  return Math.round(capped + jitter);
}

// ── Error classification ─────────────────────────────────────────────────────────

export type FailureKind = 'transient' | 'terminal';

/** Decide whether an HTTP status warrants a retry. */
export function classifyStatus(status: number): FailureKind {
  if (status === 408 || status === 429) return 'transient';
  if (status >= 500) return 'transient';
  // 4xx (incl. 401/403/404/409/422) won't succeed on blind retry.
  return 'terminal';
}

// ── Conflict detection ───────────────────────────────────────────────────────────
// The pure comparison helpers live in `conflictDetection.ts` so the
// conflict-resolution path in `offlineQueue.ts` can reuse them without a
// circular import. Re-exported here for callers/tests that import them from the
// sync engine.

export { detectConflict, type ConflictDecision };

// ── User-facing surfacing ────────────────────────────────────────────────────────

interface SyncEventDetail {
  area: OfflineArea;
  label: string;
  reason: string;
}

/** Notify the app (header/toasts) that a queued write permanently failed. */
function surfaceFailure(entry: QueueEntry, reason: string): void {
  log('error', 'sync_failed', { area: entry.area, label: entry.label, attempts: entry.attempts, reason });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<SyncEventDetail>('mo:offline-sync-failed', {
      detail: { area: entry.area, label: entry.label, reason },
    }));
  }
}

/** Notify the app that a queued write replayed successfully (2xx). */
function surfaceSuccess(entry: QueueEntry): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<SyncEventDetail>('mo:offline-sync-ok', {
      detail: { area: entry.area, label: entry.label, reason: 'synced' },
    }));
  }
}

/** Notify the app that a queued write replayed onto a record that had changed. */
function surfaceConflict(entry: QueueEntry): void {
  log('warn', 'sync_conflict', { area: entry.area, label: entry.label, recordKey: entry.recordKey });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<SyncEventDetail>('mo:offline-sync-conflict', {
      detail: { area: entry.area, label: entry.label, reason: 'record changed on the server' },
    }));
  }
}

// ── Replay primitives ────────────────────────────────────────────────────────────

interface ReplayResult {
  ok: boolean;
  status: number;
  data: unknown;
  /** Set when the request never reached the server (offline / DNS / abort). */
  networkError?: boolean;
}

async function replayRequest(entry: QueueEntry): Promise<ReplayResult> {
  const opts: RequestInit = { method: entry.method, credentials: 'same-origin' };

  if (entry.formFields && entry.formFields.length) {
    const fd = new FormData();
    for (const f of entry.formFields) {
      if (f.blob) fd.append(f.name, f.blob, f.filename);
      else fd.append(f.name, f.value ?? '');
    }
    opts.body = fd; // browser sets multipart Content-Type + boundary
  } else if (entry.body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(entry.body);
  }

  try {
    const r = await fetch(entry.url, opts);
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: null, networkError: true };
  }
}

async function fetchServerRecord(url: string): Promise<ReplayResult> {
  try {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: null, networkError: true };
  }
}

// ── Per-entry processing ─────────────────────────────────────────────────────────

async function scheduleRetry(entry: QueueEntry, reason: string): Promise<void> {
  const attempts = entry.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await updateEntry(entry.id, { status: 'failed', attempts, lastError: reason });
    surfaceFailure({ ...entry, attempts }, reason);
    return;
  }
  const delay = backoffMs(attempts);
  await updateEntry(entry.id, {
    status: 'pending',
    attempts,
    lastError: reason,
    nextAttemptAt: Date.now() + delay,
  });
  log('info', 'sync_retry_scheduled', { area: entry.area, label: entry.label, attempts, delayMs: delay });
}

async function processEntry(entry: QueueEntry): Promise<void> {
  await updateEntry(entry.id, { status: 'syncing' });

  // 1. Conflict detection for updates that carry a cached base + check URL.
  const hasBase = entry.baseVersion != null || !!entry.baseUpdatedAt;
  if (entry.conflictCheckUrl && hasBase) {
    const snap = await fetchServerRecord(entry.conflictCheckUrl);
    if (snap.networkError) {
      await scheduleRetry(entry, 'network error during conflict check');
      return;
    }
    if (snap.ok) {
      const decision = detectConflict(
        { version: entry.baseVersion, updatedAt: entry.baseUpdatedAt },
        snap.data,
      );
      if (decision.conflicted) {
        // An `abortOnConflict` entry (a "Restore server copy" replay) must NOT
        // overwrite a server change that landed after its conflict was detected.
        // Re-flag a fresh conflict and drop the entry instead of replaying it,
        // so the restore can never clobber the newer server state.
        await recordConflict({
          area: entry.area,
          label: entry.label,
          url: entry.url,
          method: entry.method,
          recordKey: entry.recordKey,
          conflictCheckUrl: entry.conflictCheckUrl,
          attemptedBody: entry.body,
          baseVersion: entry.baseVersion ?? null,
          baseUpdatedAt: entry.baseUpdatedAt ?? null,
          serverVersion: decision.serverVersion,
          serverUpdatedAt: decision.serverUpdatedAt != null
            ? new Date(decision.serverUpdatedAt).toISOString() : null,
          serverData: snap.data,
          resolution: entry.abortOnConflict ? 'flagged' : 'last_write_wins',
        });
        surfaceConflict(entry);
        if (entry.abortOnConflict) {
          await removeEntry(entry.id);
          log('warn', 'sync_restore_aborted', {
            area: entry.area, label: entry.label, recordKey: entry.recordKey,
          });
          return;
        }
        // Otherwise (a normal edit) fall through to last-write-wins below.
      }
    }
    // A 4xx/5xx on the check URL (e.g. 404 — record deleted) falls through to the
    // write replay, which will surface the real outcome.
  }

  // 2. Replay the write.
  const result = await replayRequest(entry);
  if (result.ok) {
    await removeEntry(entry.id);
    await markSynced();
    surfaceSuccess(entry);
    log('info', 'sync_ok', { area: entry.area, label: entry.label, status: result.status });
    return;
  }
  if (result.networkError) {
    await scheduleRetry(entry, 'network error');
    return;
  }
  if (classifyStatus(result.status) === 'transient') {
    await scheduleRetry(entry, `server error ${result.status}`);
    return;
  }
  // Terminal client error — parking as failed.
  const msg = (result.data as { error?: string })?.error || `request failed (${result.status})`;
  await updateEntry(entry.id, { status: 'failed', attempts: entry.attempts + 1, lastError: msg });
  surfaceFailure({ ...entry, attempts: entry.attempts + 1 }, msg);
}

// ── Flush orchestration ──────────────────────────────────────────────────────────

let _flushing = false;

/**
 * Drain ready entries once. Processes entries sequentially in insertion order so
 * dependent writes replay in the order the user made them. Concurrent calls are
 * coalesced via a module lock.
 */
export async function flushQueue(): Promise<void> {
  if (_flushing) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  _flushing = true;
  try {
    const all = await getEntries();
    const now = Date.now();
    for (const entry of all) {
      // Resume safely: an entry left `syncing` by an interrupted run is retried.
      if (entry.status === 'syncing') entry.status = 'pending';
      if (entry.status !== 'pending') continue;
      if ((entry.nextAttemptAt ?? 0) > now) continue;
      // Bail out mid-drain if connectivity dropped again.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
      await processEntry(entry);
    }
  } finally {
    _flushing = false;
  }
}

/** Reset a `failed` entry to `pending` for an immediate manual retry. */
export async function retryEntry(id: number): Promise<void> {
  await updateEntry(id, { status: 'pending', attempts: 0, nextAttemptAt: Date.now(), lastError: undefined });
  void flushQueue();
}

let _initialised = false;
let _interval: ReturnType<typeof setInterval> | null = null;

/**
 * Bind the engine to connectivity changes. Idempotent. Flushes immediately if
 * already online, on every `online` event, and on a periodic timer so backoff
 * retries fire while the tab is open.
 */
export function initSyncEngine(): void {
  if (_initialised || typeof window === 'undefined') return;
  _initialised = true;

  window.addEventListener('online', () => {
    log('info', 'online_event');
    void flushQueue();
  });

  if (_interval === null) {
    _interval = setInterval(() => { void flushQueue(); }, FLUSH_INTERVAL_MS);
  }

  // Catch up on anything queued from a previous session.
  if (typeof navigator === 'undefined' || navigator.onLine !== false) {
    void flushQueue();
  }
}

// Re-export the area/method types so callers can import everything sync-related
// from one module if they prefer.
export type { OfflineArea, QueueMethod };
