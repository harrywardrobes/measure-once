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

import type { ConflictEntry } from './offlineQueue';

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
function contactIdFor(conflict: ConflictEntry): string | null {
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
 * Best-effort lookup of the design-visit id a *visit* conflict touched, checked
 * across the record key (`dv:<id>` / `design-visit:<id>`), the attempted write
 * body, the server snapshot, and finally the request URL
 * (`/api/design-visits/<id>`). Returns `null` when none can be derived.
 */
function visitIdFor(conflict: ConflictEntry): string | null {
  const parts = recordKeyParts(conflict.recordKey);
  if (parts && (parts.type === 'dv' || parts.type === 'design-visit')) {
    const id = asId(parts.id);
    if (id) return id;
  }

  const body = (conflict.attemptedBody ?? null) as Record<string, unknown> | null;
  const fromBody = asId(body?.id ?? body?.visitId ?? body?.visit_id);
  if (fromBody) return fromBody;

  const server = (conflict.serverData ?? null) as Record<string, unknown> | null;
  const fromServer = asId(server?.id ?? server?.visitId ?? server?.visit_id);
  if (fromServer) return fromServer;

  const m = conflict.url.match(/\/api\/design-visits\/([^/?#]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  return null;
}

/**
 * Resolve a conflict to an in-app deep link, or `null` when none can be derived.
 *
 * - **customer** / **photo** edits → the customer detail page `/customers/:id`.
 * - **visit** edits → the owning customer page, where design visits are reviewed
 *   (there is no standalone per-visit route). The contact id is read from the
 *   attempted body / server snapshot, since a `dv:<visitId>` key alone is not a
 *   contact id. When the specific visit id is known, a
 *   `#design-visit-<visitId>` fragment is appended so the customer page can
 *   auto-expand and scroll to that exact visit.
 */
export function resolveConflictRoute(conflict: ConflictEntry): string | null {
  const contactId = contactIdFor(conflict);
  if (!contactId) return null;

  const base = `/customers/${encodeURIComponent(contactId)}`;

  switch (conflict.area) {
    case 'customer':
    case 'photo':
      return base;
    case 'visit': {
      const visitId = visitIdFor(conflict);
      return visitId ? `${base}#design-visit-${encodeURIComponent(visitId)}` : base;
    }
    default:
      return null;
  }
}
