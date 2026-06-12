import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import BrokenImageIcon from '@mui/icons-material/BrokenImage';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HomeIcon from '@mui/icons-material/Home';
import HourglassBottomIcon from '@mui/icons-material/HourglassBottom';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SendIcon from '@mui/icons-material/Send';
import WifiOffIcon from '@mui/icons-material/WifiOff';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { usePrivilege } from '../../hooks/usePrivilege';
import { useToast } from '../../contexts/ToastContext';
import { SyncStatePill } from '../../components/SyncStatePill';
import { useOfflinePhotoReviewEntries, type PendingPhotoReviewEntry } from '../../hooks/useOfflinePhotoReviewEntries';
import { cacheRecord, readRecord } from '../../lib/offlineDb';
import { formatAddress, isAddressEmpty, type StructuredAddress } from '../../../../shared/address';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Submission {
  id: number;
  created_at: string;
  submitted_at: string | null;
  expires_at: string;
  contact_name: string | null;
  contact_email: string | null;
  corrected_email: string | null;
  corrected_mobile: string | null;
  address_line1: string | null;
  city: string | null;
  postcode: string | null;
  structuredAddress?: StructuredAddress | null;
  room_count: string | null;
  room_notes: string | null;
  photo_keys: string[];
  photoUrls: string[];
  email_skipped_count: number;
  form_link: string | null;
}

/**
 * Shape the "Review customer photos" drawer writes into the offline `photos`
 * store (keyed by contactId). Mirrors that drawer's `Submission` interface —
 * camelCase, with only the fields a submitted review needs.
 */
interface CachedPhotoSubmission {
  id: number;
  contactName: string | null;
  contactEmail: string | null;
  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
  roomCount: string | null;
  roomNotes: string | null;
  correctedEmail: string | null;
  correctedMobile: string | null;
  submittedAt: string | null;
  emailSkippedCount: number;
  photoUrls: string[];
}

/**
 * Map a cached photo-review submission (camelCase, from IndexedDB) into the
 * rail's snake_case `Submission` shape. Used only as an offline fallback when
 * the live submissions fetch fails, so any submission with a queued review
 * still renders with its sync pill. Fields the cache doesn't carry
 * (`created_at`, `expires_at`, `form_link`, `photo_keys`) are left empty —
 * a reviewed submission is always submitted, so the pending-only fields are
 * never read for it.
 */
function cachedToSubmission(c: CachedPhotoSubmission): Submission {
  return {
    id: c.id,
    created_at: '',
    submitted_at: c.submittedAt,
    expires_at: '',
    contact_name: c.contactName ?? null,
    contact_email: c.contactEmail ?? null,
    corrected_email: c.correctedEmail ?? null,
    corrected_mobile: c.correctedMobile ?? null,
    address_line1: c.addressLine1 ?? null,
    city: c.city ?? null,
    postcode: c.postcode ?? null,
    room_count: c.roomCount ?? null,
    room_notes: c.roomNotes ?? null,
    photo_keys: [],
    photoUrls: Array.isArray(c.photoUrls) ? c.photoUrls : [],
    email_skipped_count: c.emailSkippedCount ?? 0,
    form_link: null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
  } catch { return iso; }
}

function roomLabel(count: string | null): string {
  if (!count) return '—';
  if (count === '1') return '1 room';
  if (count === '2') return '2 rooms';
  return '3+ rooms';
}

/** Returns true when two ISO-date strings refer to the same instant (within 2 s). */
function datesMatch(a: string, b: string): boolean {
  try {
    return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 2000;
  } catch { return true; }
}

/**
 * Warm the service-worker `mo-customer-photos` cache with the submission photo
 * images so they render offline.
 *
 * Submission thumbnails live inside a collapsed, lazy-loaded grid, so the
 * browser only fetches them when a card is expanded. A field user who caches
 * the list online but never expands a card would otherwise have no image bytes
 * cached, and offline expansion would show broken thumbnails. We therefore
 * proactively fetch each signed photo URL right after a successful online load,
 * which lets the SW runtime cache store the 200 responses under the exact URLs
 * the offline list will reference.
 *
 * Bounded + best-effort:
 *  - Skips entirely when known offline (the SW has nothing fresh to add and the
 *    fetches would just fail).
 *  - Only touches same-origin signed photo routes.
 *  - Caps the total prefetched per load (`MAX_PREFETCH`) so a huge photo set
 *    degrades gracefully instead of flooding the network; the SW cache's own
 *    `maxEntries` evicts oldest-first beyond that.
 *  - Limited concurrency; every fetch failure is swallowed.
 */
