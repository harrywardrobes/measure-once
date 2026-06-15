import React, { useState, useCallback, useEffect, useRef, Suspense } from 'react';
import Tooltip from '@mui/material/Tooltip';
import { fmtDesignVisitWhen } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';
import { useOfflineSurveyVisitEntries, type PendingSurveyVisitEntry } from '../../hooks/useOfflineSurveyVisitEntries';
import { useToast } from '../../contexts/ToastContext';
import { SyncStatePill } from '../../components/SyncStatePill';
import { evictCachedRecord } from '../../lib/offlineDb';
import type {
  SurveyVisitWizardHandler,
  SurveyVisitWizardCtx,
  ExistingSurveyVisit,
} from '../../components/SurveyVisitWizard';

const SurveyVisitWizardLazy = React.lazy(() =>
  import('../../components/SurveyVisitWizard').then(m => ({ default: m.SurveyVisitWizard })),
);

const sxHeader: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 };
const sxHeaderLabel: React.CSSProperties = { fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink-2)' };
const sxItem: React.CSSProperties = { background: 'var(--paper)', border: '1px solid var(--stone)', borderRadius: 'var(--radius-lg)', padding: '11px 14px', boxShadow: 'var(--shadow-sm)' };
const sxMeta: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 };
const sxMetaSep: React.CSSProperties = { fontSize: '0.65rem', color: 'var(--ink-4)' };
const sxDate: React.CSSProperties = { fontSize: '0.68rem', color: 'var(--ink-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' };
const sxText: React.CSSProperties = { fontSize: '0.875rem', color: 'var(--ink-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' };
const sxSecondaryBtn: React.CSSProperties = { background: 'none', color: 'var(--ink-3)', fontSize: '0.75rem', border: '1px solid var(--stone)', borderRadius: 'var(--radius-md)', cursor: 'pointer', padding: '4px 10px' };
const sxEditBtn: React.CSSProperties = { background: 'none', color: 'var(--ink-2)', fontSize: '0.75rem', border: '1px solid var(--stone)', borderRadius: 'var(--radius-md)', cursor: 'pointer', padding: '4px 10px' };

export interface SurveyVisitServer {
  id: number;
  contact_id: string;
  contact_name: string;
  contact_email: string;
  status: string;
  visit_date: string | null;
  created_at: string;
  updated_at: string | null;
  version: number | null;
  estimate_total_pence: number | string;
  handler_config: Record<string, unknown> | null;
  design_visit_id: number | string | null;
  handle_id: number | string | null;
  furniture_range_id: number | string | null;
  location: string | null;
  notes: string | null;
  terms_accepted: boolean;
  duration_min: number | null;
  revision_note?: string | null;
  signoff_token_hash: string | null;
  signoff_expires_at: string | null;
}

function fmtGbpFromPence(pence: number): string {
  return (pence / 100).toFixed(2);
}

const SV_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  revision_requested: 'Revision requested',
  signed_off: 'Signed off',
  cancelled: 'Cancelled',
};

const SV_STATUS_COLORS: Record<string, string> = {
  draft: 'var(--ink-4)',
  submitted: 'var(--brand)',
  revision_requested: 'var(--warning, #d97706)',
  signed_off: 'var(--success, #059669)',
  cancelled: 'var(--error)',
};

function SurveyVisitStatusPill({ status }: { status: string }) {
  const label = SV_STATUS_LABELS[status] ?? status;
  const color = SV_STATUS_COLORS[status] ?? 'var(--ink-4)';
  return (
    <span style={{
      fontSize: '0.65rem',
      fontWeight: 700,
      color,
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      border: `1px solid ${color}`,
      borderRadius: 'var(--radius-sm)',
      padding: '1px 5px',
    }}>
      {label}
    </span>
  );
}

/**
 * Maps a queued survey-visit PUT body (camelCase) back to an ExistingSurveyVisit shape
 * so the wizard can resume from the user's unsynced edits.
 *
 * `baseVersion` and `baseUpdatedAt` carry the conflict base the original queued edit was
 * built on, so re-saving keeps the same base rather than re-reading a fresher server version.
 * Returns `null` when the body can't be read.
 */
