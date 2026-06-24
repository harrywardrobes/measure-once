import { CP_RECENT_CUSTOMERS_PREFIX, CP_RECENT_CUSTOMERS_LEGACY_KEY } from '../constants/localStorageKeys';

/**
 * Date, name, currency, and string formatters shared across React components.
 *
 * These are direct ports of the same-named helpers in `public/core.js`.
 * Vanilla-JS pages continue to use the core.js versions during migration;
 * React components should import from here instead.
 *
 * @deprecated core.js versions — use these typed exports instead.
 */

/**
 * Formats an ISO timestamp as "D Mon YYYY HH:MM" in en-GB locale.
 * Returns '' for falsy input.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return (
    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  );
}

/**
 * Formats a date-only string (YYYY-MM-DD) as "D Mon YYYY" in en-GB locale.
 * Returns '' for falsy input.
 */
export function formatShortDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Returns today's date as "YYYY-MM-DD".
 */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

type ContactLike = {
  properties?: {
    firstname?: string;
    lastname?: string;
    email?: string;
  };
};

/**
 * Returns "First Last", falling back to email, then "Unnamed".
 */
export function contactName(contact: ContactLike | null | undefined): string {
  const p = contact?.properties || {};
  const name = [p.firstname, p.lastname].filter(Boolean).join(' ');
  return name || p.email || 'Unnamed';
}

/**
 * Returns "First Last", falling back to email, then "Contact <id>".
 */
export function contactDisplayName(
  c: (ContactLike & { id?: string | number }) | null | undefined,
): string {
  const p = (c && c.properties) || {};
  const n = `${p.firstname || ''} ${p.lastname || ''}`.trim();
  return n || p.email || `Contact ${c?.id || ''}`;
}

/**
 * Formats a number as GBP currency (e.g. £1,234.56).
 * Returns '—' for null/undefined/NaN (em dash, suitable for UI display).
 */
export function formatCurrency(amount: number | string | null | undefined): string {
  if (amount == null) return '—';
  const n = Number(amount);
  if (isNaN(n)) return '—';
  return '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * HTML-escapes a string. Handles null/undefined by returning ''.
 */
export function escapeHtml(str: string | null | undefined): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Formats a QuickBooks date string (YYYY-MM-DD) as "D Mon YYYY" in en-GB locale.
 * Returns '' for falsy input.
 */
export function formatQuickBooksDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10))
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Updates the cp_recent_customers localStorage entry for a contact after a
 * successful save.  Any rename path that writes a new name to the server
 * should call this so the cached name stays current without requiring a visit
 * to CustomerDetailPage first.
 *
 * Name derivation mirrors customer-detail/types.contactName:
 *   "First Last" → email → company → "Unnamed"
 * (company is included as a fallback for contacts without a personal name/email)
 */
export function updateRecentCustomer(contact: {
  id: string;
  properties?: { firstname?: string; lastname?: string; email?: string; company?: string };
}): void {
  try {
    const uid = (window as unknown as { __moHeaderUser?: { id?: string } }).__moHeaderUser?.id;
    const KEY = uid ? `${CP_RECENT_CUSTOMERS_PREFIX}${uid}` : CP_RECENT_CUSTOMERS_LEGACY_KEY;
    const p = contact.properties || {};
    const parts = [p.firstname, p.lastname].filter(Boolean);
    const name = parts.length ? parts.join(' ') : (p.email || p.company || 'Unnamed');
    const entry = { id: contact.id, name, company: p.company || '', ts: Date.now() };
    type Entry = typeof entry;
    const list = JSON.parse(localStorage.getItem(KEY) || '[]') as Entry[];
    const filtered = list.filter((r) => r.id !== contact.id);
    filtered.unshift(entry);
    localStorage.setItem(KEY, JSON.stringify(filtered.slice(0, 5)));
  } catch { /* noop */ }
}

/**
 * Returns a compact relative-time string for how long ago `value` was.
 *
 * Accepts ISO 8601 strings or numeric epoch-millisecond strings.
 * Returns:
 *   - `null`   for falsy, unparseable, or NaN inputs
 *   - `"now"`  for future timestamps or differences under 1 minute
 *   - `"Xmin"` for 1 min – 59 min  (e.g. "30min")
 *   - `"Xhr"`  for 1 hr  – 23 hr   (e.g. "8hr")
 *   - `"Xd"`   for 1 day – 6 days  (e.g. "4d")
 *   - `"Xw"`   for 1 week – 3 weeks (e.g. "3w")
 *   - `"Xmo"`  for 4+ weeks         (e.g. "2mo")
 */
export function compactRelativeTime(
  value: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!value) return null;
  const ms = /^\d{10,}$/.test(value.trim()) ? Number(value) : Date.parse(value);
  if (!isFinite(ms)) return null;
  const diffMs = now.getTime() - ms;
  if (diffMs < 60_000) return 'now';
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}min`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}hr`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  const diffWeek = Math.floor(diffDay / 7);
  if (diffWeek < 4) return `${diffWeek}w`;
  const diffMo = Math.round(diffDay / 30.44);
  return `${Math.max(1, diffMo)}mo`;
}

/**
 * Returns the most-recent parseable timestamp string from `values`, or `null`
 * if none of the inputs are parseable. Accepts ISO 8601 or epoch-ms strings.
 */
export function latestTimestamp(
  ...values: Array<string | null | undefined>
): string | null {
  let bestMs = -Infinity;
  let bestVal: string | null = null;
  for (const v of values) {
    if (!v) continue;
    const ms = /^\d{10,}$/.test(v.trim()) ? Number(v) : Date.parse(v);
    if (isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      bestVal = v;
    }
  }
  return bestVal;
}

/**
 * Formats an ISO timestamp as a verbose relative string ("2 hours ago", "3 days ago").
 * Returns 'just now' for future timestamps or differences under 2 minutes.
 */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(diff / 86400000);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

/**
 * Returns the URL if it is a valid http/https URL, otherwise ''.
 */
export function safeUrl(url: string | null | undefined): string {
  const s = (url || '').trim();
  if (!s) return '';
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return s;
}
