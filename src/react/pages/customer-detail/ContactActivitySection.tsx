import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { GET } from '../../utils/api';
import { Skeleton } from '../../components/Skeleton';
import { ContactTimelineRow } from '../../components/customer-activity/ContactTimelineRow';
import type { ActivityResponse, TimelineItem } from '../../components/customer-activity/timeline';

interface Props {
  contactId: string;
}

const INITIAL_VISIBLE = 8;

// Placeholder rows shown while the feed loads — shaped like collapsed timeline
// rows so the layout doesn't shift when the real activity arrives. Matches the
// skeleton-loader pattern used by the other customer-detail sections (Invoices,
// submissions rail) rather than a spinner.
function ActivitySkeletonRows() {
  return (
    <Box data-testid="contact-activity-skeleton" sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {[68, 54, 60, 46].map((w, i) => (
        <Box
          key={i}
          sx={{
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'divider',
            bgcolor: 'grey.50',
            px: 1,
            py: 0.5,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
          }}
        >
          <Skeleton width={16} height={16} style={{ borderRadius: 4, flexShrink: 0 }} />
          <Skeleton width={44} height={11} style={{ flexShrink: 0 }} />
          <Skeleton width={`${w}%`} height={11} />
          <Skeleton width={32} height={11} style={{ flexShrink: 0, marginLeft: 'auto' }} />
        </Box>
      ))}
    </Box>
  );
}

// ── Customer detail page: full HubSpot activity feed ──────────────────────────
// The richer sibling of the Contact Customer modal timeline. Lazy-loaded after
// the page mounts (the rest of the page renders instantly). In addition to
// emails/calls/meetings/notes/tasks/forms it surfaces marketing emails (with
// open/click counts), page-view analytics and form-submission field values —
// the heavier sources the modal intentionally leaves out. Sources the token
// can't read degrade independently and are noted in a footer rather than
// breaking the feed.
export function ContactActivitySection({ contactId }: Props) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const fetchedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!contactId || !/^\d+$/.test(contactId)) return;
    if (fetchedRef.current === contactId) return;
    fetchedRef.current = contactId;
    setLoading(true);
    setError(false);
    setItems([]);
    setUnavailable([]);
    setShowAll(false);
    setExpandedIds(new Set());
    GET<ActivityResponse>(`/api/contacts/${encodeURIComponent(contactId)}/activity`)
      .then((d) => {
        setItems((d.activities || []) as TimelineItem[]);
        setUnavailable(Array.isArray(d.unavailable) ? d.unavailable : []);
      })
      .catch(() => { setError(true); })
      .finally(() => { setLoading(false); });
  }, [contactId]);

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const visible = showAll ? items : items.slice(0, INITIAL_VISIBLE);
  const rest = items.length - visible.length;

  return (
    <div id="contact-activity-section" className="mb-5">
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography sx={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink-2)' }}>
          Activity
        </Typography>
      </Box>

      {loading && <ActivitySkeletonRows />}

      {!loading && error && (
        <p className="text-sm px-1" style={{ color: 'var(--status-danger-text)' }}>
          HubSpot activity could not be loaded.
        </p>
      )}

      {!loading && !error && items.length === 0 && (
        <p className="text-sm italic px-1" style={{ color: 'var(--stone-deep)' }}>
          No HubSpot activity recorded yet.
        </p>
      )}

      {items.length > 0 && (
        <Box data-testid="contact-detail-activity-timeline" sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {visible.map((item) => (
            <ContactTimelineRow
              key={item.id}
              item={item}
              expanded={expandedIds.has(item.id)}
              onToggle={() => toggleExpanded(item.id)}
            />
          ))}
        </Box>
      )}

      {rest > 0 && (
        <button
          className="text-xs mt-2 hover:underline"
          style={{ color: 'var(--orchid)' }}
          onClick={() => setShowAll(true)}
        >
          Show {rest} more
        </button>
      )}

      {showAll && items.length > INITIAL_VISIBLE && (
        <button
          className="text-xs mt-2 hover:underline"
          style={{ color: 'var(--orchid)' }}
          onClick={() => setShowAll(false)}
        >
          Show fewer
        </button>
      )}

      {!loading && !error && unavailable.length > 0 && (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.75, fontStyle: 'italic' }}>
          Some activity couldn’t be loaded ({unavailable.join(', ')}).
        </Typography>
      )}
    </div>
  );
}
