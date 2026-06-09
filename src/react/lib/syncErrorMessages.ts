/**
 * Plain-language explanations for offline sync failures.
 *
 * When a queued offline write exhausts its retry budget the sync engine parks
 * the entry with a raw `lastError` — typically an HTTP status line (e.g.
 * "Server error 500 …") or a thrown exception message ("Failed to fetch").
 * These are accurate but technical, and a field user or non-technical admin
 * can't easily tell from them whether to retry or discard the change.
 *
 * `explainSyncError` maps the common failure causes to a short, actionable
 * sentence. It is intentionally pattern-based (status codes + well-known
 * exception text) and falls back to the raw error when nothing matches, so the
 * UI never hides information — the raw detail stays available as a secondary
 * line / tooltip for debugging.
 *
 * Shared by the header `SyncPill` dialog and the admin Offline support tab so
 * both surfaces describe the same failure identically.
 */

export interface SyncErrorExplanation {
  /** Short, plain-language, actionable summary safe to show prominently. */
  summary: string;
  /** True when `summary` came from a known pattern; false when it is the raw error. */
  mapped: boolean;
  /** The original technical error, when present — keep available for debugging. */
  raw?: string;
}

/** Pull the first HTTP status code (3 digits) out of an error string, if any. */
function extractStatus(error: string): number | null {
  const match = error.match(/\b([1-5][0-9]{2})\b/);
  if (!match) return null;
  const code = Number(match[1]);
  return code >= 100 && code <= 599 ? code : null;
}

const DEFAULT_SUMMARY = 'This change could not be synced after several attempts.';

/**
 * Map a raw `lastError` to a plain-language explanation.
 *
 * Order matters: network/connection problems are checked before status codes
 * (a fetch that never reached the server has no status), then auth, not-found,
 * conflict, validation, and finally generic server errors.
 */
export function explainSyncError(lastError?: string | null): SyncErrorExplanation {
  const raw = lastError?.trim() || undefined;

  if (!raw) {
    return { summary: DEFAULT_SUMMARY, mapped: false, raw: undefined };
  }

  const lower = raw.toLowerCase();
  const status = extractStatus(raw);

  // ── Network / connection problems (request never completed) ──
  if (
    /failed to fetch|networkerror|network error|err_internet|err_network|err_connection|econnrefused|enotfound|etimedout|timed? ?out|connection (refused|reset|closed)|load failed/.test(
      lower,
    ) ||
    lower === 'typeerror'
  ) {
    return {
      summary:
        "Your device couldn't reach the server — this is usually a connection problem. It will retry automatically when you're back online.",
      mapped: true,
      raw,
    };
  }

  // ── Auth / session expired ──
  if (
    status === 401 ||
    status === 403 ||
    /unauthor|forbidden|not logged in|session (expired|invalid)|please log ?in|onboarding_required/.test(
      lower,
    )
  ) {
    return {
      summary:
        'Your sign-in session has expired, so the server rejected this change. Sign in again, then retry.',
      mapped: true,
      raw,
    };
  }

  // ── Record deleted / not found ──
  if (status === 404 || /not found|no longer exists|has been deleted|was deleted/.test(lower)) {
    return {
      summary:
        'The server rejected this change because the record no longer exists — it may have been deleted. You probably need to discard it.',
      mapped: true,
      raw,
    };
  }

  // ── Conflict (record changed on the server) ──
  if (status === 409 || /\bconflict\b|version mismatch|stale|out of date/.test(lower)) {
    return {
      summary:
        'Someone else changed this record on the server while you were offline, so it was rejected. Review the latest version before retrying.',
      mapped: true,
      raw,
    };
  }

  // ── Lead status removed ──
  if (/lead.?status.*removed|has been removed.*admin|lead_status_removed/.test(lower)) {
    return {
      summary:
        'This pipeline status has been removed. Contact an admin to re-add it before saving.',
      mapped: true,
      raw,
    };
  }

  // ── Validation / bad request ──
  if (status === 400 || status === 422 || /validation|invalid|required field|bad request|must be/.test(lower)) {
    return {
      summary:
        "The server didn't accept this change because some of its details are missing or invalid. Fix the record and re-enter it.",
      mapped: true,
      raw,
    };
  }

  // ── Payload too large ──
  if (status === 413 || /too large|payload too large|request entity too large|file too big/.test(lower)) {
    return {
      summary:
        'This change was too large for the server to accept — usually an oversized photo or attachment. Try a smaller file.',
      mapped: true,
      raw,
    };
  }

  // ── Rate limited ──
  if (status === 429 || /too many requests|rate limit/.test(lower)) {
    return {
      summary: 'The server is busy and asked us to slow down. It will retry automatically in a moment.',
      mapped: true,
      raw,
    };
  }

  // ── Server error (request reached the server, which failed) ──
  if ((status != null && status >= 500) || /server error|internal server|bad gateway|service unavailable|gateway timeout/.test(lower)) {
    return {
      summary:
        'The server hit an error while saving this change. This is usually temporary — try again, and contact support if it keeps failing.',
      mapped: true,
      raw,
    };
  }

  // ── Unmapped: show the raw error as-is so nothing is hidden. ──
  return { summary: raw, mapped: false, raw };
}

