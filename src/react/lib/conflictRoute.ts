/**
 * Deep-link resolver for offline sync conflicts (Offline Phase 3).
 *
 * Turns a {@link ConflictEntry} into an in-app route to the record it touched so
 * the conflicts review dialog can offer an "Open record" affordance — letting a
 * user jump straight to the customer / design visit to verify or re-apply their
 * overwritten edit.
 *
 * Kept as a tiny, dependency-free module (it imports only the erased
 * `ConflictEntry` type) so it can be statically imported by the lazy-loaded
 * `ConflictsReview` component without pulling the `idb`-backed offline queue
 * into that chunk.
 *
 * Returns `null` when no route can be derived; the caller hides the link then.
 */

import type { ConflictEntry, QueueEntry, OfflineArea } from './offlineQueue';

/**
 * Minimal shape needed to derive a record route. Both {@link ConflictEntry}
 * (conflicts review) and an adapted {@link QueueEntry} (failed-sync PDF export)
 * satisfy it, so the resolver logic is shared across both surfaces.
 */
interface RouteSource {
  area: OfflineArea;
  url: string;
  recordKey?: string;
  attemptedBody?: unknown;
  serverData?: unknown;
}

function asId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/** Split a `type:id` record key (e.g. `contact:991`, `dv:482`). */
function recordKeyParts(recordKey?: string): { type: string; id: string } | null {
  if (!recordKey) return null;
  const idx = recordKey.indexOf(':');
  if (idx < 1) return null;
  const id = recordKey.slice(idx + 1).trim();
  if (!id) return null;
  return { type: recordKey.slice(0, idx), id };
}

/**
 * Best-effort lookup of the owning HubSpot contact id for a conflict, checked
 * across every surface that may carry it: the record key, the attempted write
 * body, the server snapshot, and finally the request URL.
 */