function queuedBodyToExistingSurveyVisit(
  body: Record<string, unknown> | null,
  visitId: number,
  baseVersion: number | null,
  baseUpdatedAt: string | null,
): ExistingSurveyVisit | null {
  if (!body || typeof body !== 'object') return null;
  if (!Array.isArray(body.rooms)) return null;
  const rooms = body.rooms as Array<Record<string, unknown>>;
  return {
    id: visitId,
    version: baseVersion,
    updated_at: baseUpdatedAt,
    design_visit_id: (body.designVisitId as number | string | null | undefined) ?? null,
    visit_date: typeof body.visitDate === 'string' ? body.visitDate : undefined,
    duration_min: typeof body.durationMin === 'number' ? body.durationMin : undefined,
    location: typeof body.location === 'string' ? body.location : undefined,
    structuredAddress: body.structuredAddress as ExistingSurveyVisit['structuredAddress'],
    handle_id: (body.handleId as string | number | null | undefined) ?? null,
    furniture_range_id: (body.furnitureRangeId as string | number | null | undefined) ?? null,
    notes: typeof body.notes === 'string' ? body.notes : undefined,
    terms_accepted: !!body.termsAccepted,
    rooms: rooms.map(r => ({
      roomName: typeof r.roomName === 'string' ? r.roomName : '',
      doorStyleId: (r.doorStyleId as string | number | undefined) ?? '',
      widthMm: typeof r.widthMm === 'number' ? r.widthMm : null,
      heightMm: typeof r.heightMm === 'number' ? r.heightMm : null,
      depthMm: typeof r.depthMm === 'number' ? r.depthMm : null,
      unitCount: typeof r.unitCount === 'number' ? r.unitCount : 1,
      unitPricePence: typeof r.unitPricePence === 'number' ? r.unitPricePence : 0,
      notes: typeof r.notes === 'string' ? r.notes : '',
      images: Array.isArray(r.images)
        ? (r.images as Array<Record<string, unknown>>).map(i => ({
            storageKey: typeof i.storageKey === 'string' ? i.storageKey : '',
            mimeType: typeof i.mimeType === 'string' ? i.mimeType : undefined,
            viewUrl: typeof i.viewUrl === 'string' ? i.viewUrl : undefined,
          }))
        : [],
    })),
  };
}

/** Retry / Discard actions for a queued *refund* that failed to sync. */
function PendingRefundActions({ entries }: { entries: PendingSurveyVisitEntry[] }) {
  const [busy, setBusy] = useState(false);

  const handleRetry = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const engine = await import('../../lib/syncEngine');
      await Promise.all(entries.map(e => engine.retryEntry(e.id)));
    } catch {
      /* best-effort — the periodic flush will pick it up */
    } finally {
      setBusy(false);
    }
  }, [busy, entries]);

  const handleDiscard = useCallback(() => {
    if (busy) return;
    const doDiscard = async () => {
      setBusy(true);
      try {
        const mod = await import('../../lib/offlineQueue');
        await Promise.all(entries.map(e => mod.removeEntry(e.id)));
      } catch {
        /* best-effort */
      } finally {
        setBusy(false);
      }
    };
    window.showBottomConfirm(
      "Discard this queued refund request? The request will be permanently removed — you'll need to submit it again manually if still needed.",
      doDiscard,
    );
  }, [busy, entries]);

  return (
    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
      <button style={sxSecondaryBtn} disabled={busy} onClick={handleRetry}>Retry</button>
      <button style={{ ...sxSecondaryBtn, color: 'var(--error)' }} disabled={busy} onClick={handleDiscard}>Discard</button>
    </div>
  );
}

