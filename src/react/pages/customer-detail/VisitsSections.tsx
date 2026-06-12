/**
 * VisitsSections — calendar-event-backed upcoming and past visits.
 *
 * Data source: GET /api/events?contactId=<id> (Google Calendar events tagged
 * with moContactId extended property). The visits table is no longer queried
 * by these components.
 *
 * The old visit-table flows (Add visit / Edit visit / Cancel visit menus) have
 * been deprecated and commented out. Use the "Book a visit" button instead,
 * which writes directly to Google Calendar via ScheduleVisitModal.
 */
import React, { useCallback, useEffect, useState } from 'react';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import AddIcon from '@mui/icons-material/Add';
import EventIcon from '@mui/icons-material/Event';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';
import { formatAddress, emptyAddress, type StructuredAddress } from '../../../../shared/address';
import { usePrivilege } from '../../hooks/usePrivilege';
import { ScheduleVisitModal } from '../../components/modals/ScheduleVisitModal';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CalendarVisit {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  moVisitType?: string;
}

interface CalendarEventRaw {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
  extendedProperties?: { private?: Record<string, string> };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const VISIT_TYPE_LABELS: Record<string, string> = {
  design:       'Design visit',
  survey:       'Survey',
  installation: 'Installation slot',
  delivery:     'Delivery window',
  remedial:     'Remedial',
  workshop:     'Workshop',
  other:        'Other',
};

function visitTypeLabel(type?: string): string {
  if (!type) return 'Visit';
  return VISIT_TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

function fmtVisitRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const dateStr  = s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const startTime = s.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const endTime   = e.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${dateStr} · ${startTime}–${endTime}`;
}

function gcalLink(eventId: string): string {
  return `https://calendar.google.com/calendar/event?eid=${btoa(eventId)}`;
}

function mapCalendarEvent(raw: CalendarEventRaw): CalendarVisit | null {
  const id = raw.id;
  if (!id) return null;
  const start = raw.start?.dateTime || raw.start?.date || '';
  const end   = raw.end?.dateTime   || raw.end?.date   || '';
  if (!start) return null;
  return {
    id,
    summary:     raw.summary || 'Visit',
    start,
    end:         end || start,
    location:    raw.location,
    description: raw.description,
    moVisitType: raw.extendedProperties?.private?.moVisitType,
  };
}

// ── Style tokens ──────────────────────────────────────────────────────────────

const sxHeader:      React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 };
const sxHeaderLabel: React.CSSProperties = { fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink-2)' };
const sxItem:        React.CSSProperties = { background: 'var(--paper)', border: '1px solid var(--stone)', borderRadius: 'var(--radius-lg)', padding: '11px 14px', boxShadow: 'var(--shadow-sm)' };
const sxMeta:        React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 };
const sxMetaSep:     React.CSSProperties = { fontSize: '0.65rem', color: 'var(--ink-4)' };
const sxDate:        React.CSSProperties = { fontSize: '0.68rem', color: 'var(--ink-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' };
const sxText:        React.CSSProperties = { fontSize: '0.875rem', color: 'var(--ink-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' };
const sxMuted:       React.CSSProperties = { fontSize: '0.875rem', fontStyle: 'italic', padding: '0 4px', color: 'var(--stone-deep)' };
const sxHelper:      React.CSSProperties = { fontSize: '0.75rem', lineHeight: 1.5, padding: '6px 4px 0', color: 'var(--ink-4)' };
const sxStack:       React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };

// ── Sub-components ────────────────────────────────────────────────────────────

function VisitTypeBadge({ type }: { type?: string }) {
  const STAGE_COLOURS: Record<string, { light: string; text: string }> = {
    design:       { light: 'var(--orchid-bg, #f3e8ff)',   text: 'var(--orchid, #7c3aed)' },
    survey:       { light: 'var(--sky-bg, #e0f2fe)',      text: 'var(--sky, #0284c7)' },
    installation: { light: 'var(--jade-bg, #d1fae5)',     text: 'var(--jade, #059669)' },
    delivery:     { light: 'var(--amber-bg, #fef3c7)',    text: 'var(--amber, #d97706)' },
  };
  if (!type) return null;
  const col = STAGE_COLOURS[type];
  return (
    <span style={{
      display: 'inline-block',
      fontSize: '0.68rem',
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      padding: '1px 7px',
      borderRadius: 'var(--radius-sm)',
      background: col?.light ?? 'var(--status-neutral-bg)',
      color:      col?.text  ?? 'var(--ink-3)',
      marginBottom: 5,
    }}>
      {visitTypeLabel(type)}
    </span>
  );
}

