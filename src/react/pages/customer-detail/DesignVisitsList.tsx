import React, { useState, useCallback, useEffect, useRef } from 'react';
import { DesignVisit, DesignVisitRoom, fmtDesignVisitWhen, fmtGbp } from './types';
import { DesignVisitStatusPill } from './DesignVisitStatusPill';
import { usePrivilege } from '../../hooks/usePrivilege';
import { useOfflineVisitEntries, type PendingVisitEntry } from '../../hooks/useOfflineVisitEntries';
import { useToast } from '../../contexts/ToastContext';
import { SyncStatePill } from '../../components/SyncStatePill';
import { DesignVisitWizard, type DesignVisitWizardHandler, type DesignVisitWizardCtx, type ExistingVisit } from '../../components/DesignVisitWizard';
import { useQBInvoices } from '../../hooks/useQBInvoices';

const sxHeader: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 };
const sxHeaderLabel: React.CSSProperties = { fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink-2)' };
const sxItem: React.CSSProperties = { background: 'var(--paper)', border: '1px solid var(--stone)', borderRadius: 'var(--radius-lg)', padding: '11px 14px', boxShadow: 'var(--shadow-sm)' };
const sxMeta: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 };
const sxMetaSep: React.CSSProperties = { fontSize: '0.65rem', color: 'var(--ink-4)' };
const sxDate: React.CSSProperties = { fontSize: '0.68rem', color: 'var(--ink-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' };
const sxText: React.CSSProperties = { fontSize: '0.875rem', color: 'var(--ink-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' };
const sxSecondaryBtn: React.CSSProperties = { background: 'none', color: 'var(--ink-3)', fontSize: '0.75rem', border: '1px solid var(--stone)', borderRadius: 'var(--radius-md)', cursor: 'pointer', padding: '4px 10px' };

/**
 * Retry / Discard actions for a queued *edit* that failed to upload. The edit
 * targets an existing server visit, so discarding only drops the unsynced
 * changes — the server copy stays. Reuses the same retry/remove APIs as
 * PendingVisitCard.
 */
export function PendingEditActions({ entry }: { entry: PendingVisitEntry }) {
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
      <button
        data-testid="dv-edit-retry"
        style={sxSecondaryBtn}
        disabled={busy}
        onClick={handleRetry}
      >
        Retry
      </button>
      <button
        data-testid="dv-edit-discard"
        style={{ ...sxSecondaryBtn, color: 'var(--error)' }}
        disabled={busy}
        onClick={handleDiscard}
      >
        Discard
      </button>
    </div>
  );
}

/**
 * Bulk **Retry all** / **Discard all** controls for the design-visits section.
 * Renders only when 2+ queued design-visit writes for this contact are
 * `failed`, so a field user recovering from a long offline stint can act on the
 * whole backlog at once instead of one card at a time.
 *
 * - **Retry all** re-queues every failed entry (`retryEntry`) with no extra
 *   confirmation — the periodic flush picks them up.
 * - **Discard all** first offers the same PDF safety-net download used by the
 *   SyncPill failed-sync dialog (built from the real outbox entries), confirms
 *   via the existing toast, then gates the permanent removal behind
 *   `window.showBottomConfirm` before calling `removeEntry` for each.
 */
export function BulkVisitActions({ entries }: { entries: PendingVisitEntry[] }) {
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
      /* best-effort — the periodic flush will pick them up */
    } finally {
      setBusy(false);
    }
  }, [busy, failed]);

  const handleDiscardAll = useCallback(async () => {
    if (busy) return;
    const ids = failed.map(e => e.id);
    if (!ids.length) return;

    // 1. Offer the PDF safety-net first, built from the real outbox entries
    //    (the queue rows, not the summarised view) so the export carries every
    //    captured field. Best-effort: a PDF failure must not block the discard.
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
      /* best-effort — still let the user discard even if the PDF export failed */
    }

    // 2. Gate the permanent removal behind an explicit confirmation.
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
      `Discard all ${ids.length} unsynced visit changes? New visits captured offline will be permanently lost; queued edits drop their unsynced changes and keep each visit's last synced copy on the server.`,
      doDiscard,
    );
  }, [busy, failed, showToast]);

  if (failed.length < 2) return null;

  return (
    <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <button
        data-testid="dv-retry-all"
        style={sxSecondaryBtn}
        disabled={busy}
        onClick={handleRetryAll}
      >
        Retry all
      </button>
      <button
        data-testid="dv-discard-all"
        style={{ ...sxSecondaryBtn, color: 'var(--error)' }}
        disabled={busy}
        onClick={handleDiscardAll}
      >
        Discard all
      </button>
    </div>
  );
}