const MAX_PREFETCH_PHOTOS = 60;
const PREFETCH_CONCURRENCY = 4;

async function prefetchSubmissionPhotos(urls: string[]): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (typeof fetch !== 'function') return;
  const targets = urls
    .filter((u): u is string => typeof u === 'string' && u.startsWith('/api/customer-info-photos/'))
    .slice(0, MAX_PREFETCH_PHOTOS);
  if (targets.length === 0) return;

  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const url = targets[cursor++];
      try {
        // Let the response go through the SW so it lands in mo-customer-photos.
        await fetch(url, { credentials: 'same-origin' });
      } catch {
        /* best-effort warming — broken/expired URLs just stay uncached */
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(PREFETCH_CONCURRENCY, targets.length) },
    () => worker(),
  );
  await Promise.all(workers);
}

// ── Copy link button (controlled) ─────────────────────────────────────────────

function CopyLinkButton({
  onClick,
  copied,
  isChecking,
}: {
  onClick: () => void;
  copied: boolean;
  isChecking: boolean;
}) {
  return (
    <Tooltip title={copied ? 'Copied!' : 'Copy link'} placement="top" arrow>
      <span>
        <IconButton
          size="small"
          onClick={onClick}
          aria-label="Copy customer link"
          color={copied ? 'success' : 'default'}
          disabled={isChecking}
          data-testid="copy-link-btn"
        >
          {isChecking
            ? <CircularProgress size={14} color="inherit" />
            : copied
              ? <CheckIcon fontSize="small" />
              : <ContentCopyIcon fontSize="small" />
          }
        </IconButton>
      </span>
    </Tooltip>
  );
}

// ── Resend button ─────────────────────────────────────────────────────────────

type ResendState = 'idle' | 'loading' | 'sent' | 'error';

