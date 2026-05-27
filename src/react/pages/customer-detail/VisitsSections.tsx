import React, { useState, useCallback } from 'react';
import { Visit } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';

const sxHeader: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 };
const sxHeaderLabel: React.CSSProperties = { fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink-2)' };
const sxItem: React.CSSProperties = { background: 'var(--paper)', border: '1px solid var(--stone)', borderRadius: 'var(--radius-lg)', padding: '11px 14px', boxShadow: 'var(--shadow-sm)' };
const sxMeta: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 };
const sxMetaSep: React.CSSProperties = { fontSize: '0.65rem', color: 'var(--ink-4)' };
const sxDate: React.CSSProperties = { fontSize: '0.68rem', color: 'var(--ink-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' };
const sxText: React.CSSProperties = { fontSize: '0.875rem', color: 'var(--ink-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' };

interface Props {
  contactId: string;
  contact: { id: string; properties: { firstname?: string; lastname?: string; email?: string } };
  upcomingVisits: Visit[];
  pastVisits: Visit[];
  loadingVisits: boolean;
}

function fmtVisitRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const dateStr = s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const startTime = s.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const endTime   = e.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${dateStr} · ${startTime}–${endTime}`;
}

export function UpcomingVisitsSection({ contactId, contact, upcomingVisits, loadingVisits }: Omit<Props, 'pastVisits'>) {
  const { isViewer } = usePrivilege();

  return (
    <div id="upcoming-visits-section" className="mb-5">
      <div style={sxHeader}>
        <span style={sxHeaderLabel}>Upcoming visits</span>
      </div>
      {loadingVisits && <p className="text-sm text-slate-400 italic px-1">Loading…</p>}
      {!loadingVisits && upcomingVisits.length === 0 && (
        <p className="text-sm text-slate-400 italic px-1">No upcoming visits.</p>
      )}
      {!loadingVisits && upcomingVisits.length > 0 && (
        <div className="space-y-2">
          {upcomingVisits.map(v => (
            <div key={v.id} style={sxItem}>
              <div style={{ ...sxText, fontWeight: 500 }}>
                {v.title || v.type || 'Visit'}
              </div>
              <div style={sxMeta}>
                <span style={sxDate}>{fmtVisitRange(v.startAt, v.endAt)}</span>
                {v.location && <><span style={sxMetaSep}>·</span><span>{v.location}</span></>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PastVisitsSection({ pastVisits, loadingVisits }: Pick<Props, 'pastVisits' | 'loadingVisits'>) {
  const [expanded, setExpanded] = useState(false);
  const recent = pastVisits.slice(0, 3);
  const rest   = pastVisits.slice(3);

  return (
    <div id="past-visits-section" className="mb-5">
      <div style={sxHeader}>
        <span style={sxHeaderLabel}>Past visits</span>
      </div>
      {loadingVisits && <p className="text-sm text-slate-400 italic px-1">Loading…</p>}
      {!loadingVisits && pastVisits.length === 0 && (
        <p className="text-sm text-slate-400 italic px-1">No past visits.</p>
      )}
      {!loadingVisits && pastVisits.length > 0 && (
        <>
          <div className="space-y-2">
            {recent.map(v => (
              <div key={v.id} style={sxItem}>
                <div style={sxText}>{v.title || v.type || 'Visit'}</div>
                <div style={sxMeta}>
                  <span style={sxDate}>{fmtVisitRange(v.startAt, v.endAt)}</span>
                </div>
              </div>
            ))}
            {expanded && rest.map(v => (
              <div key={v.id} style={sxItem}>
                <div style={sxText}>{v.title || v.type || 'Visit'}</div>
                <div style={sxMeta}>
                  <span style={sxDate}>{fmtVisitRange(v.startAt, v.endAt)}</span>
                </div>
              </div>
            ))}
          </div>
          {rest.length > 0 && (
            <button
              className="text-xs text-blue-600 mt-2 hover:underline"
              onClick={() => setExpanded(v => !v)}
            >
              {expanded ? 'Show fewer' : `Show ${rest.length} more`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
