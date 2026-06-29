import React from 'react';
import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import NotesOutlined from '@mui/icons-material/NotesOutlined';
import { relativeTime } from '../../utils/formatters';
import { TYPE_ICON, TIMELINE_TYPE_LABEL, type TimelineItem } from './timeline';

interface FormField { name: string; value: string }

// ── A single compact, expandable row in the unified contact timeline ──────────
// Shared by the Contact Customer modal and the customer detail page activity
// feed so both surfaces render the same way. Internal Measure Once attempts are
// tinted differently from HubSpot-sourced rows.
export function ContactTimelineRow({
  item,
  expanded,
  onToggle,
}: {
  item: TimelineItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = TYPE_ICON[item.type] || NotesOutlined;
  const m = item.meta || {};
  const durationMs = m.durationMs != null ? Number(m.durationMs) : null;
  const opens = typeof m.opens === 'number' ? m.opens : null;
  const clicks = typeof m.clicks === 'number' ? m.clicks : null;
  const fields = Array.isArray(m.fields) ? (m.fields as FormField[]) : null;
  const hasEngagementMeta = Boolean(opens || clicks);
  const hasDetail = Boolean(
    (item.body && item.body.trim()) ||
    m.pageUrl || m.from || m.to || m.disposition ||
    (durationMs != null && durationMs > 0) || m.status || m.outcome ||
    hasEngagementMeta || (fields && fields.length) || item.actor,
  );
  const dirLabel =
    item.direction === 'incoming' ? 'In'
    : item.direction === 'outgoing' ? 'Out'
    : null;
  const isInternal = item.source === 'measureonce';

  // A compact open/click summary surfaced inline on the collapsed row.
  const engagementSummary = hasEngagementMeta
    ? [opens ? `${opens} open${opens === 1 ? '' : 's'}` : null,
       clicks ? `${clicks} click${clicks === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')
    : null;

  return (
    <Box
      sx={{
        borderRadius: 1,
        bgcolor: isInternal ? 'grey.100' : 'grey.50',
        border: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Box
        component={hasDetail ? 'button' : 'div'}
        onClick={hasDetail ? onToggle : undefined}
        sx={{
          width: '100%',
          textAlign: 'left',
          background: 'none',
          border: 'none',
          px: 1,
          py: 0.5,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          cursor: hasDetail ? 'pointer' : 'default',
        }}
      >
        <Icon sx={{ fontSize: 16, color: isInternal ? 'primary.main' : 'text.secondary', flexShrink: 0 }} />
        <Typography variant="caption" sx={{ fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>
          {TIMELINE_TYPE_LABEL[item.type]}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {item.title}
          {dirLabel ? ` · ${dirLabel}` : ''}
          {engagementSummary ? ` · ${engagementSummary}` : ''}
        </Typography>
        <Typography variant="caption" color="text.disabled" sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
          {item.timestamp ? relativeTime(item.timestamp) : ''}
        </Typography>
        {hasDetail && (
          <Box component="span" sx={{ color: 'text.disabled', fontSize: 11, flexShrink: 0 }}>
            {expanded ? '▲' : '▼'}
          </Box>
        )}
      </Box>

      {hasDetail && (
        <Collapse in={expanded} unmountOnExit>
          <Box sx={{ px: 1, pb: 0.75, pl: '30px', display: 'flex', flexDirection: 'column', gap: 0.25 }}>
            <Typography variant="caption" color="text.secondary">
              {isInternal ? 'Logged in Measure Once' : 'HubSpot'}
              {item.actor ? ` · ${item.actor}` : ''}
            </Typography>
            {Boolean(m.from) && <Typography variant="caption" color="text.secondary">From: {String(m.from)}</Typography>}
            {Boolean(m.to) && <Typography variant="caption" color="text.secondary">To: {String(m.to)}</Typography>}
            {durationMs != null && durationMs > 0 && (
              <Typography variant="caption" color="text.secondary">Duration: {Math.round(durationMs / 1000)}s</Typography>
            )}
            {Boolean(m.disposition) && <Typography variant="caption" color="text.secondary">Outcome: {String(m.disposition)}</Typography>}
            {Boolean(m.outcome) && <Typography variant="caption" color="text.secondary">Outcome: {String(m.outcome)}</Typography>}
            {Boolean(m.status) && <Typography variant="caption" color="text.secondary">Status: {String(m.status)}</Typography>}
            {opens != null && (
              <Typography variant="caption" color="text.secondary">
                Opened {opens} time{opens === 1 ? '' : 's'}
                {m.lastOpenedAt ? ` · last ${relativeTime(String(m.lastOpenedAt))}` : ''}
              </Typography>
            )}
            {clicks != null && (
              <Typography variant="caption" color="text.secondary">
                Clicked {clicks} time{clicks === 1 ? '' : 's'}
                {m.lastClickedAt ? ` · last ${relativeTime(String(m.lastClickedAt))}` : ''}
              </Typography>
            )}
            {fields && fields.length > 0 && fields.map((f, i) => (
              <Typography key={`${f.name}:${i}`} variant="caption" color="text.secondary">
                {f.name}: {f.value || '—'}
              </Typography>
            ))}
            {item.body && (
              <Typography variant="caption" color="text.primary" sx={{ whiteSpace: 'pre-wrap', mt: 0.25 }}>
                {item.body.length > 1200 ? `${item.body.slice(0, 1200)}…` : item.body}
              </Typography>
            )}
            {m.pageUrl != null && m.pageUrl !== '' && (
              <Link
                href={String(m.pageUrl)}
                target="_blank"
                rel="noopener noreferrer"
                variant="caption"
                sx={{ mt: 0.25 }}
              >
                View page
              </Link>
            )}
          </Box>
        </Collapse>
      )}
    </Box>
  );
}