/** Retry / Discard actions for a queued *edit* that failed to upload. */
function PendingEditActions({ entry }: { entry: PendingSurveyVisitEntry }) {
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
      "Discard this unsynced edit? The changes saved on this device will be lost — the visit's last synced copy on the server stays as it is.",
      doDiscard,
    );
  }, [busy, entry.id]);

  return (
    <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <button style={sxSecondaryBtn} disabled={busy} onClick={handleRetry}>Retry</button>
      <button style={{ ...sxSecondaryBtn, color: 'var(--error)' }} disabled={busy} onClick={handleDiscard}>Discard</button>
    </div>
  );
}

/** Bulk Retry all / Discard all for 2+ failed survey-visit writes. */
function BulkSurveyVisitActions({ entries }: { entries: PendingSurveyVisitEntry[] }) {
  const [busy, setBusy] = useState(false);
  const showToast = useToast();
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
      /* best-effort */
    } finally {
      setBusy(false);
    }
  }, [busy, failed]);

  const handleDiscardAll = useCallback(async () => {
    if (busy) return;
    const ids = failed.map(e => e.id);
    if (!ids.length) return;
    try {
      const queueMod = await import('../../lib/offlineQueue');
      const idSet = new Set(ids);
      const toExport = (await queueMod.getEntries()).filter(e => idSet.has(e.id));
      if (toExport.length) {
        const generatedAt = Date.now();
        const pdfMod = await import('../../lib/failuresPdf');
        pdfMod.downloadFailuresPdf(toExport, generatedAt);
        showToast(`Saved ${pdfMod.failuresPdfFilename(generatedAt)} — your changes are safe to discard.`);
      }
    } catch {
      /* best-effort */
    }
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
      `Discard all ${ids.length} unsynced survey visit changes? New visits captured offline will be permanently lost; queued edits drop their unsynced changes and keep each visit's last synced copy on the server.`,
      doDiscard,
    );
  }, [busy, failed, showToast]);

  if (failed.length < 2) return null;

  return (
    <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <button style={sxSecondaryBtn} disabled={busy} onClick={handleRetryAll}>Retry all</button>
      <button style={{ ...sxSecondaryBtn, color: 'var(--error)' }} disabled={busy} onClick={handleDiscardAll}>Discard all</button>
    </div>
  );
}

/** A survey visit captured offline that has not yet reached the server. */
function PendingSurveyVisitCard({ entry }: { entry: PendingSurveyVisitEntry }) {
  const when = fmtDesignVisitWhen(entry.visitDate || new Date(entry.createdAt).toISOString());
  const totalGbp = fmtGbpFromPence(entry.estimateTotalPence || 0);
  const [busy, setBusy] = useState(false);
  const isFailed = entry.status === 'failed';

  const handleRetry = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const engine = await import('../../lib/syncEngine');
      await engine.retryEntry(entry.id);
    } catch {
      /* best-effort */
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
      'Discard this failed survey visit? The captured visit data will be permanently lost.',
      doDiscard,
    );
  }, [busy, entry.id]);

  return (
    <div
      data-testid="sv-pending-card"
      style={{
        ...sxItem, marginBottom: 6, flexDirection: 'column', alignItems: 'stretch', gap: 6,
        borderStyle: 'dashed', opacity: isFailed ? 1 : 0.95,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, justifyContent: 'space-between' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...sxText, fontWeight: 500 }}>{when}</div>
          <div style={{ ...sxMeta, marginTop: 2 }}>
            <SyncStatePill status={entry.status} />
            <span style={sxMetaSep}>·</span>
            <span style={sxDate}>Estimate: £{totalGbp}</span>
          </div>
        </div>
        {isFailed && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button style={sxSecondaryBtn} disabled={busy} onClick={handleRetry}>Retry</button>
            <button style={{ ...sxSecondaryBtn, color: 'var(--error)' }} disabled={busy} onClick={handleDiscard}>Discard</button>
          </div>
        )}
      </div>
      <p style={{ fontSize: '0.78rem', color: 'var(--ink-3)', margin: 0 }}>
        {isFailed
          ? `Couldn't sync this survey visit${entry.lastError ? ` — ${entry.lastError}` : ''}. Retry to upload it again, or discard it.`
          : "Saved on this device — it'll upload and send the sign-off email when you're back online."}
      </p>
    </div>
  );
}

