import React, { useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
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

  const EmailCard = ({ em }: { em: GoogleEmail }) => (
    <Box sx={{
      background: 'var(--paper)',
      border: '1px solid var(--stone)',
      borderRadius: 'var(--radius-lg)',
      p: '11px 14px',
      boxShadow: 'var(--shadow-sm)',
    }}>
      <Typography sx={{ fontSize: '0.875rem', color: 'var(--ink-2)', lineHeight: 1.6, fontWeight: 500 }}>
        {em.subject || '(no subject)'}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '5px', mt: '4px' }}>
        {em.from && (
          <Typography component="span" sx={{ fontSize: '0.75rem', color: 'var(--ink-3)' }}>
            {em.from}
          </Typography>
        )}
        {em.date && (
          <>
            <Typography component="span" sx={{ fontSize: '0.65rem', color: 'var(--ink-4)' }}>·</Typography>
            <Typography component="span" sx={{ fontSize: '0.68rem', color: 'var(--ink-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {new Date(em.date).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'short', year: 'numeric',
              })}
            </Typography>
          </>
        )}
      </Box>
      {em.snippet && (
        <Typography sx={{ fontSize: '0.75rem', color: 'var(--ink-4)', mt: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {em.snippet}
        </Typography>
      )}
    </Box>
  );

  return (
    <div id="google-emails-section" className="mb-5">
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography sx={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink-2)' }}>Emails</Typography>
      </Box>
      {loading && <p className="text-sm text-slate-400 italic px-1">Loading emails…</p>}
      {!loading && error && (
        <p className="text-sm text-red-500 px-1">Could not load emails.</p>
      )}
      {!loading && !error && emails.length === 0 && (
        <p className="text-sm text-slate-400 italic px-1">No emails found.</p>
      )}
      {!loading && !error && emails.length > 0 && (
        <>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {recent.map(em => (
              <EmailCard key={em.id} em={em} />
            ))}
            {expanded && rest.map(em => (
              <EmailCard key={em.id} em={em} />
            ))}
          </Box>
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
