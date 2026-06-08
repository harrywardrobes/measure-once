/**
 * Client-side PDF export for the "Changes that failed to sync" backlog
 * (Offline Phase 2 — bulk failed-change actions).
 *
 * When offline changes can't be synced and must be discarded, the user can save
 * a readable record of exactly what was changed and manually re-enter it later.
 * This module turns the failed queue entries already held in the outbox into a
 * titled, dated, human-readable PDF — entirely client-side, no server round-trip.
 *
 * It deliberately depends on no PDF library: a text-only PDF is a small, well
 * specified format, so we emit it by hand. That keeps it tree-shakeable and out
 * of the always-loaded bundle. `SyncPill` dynamically `import()`s this module
 * only when the user taps "Download as PDF", so it forms its own lazy chunk.
 */

import type { QueueEntry, OfflineArea } from './offlineQueue';

const AREA_LABELS: Record<OfflineArea, string> = {
  customer: 'Customer details',
  visit: 'Visit & schedule',
  photo: 'Photo',
};

function areaLabel(area: OfflineArea): string {
  return AREA_LABELS[area] ?? area;
}

// Bookkeeping / sync-plumbing keys that never represent a user-meaningful field.
const NOISE_KEYS = new Set([
  'id',
  'version',
  'updated_at',
  'updatedAt',
  'created_at',
  'createdAt',
  'created_by',
  'createdBy',
  'updated_by',
  'updatedBy',
]);

function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatFieldValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value.trim() === '' ? '—' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatTimestamp(value: number | string | null | undefined): string {
  if (value == null) return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) return '—';
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString();
  }
}

interface FieldLine {
  label: string;
  value: string;
}

/** Pull the changed fields + attempted values out of a queued entry. */
function entryFields(entry: QueueEntry): FieldLine[] {
  const out: FieldLine[] = [];
  const body = entry.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (NOISE_KEYS.has(key) || typeof value === 'function') continue;
      out.push({ label: humanizeKey(key), value: formatFieldValue(value) });
    }
  }
  if (entry.formFields) {
    for (const f of entry.formFields) {
      if (f.blob) out.push({ label: humanizeKey(f.name), value: `[file: ${f.filename || 'attachment'}]` });
      else if (f.value !== undefined) out.push({ label: humanizeKey(f.name), value: f.value });
    }
  }
  return out;
}

// ── Minimal text PDF writer ──────────────────────────────────────────────────────
// US Letter, single Helvetica font, left-aligned text with simple word wrapping
// and pagination. Coordinates are in PDF points (72 per inch); origin is the
// bottom-left of the page.

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const BODY_SIZE = 11;
const TITLE_SIZE = 18;
const LEADING = 15;
const USABLE_HEIGHT = PAGE_HEIGHT - MARGIN * 2;
const LINES_PER_PAGE = Math.floor(USABLE_HEIGHT / LEADING);
// Approximate character capacity for an 11pt Helvetica line within the margins.
const MAX_CHARS = 92;

interface Line {
  text: string;
  size: number;
  /** Extra blank space (in lines) reserved before this line. */
  spacerBefore?: number;
}

// Common Unicode punctuation → CP1252 (WinAnsi) byte values. Declared via the
// font's /Encoding /WinAnsiEncoding, so emitting these bytes renders the glyph
// (e.g. an em-dash) instead of a fallback '?'.
const WINANSI_MAP: Record<number, number> = {
  0x20ac: 0x80, // €
  0x201a: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201e: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x2030: 0x89, // ‰
  0x2018: 0x91, // '
  0x2019: 0x92, // '
  0x201c: 0x93, // "
  0x201d: 0x94, // "
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x2122: 0x99, // ™
};

/** Escape a string for a PDF literal-string body, mapping to WinAnsi bytes. */
function pdfEscape(text: string): string {
  let out = '';
  for (const ch of text) {
    let code = ch.codePointAt(0) ?? 0;
    if (code > 255) {
      const mapped = WINANSI_MAP[code];
      if (mapped === undefined) { out += '?'; continue; }
      code = mapped;
    }
    if (code === 0x5c) out += '\\\\'; // backslash
    else if (code === 0x28) out += '\\('; // (
    else if (code === 0x29) out += '\\)'; // )
    else if (code < 32) out += ' ';
    else out += String.fromCharCode(code);
  }
  return out;
}

/** Greedy word-wrap to a max character width, hard-breaking over-long tokens. */
function wrapText(text: string, maxChars: number): string[] {
  const result: string[] = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) { result.push(''); continue; }
    let current = '';
    for (const word of words) {
      let w = word;
      while (w.length > maxChars) {
        if (current) { result.push(current); current = ''; }
        result.push(w.slice(0, maxChars));
        w = w.slice(maxChars);
      }
      if (!current) current = w;
      else if (current.length + 1 + w.length <= maxChars) current += ` ${w}`;
      else { result.push(current); current = w; }
    }
    if (current) result.push(current);
  }
  return result;
}

