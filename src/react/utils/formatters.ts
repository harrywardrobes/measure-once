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
 */
export function fmtGBP(amount: number | string | null | undefined): string {
  const n = Number(amount);
  if (isNaN(n)) return '';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
}

/**
 * HTML-escapes a string. Handles null/undefined by returning ''.
 */
export function escHtml(str: string | null | undefined): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
