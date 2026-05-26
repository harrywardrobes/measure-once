import React, { useState, useCallback } from 'react';
import { GoogleEmail } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';

interface Props {
  contactEmail: string;
  emails: GoogleEmail[];
  loading: boolean;
  error: string | null;
  connected: boolean;
}

export function GoogleEmailSection({ contactEmail, emails, loading, error, connected }: Props) {
  const [expanded, setExpanded] = useState(false);
  const recent = emails.slice(0, 3);
  const rest   = emails.slice(3);

  if (!connected) return null;

  return (
    <div id="google-emails-section" className="mb-5">
      <div className="notes-header">
        <span className="notes-header-label">Emails</span>
      </div>
      {loading && <p className="text-sm text-slate-400 italic px-1">Loading emails…</p>}
      {!loading && error && (
        <p className="text-sm text-red-500 px-1">Could not load emails.</p>
      )}
      {!loading && !error && emails.length === 0 && (
        <p className="text-sm text-slate-400 italic px-1">No emails found.</p>
      )}
      {!loading && !error && emails.length > 0 && (
        <>
          <div className="space-y-2">
            {recent.map(em => (
              <div key={em.id} className="comment-item">
                <div className="comment-text" style={{ fontWeight: 500 }}>
                  {em.subject || '(no subject)'}
                </div>
                <div className="comment-meta">
                  <span>{em.from || ''}</span>
                  {em.date && (
                    <>
                      <span className="comment-meta-sep">·</span>
                      <span className="comment-date">
                        {new Date(em.date).toLocaleDateString('en-GB', {
                          day: 'numeric', month: 'short', year: 'numeric',
                        })}
                      </span>
                    </>
                  )}
                </div>
                {em.snippet && (
                  <div className="text-xs text-slate-400 mt-1 truncate">{em.snippet}</div>
                )}
              </div>
            ))}
            {expanded && rest.map(em => (
              <div key={em.id} className="comment-item">
                <div className="comment-text" style={{ fontWeight: 500 }}>
                  {em.subject || '(no subject)'}
                </div>
                <div className="comment-meta">
                  <span>{em.from || ''}</span>
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