/** A design visit captured offline that has not yet reached the server. */
export function PendingVisitCard({ entry }: { entry: PendingVisitEntry }) {
  const when = fmtDesignVisitWhen(entry.visitDate || new Date(entry.createdAt).toISOString());
  const totalGbp = fmtGbp(entry.estimateTotalPence || 0);
  const [busy, setBusy] = useState(false);
  const isFailed = entry.status === 'failed';

  // Re-queue a permanently-failed entry (reset to `pending`) and kick a flush.
  // The queue's pub/sub refreshes useOfflineVisitEntries once the status flips.
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

  // Discard a failed entry for good — the captured visit data is lost, so this
  // is gated behind a confirmation.
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
      'Discard this failed design visit? The captured visit data will be permanently lost.',
      doDiscard,
    );
  }, [busy, entry.id]);

  return (
    <div
      data-testid="dv-pending-card"
      style={{
        ...sxItem, marginBottom: 6, flexDirection: 'column', alignItems: 'stretch', gap: 6,
        borderStyle: 'dashed', opacity: isFailed ? 1 : 0.95,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, justifyContent: 'space-between' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div data-testid="dv-when" style={{ ...sxText, fontWeight: 500 }}>{when}</div>
          <div style={{ ...sxMeta, marginTop: 2 }}>
            <SyncStatePill status={entry.status} />
            <span style={sxMetaSep}>·</span>
            <span style={sxDate}>Estimate: £{totalGbp}</span>
          </div>
        </div>
        {isFailed && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              data-testid="dv-pending-retry"
              style={sxSecondaryBtn}
              disabled={busy}
              onClick={handleRetry}
            >
              Retry
            </button>
            <button
              data-testid="dv-pending-discard"
              style={{ ...sxSecondaryBtn, color: 'var(--error)' }}
              disabled={busy}
              onClick={handleDiscard}
            >
              Discard
            </button>
          </div>
        )}
      </div>
      <p style={{ fontSize: '0.78rem', color: 'var(--ink-3)', margin: 0 }}>
        {isFailed
          ? `Couldn't sync this visit${entry.lastError ? ` — ${entry.lastError}` : ''}. Retry to upload it again, or discard it.`
          : "Saved on this device — it'll upload and send the sign-off email when you're back online."}
      </p>
    </div>
  );
}

interface Props {
  contactId: string;
  visits: DesignVisit[];
  loading: boolean;
  error: string | null;
  fromCache?: boolean;
  onRefresh: () => void;
}

interface DetailState {
  loading: boolean;
  data: DesignVisit | null;
  error: string | null;
}

interface WizardState {
  handler: DesignVisitWizardHandler;
  ctx: DesignVisitWizardCtx;
  existingVisit: ExistingVisit | null;
}

/**
 * Build an {@link ExistingVisit} the wizard can prefill from a **queued** edit
 * payload (the wizard's own submit body) instead of the stale server copy, so a
 * user resumes their unsynced changes. The wizard's prefill helpers read the
 * server-style snake_case keys for step-1 fields and accept either casing for
 * rooms, so we map the payload's camelCase keys across here.
 *
 * `version`/`updated_at` carry the conflict base the original queued edit was
 * built on, so re-saving keeps the same base (and the same record/dedupe key)
 * rather than re-reading a fresher server version. Returns `null` when the body
 * can't be read, letting the caller fall back to the server copy.
 */