function contactIdFor(conflict: RouteSource): string | null {
  const parts = recordKeyParts(conflict.recordKey);
  if (parts && parts.type === 'contact') return parts.id;

  const body = (conflict.attemptedBody ?? null) as Record<string, unknown> | null;
  const fromBody = asId(body?.contactId ?? body?.contact_id);
  if (fromBody) return fromBody;

  const server = (conflict.serverData ?? null) as Record<string, unknown> | null;
  const fromServer = asId(server?.contact_id ?? server?.contactId);
  if (fromServer) return fromServer;

  const m = conflict.url.match(/\/api\/contacts\/([^/?#]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  return null;
}

/**
 * Best-effort lookup of the visit id a *visit* conflict touched, checked across
 * the record key (`dv:<id>` for design visits, `visit:<id>` for arrange
 * visits), the attempted write body, the server
 * snapshot, and finally the request URL (`/api/design-visits/<id>` or
 * `/api/visits/<id>`). Returns `null` when none can be derived.
 */
function visitIdFor(conflict: RouteSource): string | null {
  const parts = recordKeyParts(conflict.recordKey);
  if (parts && (parts.type === 'dv' || parts.type === 'visit' || parts.type === 'sv')) {
    const id = asId(parts.id);
    if (id) return id;
  }

  const body = (conflict.attemptedBody ?? null) as Record<string, unknown> | null;
  const fromBody = asId(body?.id ?? body?.visitId ?? body?.visit_id);
  if (fromBody) return fromBody;

  const server = (conflict.serverData ?? null) as Record<string, unknown> | null;
  const fromServer = asId(server?.id ?? server?.visitId ?? server?.visit_id);
  if (fromServer) return fromServer;

  const m = conflict.url.match(/\/api\/(?:design-visits|survey-visits|visits)\/([^/?#]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  return null;
}

/**
 * Returns `true` when the source looks like an arrange-visit entry (uses
 * `/api/visits/:id` rather than `/api/design-visits/:id`). Used to choose the
 * correct customer-page fragment for the "Open record" link.
 */
function isArrangeVisit(source: RouteSource): boolean {
  if (source.recordKey) {
    const parts = recordKeyParts(source.recordKey);
    if (parts?.type === 'visit') return true;
    if (parts && (parts.type === 'dv' || parts.type === 'sv')) return false;
  }
  if (/\/api\/survey-visits\//.test(source.url)) return false;
  return /\/api\/visits\//.test(source.url);
}

/** Returns `true` when the source is a survey-visit write (`sv:` record key or `/api/survey-visits/` URL). */
function isSurveyVisit(source: RouteSource): boolean {
  if (source.recordKey) {
    const parts = recordKeyParts(source.recordKey);
    if (parts?.type === 'sv') return true;
  }
  return /\/api\/survey-visits\//.test(source.url);
}

/**
 * Best-effort lookup of the customer-info submission id a *photo* conflict
 * touched, checked across the record key (`customer-info:<id>` /
 * `submission:<id>` / `photo:<id>`), the attempted write body
 * (`submissionId` / `submission_id`), the server snapshot, and finally the
 * request URL (e.g. `/api/customer-info/submissions/<id>`). Returns `null`
 * when none can be derived.
 */
function submissionIdFor(conflict: RouteSource): string | null {
  const parts = recordKeyParts(conflict.recordKey);
  if (parts && (parts.type === 'customer-info' || parts.type === 'submission' || parts.type === 'photo')) {
    const id = asId(parts.id);
    if (id) return id;
  }

  const body = (conflict.attemptedBody ?? null) as Record<string, unknown> | null;
  const fromBody = asId(body?.submissionId ?? body?.submission_id);
  if (fromBody) return fromBody;

  const server = (conflict.serverData ?? null) as Record<string, unknown> | null;
  const fromServer = asId(server?.submissionId ?? server?.submission_id ?? server?.id);
  if (fromServer) return fromServer;

  const m = conflict.url.match(/\/api\/customer-info\/submissions\/([^/?#]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  return null;
}

/**
 * Resolve a conflict to an in-app deep link, or `null` when none can be derived.
 *
 * - **customer** edits → the customer detail page `/customers/:id`.
 * - **photo** edits → the owning customer page. When the specific customer-info
 *   submission id is known, a `#customer-info-<submissionId>` fragment is
 *   appended so the customer page can auto-expand and scroll to that exact
 *   submission.
 * - **visit** edits (design visit) → the owning customer page. When the specific
 *   design-visit id is known, a `#design-visit-<visitId>` fragment is appended
 *   so the customer page can auto-expand and scroll to that exact visit. The
 *   contact id is read from the attempted body / server snapshot, since a
 *   `dv:<visitId>` key alone is not a contact id.
 * - **visit** edits (arrange visit) → the owning customer page with a
 *   `#upcoming-visits-section` fragment so the browser scrolls to the visits
 *   section. Arrange visits use `/api/visits/:id` and `visit:<id>` record keys
 *   (distinct from the `dv:` keys used by design visits).
 */
function resolveRoute(source: RouteSource): string | null {
  const contactId = contactIdFor(source);
  if (!contactId) return null;

  const base = `/customers/${encodeURIComponent(contactId)}`;

  switch (source.area) {
    case 'customer':
      return base;
    case 'photo': {
      const submissionId = submissionIdFor(source);
      return submissionId ? `${base}#customer-info-${encodeURIComponent(submissionId)}` : base;
    }
    case 'visit': {
      if (isArrangeVisit(source)) {
        return `${base}#upcoming-visits-section`;
      }
      if (isSurveyVisit(source)) {
        return `${base}#survey-visits-section`;
      }
      const visitId = visitIdFor(source);
      return visitId ? `${base}#design-visit-${encodeURIComponent(visitId)}` : base;
    }
    default:
      return null;
  }
}

export function resolveConflictRoute(conflict: ConflictEntry): string | null {
  return resolveRoute(conflict);
}

/**
 * Resolve a queued (failed-sync) entry to the same in-app record route used by
 * the conflicts review, or `null` when none can be derived. A {@link QueueEntry}
 * carries its attempted write in `body` (there is no server snapshot), so it is
 * mapped onto the shared {@link RouteSource} shape before resolving.
 */
export function resolveQueueEntryRoute(entry: QueueEntry): string | null {
  return resolveRoute({
    area: entry.area,
    url: entry.url,
    recordKey: entry.recordKey,
    attemptedBody: entry.body,
  });
}
