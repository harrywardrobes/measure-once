/**
 * Pure conflict-detection helpers (Offline Phase 2/3).
 *
 * Extracted into a dependency-free module so both the sync engine
 * (`syncEngine.ts`, which runs the check before replaying a queued write) and
 * the conflict-resolution path (`offlineQueue.ts`, which re-checks before a
 * "Restore server copy" overwrites the record) can share one implementation
 * without importing each other (which would create a circular dependency).
 *
 * Nothing here touches the network or IndexedDB — callers fetch the server
 * record and pass it in.
 */

/** Pull a numeric `version` from a server payload, checking nested records. */
export function extractVersion(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const candidates = [obj.version, (obj.visit as Record<string, unknown>)?.version,
    (obj.designVisit as Record<string, unknown>)?.version,
    (obj.submission as Record<string, unknown>)?.version];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

/** Pull an `updated_at`/`updatedAt` timestamp (ms) from a server payload. */
export function extractUpdatedAt(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const nested = [obj, obj.visit, obj.designVisit, obj.submission].filter(
    (o): o is Record<string, unknown> => !!o && typeof o === 'object',
  );
  for (const o of nested) {
    const raw = o.updated_at ?? o.updatedAt;
    if (typeof raw === 'string') {
      const ms = Date.parse(raw);
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return null;
}

export interface ConflictDecision {
  conflicted: boolean;
  serverVersion: number | null;
  serverUpdatedAt: number | null;
}

/** Pure comparison: did the server copy advance past the cached base? */
export function detectConflict(
  base: { version?: number | null; updatedAt?: string | null },
  serverData: unknown,
): ConflictDecision {
  const serverVersion = extractVersion(serverData);
  const serverUpdatedAt = extractUpdatedAt(serverData);
  let conflicted = false;
  if (base.version != null && serverVersion != null && serverVersion > base.version) {
    conflicted = true;
  }
  if (base.updatedAt) {
    const baseMs = Date.parse(base.updatedAt);
    if (!Number.isNaN(baseMs) && serverUpdatedAt != null && serverUpdatedAt > baseMs) {
      conflicted = true;
    }
  }
  return { conflicted, serverVersion, serverUpdatedAt };
}
