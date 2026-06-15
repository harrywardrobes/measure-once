import React, { useState, useCallback, useEffect, useRef } from 'react';
import { SurveyVisit, fmtDesignVisitWhen, fmtGbp } from './types';
import { DesignVisitStatusPill } from './DesignVisitStatusPill';
import { usePrivilege } from '../../hooks/usePrivilege';
import { useOfflineSurveyVisitEntries, type PendingSurveyVisitEntry } from '../../hooks/useOfflineSurveyVisitEntries';
import { useToast } from '../../contexts/ToastContext';
import { SyncStatePill } from '../../components/SyncStatePill';

const sxHeader: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 };
const sxHeaderLabel: React.CSSProperties = { fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink-2)' };
const sxItem: React.CSSProperties = { background: 'var(--paper)', border: '1px solid var(--stone)', borderRadius: 'var(--radius-lg)', padding: '11px 14px', boxShadow: 'var(--shadow-sm)' };
const sxMeta: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 };
const sxMetaSep: React.CSSProperties = { fontSize: '0.65rem', color: 'var(--ink-4)' };
const sxDate: React.CSSProperties = { fontSize: '0.68rem', color: 'var(--ink-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' };
const sxText: React.CSSProperties = { fontSize: '0.875rem', color: 'var(--ink-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' };
const sxSecondaryBtn: React.CSSProperties = { background: 'none', color: 'var(--ink-3)', fontSize: '0.75rem', border: '1px solid var(--stone)', borderRadius: 'var(--radius-md)', cursor: 'pointer', padding: '4px 10px' };

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
  const totalGbp = fmtGbp(entry.estimateTotalPence || 0);
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

/** Sync-state badge shown inline on a server card when there is a queued edit. */
function PendingEditBadge({ entry }: { entry: PendingSurveyVisitEntry }) {
  const isFailed = entry.status === 'failed';
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <SyncStatePill status={entry.status} />
        {isFailed && <PendingEditActions entry={entry} />}
      </div>
      {isFailed && (
        <p style={{ fontSize: '0.78rem', color: 'var(--ink-3)', margin: '4px 0 0' }}>
          {`Couldn't sync your edit to this visit${entry.lastError ? ` — ${entry.lastError}` : ''}. Retry to upload it again, or discard it to drop the unsynced changes and keep the server copy.`}
        </p>
      )}
    </div>
  );
}

interface Props {
  contactId: string;
  visits: SurveyVisit[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/**
 * Shows server-sourced survey visits for a contact, merged with any
 * offline-queued pending / failed writes. Each card shows visit date, status
 * pill, and estimate total. Admins can request a revision or delete a visit.
 */
export function SurveyVisitsList({ contactId, visits, loading, error, onRefresh }: Props) {
  const { isAdmin } = usePrivilege();
  const [actionError, setActionError] = useState<string | null>(null);

  const pendingEntries = useOfflineSurveyVisitEntries(contactId);
  const pendingCreates = pendingEntries.filter(e => !e.isEdit);
  const pendingEditByVisitId = new Map<number, PendingSurveyVisitEntry>();
  for (const e of pendingEntries) {
    if (e.isEdit && e.editVisitId != null) pendingEditByVisitId.set(e.editVisitId, e);
  }

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
    if (removed) onRefresh();
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
      onRefresh();
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
        onRefresh();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'error';
        setActionError(`Could not delete: ${msg}`);
      }
    };
    window.showBottomConfirm('Delete this survey visit? This cannot be undone.', doDelete);
  }, [isAdmin, onRefresh]);

  const hasContent = visits.length > 0 || pendingEntries.length > 0 || loading || !!error;

  if (!hasContent) return null;

  return (
    <div id="survey-visits-section" style={{ marginBottom: 20 }}>
      <div style={sxHeader}>
        <span style={sxHeaderLabel}>Survey visits</span>
        <BulkSurveyVisitActions entries={pendingEntries} />
      </div>
      {actionError && (
        <p style={{ fontSize: '0.85rem', color: 'var(--error)', padding: '4px 0' }}>{actionError}</p>
      )}
      <div style={{ fontSize: '0.875rem', color: 'var(--stone-deep)' }}>
        {loading && (
          <p style={{ fontSize: '0.85rem', padding: '4px 0', fontStyle: 'italic' }}>Loading…</p>
        )}
        {!loading && error && (
          <p style={{ fontSize: '0.85rem', color: 'var(--error)', padding: '4px 0' }}>Could not load survey visits.</p>
        )}
        {/* Pending offline cards render even when the server fetch failed */}
        {!loading && pendingCreates.map(p => (
          <PendingSurveyVisitCard key={`sv-pending-${p.id}`} entry={p} />
        ))}
        {!loading && !error && visits.map(v => {
          const when      = fmtDesignVisitWhen(v.visit_date || v.created_at);
          const totalGbp  = fmtGbp(Number(v.estimate_total_pence) || 0);
          const canRevise = v.status === 'submitted' || v.status === 'signed_off';
          const pendingEdit = pendingEditByVisitId.get(v.id);

          return (
            <div
              key={v.id}
              data-sv-id={v.id}
              style={{ ...sxItem, marginBottom: 6, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, justifyContent: 'space-between' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...sxText, fontWeight: 500 }}>{when}</div>
                  <div style={{ ...sxMeta, marginTop: 2 }}>
                    <span data-testid="sv-status-pill">
                      <DesignVisitStatusPill status={v.status} />
                    </span>
                    {pendingEdit && <SyncStatePill status={pendingEdit.status} />}
                    <span style={sxMetaSep}>·</span>
                    <span style={sxDate}>Estimate: £{totalGbp}</span>
                  </div>
                  {v.revision_note && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--error)', marginTop: 2, whiteSpace: 'pre-wrap' }}>
                      <strong>Revision note:</strong> {v.revision_note}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {isAdmin && canRevise && (
                    <button
                      style={sxSecondaryBtn}
                      onClick={() => handleRevision(v.id)}
                    >
                      Request revision
                    </button>
                  )}
                  {isAdmin && (
                    <button
                      style={{ ...sxSecondaryBtn, color: 'var(--error)' }}
                      onClick={() => handleDelete(v.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
              {pendingEdit && <PendingEditBadge entry={pendingEdit} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