/**
 * A stale-write conflict isn't an error — the change synced, but the record had
 * also changed on the server in the meantime. The admin Offline support tab
 * surfaces these for review with a terse technical caption (e.g. "applied
 * (last-write-wins) · server v3 vs yours v2"). `explainConflict` turns that into
 * the same plain-language, actionable treatment `explainSyncError` gives
 * failures, so a non-technical admin can tell what happened and what to do.
 */
export interface ConflictExplanationInput {
  /** How the engine handled it: applied anyway, or held for manual review. */
  resolution?: 'last_write_wins' | 'flagged' | null;
  /** Version the server record was on when the conflict was detected. */
  serverVersion?: number | null;
  /** Version your queued edit was based on. */
  baseVersion?: number | null;
  /**
   * When set, the conflict was caused by a specific server-side error code
   * rather than a data-version race. Takes precedence over `resolution`.
   */
  errorCode?: string | null;
  /**
   * Structured metadata from the server alongside a known error code.
   * For `LEAD_STATUS_REMOVED`, `removedKey` names the exact status that
   * was missing so the message can be specific.
   */
  errorMeta?: { removedKey?: string } | null;
}

export interface ConflictExplanation {
  /** Short, plain-language, actionable summary safe to show prominently. */
  summary: string;
  /**
   * The terse technical detail (version numbers, resolution), when available —
   * keep it available as a secondary line for admins who want specifics.
   */
  detail?: string;
}

/**
 * Map a conflict's resolution + version data to a plain-language explanation.
 *
 * `last_write_wins` (the common case) means the queued edit was applied on top
 * of the newer server record, so the admin should double-check nothing useful
 * was overwritten. `flagged` means the edit was held back for manual review, so
 * nothing was overwritten yet but a decision is needed.
 */
export function explainConflict(input: ConflictExplanationInput): ConflictExplanation {
  const { resolution, serverVersion, baseVersion, errorCode, errorMeta } = input;

  // ── Configuration errors (not data-version races) ──
  // These take precedence over the resolution-based explanations below because
  // the queued write was never applied — the server rejected it outright. The
  // user needs targeted admin guidance rather than a "keep mine / restore
  // server" framing.
  if (errorCode === 'LEAD_STATUS_REMOVED') {
    const statusName = errorMeta?.removedKey
      ? `The status '${errorMeta.removedKey}' has been removed`
      : 'The pipeline status this change referenced has been removed';
    return {
      summary:
        `${statusName} — ask an admin to restore it in Visit Settings → Lead statuses, then re-enter the change.`,
    };
  }

  const haveVersions = serverVersion != null && baseVersion != null;
  const detail = haveVersions
    ? `Server was on v${serverVersion}; your edit was based on v${baseVersion}.`
    : undefined;

  if (resolution === 'flagged') {
    return {
      summary:
        'Someone else changed this record on the server while your edit was waiting to sync. Your edit was held back so nothing was overwritten — review the latest server version and re-enter your change if it is still needed.',
      detail,
    };
  }

  // Default to the last-write-wins explanation (the engine's usual behaviour).
  return {
    summary:
      'Someone else changed this record on the server while your edit was waiting to sync. Your edit was saved on top of theirs, so please double-check the record still looks right and re-apply their change if anything important was lost.',
    detail,
  };
}