function GCalLink({ eventId }: { eventId: string }) {
  return (
    <Tooltip title="Open in Google Calendar">
      <a
        href={gcalLink(eventId)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open in Google Calendar"
        data-testid="gcal-link"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          fontSize: '0.72rem', color: 'var(--orchid)', textDecoration: 'none',
          fontWeight: 500, marginTop: 4,
        }}
        onMouseEnter={e => ((e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline')}
        onMouseLeave={e => ((e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none')}
      >
        <EventIcon sx={{ fontSize: '0.85rem' }} />
        Open in Calendar
      </a>
    </Tooltip>
  );
}

// ── Google auth check helper ───────────────────────────────────────────────────

async function fetchCalendarEvents(contactId: string): Promise<CalendarVisit[]> {
  const res = await fetch(`/api/events?contactId=${encodeURIComponent(contactId)}`);
  if (res.status === 401) {
    const data = await res.json().catch(() => ({})) as { code?: string };
    if (data?.code === 'GOOGLE_AUTH') {
      const err = new Error('GOOGLE_AUTH');
      (err as Error & { code: string }).code = 'GOOGLE_AUTH';
      throw err;
    }
    throw new Error('Unauthorised');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string; code?: string };
    if (data?.code === 'GOOGLE_AUTH') {
      const err = new Error('GOOGLE_AUTH');
      (err as Error & { code: string }).code = 'GOOGLE_AUTH';
      throw err;
    }
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  const data = await res.json() as { items?: CalendarEventRaw[] };
  const items: CalendarEventRaw[] = Array.isArray(data.items) ? data.items : [];
  return items.map(mapCalendarEvent).filter(Boolean) as CalendarVisit[];
}

// ── Exported components ───────────────────────────────────────────────────────

interface VisitsSectionProps {
  contactId: string;
  contact: {
    id: string;
    properties: { firstname?: string; lastname?: string; email?: string; phone?: string; mobilephone?: string; structuredAddress?: StructuredAddress };
  };
}

function contactDisplayName(contact: VisitsSectionProps['contact']): string {
  const p = contact.properties;
  const parts = [p.firstname, p.lastname].filter(Boolean);
  return parts.length ? parts.join(' ') : (p.email || '');
}

function contactAddress(contact: VisitsSectionProps['contact']): string {
  const p = contact.properties;
  return formatAddress(p.structuredAddress || emptyAddress()).replace(/\n/g, ', ');
}

export function UpcomingVisitsSection({ contactId, contact }: VisitsSectionProps) {
  const { isAdmin, isManager } = usePrivilege();
  const canEdit = isAdmin || isManager;

  const [visits, setVisits] = useState<CalendarVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [googleConnected, setGoogleConnected] = useState(true);
  const [bookOpen, setBookOpen] = useState(false);

  const name    = contactDisplayName(contact);
  const addr    = contactAddress(contact);
  const email   = contact.properties.email || '';

  const ctx: CardActionContext = {
    contactId:   contactId,
    contactName: name,
    contactEmail: email,
  };

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const all = await fetchCalendarEvents(contactId);
      const now = Date.now();
      setVisits(all.filter(v => new Date(v.end).getTime() >= now));
      setGoogleConnected(true);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'GOOGLE_AUTH') {
        setGoogleConnected(false);
      }
      setVisits([]);
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => { void fetchEvents(); }, [fetchEvents]);

  useEffect(() => {
    const handler = () => { void fetchEvents(); };
    window.addEventListener('mo:refresh-visits', handler);
    return () => window.removeEventListener('mo:refresh-visits', handler);
  }, [fetchEvents]);

  return (
    <div id="upcoming-visits-section" style={{ marginBottom: 20 }}>
      <div style={sxHeader}>
        <span style={sxHeaderLabel}>Upcoming visits</span>
        {canEdit && (
          <Button
            size="small"
            variant="outlined"
            startIcon={<AddIcon fontSize="inherit" />}
            onClick={() => setBookOpen(true)}
            data-testid="add-visit-btn"
            sx={{ fontSize: '0.75rem', py: 0.25, px: 1 }}
          >
            Book a visit
          </Button>
        )}
      </div>

      {loading && <p style={sxMuted}>Loading…</p>}

      {!loading && !googleConnected && (
        <>
          <p style={sxMuted}>Google Calendar not connected.</p>
          <p style={sxHelper}>
            Connect your Google account to view and book visits directly in Google Calendar.
          </p>
        </>
      )}

      {!loading && googleConnected && visits.length === 0 && (
        <p style={sxMuted}>No upcoming visits.</p>
      )}

      {!loading && googleConnected && visits.length > 0 && (
        <div style={sxStack}>
          {visits.map(v => (
            <div key={v.id} style={sxItem}>
              <VisitTypeBadge type={v.moVisitType} />
              <div style={{ ...sxText, fontWeight: 500 }}>{v.summary}</div>
              <div style={sxMeta}>
                <span style={sxDate}>{fmtVisitRange(v.start, v.end)}</span>
                {v.location && <><span style={sxMetaSep}>·</span><span style={{ fontSize: '0.875rem' }}>{v.location}</span></>}
              </div>
              {v.description && <div style={{ ...sxHelper, paddingTop: 2 }}>{v.description}</div>}
              <GCalLink eventId={v.id} />
            </div>
          ))}
        </div>
      )}

      {/* deprecated: visits table write flows removed; use ScheduleVisitModal / Google Calendar instead */}

      {bookOpen && (
        <ScheduleVisitModal
          ctx={ctx}
          contactAddress={addr}
          open={bookOpen}
          onClose={() => setBookOpen(false)}
          onSuccess={() => {
            setBookOpen(false);
            void fetchEvents();
          }}
        />
      )}
    </div>
  );
}

export function PastVisitsSection({ contactId }: Pick<VisitsSectionProps, 'contactId'>) {
  const [visits, setVisits] = useState<CalendarVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [googleConnected, setGoogleConnected] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const all = await fetchCalendarEvents(contactId);
      const now = Date.now();
      // Past events: end is before now, sorted newest-first
      const past = all
        .filter(v => new Date(v.end).getTime() < now)
        .sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime());
      setVisits(past);
      setGoogleConnected(true);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'GOOGLE_AUTH') setGoogleConnected(false);
      setVisits([]);
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => { void fetchEvents(); }, [fetchEvents]);

  useEffect(() => {
    const handler = () => { void fetchEvents(); };
    window.addEventListener('mo:refresh-visits', handler);
    return () => window.removeEventListener('mo:refresh-visits', handler);
  }, [fetchEvents]);

  const recent = visits.slice(0, 3);
  const rest   = visits.slice(3);

  return (
    <div id="past-visits-section" style={{ marginBottom: 20 }}>
      <div style={sxHeader}>
        <span style={sxHeaderLabel}>Past visits</span>
      </div>

      {loading && <p style={sxMuted}>Loading…</p>}

      {!loading && !googleConnected && (
        <p style={sxMuted}>Google Calendar not connected.</p>
      )}

      {!loading && googleConnected && visits.length === 0 && (
        <p style={sxMuted}>No past visits.</p>
      )}

      {!loading && googleConnected && visits.length > 0 && (
        <>
          <div style={sxStack}>
            {recent.map(v => (
              <div key={v.id} style={sxItem}>
                <VisitTypeBadge type={v.moVisitType} />
                <div style={sxText}>{v.summary}</div>
                <div style={sxMeta}>
                  <span style={sxDate}>{fmtVisitRange(v.start, v.end)}</span>
                  {v.location && <><span style={sxMetaSep}>·</span><span style={{ fontSize: '0.875rem' }}>{v.location}</span></>}
                </div>
                <GCalLink eventId={v.id} />
              </div>
            ))}
            {expanded && rest.map(v => (
              <div key={v.id} style={sxItem}>
                <VisitTypeBadge type={v.moVisitType} />
                <div style={sxText}>{v.summary}</div>
                <div style={sxMeta}>
                  <span style={sxDate}>{fmtVisitRange(v.start, v.end)}</span>
                </div>
                <GCalLink eventId={v.id} />
              </div>
            ))}
          </div>
          {rest.length > 0 && (
            <button
              style={{ fontSize: '0.75rem', marginTop: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--orchid)', textDecoration: hovered ? 'underline' : 'none' }}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
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