/** Returns the sign-off link label for a submitted visit, or null if not applicable. */
function signoffStatusLabel(visit: SurveyVisitServer): { label: string; color: string } | null {
  if (visit.status !== 'submitted') return null;
  if (!visit.signoff_token_hash) {
    return { label: 'No link sent', color: 'var(--warning, #d97706)' };
  }
  const isExpired = !!visit.signoff_expires_at && new Date() > new Date(visit.signoff_expires_at);
  return isExpired
    ? { label: 'Link expired', color: 'var(--warning, #d97706)' }
    : { label: 'Link sent',    color: 'var(--success, #059669)' };
}

interface ServerVisitCardProps {
  visit: SurveyVisitServer;
  pendingEdit: PendingSurveyVisitEntry | undefined;
  pendingRefund: PendingSurveyVisitEntry | undefined;
  isAdmin: boolean;
  resendBusy: boolean;
  onEdit: (id: number) => void;
  onRevision: (id: number) => void;
  onDelete: (id: number) => void;
  onResendSignoff: (id: number) => void;
}

/** Card for a server-synced survey visit row, with optional queued-edit badge and admin actions. */
function ServerSurveyVisitCard({ visit, pendingEdit, pendingRefund, isAdmin, resendBusy, onEdit, onRevision, onDelete, onResendSignoff }: ServerVisitCardProps) {
  const when = fmtDesignVisitWhen(visit.visit_date || visit.created_at);
  const totalGbp = fmtGbpFromPence(Number(visit.estimate_total_pence) || 0);
  const canEdit       = visit.status === 'submitted' || visit.status === 'revision_requested' || visit.status === 'draft';
  const canRevise     = isAdmin && (visit.status === 'submitted' || visit.status === 'signed_off');
  const canResend     = isAdmin && visit.status === 'submitted';
  const isFailed      = pendingEdit?.status === 'failed';
  const signoffStatus = signoffStatusLabel(visit);

  return (
    <div
      data-testid="sv-server-card"
      data-sv-id={visit.id}
      style={{ ...sxItem, marginBottom: 6, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, justifyContent: 'space-between' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...sxText, fontWeight: 500 }}>{when}</div>
          <div style={{ ...sxMeta, marginTop: 2 }}>
            <span data-testid="sv-status-pill">
              <SurveyVisitStatusPill status={visit.status} />
            </span>
            {pendingEdit && (
              <>
                <span style={sxMetaSep}>·</span>
                <SyncStatePill status={pendingEdit.status} />
              </>
            )}
            {signoffStatus && (
              <>
                <span style={sxMetaSep}>·</span>
                <Tooltip
                  title={signoffStatus.label === 'No link sent'
                    ? "The sign-off email failed to send at submission time — use 'Resend sign-off email' to send it now"
                    : ''}
                  disableHoverListener={signoffStatus.label !== 'No link sent'}
                  disableFocusListener={signoffStatus.label !== 'No link sent'}
                  disableTouchListener={signoffStatus.label !== 'No link sent'}
                  arrow
                >
                  <span data-testid="sv-signoff-status" style={{
                    fontSize: '0.65rem', fontWeight: 700, color: signoffStatus.color,
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                    cursor: signoffStatus.label === 'No link sent' ? 'help' : undefined,
                  }}>
                    {signoffStatus.label}
                  </span>
                </Tooltip>
              </>
            )}
            <span style={sxMetaSep}>·</span>
            <span style={sxDate}>Estimate: £{totalGbp}</span>
          </div>
          {visit.revision_note && (
            <div style={{ fontSize: '0.78rem', color: 'var(--error)', marginTop: 2, whiteSpace: 'pre-wrap' }}>
              <strong>Revision note:</strong> {visit.revision_note}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {canEdit && (
            <button style={sxEditBtn} onClick={() => onEdit(visit.id)}>
              {pendingEdit ? 'Resume changes' : 'Edit'}
            </button>
          )}
          {canRevise && (
            <button style={sxSecondaryBtn} onClick={() => onRevision(visit.id)}>
              Request revision
            </button>
          )}
          {canResend && (
            <button style={sxSecondaryBtn} disabled={resendBusy} onClick={() => onResendSignoff(visit.id)}>
              {resendBusy ? 'Sending…' : 'Resend sign-off email'}
            </button>
          )}
          {isAdmin && (
            <button style={{ ...sxSecondaryBtn, color: 'var(--error)' }} onClick={() => onDelete(visit.id)}>
              Delete
            </button>
          )}
          {isFailed && <PendingEditActions entry={pendingEdit!} />}
        </div>
      </div>
      {isFailed && (
        <p style={{ fontSize: '0.78rem', color: 'var(--ink-3)', margin: 0 }}>
          {`Couldn't sync your edit to this visit${pendingEdit?.lastError ? ` — ${pendingEdit.lastError}` : ''}. Retry to upload it again, or discard it to drop the unsynced changes and keep the server copy.`}
        </p>
      )}
      {pendingEdit && pendingEdit.status === 'pending' && (
        <p style={{ fontSize: '0.78rem', color: 'var(--ink-3)', margin: 0 }}>
          Edit saved on this device — it'll upload when you&apos;re back online.
        </p>
      )}
      {pendingRefund && (
        <div
          data-testid="sv-refund-inline-badge"
          style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            background: 'var(--paper)', border: '1px dashed var(--stone)',
            borderRadius: 'var(--radius-md)', padding: '5px 10px',
          }}
        >
          <SyncStatePill status={pendingRefund.status} testId="sv-refund-sync-pill" />
          <span style={{ fontSize: '0.78rem', color: 'var(--ink-3)', flex: 1, minWidth: 0 }}>
            {pendingRefund.status === 'failed'
              ? `Refund request couldn't sync${pendingRefund.lastError ? ` — ${pendingRefund.lastError}` : ''}.`
              : "Refund request pending sync — it'll be sent when you're back online."}
          </span>
          {pendingRefund.status === 'failed' && (
            <PendingRefundActions entries={[pendingRefund]} />
          )}
        </div>
      )}
    </div>
  );
}