/** Build the ordered list of rendered lines for the whole document. */
function buildLines(entries: QueueEntry[], generatedAt: number): Line[] {
  const lines: Line[] = [];
  lines.push({ text: 'Changes that failed to sync', size: TITLE_SIZE });
  lines.push({ text: `Exported ${formatTimestamp(generatedAt)}`, size: BODY_SIZE });
  lines.push({
    text: `${entries.length} change${entries.length === 1 ? '' : 's'} that could not be sent to the server.`,
    size: BODY_SIZE,
  });

  entries.forEach((entry, index) => {
    const heading = `${index + 1}. ${entry.label || entry.recordKey || 'Change'}  [${areaLabel(entry.area)}]`;
    wrapText(heading, MAX_CHARS).forEach((t, i) => {
      lines.push({ text: t, size: BODY_SIZE, spacerBefore: i === 0 ? 1 : 0 });
    });
    lines.push({ text: `Original change: ${formatTimestamp(entry.createdAt)}`, size: BODY_SIZE });

    const fields = entryFields(entry);
    if (fields.length === 0) {
      lines.push({ text: 'No field details were captured for this change.', size: BODY_SIZE });
    } else {
      lines.push({ text: 'Fields changed:', size: BODY_SIZE });
      for (const f of fields) {
        wrapText(`- ${f.label}: ${f.value}`, MAX_CHARS).forEach((t, i) => {
          lines.push({ text: i === 0 ? t : `    ${t}`, size: BODY_SIZE });
        });
      }
    }
    if (entry.lastError) {
      wrapText(`Reason it failed: ${entry.lastError}`, MAX_CHARS).forEach((t, i) => {
        lines.push({ text: i === 0 ? t : `    ${t}`, size: BODY_SIZE });
      });
    }
  });

  return lines;
}

/** Split rendered lines into pages, honouring spacers without splitting them off. */
function paginate(lines: Line[]): Line[][] {
  const pages: Line[][] = [];
  let page: Line[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = (line.spacerBefore ?? 0) + 1;
    if (used + cost > LINES_PER_PAGE && page.length > 0) {
      pages.push(page);
      page = [];
      used = 0;
      // Drop a leading spacer at the top of a fresh page.
      line.spacerBefore = 0;
    }
    page.push(line);
    used += (line.spacerBefore ?? 0) + 1;
  }
  if (page.length > 0) pages.push(page);
  return pages.length > 0 ? pages : [[]];
}

/** Render one page's lines into a PDF content stream. */
function pageContentStream(lines: Line[]): string {
  let y = PAGE_HEIGHT - MARGIN;
  const parts: string[] = ['BT', `1 0 0 1 ${MARGIN} ${y} Tm`];
  let currentSize = 0;
  for (const line of lines) {
    const spacer = line.spacerBefore ?? 0;
    if (spacer > 0) y -= spacer * LEADING;
    if (line.size !== currentSize) {
      parts.push(`/F1 ${line.size} Tf`);
      currentSize = line.size;
    }
    parts.push(`1 0 0 1 ${MARGIN} ${y} Tm`);
    parts.push(`(${pdfEscape(line.text)}) Tj`);
    y -= LEADING;
  }
  parts.push('ET');
  return parts.join('\n');
}

/** Encode a string as Latin1 bytes (every char is <= 255 after pdfEscape). */
function latin1Bytes(str: string): number[] {
  const out: number[] = new Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Assemble a complete, text-only PDF document from the failed entries.
 * Returns a `Blob` of type `application/pdf`.
 */
export function buildFailuresPdf(entries: QueueEntry[], generatedAt: number = Date.now()): Blob {
  const pages = paginate(buildLines(entries, generatedAt));

  // Object layout: 1 = Catalog, 2 = Pages, 3 = Font, then per page a Page object
  // and a content-stream object.
  const fontObj = 3;
  const pageObjs: number[] = [];
  const contentObjs: number[] = [];
  let next = 4;
  for (let i = 0; i < pages.length; i++) {
    pageObjs.push(next++);
    contentObjs.push(next++);
  }
  const objectCount = next - 1;

  const bodies: string[] = [];
  bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[2] = `<< /Type /Pages /Kids [${pageObjs.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageObjs.length} >>`;
  bodies[fontObj] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  pages.forEach((pageLines, i) => {
    const pageObj = pageObjs[i];
    const contentObj = contentObjs[i];
    const stream = pageContentStream(pageLines);
    bodies[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`;
    bodies[contentObj] = `<< /Length ${latin1Bytes(stream).length} >>\nstream\n${stream}\nendstream`;
  });

  // Serialize body, tracking each object's byte offset for the xref table.
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = new Array(objectCount + 1).fill(0);
  for (let n = 1; n <= objectCount; n++) {
    offsets[n] = latin1Bytes(pdf).length;
    pdf += `${n} 0 obj\n${bodies[n]}\nendobj\n`;
  }

  const xrefOffset = latin1Bytes(pdf).length;
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objectCount; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += xref;
  pdf += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new Blob([new Uint8Array(latin1Bytes(pdf))], { type: 'application/pdf' });
}

/** Build a dated filename like `failed-changes-2026-06-08.pdf`. */
export function failuresPdfFilename(generatedAt: number = Date.now()): string {
  const d = new Date(generatedAt);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `failed-changes-${yyyy}-${mm}-${dd}.pdf`;
}

/**
 * Generate the PDF from the given failed entries and trigger a browser download.
 * No server round-trip — the document is built from outbox data already on the
 * device.
 */
export function downloadFailuresPdf(entries: QueueEntry[], generatedAt: number = Date.now()): void {
  const blob = buildFailuresPdf(entries, generatedAt);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = failuresPdfFilename(generatedAt);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
