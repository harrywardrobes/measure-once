import React, { useState, useCallback, useEffect, useRef } from 'react';
import { fmtDesignVisitWhen } from './types';
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

function fmtGbpFromPence(pence: number): string {
  return (pence / 100).toFixed(2);
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

/** Card shown inline on a server-side survey visit row when there is a pending edit queued. */
function PendingEditCard({ entry }: { entry: PendingSurveyVisitEntry }) {
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
  onRefresh?: () => void;
}

/**
 * Shows offline-queued survey visit writes (pending / failed) for a contact.
 *
 * Survey visits are launched from the card-action modal host rather than as a
 * persistent page list, so this component only renders when there are queued
 * entries in the outbox — it is invisible in the normal (online) case.
 */
export function SurveyVisitsList({ contactId, onRefresh }: Props) {
  const pendingEntries = useOfflineSurveyVisitEntries(contactId);
  const pendingCreates = pendingEntries.filter(e => !e.isEdit);
  const pendingEditByVisitId = new Map<number, PendingSurveyVisitEntry>();
  for (const e of pendingEntries) {
    if (e.isEdit && e.editVisitId != null) pendingEditByVisitId.set(e.editVisitId, e);
  }

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

  if (pendingEntries.length === 0) return null;

  return (
    <div id="survey-visits-section" style={{ marginBottom: 20 }}>
      <div style={sxHeader}>
        <span style={sxHeaderLabel}>Survey visits</span>
        <BulkSurveyVisitActions entries={pendingEntries} />
      </div>
      <div style={{ fontSize: '0.875rem', color: 'var(--stone-deep)' }}>
        {pendingCreates.map(p => (
          <PendingSurveyVisitCard key={`sv-pending-${p.id}`} entry={p} />
        ))}
        {Array.from(pendingEditByVisitId.entries()).map(([visitId, e]) => (
          <div key={`sv-edit-${visitId}`} style={{ ...sxItem, marginBottom: 6 }}>
            <div style={{ ...sxText, fontWeight: 500, fontSize: '0.8rem' }}>
              Survey visit #{visitId} — pending edit
            </div>
            <PendingEditCard entry={e} />
          </div>
        ))}
      </div>
    </div>
  );
}