function queuedBodyToExistingVisit(
  body: Record<string, unknown> | null,
  visitId: number,
  baseVersion: number | null,
  baseUpdatedAt: string | null,
): ExistingVisit | null {
  if (!body || typeof body !== 'object') return null;
  // Shape check: a real queued design-visit edit always carries a `rooms` array
  // (the wizard submits at least one room). A body without it is empty/corrupt,
  // so signal "can't read" and let the caller fall back to the server copy.
  if (!Array.isArray(body.rooms)) return null;
  const rooms = body.rooms as Array<Record<string, unknown>>;
  return {
    id: visitId,
    version: baseVersion,
    updated_at: baseUpdatedAt,
    visit_date: typeof body.visitDate === 'string' ? body.visitDate : undefined,
    duration_min: typeof body.durationMin === 'number' ? body.durationMin : undefined,
    location: typeof body.location === 'string' ? body.location : undefined,
    handle_id: (body.handleId as string | number | null | undefined) ?? null,
    furniture_range_id: (body.furnitureRangeId as string | number | null | undefined) ?? null,
    notes: typeof body.notes === 'string' ? body.notes : undefined,
    terms_accepted: !!body.termsAccepted,
    rooms: rooms.map(r => ({
      roomName:       typeof r.roomName === 'string' ? r.roomName : '',
      doorStyleId:    (r.doorStyleId as string | number | undefined) ?? '',
      widthMm:        typeof r.widthMm === 'number' ? r.widthMm : null,
      heightMm:       typeof r.heightMm === 'number' ? r.heightMm : null,
      depthMm:        typeof r.depthMm === 'number' ? r.depthMm : null,
      unitCount:      typeof r.unitCount === 'number' ? r.unitCount : 1,
      unitPricePence: typeof r.unitPricePence === 'number' ? r.unitPricePence : 0,
      notes:          typeof r.notes === 'string' ? r.notes : '',
      images: Array.isArray(r.images)
        ? (r.images as Array<Record<string, unknown>>).map(i => ({
            storageKey: typeof i.storageKey === 'string' ? i.storageKey : '',
            mimeType:   typeof i.mimeType === 'string' ? i.mimeType : undefined,
            // Offline-captured photos keep a data: URI in storageKey and render
            // directly; online uploads keep an opaque key whose short-lived
            // viewUrl is re-derived on resume (see openWizardForEdit).
            viewUrl:    typeof i.viewUrl === 'string' ? i.viewUrl : undefined,
          }))
        : [],
    })),
  };
}

/**
 * Re-derive short-lived signed view URLs for a resumed visit's room photos.
 *
 * A queued (unsynced) edit preserves each photo's `storageKey` but not the
 * expired signed `viewUrl`. Offline-captured photos keep a `data:` URI in
 * `storageKey` and render directly, so they need no signing. Online uploads keep
 * an opaque `obj:…` key whose thumbnail must be re-signed via the server.
 *
 * Best-effort: if the request fails (e.g. resuming while offline) the visit is
 * returned unchanged — the underlying image data still re-submits correctly,
 * only the preview thumbnail is missing.
 */
async function resignResumedImages(visit: ExistingVisit): Promise<ExistingVisit> {
  const rooms = visit.rooms || [];
  const opaqueKeys = new Set<string>();
  for (const r of rooms) {
    for (const img of r.images || []) {
      const key = img.storageKey || '';
      if (key.startsWith('obj:') && !img.viewUrl) opaqueKeys.add(key);
    }
  }
  if (opaqueKeys.size === 0) return visit;

  let urls: Record<string, string> = {};
  try {
    const r = await fetch('/api/design-visits/sign-image-urls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageKeys: Array.from(opaqueKeys) }),
    });
    if (r.ok) {
      const data = await r.json();
      if (data && typeof data.urls === 'object' && data.urls) {
        for (const [k, val] of Object.entries(data.urls as Record<string, unknown>)) {
          if (typeof val === 'string') urls[k] = val;
        }
      }
    }
  } catch {
    return visit; // offline or server error — keep storageKey-only previews
  }

  return {
    ...visit,
    rooms: rooms.map(r => ({
      ...r,
      images: (r.images || []).map(img => {
        const key = img.storageKey || '';
        return urls[key] ? { ...img, viewUrl: urls[key] } : img;
      }),
    })),
  };
}