/** A single refund-banner row with its own Retry / Discard pair. */
function RefundBannerRow({ entry, showIndex, total }: { entry: PendingSurveyVisitEntry; showIndex: number; total: number }) {
  const [busy, setBusy] = useState(false);
  const isFailed = entry.status === 'failed';

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
      "Discard this queued refund request? The request will be permanently removed — you'll need to submit it again manually if still needed.",
      doDiscard,
    );
  }, [busy, entry.id]);

  return (
    <div
      data-testid="sv-refund-banner-row"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        background: 'var(--paper)',
        borderTop: showIndex > 0 ? '1px solid var(--stone)' : undefined,
        padding: total > 1 ? '6px 0' : '0',
      }}
    >
      <SyncStatePill status={entry.status} testId="sv-refund-sync-pill" />
      <span style={{ fontSize: '0.8rem', color: 'var(--ink-3)', flex: 1, minWidth: 0 }}>
        {isFailed
          ? `Refund request ${total > 1 ? `#${showIndex + 1} ` : ''}couldn't sync${entry.lastError ? ` — ${entry.lastError}` : ''}.`
          : `Refund request${total > 1 ? ` #${showIndex + 1}` : ''} pending sync — it'll be sent when you're back online.`}
      </span>
      {isFailed && (
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button style={sxSecondaryBtn} disabled={busy} onClick={handleRetry}>Retry</button>
          <button style={{ ...sxSecondaryBtn, color: 'var(--error)' }} disabled={busy} onClick={handleDiscard}>Discard</button>
        </div>
      )}
    </div>
  );
}