function ResendButton({
  contactId,
  onSuccess,
}: {
  contactId: string;
  onSuccess: () => void;
}) {
  const [state, setState] = useState<ResendState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const showToast = useToast();

  async function handleResend() {
    setState('loading');
    setErrorMsg('');
    try {
      const r = await fetch(
        `/api/customer-info/by-contact/${encodeURIComponent(contactId)}/resend`,
        { method: 'POST' }
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${r.status}`);
      }
      setState('sent');
      showToast('A fresh link has been sent to the customer');
      onSuccess();
    } catch (e) {
      const msg = (e as Error).message;
      setErrorMsg(msg);
      setState('error');
      showToast(msg, true);
    }
  }

  if (state === 'sent') {
    return (
      <Chip
        icon={<CheckCircleIcon />}
        label="Link sent"
        size="small"
        color="success"
        variant="outlined"
      />
    );
  }

  return (
    <Tooltip
      title={state === 'error' ? errorMsg : ''}
      placement="top"
      arrow
    >
      <span>
        <Button
          size="small"
          variant="outlined"
          color={state === 'error' ? 'error' : 'primary'}
          startIcon={state === 'loading'
            ? <CircularProgress size={13} color="inherit" />
            : <SendIcon fontSize="small" />
          }
          disabled={state === 'loading'}
          onClick={handleResend}
          sx={{ fontSize: '0.75rem', py: 0.4 }}
          data-testid="resend-link-btn"
        >
          {state === 'error' ? 'Retry' : 'Resend link'}
        </Button>
      </span>
    </Tooltip>
  );
}

// ── Pending photo-review retry / discard actions ──────────────────────────────

/**
 * Retry / Discard actions for a queued photo-review outcome that failed to
 * upload. Mirrors `PendingEditActions` in `DesignVisitsList.tsx`, reusing the
 * same retry/remove queue APIs. Discarding only drops the unsynced review
 * outcome from the outbox — the submission row on the server is untouched.
 */
export function PendingReviewActions({ entry }: { entry: PendingPhotoReviewEntry }) {
  const [busy, setBusy] = useState(false);

  const handleRetry = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const engine = await import('../../lib/syncEngine');
      await engine.retryEntry(entry.id);
    } catch {
      /* best-effort — the periodic flush will pick it up */
    } finally {
      setBusy(false);
    }
  }, [busy, entry.id]);

  const handleDiscard = useCallback(() => {
    if (busy) return;
    const doDiscard = async () => {
      setBusy(true);
      try {
        const mod = await import('../../lib/offlineQueue');
        await mod.removeEntry(entry.id);
      } catch {
        /* best-effort */
      } finally {
        setBusy(false);
      }
    };
    window.showBottomConfirm(
      'Discard this unsynced photo review? The outcome saved on this device will be lost — the submission on the server stays as it is.',
      doDiscard,
    );
  }, [busy, entry.id]);

  return (
    <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button
        size="small"
        variant="outlined"
        disabled={busy}
        onClick={handleRetry}
        sx={{ fontSize: '0.75rem', py: 0.3 }}
        data-testid={`photo-review-retry-${entry.submissionId ?? entry.id}`}
      >
        Retry
      </Button>
      <Button
        size="small"
        variant="outlined"
        color="error"
        disabled={busy}
        onClick={handleDiscard}
        sx={{ fontSize: '0.75rem', py: 0.3 }}
        data-testid={`photo-review-discard-${entry.submissionId ?? entry.id}`}
      >
        Discard
      </Button>
    </Stack>
  );
}

// ── Bulk photo-review retry / discard actions ─────────────────────────────────

/**
 * Bulk **Retry all** / **Discard all** controls for the customer-info
 * submissions rail. Renders only when 2+ queued photo-review outcomes for this
 * contact are `failed`, so a field user recovering from a long offline stint can
 * clear the whole backlog at once instead of one card at a time. Mirrors
 * `BulkVisitActions` in `DesignVisitsList.tsx`, reusing the same retry/remove
 * queue APIs.
 *
 * - **Retry all** re-queues every failed entry (`retryEntry`) with no extra
 *   confirmation — the periodic flush picks them up.
 * - **Discard all** gates the permanent removal behind `window.showBottomConfirm`
 *   before calling `removeEntry` for each. Discarding only drops the unsynced
 *   review outcomes from the outbox — the submission rows on the server stay
 *   untouched.
 */
export function BulkReviewActions({ entries }: { entries: PendingPhotoReviewEntry[] }) {
  const [busy, setBusy] = useState(false);
  const failed = entries.filter(e => e.status === 'failed');

  const handleRetryAll = useCallback(async () => {
    if (busy) return;
    const ids = failed.map(e => e.id);
    if (!ids.length) return;
    setBusy(true);
    try {
      const engine = await import('../../lib/syncEngine');
      await Promise.all(ids.map(id => engine.retryEntry(id)));
    } catch {
      /* best-effort — the periodic flush will pick them up */
    } finally {
      setBusy(false);
    }
  }, [busy, failed]);

  const handleDiscardAll = useCallback(() => {
    if (busy) return;
    const ids = failed.map(e => e.id);
    if (!ids.length) return;
    const doDiscard = async () => {
      setBusy(true);
      try {
        const mod = await import('../../lib/offlineQueue');
        await Promise.all(ids.map(id => mod.removeEntry(id)));
      } catch {
        /* best-effort */
      } finally {
        setBusy(false);
      }
    };
    window.showBottomConfirm(
      `Discard all ${ids.length} unsynced photo reviews? The outcomes saved on this device will be lost — the submissions on the server stay as they are.`,
      doDiscard,
    );
  }, [busy, failed]);

  if (failed.length < 2) return null;

  return (
    <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button
        size="small"
        variant="outlined"
        disabled={busy}
        onClick={handleRetryAll}
        sx={{ fontSize: '0.75rem', py: 0.3 }}
        data-testid="photo-review-retry-all"
      >
        Retry all
      </Button>
      <Button
        size="small"
        variant="outlined"
        color="error"
        disabled={busy}
        onClick={handleDiscardAll}
        sx={{ fontSize: '0.75rem', py: 0.3 }}
        data-testid="photo-review-discard-all"
      >
        Discard all
      </Button>
    </Stack>
  );
}

// ── Submission photo thumbnail ─────────────────────────────────────────────────

/**
 * Renders a single submission photo thumbnail.  When the image fails to load
 * a neutral placeholder fills the same 1:1 tile — no layout shift.  The
 * placeholder copy distinguishes between offline (photo was not cached) and
 * online (URL is genuinely broken / unavailable).
 */
function SubmissionPhoto({ url, index }: { url: string; index: number }) {
  const [errored, setErrored] = useState(false);
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;

  if (errored) {
    const Icon = offline ? WifiOffIcon : BrokenImageIcon;
    const caption = offline ? 'Not saved for offline viewing' : 'Photo unavailable';
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          aspectRatio: '1',
          borderRadius: 1.5,
          bgcolor: 'grey.100',
          border: '1px solid',
          borderColor: 'divider',
          p: 0.5,
          gap: 0.5,
        }}
        aria-label={caption}
        title={caption}
      >
        <Icon sx={{ fontSize: 22, color: 'text.disabled' }} />
        <Typography
          variant="caption"
          sx={{
            color: 'text.disabled',
            fontSize: '0.6rem',
            textAlign: 'center',
            lineHeight: 1.2,
          }}
        >
          {caption}
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      component="img"
      src={url}
      alt={`Photo ${index + 1}`}
      sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      loading="lazy"
      onError={() => setErrored(true)}
    />
  );
}

// ── Submission card ───────────────────────────────────────────────────────────

type ConflictTarget = 'copy' | 'open';

function SubmissionCard({ sub, contactId, canResend, onResendSuccess, isSuperseded, autoExpand, pendingReview }: {
  sub: Submission;
  contactId: string;
  canResend: boolean;
  onResendSuccess: () => void;
  isSuperseded?: boolean;
  autoExpand?: boolean;
  pendingReview?: PendingPhotoReviewEntry;
}) {
  const [open, setOpen] = useState(false);

  // Deep-link support: when a `#customer-info-<id>` fragment targets this card,
  // the rail flags it via `autoExpand` so it opens on mount. The user can still
  // collapse it afterwards — we only force it open when the flag turns on.
  useEffect(() => {
    if (autoExpand) setOpen(true);
  }, [autoExpand]);
  const isPending = !sub.submitted_at;
  const isExpired = isPending && new Date(sub.expires_at) < new Date();
  const isActive  = isPending && !isExpired;

  // ── Copy / open link with conflict-check ───────────────────────────────────
  const [isChecking, setIsChecking]           = useState(false);
  const [conflictTarget, setConflictTarget]   = useState<ConflictTarget | null>(null);
  const [copied, setCopied]                   = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); },
    []
  );

  function performCopy() {
    if (!sub.form_link) return;
    navigator.clipboard.writeText(sub.form_link).then(() => {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // Clipboard write failed — silent
    });
  }

  function performAction(target: ConflictTarget) {
    if (target === 'copy') performCopy();
    else {
      // 'open' path called from a synchronous click handler (handleProceedAnyway),
      // so window.open runs within the user-activation window — no popup block.
      if (sub.form_link) window.open(sub.form_link, '_blank', 'noopener,noreferrer');
    }
  }

  async function checkThenAct(target: ConflictTarget) {
    if (!sub.form_link) return;

    // For the 'open' path, grab a window handle synchronously right now so the
    // browser sees a user-gesture–initiated popup. We then either navigate it
    // to the real URL (no conflict) or close it (conflict detected) once the
    // async check completes.
    let pendingWindow: Window | null = null;
    if (target === 'open') {
      pendingWindow = window.open('', '_blank');
      // Security trade-off: `noopener,noreferrer` is intentionally omitted here.
      // This provisional open targets a blank page with no cross-origin content,
      // so there is no actual opener-exploitation risk at this point. Keeping the
      // opener reference is required so we can navigate the tab to the real URL
      // (or close it) once the async conflict-check below resolves — without a
      // handle the tab would be orphaned and we'd have to open a second popup.
      // The final window.open calls that load a real URL (see below) DO pass
      // 'noopener,noreferrer', severing the reference once the destination is set.
    }

    setIsChecking(true);
    setConflictTarget(null);
    try {
      const r = await fetch(
        `/api/customer-info/by-contact/${encodeURIComponent(contactId)}/link-status`
      );
      const status: { hasActiveLink: boolean; expiresAt?: string } =
        r.ok ? await r.json() : { hasActiveLink: false };

      // A conflict exists when the DB's newest active link has a DIFFERENT
      // expiry than this card — meaning a newer row has since been created.
      const hasConflict =
        status.hasActiveLink &&
        status.expiresAt != null &&
        !datesMatch(status.expiresAt, sub.expires_at);

      if (hasConflict) {
        // Close the provisional window — the user must acknowledge first.
        pendingWindow?.close();
        setConflictTarget(target);
      } else {
        if (pendingWindow) {
          pendingWindow.location.href = sub.form_link;
        } else if (target === 'open') {
          // window.open returned null (popup blocked) — try once more now that
          // we know there's no conflict, so the user gets a clear attempt.
          window.open(sub.form_link, '_blank', 'noopener,noreferrer');
        } else {
          performCopy();
        }
      }
    } catch {
      // On network / parse error, fail open so staff are never blocked.
      if (pendingWindow) {
        pendingWindow.location.href = sub.form_link;
      } else if (target === 'open') {
        window.open(sub.form_link, '_blank', 'noopener,noreferrer');
      } else {
        performCopy();
      }
    } finally {
      setIsChecking(false);
    }
  }

  function handleProceedAnyway() {
    if (!conflictTarget) return;
    const target = conflictTarget;
    setConflictTarget(null);
    performAction(target);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const statusChip = isPending ? (
    <Chip icon={<HourglassBottomIcon />} label="Awaiting submission" size="small" color="default" variant="outlined" data-testid="status-chip" />
  ) : (
    <Chip icon={<CheckCircleIcon />} label="Submitted" size="small" color="success" variant="outlined" data-testid="status-chip" />
  );

  const address = sub.structuredAddress && !isAddressEmpty(sub.structuredAddress)
    ? formatAddress(sub.structuredAddress).replace(/\n/g, ', ')
    : [sub.address_line1, sub.city, sub.postcode].filter(Boolean).join(', ');

  return (
    <Box
      id={`customer-info-${sub.id}`}
      data-testid={`submission-card-${sub.id}`}
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        overflow: 'hidden',
        bgcolor: 'background.paper',
      }}
    >
      {/* Header row */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 1.5,
          gap: 1,
        }}
      >
        <Box
          onClick={() => setOpen(v => !v)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            flex: 1,
            cursor: 'pointer',
            gap: 1,
            minWidth: 0,
            '&:hover .expand-icon': { color: 'text.secondary' },
          }}
        >
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Sent {fmtDate(sub.created_at)}
            </Typography>
            {statusChip}
            {pendingReview && pendingReview.status !== 'synced' && (
              <SyncStatePill status={pendingReview.status} testId={`photo-review-sync-pill-${sub.id}`} />
            )}
          </Stack>
          {open
            ? <ExpandLessIcon className="expand-icon" fontSize="small" sx={{ color: 'text.disabled', ml: 'auto', flexShrink: 0 }} />
            : <ExpandMoreIcon className="expand-icon" fontSize="small" sx={{ color: 'text.disabled', ml: 'auto', flexShrink: 0 }} />
          }
        </Box>

        {/* Action area */}
        {!isPending ? (
          <Box sx={{ flexShrink: 0 }}>
            <Button
              size="small"
              variant="outlined"
              onClick={() => setOpen(v => !v)}
              data-testid="review-btn"
            >
              Review
            </Button>
          </Box>
        ) : isActive ? (
          isSuperseded ? (
            <Box sx={{ flexShrink: 0 }}>
              <Tooltip
                title="A newer link has been generated — this one is no longer active"
                placement="top"
                arrow
              >
                <Chip label="Superseded" size="small" variant="outlined" data-testid="superseded-chip" />
              </Tooltip>
            </Box>
          ) : (
            <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0, alignItems: 'center' }}>
              {sub.form_link && (
                <>
                  <CopyLinkButton
                    onClick={() => checkThenAct('copy')}
                    copied={copied}
                    isChecking={isChecking && !conflictTarget}
                  />
                  <Tooltip title="Open link in new tab" placement="top" arrow>
                    <span>
                      <IconButton
                        size="small"
                        onClick={() => checkThenAct('open')}
                        aria-label="Open customer link in new tab"
                        disabled={isChecking && !conflictTarget}
                        data-testid="open-link-btn"
                      >
                        <OpenInNewIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </>
              )}
              {canResend && <ResendButton contactId={contactId} onSuccess={onResendSuccess} />}
            </Stack>
          )
        ) : null}
      </Box>

      {/* Failed photo-review — inline retry / discard */}
      {pendingReview && pendingReview.status === 'failed' && (
        <Box
          sx={{ px: 2, pb: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}
          data-testid={`photo-review-failed-actions-${sub.id}`}
        >
          <Typography variant="caption" sx={{ color: 'text.secondary', flex: 1, minWidth: 0 }}>
            {`Couldn't sync this photo review${pendingReview.lastError ? ` — ${pendingReview.lastError}` : ''}. Retry to upload it again, or discard it to drop the unsynced outcome.`}
          </Typography>
          <PendingReviewActions entry={pendingReview} />
        </Box>
      )}

      {/* Conflict warning */}
      {conflictTarget && (
        <Box sx={{ px: 2, pb: 1.5 }}>
          <Alert
            severity="warning"
            icon={<WarningAmberIcon fontSize="inherit" />}
            data-testid="conflict-alert"
            action={
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexShrink: 0 }}>
                <Button
                  size="small"
                  color="warning"
                  onClick={handleProceedAnyway}
                  data-testid="conflict-proceed-btn"
                >
                  {conflictTarget === 'copy' ? 'Copy anyway' : 'Open anyway'}
                </Button>
                <Button
                  size="small"
                  onClick={() => setConflictTarget(null)}
                  data-testid="conflict-cancel-btn"
                >
                  Cancel
                </Button>
              </Stack>
            }
          >
            A newer link has already been sent for this contact. This link may
            have been replaced — the customer might not be able to use it.
          </Alert>
        </Box>
      )}

      {/* Expanded detail */}
      <Collapse in={open} data-testid="submission-card-collapse">
        <Divider />
        <Box data-testid="submission-card-body" sx={{ px: 2, py: 2 }}>
          {isPending ? (
            <Typography variant="body2" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
              Waiting for the customer to complete the form.
            </Typography>
          ) : (
            <Stack spacing={2}>
              {sub.submitted_at && (
                <Typography variant="caption" color="text.secondary">
                  Submitted {fmtDate(sub.submitted_at)}
                  {(sub.corrected_email || sub.corrected_mobile) && ' · Customer provided corrections'}
                </Typography>
              )}

              {/* Address */}
              {address && (
                <Box>
                  <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.25 }}>
                    Address
                  </Typography>
                  <Typography variant="body2">{address}</Typography>
                </Box>
              )}

              {/* Corrections */}
              {(sub.corrected_email || sub.corrected_mobile) && (
                <Box>
                  <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.25 }}>
                    Contact corrections
                  </Typography>
                  {sub.corrected_email  && <Typography variant="body2">Email: {sub.corrected_email}</Typography>}
                  {sub.corrected_mobile && <Typography variant="body2">Mobile: {sub.corrected_mobile}</Typography>}
                </Box>
              )}

              {/* Rooms */}
              {sub.room_count && (
                <Box>
                  <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.25 }}>
                    Rooms
                  </Typography>
                  <Typography variant="body2">{roomLabel(sub.room_count)}</Typography>
                </Box>
              )}

              {/* Notes */}
              {sub.room_notes && (
                <Box>
                  <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.25 }}>
                    Notes
                  </Typography>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                    {sub.room_notes}
                  </Typography>
                </Box>
              )}

              {/* Photos */}
              {sub.photoUrls && sub.photoUrls.length > 0 && (
                <Box>
                  <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.75 }}>
                    Photos ({sub.photoUrls.length})
                  </Typography>
                  {sub.email_skipped_count > 0 && (
                    <Alert severity="warning" sx={{ mb: 1, py: 0.5, fontSize: '0.75rem' }} data-testid="skipped-photo-alert">
                      {sub.email_skipped_count} photo{sub.email_skipped_count === 1 ? ' was' : 's were'} too large to attach to the admin email —{' '}
                      {sub.email_skipped_count === 1 ? 'it is' : 'they are'}{' '}
                      <a
                        href={sub.photoUrls[0]}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="skipped-photo-link"
                      >
                        still viewable here
                      </a>.
                    </Alert>
                  )}
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
                      gap: 1,
                    }}
                  >
                    {sub.photoUrls.map((url, i) => (
                      <Box
                        key={i}
                        component="a"
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        sx={{
                          display: 'block',
                          borderRadius: 1.5,
                          overflow: 'hidden',
                          aspectRatio: '1',
                          bgcolor: 'grey.100',
                          border: '1px solid',
                          borderColor: 'divider',
                        }}
                      >
                        <SubmissionPhoto url={url} index={i} />
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}
              {(!sub.photoUrls || sub.photoUrls.length === 0) && (
                <Typography variant="body2" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
                  No photos uploaded.
                </Typography>
              )}
            </Stack>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

// ── Rail ──────────────────────────────────────────────────────────────────────

/** Parse a `#customer-info-<id>` deep-link fragment into a numeric submission id. */
function submissionIdFromHash(hash: string): number | null {
  const m = hash.match(/^#customer-info-(\d+)$/);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) ? id : null;
}

interface Props {
  contactId: string;
}

export function CustomerInfoSubmissionsRail({ contactId }: Props) {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  // True when submissions are served from the offline cache because the live
  // fetch failed (e.g. the device is offline).
  const [fromCache, setFromCache]     = useState(false);
  const [open, setOpen]               = useState(true);
  const [deepLinkId, setDeepLinkId]   = useState<number | null>(null);
  const { isViewer, isManager, isAdmin } = usePrivilege();
  const pendingReviews                = useOfflinePhotoReviewEntries(contactId);

  const loadSubmissions = useCallback(() => {
    if (!contactId || isViewer) return;
    setLoading(true);
    setError('');
    fetch(`/api/customer-info/by-contact/${encodeURIComponent(contactId)}`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json() as Submission[];
        setSubmissions(d);
        setFromCache(false);
        // Write-through the full list (keyed by contactId) so the whole history
        // — not just the single drawer-cached submission — is available offline.
        void cacheRecord('customerInfo', contactId, d);
        // Warm the SW image cache so the photo thumbnails (lazy, inside a
        // collapsed grid) are available offline even if no card is expanded.
        void prefetchSubmissionPhotos(d.flatMap(s => Array.isArray(s.photoUrls) ? s.photoUrls : []));
      })
      .catch(async e => {
        // Offline fallback. Prefer the full submissions list cached on the last
        // successful online load. If that's missing, fall back to the single
        // submission the "Review customer photos" drawer cached (`photos` store,
        // keyed by contactId) so a card with a queued review still appears with
        // its sync pill.
        const cachedList = await readRecord<Submission[]>('customerInfo', contactId);
        if (Array.isArray(cachedList) && cachedList.length > 0) {
          setSubmissions(cachedList);
          setFromCache(true);
          setError('');
          return;
        }
        const cached = await readRecord<CachedPhotoSubmission>('photos', contactId);
        if (cached && cached.id != null) {
          setSubmissions([cachedToSubmission(cached)]);
          setFromCache(true);
          setError('');
        } else {
          setError((e as Error).message);
        }
      })
      .finally(() => setLoading(false));
  }, [contactId, isViewer]);

  useEffect(() => {
    loadSubmissions();
  }, [loadSubmissions]);

  useEffect(() => {
    function handleLinkGenerated(e: Event) {
      const detail = (e as CustomEvent<{ contactId: string }>).detail;
      if (detail?.contactId === contactId) {
        loadSubmissions();
      }
    }
    window.addEventListener('customer-info-link-generated', handleLinkGenerated);
    return () => window.removeEventListener('customer-info-link-generated', handleLinkGenerated);
  }, [contactId, loadSubmissions]);

  // Deep-link support: a photo conflict's "Open record" link can carry a
  // `#customer-info-<id>` fragment so this rail auto-expands and scrolls to the
  // exact submission. Acts once per fragment, only when the target submission is
  // actually present, so the user can still collapse it afterwards.
  const deepLinkedRef = useRef<number | null>(null);
  useEffect(() => {
    const targetId = submissionIdFromHash(window.location.hash);
    if (targetId == null || deepLinkedRef.current === targetId) return;
    if (!submissions.some(s => s.id === targetId)) return;
    deepLinkedRef.current = targetId;
    setOpen(true);
    setDeepLinkId(targetId);
    requestAnimationFrame(() => {
      const el = document.getElementById(`customer-info-${targetId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [submissions]);

  // Filter out expired-pending cards — staff only need to see active and submitted entries
  const visibleSubmissions = submissions.filter(sub => {
    const isPending = !sub.submitted_at;
    const isExpired = isPending && new Date(sub.expires_at) < new Date();
    return !(isPending && isExpired);
  });

  // Separate active cards from the rest, sort active by expires_at descending so
  // the newest is first, then recombine. Only the first active card gets Copy/Open
  // buttons; earlier (older) ones are marked superseded.
  const activeCards = visibleSubmissions
    .filter(sub => !sub.submitted_at && new Date(sub.expires_at) >= new Date())
    .sort((a, b) => new Date(b.expires_at).getTime() - new Date(a.expires_at).getTime());
  const activeIds = new Set(activeCards.map(s => s.id));
  const otherCards = visibleSubmissions.filter(s => !activeIds.has(s.id));
  const sortedSubmissions = [...activeCards, ...otherCards];

  if (!loading && !error && visibleSubmissions.length === 0) return null;

  return (
    <Box
      id="customer-info-submissions-section"
      sx={{ mb: 3 }}
    >
      {/* Section header */}
      <Box
        onClick={() => setOpen(v => !v)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          mb: open ? 1.5 : 0,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <HomeIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
        <Typography variant="subtitle2" sx={{ fontWeight: 600, flex: 1 }}>
          Customer Info
          {visibleSubmissions.length > 0 && (
            <Typography component="span" variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
              ({visibleSubmissions.length})
            </Typography>
          )}
        </Typography>
        {/* Bulk retry/discard sits in the header so it's reachable even when the
            rail is collapsed. Stop click propagation so the buttons don't toggle
            the section open/closed. */}
        <Box onClick={e => e.stopPropagation()} sx={{ display: 'flex', flexShrink: 0 }}>
          <BulkReviewActions entries={Array.from(pendingReviews.values())} />
        </Box>
        {open
          ? <ExpandLessIcon fontSize="small" sx={{ color: 'text.disabled' }} />
          : <ExpandMoreIcon fontSize="small" sx={{ color: 'text.disabled' }} />
        }
      </Box>

      <Collapse in={open}>
        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        )}
        {error && (
          <Typography variant="caption" color="error">
            Could not load submissions: {error}
          </Typography>
        )}
        {!loading && !error && (
          <Stack spacing={1.5} data-testid="submission-cards-stack">
            {fromCache && (
              <Alert severity="info" sx={{ py: 0.5 }} data-testid="submissions-offline-banner">
                {typeof navigator !== 'undefined' && navigator.onLine === false
                  ? "You're offline — showing saved submissions from your last visit. The list may be incomplete or out of date."
                  : "Couldn't reach the server — showing saved submissions from your last visit. The list may be incomplete or out of date."}
              </Alert>
            )}
            {sortedSubmissions.map((sub, index) => (
              <SubmissionCard
                key={sub.id}
                sub={sub}
                contactId={contactId}
                canResend={isManager || isAdmin}
                onResendSuccess={loadSubmissions}
                isSuperseded={activeIds.has(sub.id) && index > 0}
                autoExpand={sub.id === deepLinkId}
                pendingReview={pendingReviews.get(sub.id)}
              />
            ))}
          </Stack>
        )}
      </Collapse>
    </Box>
  );
}