/** Parse a `#design-visit-<id>` deep-link fragment into a numeric visit id. */
function visitIdFromHash(hash: string): number | null {
  const m = hash.match(/^#design-visit-(\d+)$/);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) ? id : null;
}

export function DesignVisitsList({ contactId, visits, loading, error, fromCache, onRefresh }: Props) {
  const { isAdmin } = usePrivilege();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [details, setDetails] = useState<Record<number, DetailState>>({});
  const [wizardState, setWizardState] = useState<WizardState | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const qb = useQBInvoices();
  useEffect(() => { qb.triggerLoad(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Queued offline design-visit writes for this contact (Phase 2). New visits
  // appear as their own pending cards; queued edits badge their server card.
  const pendingEntries = useOfflineVisitEntries(contactId);
  const pendingCreates = pendingEntries.filter(e => !e.isEdit);
  const pendingEditByVisitId = new Map<number, PendingVisitEntry>();
  for (const e of pendingEntries) {
    if (e.isEdit && e.editVisitId != null) pendingEditByVisitId.set(e.editVisitId, e);
  }

  // When a queued write drains (entry removed on a confirmed 2xx) the server
  // copy is now authoritative — refetch so the real card replaces the pending
  // one. Compare ids across renders so we only refresh on an actual removal.
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

  const loadDetail = useCallback((id: number) => {
    setDetails(d => {
      if (d[id]) return d;
      fetch(`/api/design-visits/${id}`)
        .then(r => r.ok ? r.json() : Promise.reject(r))
        .then((v: DesignVisit) => setDetails(dd => ({ ...dd, [id]: { loading: false, data: v, error: null } })))
        .catch(() => setDetails(dd => ({ ...dd, [id]: { loading: false, data: null, error: 'Could not load' } })));
      return { ...d, [id]: { loading: true, data: null, error: null } };
    });
  }, []);

  const toggleExpanded = useCallback((id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        loadDetail(id);
      }
      return next;
    });
  }, [loadDetail]);

  // Deep-link support: a conflict "Open record" link can carry a
  // `#design-visit-<id>` fragment so this list auto-expands and scrolls to the
  // exact visit. Runs once per fragment+visits change, only acting when the
  // target visit is actually present, so the user can still collapse it after.
  const deepLinkedRef = useRef<number | null>(null);
  useEffect(() => {
    const targetId = visitIdFromHash(window.location.hash);
    if (targetId == null || deepLinkedRef.current === targetId) return;
    if (!visits.some(v => v.id === targetId)) return;
    deepLinkedRef.current = targetId;
    setExpanded(prev => (prev.has(targetId) ? prev : new Set(prev).add(targetId)));
    loadDetail(targetId);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-dv-id="${targetId}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [visits, loadDetail]);

  const handleRevision = useCallback(async (id: number) => {
    if (!isAdmin) return;
    const note = window.prompt('Revision note (optional):', '');
    if (note === null) return;
    try {
      const r = await fetch(`/api/design-visits/${id}/revision`, {
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
        const r = await fetch(`/api/design-visits/${id}`, { method: 'DELETE' });
        if (!r.ok) throw new Error(`${r.status}`);
        onRefresh();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'error';
        setActionError(`Could not delete: ${msg}`);
      }
    };
    window.showBottomConfirm('Delete this design visit? This cannot be undone.', doDelete);
  }, [isAdmin, onRefresh]);

  const openWizardForEdit = useCallback(async (id: number) => {
    const v = visits.find(x => x.id === id);
    if (!v || !['submitted', 'revision_requested', 'draft'].includes(v.status)) return;
    const detail = details[id]?.data || v;
    const ctx: DesignVisitWizardCtx = {
      contactId:    detail.contact_id || contactId,
      contactName:  detail.contact_name  || '',
      contactEmail: detail.contact_email || '',
    };

    // If this visit has unsynced changes queued on this device, resume from that
    // payload so the user continues from their own edits rather than the stale
    // server copy. Saving re-uses the same record/dedupe key, replacing the
    // queued entry instead of adding a second conflicting edit. Fall back to the
    // server copy when the queued body can't be read.
    const pending = pendingEditByVisitId.get(id);
    let existingVisit: ExistingVisit = detail as unknown as ExistingVisit;
    if (pending && pending.status !== 'synced') {
      const resumed = queuedBodyToExistingVisit(
        pending.queuedBody, id, pending.baseVersion, pending.baseUpdatedAt,
      );
      if (resumed) existingVisit = await resignResumedImages(resumed);
    }

    setEditingId(id);
    setWizardState({ handler: { config: {} }, ctx, existingVisit });
  }, [visits, details, contactId, pendingEditByVisitId]);

  const handleEdit = useCallback((id: number) => {
    openWizardForEdit(id);
  }, [openWizardForEdit]);

  return (
    <>
    {wizardState && (
      <DesignVisitWizard
        handler={wizardState.handler}
        ctx={wizardState.ctx}
        existingVisit={wizardState.existingVisit}
        onCatalogueReady={() => setEditingId(null)}
        onClose={() => { setEditingId(null); setWizardState(null); onRefresh(); }}
      />
    )}
    <div id="design-visits-section" style={{ marginBottom: 20 }}>
      <div style={sxHeader}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={sxHeaderLabel}>Design visits</span>
          {fromCache && (
            <span
              data-testid="dv-cached-badge"
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
        <BulkVisitActions entries={pendingEntries} />
      </div>
      {actionError && (
        <p style={{ fontSize: '0.85rem', color: 'var(--error)', padding: '4px 0' }}>{actionError}</p>
      )}
      <div id="design-visits-list" style={{ fontSize: '0.875rem', color: 'var(--stone-deep)' }}>
        {loading && (
          <p style={{ fontSize: '0.85rem', padding: '4px 0', fontStyle: 'italic' }}>Loading…</p>
        )}
        {!loading && error && (
          <p style={{ fontSize: '0.85rem', color: 'var(--error)', padding: '4px 0' }}>Could not load design visits.</p>
        )}
        {!loading && !error && visits.length === 0 && pendingCreates.length === 0 && (
          <p style={{ fontSize: '0.85rem', padding: '4px 0', fontStyle: 'italic' }}>No design visits yet.</p>
        )}
        {/* Pending offline cards render even when the server fetch failed —
            that's the offline case where this visibility matters most. */}
        {!loading && pendingCreates.map(p => (
          <PendingVisitCard key={`pending-${p.id}`} entry={p} />
        ))}
        {!loading && !error && visits.map(v => {
          const when     = fmtDesignVisitWhen(v.visit_date || v.created_at);
          const totalGbp = fmtGbp(Number(v.estimate_total_pence) || 0);
          const canRevise = v.status === 'submitted' || v.status === 'signed_off';
          const canEditV  = v.status === 'submitted' || v.status === 'revision_requested' || v.status === 'draft';
          const isExp     = expanded.has(v.id);
          const det       = details[v.id];
          const pendingEdit = pendingEditByVisitId.get(v.id);

          return (
            <div
              key={v.id}
              data-dv-id={v.id}
              style={{ ...sxItem, marginBottom: 6, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, justifyContent: 'space-between' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div data-testid="dv-when" style={{ ...sxText, fontWeight: 500 }}>{when}</div>
                  <div style={{ ...sxMeta, marginTop: 2 }}>
                    <span data-testid="dv-status-pill">
                      <DesignVisitStatusPill status={v.status} />
                    </span>
                    {pendingEdit && (
                      <SyncStatePill status={pendingEdit.status} />
                    )}
                    <span style={sxMetaSep}>·</span>
                    <span data-testid="dv-date" style={sxDate}>Estimate: £{totalGbp}</span>
                    {v.qb_estimate_doc_num && (
                      <>
                        <span style={sxMetaSep}>·</span>
                        <span data-testid="dv-date" style={sxDate}>QB #{v.qb_estimate_doc_num}</span>
                      </>
                    )}
                    {v.deposit_invoice_id && (() => {
                      const qbInv = (qb.connected && qb.loaded) ? qb.invoices.find(i => i.id === v.deposit_invoice_id) : undefined;
                      const paid: boolean | null = qbInv != null ? (qbInv.balance ?? 0) <= 0 : null;
                      const linkStyle: React.CSSProperties = paid === true
                        ? { ...sxDate, textDecoration: 'none', background: '#dcfce7', border: '1px solid #bbf7d0', color: '#166534', borderRadius: 4, padding: '1px 5px' }
                        : paid === false
                        ? { ...sxDate, textDecoration: 'none', background: '#fef3c7', border: '1px solid #fbbf24', color: '#92400e', borderRadius: 4, padding: '1px 5px' }
                        : { ...sxDate, color: 'var(--orchid)', textDecoration: 'none' };
                      const linkTitle = paid === true
                        ? 'Deposit paid — view invoice'
                        : paid === false
                        ? 'Deposit outstanding — view invoice'
                        : 'View deposit invoice in QuickBooks invoices';
                      return (
                        <>
                          <span style={sxMetaSep}>·</span>
                          <a
                            data-testid="dv-deposit-invoice-link"
                            href={`/invoices#inv-${encodeURIComponent(v.deposit_invoice_id)}`}
                            style={linkStyle}
                            title={linkTitle}
                            onClick={e => e.stopPropagation()}
                          >
                            Deposit invoice{v.deposit_invoice_doc_num ? ` #${v.deposit_invoice_doc_num}` : ''}
                          </a>
                        </>
                      );
                    })()}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button style={sxSecondaryBtn}
                    onClick={() => toggleExpanded(v.id)}>
                    {isExp ? 'Hide' : 'Review'}
                  </button>
                  {canEditV && (
                    <button
                      style={sxSecondaryBtn}
                      disabled={editingId === v.id}
                      data-cah-loading={editingId === v.id ? '1' : undefined}
                      data-testid="dv-edit-btn"
                      onClick={() => handleEdit(v.id)}
                    >
                      {(() => {
                        const pe = pendingEditByVisitId.get(v.id);
                        return pe && pe.status !== 'synced' ? 'Resume changes' : 'Edit';
                      })()}
                    </button>
                  )}
                  {isAdmin && canRevise && (
                    <button style={sxSecondaryBtn}
                      onClick={() => handleRevision(v.id)}>
                      Request revision
                    </button>
                  )}
                  {isAdmin && (
                    <button style={{ ...sxSecondaryBtn, color: 'var(--error)' }}
                      onClick={() => handleDelete(v.id)}>
                      Delete
                    </button>
                  )}
                  {pendingEdit?.status === 'failed' && (
                    <PendingEditActions entry={pendingEdit} />
                  )}
                </div>
              </div>
              {pendingEdit?.status === 'failed' && (
                <p style={{ fontSize: '0.78rem', color: 'var(--ink-3)', margin: 0 }}>
                  {`Couldn't sync your edit to this visit${pendingEdit.lastError ? ` — ${pendingEdit.lastError}` : ''}. Retry to upload it again, or discard it to drop the unsynced changes and keep the server copy.`}
                </p>
              )}

              {isExp && (
                <div id={`design-visit-detail-${v.id}`} style={{
                  fontSize: '0.8rem', background: 'var(--surface-muted)', border: '1px solid var(--border-soft)',
                  borderRadius: 8, padding: '10px 12px',
                }}>
                  {!det || det.loading ? 'Loading…' : det.error ? (
                    <span style={{ color: 'var(--error)' }}>{det.error}</span>
                  ) : det.data ? (
                    <DesignVisitDetail visit={det.data} />
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
    </>
  );
}

function DesignVisitDetail({ visit }: { visit: DesignVisit }) {
  const rooms = visit.rooms || [];
  const grand = rooms.reduce((s, r) => s + (Number(r.unit_price_pence) || 0) * (Number(r.unit_count) || 0), 0);

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8, color: 'var(--ink-3)' }}>
        {visit.handle_name          && <span><strong>Handle:</strong> {visit.handle_name}</span>}
        {visit.furniture_range_name && <span><strong>Furniture range:</strong> {visit.furniture_range_name}</span>}
        {visit.location             && <span><strong>Location:</strong> {visit.location}</span>}
      </div>
      {rooms.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead>
            <tr style={{ background: 'var(--surface-muted)', color: 'var(--ink-3)' }}>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Room</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Style</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Dimensions</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Qty</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((r: DesignVisitRoom, i: number) => {
              const total = (Number(r.unit_price_pence) || 0) * (Number(r.unit_count) || 0);
              const dims  = [r.width_mm, r.height_mm, r.depth_mm].filter(Boolean).join(' × ');
              return (
                <tr key={i}>
                  <td style={{ padding: '4px 8px', borderTop: '1px solid var(--border-soft)' }}>{r.room_name || ''}</td>
                  <td style={{ padding: '4px 8px', borderTop: '1px solid var(--border-soft)' }}>{r.door_style_name || '—'}</td>
                  <td style={{ padding: '4px 8px', borderTop: '1px solid var(--border-soft)' }}>{dims ? `${dims} mm` : '—'}</td>
                  <td style={{ padding: '4px 8px', borderTop: '1px solid var(--border-soft)', textAlign: 'right' }}>{r.unit_count}</td>
                  <td style={{ padding: '4px 8px', borderTop: '1px solid var(--border-soft)', textAlign: 'right' }}>£{fmtGbp(total)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} style={{ padding: '6px 8px', fontWeight: 600, borderTop: '2px solid var(--border-strong)' }}>Estimate total</td>
              <td style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right', borderTop: '2px solid var(--border-strong)' }}>£{fmtGbp(grand)}</td>
            </tr>
          </tfoot>
        </table>
      ) : (
        <p style={{ fontStyle: 'italic', color: 'var(--ink-3)' }}>No rooms recorded.</p>
      )}
      {visit.notes         && <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}><strong>Notes:</strong> {visit.notes}</div>}
      {visit.revision_note && <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', color: 'var(--error)' }}><strong>Revision note:</strong> {visit.revision_note}</div>}
    </>
  );
}
