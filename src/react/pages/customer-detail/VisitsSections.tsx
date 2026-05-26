import React, { useState, useCallback } from 'react';
import { Visit } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';

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
      <div className="notes-header">
        <span className="notes-header-label">Upcoming visits</span>
      </div>
      {loadingVisits && <p className="text-sm text-slate-400 italic px-1">Loading…</p>}
      {!loadingVisits && upcomingVisits.length === 0 && (
        <p className="text-sm text-slate-400 italic px-1">No upcoming visits.</p>
      )}
      {!loadingVisits && upcomingVisits.length > 0 && (
        <div className="space-y-2">
          {upcomingVisits.map(v => (
            <div key={v.id} className="comment-item">
              <div className="comment-text" style={{ fontWeight: 500 }}>
                {v.title || v.type || 'Visit'}
              </div>
              <div className="comment-meta">
                <span className="comment-date">{fmtVisitRange(v.startAt, v.endAt)}</span>
                {v.location && <><span className="comment-meta-sep">·</span><span>{v.location}</span></>}
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
      <div className="notes-header">
        <span className="notes-header-label">Past visits</span>
      </div>
      {loadingVisits && <p className="text-sm text-slate-400 italic px-1">Loading…</p>}
      {!loadingVisits && pastVisits.length === 0 && (
        <p className="text-sm text-slate-400 italic px-1">No past visits.</p>
      )}
      {!loadingVisits && pastVisits.length > 0 && (
        <>
          <div className="space-y-2">
            {recent.map(v => (
              <div key={v.id} className="comment-item">
                <div className="comment-text">{v.title || v.type || 'Visit'}</div>
                <div className="comment-meta">
                  <span className="comment-date">{fmtVisitRange(v.startAt, v.endAt)}</span>
                </div>
              </div>
            ))}
            {expanded && rest.map(v => (
              <div key={v.id} className="comment-item">
                <div className="comment-text">{v.title || v.type || 'Visit'}</div>
                <div className="comment-meta">
                  <span className="comment-date">{fmtVisitRange(v.startAt, v.endAt)}</span>
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