/**
 * Banner shown at the top of the survey visits section when one or more refund
 * requests are sitting in the offline queue waiting to sync (legacy: no visit-id
 * attached). Supports multiple entries.
 *
 * - **Single entry:** collapsed single-row banner (existing behaviour).
 * - **2+ entries:** each refund gets its own inline row with its own
 *   Retry / Discard pair so staff can act on them individually.
 */
function PendingRefundBanner({ entries }: { entries: PendingSurveyVisitEntry[] }) {
  if (!entries.length) return null;

  const anyFailed = entries.some(e => e.status === 'failed');
  const anySyncing = entries.some(e => e.status === 'syncing');
  const failedEntries = entries.filter(e => e.status === 'failed');
  const status = anyFailed ? 'failed' : anySyncing ? 'syncing' : 'pending';
  const firstError = entries.find(e => e.lastError)?.lastError;

  /* 2+ entries — render one row per refund so each can be retried/discarded individually */
  if (entries.length > 1) {
    return (
      <div
        data-testid="sv-refund-pending-banner"
        style={{
          background: 'var(--paper)', border: '1px dashed var(--stone)',
          borderRadius: 'var(--radius-lg)', padding: '8px 12px', marginBottom: 6,
        }}
      >
        {entries.map((e, i) => (
          <RefundBannerRow key={e.id} entry={e} showIndex={i} total={entries.length} />
        ))}
      </div>
    );
  }

  /* Single entry — original collapsed banner */
  return (
    <div
      data-testid="sv-refund-pending-banner"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        background: 'var(--paper)', border: '1px dashed var(--stone)',
        borderRadius: 'var(--radius-lg)', padding: '8px 12px', marginBottom: 6,
      }}
    >
      <SyncStatePill status={status} testId="sv-refund-sync-pill" />
      <span style={{ fontSize: '0.8rem', color: 'var(--ink-3)', flex: 1, minWidth: 0 }}>
        {anyFailed
          ? `Refund request couldn't sync${firstError ? ` — ${firstError}` : ''}.`
          : "Refund request pending sync — it'll be sent when you're back online."}
      </span>
      {anyFailed && <PendingRefundActions entries={failedEntries} />}
    </div>
  );
}

interface WizardState {
  handler: SurveyVisitWizardHandler;
  ctx: SurveyVisitWizardCtx;
  existingVisit: ExistingSurveyVisit;
}

interface Props {
  contactId: string;
  serverVisits?: SurveyVisitServer[];
  serverLoading?: boolean;
  serverError?: string | null;
  fromCache?: boolean;
  onRefresh?: () => void;
}

/**
 * Shows survey visits for a contact: server-synced visits (fetched from
 * `/api/survey-visits?contactId=`) and offline-queued writes (pending / failed).
 *
 * Server-visit cards show a SyncStatePill when there is a queued edit in the
 * outbox, and retry/discard actions when that edit has failed. Clicking "Edit"
 * (or "Resume changes" when a queued edit exists) opens the SurveyVisitWizard
 * pre-filled from the queued payload — preserving the user's unsynced work —
 * or from the server copy when no queued edit is present.
 *
 * Admins can request a revision or delete a server-synced visit.
 *
 * Offline-only creates (not yet on the server) still render as PendingSurveyVisitCards.
 */
