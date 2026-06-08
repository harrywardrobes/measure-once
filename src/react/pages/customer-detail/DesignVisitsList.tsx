import React, { useState, useCallback, useEffect, useRef } from 'react';
import { DesignVisit, DesignVisitRoom, fmtDesignVisitWhen, fmtGbp } from './types';
import { DesignVisitStatusPill } from './DesignVisitStatusPill';
import { usePrivilege } from '../../hooks/usePrivilege';
import { useOfflineVisitEntries, type PendingVisitEntry } from '../../hooks/useOfflineVisitEntries';
import { DesignVisitWizard, type DesignVisitWizardHandler, type DesignVisitWizardCtx, type ExistingVisit } from '../../components/DesignVisitWizard';

const sxHeader: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 };
const sxHeaderLabel: React.CSSProperties = { fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink-2)' };
const sxItem: React.CSSProperties = { background: 'var(--paper)', border: '1px solid var(--stone)', borderRadius: 'var(--radius-lg)', padding: '11px 14px', boxShadow: 'var(--shadow-sm)' };
const sxMeta: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 };
const sxMetaSep: React.CSSProperties = { fontSize: '0.65rem', color: 'var(--ink-4)' };
const sxDate: React.CSSProperties = { fontSize: '0.68rem', color: 'var(--ink-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' };
const sxText: React.CSSProperties = { fontSize: '0.875rem', color: 'var(--ink-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' };
const sxSecondaryBtn: React.CSSProperties = { background: 'none', color: 'var(--ink-3)', fontSize: '0.75rem', border: '1px solid var(--stone)', borderRadius: 'var(--radius-md)', cursor: 'pointer', padding: '4px 10px' };

/** Visual treatment for the per-visit offline sync state, matching DesignVisitStatusPill. */
const SYNC_PILL: Record<PendingVisitEntry['status'], { label: string; bg: string; fg: string }> = {
  pending: { label: 'Pending sync',  bg: 'var(--stage-workshop-light)', fg: 'var(--stage-workshop-text)' },
  syncing: { label: 'Syncing…',      bg: 'var(--stage-order-light)',    fg: 'var(--stage-order-text)'    },
  failed:  { label: 'Sync failed',   bg: 'var(--status-error-bg)',      fg: 'var(--status-error-text)'   },
  synced:  { label: 'Synced',        bg: 'var(--stage-packing-light)',  fg: 'var(--stage-packing-text)'  },
};

function SyncStatePill({ status }: { status: PendingVisitEntry['status'] }) {
  const s = SYNC_PILL[status] ?? SYNC_PILL.pending;
  return (
    <span
      data-testid="dv-sync-pill"
      style={{
        fontSize: '0.7rem', background: s.bg, color: s.fg, borderRadius: 4,
        padding: '1px 6px', fontWeight: 600, whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}
    >
      {status === 'syncing' && (
        <span
          aria-hidden
          style={{
            width: 8, height: 8, borderRadius: '50%',
            border: '1.5px solid currentColor', borderTopColor: 'transparent',
            display: 'inline-block', animation: 'dv-sync-spin 0.8s linear infinite',
          }}
        />
      )}
      {s.label}
    </span>
  );
}

/** A design visit captured offline that has not yet reached the server. */
function PendingVisitCard({ entry }: { entry: PendingVisitEntry }) {
  const when = fmtDesignVisitWhen(entry.visitDate || new Date(entry.createdAt).toISOString());
  const totalGbp = fmtGbp(entry.estimateTotalPence || 0);
  return (
    <div
      data-testid="dv-pending-card"
      style={{
        ...sxItem, marginBottom: 6, flexDirection: 'column', alignItems: 'stretch', gap: 6,
        borderStyle: 'dashed', opacity: entry.status === 'failed' ? 1 : 0.95,
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
      </div>
      <p style={{ fontSize: '0.78rem', color: 'var(--ink-3)', margin: 0 }}>
        {entry.status === 'failed'
          ? `Couldn't sync this visit${entry.lastError ? ` — ${entry.lastError}` : ''}. It needs attention before it can upload.`
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

export function DesignVisitsList({ contactId, visits, loading, error, onRefresh }: Props) {
  const { isAdmin } = usePrivilege();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [details, setDetails] = useState<Record<number, DetailState>>({});
  const [wizardState, setWizardState] = useState<WizardState | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  const toggleExpanded = useCallback(async (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        if (!details[id]) {
          setDetails(d => ({ ...d, [id]: { loading: true, data: null, error: null } }));
          fetch(`/api/design-visits/${id}`)
            .then(r => r.ok ? r.json() : Promise.reject(r))
            .then((v: DesignVisit) => setDetails(d => ({ ...d, [id]: { loading: false, data: v, error: null } })))
            .catch(() => setDetails(d => ({ ...d, [id]: { loading: false, data: null, error: 'Could not load' } })));
        }
      }
      return next;
    });
  }, [details]);

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

  const openWizardForEdit = useCallback((id: number) => {
    const v = visits.find(x => x.id === id);
    if (!v || !['submitted', 'revision_requested', 'draft'].includes(v.status)) return;
    const detail = details[id]?.data || v;
    const ctx: DesignVisitWizardCtx = {
      contactId:    detail.contact_id || contactId,
      contactName:  detail.contact_name  || '',
      contactEmail: detail.contact_email || '',
    };
    setEditingId(id);
    setWizardState({ handler: { config: {} }, ctx, existingVisit: detail as unknown as ExistingVisit });
  }, [visits, details, contactId]);

  const handleEdit = useCallback((id: number) => {
    // A queued (pending/syncing/failed) edit for this same visit means an
    // earlier set of changes hasn't reached the server yet. Editing the server
    // copy now risks overwriting those queued changes once both replay, so warn
    // and let the user wait for sync or knowingly proceed on the stale copy.
    const pending = pendingEditByVisitId.get(id);
    if (pending && pending.status !== 'synced') {
      const detail = pending.status === 'failed'
        ? "This visit has changes that failed to sync and haven't reached the server yet."
        : "This visit has changes saved on this device that haven't synced to the server yet.";
      window.showBottomConfirm(
        `${detail} Editing now means you'll change the server copy, which could overwrite those unsynced changes once they upload. Edit anyway?`,
        () => openWizardForEdit(id),
      );
      return;
    }
    openWizardForEdit(id);
  }, [pendingEditByVisitId, openWizardForEdit]);

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
        <span style={sxHeaderLabel}>Design visits</span>
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
                    {pendingEditByVisitId.has(v.id) && (
                      <SyncStatePill status={pendingEditByVisitId.get(v.id)!.status} />
                    )}
                    <span style={sxMetaSep}>·</span>
                    <span data-testid="dv-date" style={sxDate}>Estimate: £{totalGbp}</span>
                    {v.qb_estimate_doc_num && (
                      <>
                        <span style={sxMetaSep}>·</span>
                        <span data-testid="dv-date" style={sxDate}>QB #{v.qb_estimate_doc_num}</span>
                      </>
                    )}
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
                      onClick={() => handleEdit(v.id)}
                    >
                      Edit
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
                </div>
              </div>

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
