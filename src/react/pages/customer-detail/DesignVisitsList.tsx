import React, { useState, useCallback } from 'react';
import { DesignVisit, DesignVisitRoom, DESIGN_VISIT_STATUS_LABELS, fmtDesignVisitWhen, fmtGbp } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';

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

export function DesignVisitsList({ contactId, visits, loading, error, onRefresh }: Props) {
  const { isAdmin } = usePrivilege();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [details, setDetails] = useState<Record<number, DetailState>>({});
  const [actionError, setActionError] = useState<string | null>(null);

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
    if (typeof window.showBottomConfirm === 'function') {
      window.showBottomConfirm('Delete this design visit? This cannot be undone.', doDelete);
    } else {
      if (window.confirm('Delete this design visit? This cannot be undone.')) void doDelete();
    }
  }, [isAdmin, onRefresh]);

  const handleEdit = useCallback(async (id: number) => {
    const g = window as unknown as Record<string, unknown>;
    if (typeof g.openDesignVisitWizard !== 'function') {
      const gst = g as unknown as { showToast?: (m: string, e: boolean) => void };
      if (typeof gst.showToast === 'function') gst.showToast('Edit wizard is not available on this page.', true);
      return;
    }
    const v = visits.find(x => x.id === id);
    if (!v || !['submitted', 'revision_requested', 'draft'].includes(v.status)) return;
    const detail = details[id]?.data || v;
    const ctx = {
      contactId:    detail.contact_id || contactId,
      contactName:  detail.contact_name  || '',
      contactEmail: detail.contact_email || '',
    };
    (g.openDesignVisitWizard as (cfg: unknown, ctx: unknown, visit: unknown) => void)(
      { config: {} }, ctx, detail,
    );
  }, [visits, details, contactId]);

  return (
    <div id="design-visits-section" className="mb-5">
      <div className="notes-header">
        <span className="notes-header-label">Design visits</span>
      </div>
      {actionError && (
        <p style={{ fontSize: '0.85rem', color: '#b91c1c', padding: '4px 0' }}>{actionError}</p>
      )}
      <div id="design-visits-list" className="text-sm" style={{ color: 'var(--stone-deep)' }}>
        {loading && (
          <p style={{ fontSize: '0.85rem', padding: '4px 0', fontStyle: 'italic' }}>Loading…</p>
        )}
        {!loading && error && (
          <p style={{ fontSize: '0.85rem', color: '#b91c1c', padding: '4px 0' }}>Could not load design visits.</p>
        )}
        {!loading && !error && visits.length === 0 && (
          <p style={{ fontSize: '0.85rem', padding: '4px 0', fontStyle: 'italic' }}>No design visits yet.</p>
        )}
        {!loading && !error && visits.map(v => {
          const st = DESIGN_VISIT_STATUS_LABELS[v.status] || { label: v.status || 'Unknown', bg: '#e5e7eb', fg: '#374151' };
          const when     = fmtDesignVisitWhen(v.visit_date || v.created_at);
          const totalGbp = fmtGbp(Number(v.estimate_total_pence) || 0);
          const canRevise = v.status === 'submitted' || v.status === 'signed_off';
          const canEditV  = v.status === 'submitted' || v.status === 'revision_requested' || v.status === 'draft';
          const isExp     = expanded.has(v.id);
          const det       = details[v.id];

          return (
            <div
              key={v.id}
              className="comment-item"
              data-dv-id={v.id}
              style={{ marginBottom: 6, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, justifyContent: 'space-between' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="comment-text" style={{ fontWeight: 500 }}>{when}</div>
                  <div className="comment-meta" style={{ marginTop: 2 }}>
                    <span style={{
                      fontSize: '0.7rem', background: st.bg, color: st.fg,
                      borderRadius: 4, padding: '1px 6px', fontWeight: 600,
                    }}>
                      {st.label}
                    </span>
                    <span className="comment-meta-sep">·</span>
                    <span className="comment-date">Estimate: £{totalGbp}</span>
                    {v.qb_estimate_doc_num && (
                      <>
                        <span className="comment-meta-sep">·</span>
                        <span className="comment-date">QB #{v.qb_estimate_doc_num}</span>
                      </>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button className="btn-cancel-note" style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                    onClick={() => toggleExpanded(v.id)}>
                    {isExp ? 'Hide' : 'Review'}
                  </button>
                  {canEditV && (
                    <button className="btn-cancel-note" style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                      onClick={() => handleEdit(v.id)}>
                      Edit
                    </button>
                  )}
                  {isAdmin && canRevise && (
                    <button className="btn-cancel-note" style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                      onClick={() => handleRevision(v.id)}>
                      Request revision
                    </button>
                  )}
                  {isAdmin && (
                    <button className="btn-cancel-note" style={{ padding: '4px 10px', fontSize: '0.75rem', color: '#b91c1c' }}
                      onClick={() => handleDelete(v.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {isExp && (
                <div id={`design-visit-detail-${v.id}`} style={{
                  fontSize: '0.8rem', background: '#f8fafc', border: '1px solid #e2e8f0',
                  borderRadius: 8, padding: '10px 12px',
                }}>
                  {!det || det.loading ? 'Loading…' : det.error ? (
                    <span style={{ color: '#b91c1c' }}>{det.error}</span>
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
  );
}

function DesignVisitDetail({ visit }: { visit: DesignVisit }) {
  const rooms = visit.rooms || [];
  const grand = rooms.reduce((s, r) => s + (Number(r.unit_price_pence) || 0) * (Number(r.unit_count) || 0), 0);

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8, color: '#475569' }}>
        {visit.handle_name          && <span><strong>Handle:</strong> {visit.handle_name}</span>}
        {visit.furniture_range_name && <span><strong>Furniture range:</strong> {visit.furniture_range_name}</span>}
        {visit.location             && <span><strong>Location:</strong> {visit.location}</span>}
      </div>
      {rooms.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
          <thead>
            <tr style={{ background: '#f1f5f9', color: '#475569' }}>
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
                  <td style={{ padding: '4px 8px', borderTop: '1px solid #e2e8f0' }}>{r.room_name || ''}</td>
                  <td style={{ padding: '4px 8px', borderTop: '1px solid #e2e8f0' }}>{r.door_style_name || '—'}</td>
                  <td style={{ padding: '4px 8px', borderTop: '1px solid #e2e8f0' }}>{dims ? `${dims} mm` : '—'}</td>
                  <td style={{ padding: '4px 8px', borderTop: '1px solid #e2e8f0', textAlign: 'right' }}>{r.unit_count}</td>
                  <td style={{ padding: '4px 8px', borderTop: '1px solid #e2e8f0', textAlign: 'right' }}>£{fmtGbp(total)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} style={{ padding: '6px 8px', fontWeight: 600, borderTop: '2px solid #cbd5e1' }}>Estimate total</td>
              <td style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right', borderTop: '2px solid #cbd5e1' }}>£{fmtGbp(grand)}</td>
            </tr>
          </tfoot>
        </table>
      ) : (
        <p style={{ fontStyle: 'italic', color: '#64748b' }}>No rooms recorded.</p>
      )}
      {visit.notes         && <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}><strong>Notes:</strong> {visit.notes}</div>}
      {visit.revision_note && <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', color: '#991b1b' }}><strong>Revision note:</strong> {visit.revision_note}</div>}
    </>
  );
}