export function SurveyVisitsList({ contactId, serverVisits = [], serverLoading, serverError, fromCache, onRefresh }: Props) {
  const { isAdmin } = usePrivilege();
  const showToast = useToast();

  const pendingEntries = useOfflineSurveyVisitEntries(contactId);
  const pendingRefunds = pendingEntries.filter(e => e.isRefund);
  const pendingCreates = pendingEntries.filter(e => !e.isEdit && !e.isRefund);
  const pendingEditByVisitId = new Map<number, PendingSurveyVisitEntry>();
  const pendingRefundByVisitId = new Map<number, PendingSurveyVisitEntry>();
  for (const e of pendingEntries) {
    if (e.isEdit && e.editVisitId != null) pendingEditByVisitId.set(e.editVisitId, e);
    if (e.isRefund && e.refundVisitId != null) pendingRefundByVisitId.set(e.refundVisitId, e);
  }
  const bannerRefunds = pendingRefunds.filter(e => e.refundVisitId == null);

  const [wizardState, setWizardState] = useState<WizardState | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resendBusyId, setResendBusyId] = useState<number | null>(null);

  // Refetch when a queued entry drains so the server card replaces the pending card.
  const prevIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const current = new Set(pendingEntries.map(e => e.id));
    const prev = prevIdsRef.current;
    let removed = false;
    for (const id of prev) {
      if (!current.has(id)) { removed = true; break; }
    }
    prevIdsRef.current = current;
    if (removed) onRefresh?.();
  }, [pendingEntries, onRefresh]);

  const handleRevision = useCallback(async (id: number) => {
    if (!isAdmin) return;
    const note = window.prompt('Revision note (optional):', '');
    if (note === null) return;
    try {
      const r = await fetch(`/api/survey-visits/${id}/revision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionNote: note }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      onRefresh?.();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'error';
      setActionError(`Could not mark for revision: ${msg}`);
    }
  }, [isAdmin, onRefresh]);

  const handleDelete = useCallback((id: number) => {
    if (!isAdmin) return;
    const doDelete = async () => {
      try {
        const r = await fetch(`/api/survey-visits/${id}`, { method: 'DELETE' });
        if (!r.ok) throw new Error(`${r.status}`);
        await evictCachedRecord('visits', `sv:${id}`);
        // Purge any queued offline edits for this visit so they don't replay
        // against a now-deleted resource after the next reconnect.
        const { removeQueuedByRecordKey } = await import('../../lib/offlineQueue');
        await removeQueuedByRecordKey(`sv:${id}`);
        onRefresh?.();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'error';
        setActionError(`Could not delete: ${msg}`);
      }
    };
    window.showBottomConfirm('Delete this survey visit? This cannot be undone.', doDelete);
  }, [isAdmin, onRefresh]);

  const handleResendSignoff = useCallback(async (id: number) => {
    if (!isAdmin) return;
    setResendBusyId(id);
    setActionError(null);
    try {
      const r = await fetch(`/api/survey-visits/${id}/resend-signoff`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `${r.status}`);
      }
      const data = await r.json() as { emailSent?: boolean };
      if (data.emailSent === false) {
        setActionError('Sign-off link refreshed, but no email was sent — email is not configured in your settings.');
        onRefresh?.();
      } else {
        const email = serverVisits.find(v => v.id === id)?.contact_email;
        const dest = email ? ` to ${email}` : '';
        showToast(`Sign-off email resent${dest}.`);
        onRefresh?.();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'error';
      setActionError(`Could not resend sign-off email: ${msg}`);
    } finally {
      setResendBusyId(null);
    }
  }, [isAdmin, onRefresh, serverVisits, showToast]);

  const openWizardForEdit = useCallback(async (visitId: number) => {
    if (editBusy) return;
    const serverVisit = serverVisits.find(v => v.id === visitId);
    if (!serverVisit) return;

    setEditBusy(true);
    setEditError(null);
    try {
      const pending = pendingEditByVisitId.get(visitId);

      let existingVisit: ExistingSurveyVisit | null = null;

      // Prefer the queued edit payload — it captures the user's unsynced changes
      // and carries the exact baseVersion/baseUpdatedAt the edit was built on.
      if (pending && pending.status !== 'synced') {
        existingVisit = queuedBodyToExistingSurveyVisit(
          pending.queuedBody, visitId, pending.baseVersion, pending.baseUpdatedAt,
        );
      }

      // Fetch the full visit+rooms from the server when no queued payload is
      // available or readable. The list endpoint does not include room detail,
      // so we must use the detail endpoint — do not fall back to the list row.
      if (!existingVisit) {
        let detailOk = false;
        try {
          const r = await fetch(`/api/survey-visits/${visitId}`);
          if (r.ok) {
            existingVisit = (await r.json()) as ExistingSurveyVisit;
            detailOk = true;
          }
        } catch {
          /* network error */
        }
        if (!detailOk || !existingVisit) {
          setEditError("Couldn't load visit details. Check your connection and try again.");
          return;
        }
      }

      const handler: SurveyVisitWizardHandler = {
        config: (serverVisit.handler_config as SurveyVisitWizardHandler['config']) ?? {},
      };
      const ctx: SurveyVisitWizardCtx = {
        contactId: String(serverVisit.contact_id),
        contactName: serverVisit.contact_name || '',
        contactEmail: serverVisit.contact_email || '',
      };

      setWizardState({ handler, ctx, existingVisit });
    } catch {
      setEditError("Couldn't open the editor. Please try again.");
    } finally {
      setEditBusy(false);
    }
  }, [editBusy, serverVisits, pendingEditByVisitId]);

  const hasAnything =
    pendingEntries.length > 0 ||
    serverVisits.length > 0 ||
    serverLoading ||
    serverError;

  if (!hasAnything) return null;

  return (
    <>
      {wizardState && (
        <Suspense fallback={null}>
          <SurveyVisitWizardLazy
            handler={wizardState.handler}
            ctx={wizardState.ctx}
            existingVisit={wizardState.existingVisit}
            onClose={() => { setWizardState(null); onRefresh?.(); }}
          />
        </Suspense>
      )}

      <div id="survey-visits-section" style={{ marginBottom: 20 }}>
        <div style={sxHeader}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={sxHeaderLabel}>Survey visits</span>
            {fromCache && (
              <span
                data-testid="sv-cached-badge"
                style={{
                  fontSize: '0.6rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--ink-3)',
                  border: '1px solid var(--stone)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '1px 5px',
                }}
              >
                Cached
              </span>
            )}
          </span>
          <BulkSurveyVisitActions entries={pendingEntries} />
        </div>
        {actionError && (
          <p style={{ fontSize: '0.85rem', color: 'var(--error)', padding: '4px 0' }}>{actionError}</p>
        )}
        <div style={{ fontSize: '0.875rem', color: 'var(--stone-deep)' }}>
          {serverLoading && (
            <p style={{ fontSize: '0.85rem', padding: '4px 0', fontStyle: 'italic' }}>Loading…</p>
          )}
          {!serverLoading && serverError && (
            <p style={{ fontSize: '0.85rem', color: 'var(--error)', padding: '4px 0' }}>Could not load survey visits.</p>
          )}
          {!serverLoading && !serverError && serverVisits.length === 0 && pendingCreates.length === 0 && pendingEntries.length === 0 && (
            <p style={{ fontSize: '0.85rem', padding: '4px 0', fontStyle: 'italic' }}>No survey visits yet.</p>
          )}

          {/* Refund request(s) queued offline without a specific visit — shown as a contact-level banner */}
          <PendingRefundBanner entries={bannerRefunds} />

          {pendingCreates.map(p => (
            <PendingSurveyVisitCard key={`sv-pending-${p.id}`} entry={p} />
          ))}

          {!serverLoading && !serverError && serverVisits.map(v => (
            <ServerSurveyVisitCard
              key={`sv-server-${v.id}`}
              visit={v}
              pendingEdit={pendingEditByVisitId.get(v.id)}
              pendingRefund={pendingRefundByVisitId.get(v.id)}
              isAdmin={isAdmin}
              resendBusy={resendBusyId === v.id}
              onEdit={openWizardForEdit}
              onRevision={handleRevision}
              onDelete={handleDelete}
              onResendSignoff={handleResendSignoff}
            />
          ))}
        </div>
        {editBusy && (
          <p style={{ fontSize: '0.78rem', color: 'var(--ink-4)', marginTop: 4 }}>Opening editor…</p>
        )}
        {editError && (
          <p style={{ fontSize: '0.78rem', color: 'var(--error)', marginTop: 4 }}>{editError}</p>
        )}
      </div>
    </>
  );
}
