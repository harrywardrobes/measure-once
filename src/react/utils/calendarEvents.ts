// Shared parsing of Google Calendar `events.list` output into the lightweight
// feed model used by the home screen, the customer detail page and the Contact
// Customer modal. Keeping this in one place lets every surface build the same
// TaskList items from the same source.

/** A non-task calendar entry (visit or other event) for the feed. */
export type UpcomingEvent = {
  id: string;
  title: string;
  /** ISO datetime, or 'YYYY-MM-DD' for all-day events; null if missing. */
  start: string | null;
  contactId?: string;
  contactName?: string;
  /** 'design' | 'survey' | … from the moVisitType extended property. */
  visitType?: string;
};

/**
 * Parse Google Calendar `events.list` output (from GET /api/events) into the
 * feed model, dropping task events (moTask=1) — those come from /api/tasks and
 * would otherwise appear twice.
 */
export function parseUpcomingEvents(data: unknown): UpcomingEvent[] {
  const items = (data as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  const out: UpcomingEvent[] = [];
  for (const raw of items) {
    const ev = raw as {
      id?: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      extendedProperties?: { private?: Record<string, string> };
    };
    const priv = ev.extendedProperties?.private || {};
    if (priv.moTask === '1') continue;
    const start = ev.start?.dateTime || ev.start?.date || null;
    out.push({
      id: ev.id || `${start ?? ''}-${ev.summary ?? ''}`,
      title: ev.summary || 'Untitled event',
      start,
      contactId: priv.moContactId || undefined,
      contactName: priv.moContactName || undefined,
      visitType: priv.moVisitType || undefined,
    });
  }
  return out;
}

export function eventTypeLabel(visitType?: string): string {
  if (visitType === 'design') return 'Design visit';
  if (visitType === 'survey') return 'Survey visit';
  if (visitType) return 'Visit';
  return 'Event';
}
