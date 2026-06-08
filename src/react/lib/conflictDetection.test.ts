import { describe, it, expect } from 'vitest';
import { extractVersion, extractUpdatedAt, detectConflict } from './conflictDetection';

// ── extractVersion ────────────────────────────────────────────────────────────

describe('extractVersion', () => {
  it('returns a top-level numeric version', () => {
    expect(extractVersion({ version: 7 })).toBe(7);
  });

  it('returns a version nested under "visit"', () => {
    expect(extractVersion({ visit: { version: 3 } })).toBe(3);
  });

  it('returns a version nested under "designVisit"', () => {
    expect(extractVersion({ designVisit: { version: 12 } })).toBe(12);
  });

  it('returns a version nested under "submission"', () => {
    expect(extractVersion({ submission: { version: 2 } })).toBe(2);
  });

  it('returns null when version is missing', () => {
    expect(extractVersion({})).toBeNull();
    expect(extractVersion(null)).toBeNull();
    expect(extractVersion('string')).toBeNull();
  });

  it('returns null for non-finite version values', () => {
    expect(extractVersion({ version: NaN })).toBeNull();
    expect(extractVersion({ version: Infinity })).toBeNull();
    expect(extractVersion({ version: '5' })).toBeNull();
  });
});

// ── extractUpdatedAt ──────────────────────────────────────────────────────────

describe('extractUpdatedAt', () => {
  const ISO = '2024-06-01T10:00:00.000Z';
  const MS = Date.parse(ISO);

  it('returns epoch-ms for a top-level updated_at', () => {
    expect(extractUpdatedAt({ updated_at: ISO })).toBe(MS);
  });

  it('returns epoch-ms for a top-level updatedAt', () => {
    expect(extractUpdatedAt({ updatedAt: ISO })).toBe(MS);
  });

  it('returns epoch-ms from a "designVisit" envelope', () => {
    expect(extractUpdatedAt({ designVisit: { updated_at: ISO } })).toBe(MS);
  });

  it('returns null for a non-date string', () => {
    expect(extractUpdatedAt({ updated_at: 'not-a-date' })).toBeNull();
  });

  it('returns null when updated_at is absent', () => {
    expect(extractUpdatedAt({})).toBeNull();
    expect(extractUpdatedAt(null)).toBeNull();
  });
});

// ── detectConflict ────────────────────────────────────────────────────────────

describe('detectConflict', () => {
  it('returns conflicted:false when server version equals base version', () => {
    const result = detectConflict({ version: 5 }, { version: 5 });
    expect(result.conflicted).toBe(false);
    expect(result.serverVersion).toBe(5);
  });

  it('returns conflicted:false when server version is older than base', () => {
    const result = detectConflict({ version: 5 }, { version: 4 });
    expect(result.conflicted).toBe(false);
  });

  it('returns conflicted:true when server version is newer than base', () => {
    const result = detectConflict({ version: 5 }, { version: 6 });
    expect(result.conflicted).toBe(true);
    expect(result.serverVersion).toBe(6);
  });

  it('returns conflicted:true when server updatedAt is newer than base', () => {
    const base = '2024-06-01T10:00:00.000Z';
    const newer = '2024-06-01T11:00:00.000Z';
    const result = detectConflict({ updatedAt: base }, { updated_at: newer });
    expect(result.conflicted).toBe(true);
  });

  it('returns conflicted:false when server updatedAt equals base', () => {
    const ts = '2024-06-01T10:00:00.000Z';
    const result = detectConflict({ updatedAt: ts }, { updated_at: ts });
    expect(result.conflicted).toBe(false);
  });

  it('returns conflicted:false when both base fields are missing (no comparison possible)', () => {
    const result = detectConflict({}, { version: 99, updated_at: new Date().toISOString() });
    expect(result.conflicted).toBe(false);
  });

  it('extracts serverVersion and serverUpdatedAt regardless of conflict outcome', () => {
    const ts = '2024-06-01T10:00:00.000Z';
    const result = detectConflict({ version: 10 }, { version: 8, updated_at: ts });
    expect(result.conflicted).toBe(false);
    expect(result.serverVersion).toBe(8);
    expect(result.serverUpdatedAt).toBe(Date.parse(ts));
  });

  it('unwraps version from a "designVisit" envelope', () => {
    const result = detectConflict({ version: 3 }, { designVisit: { version: 5 } });
    expect(result.conflicted).toBe(true);
    expect(result.serverVersion).toBe(5);
  });

  // ── Server-added-room audit ───────────────────────────────────────────────
  //
  // When the server adds a room to a design visit, the record's `version` is
  // bumped. `detectConflict` uses version/timestamp comparison only — it does
  // NOT inspect room arrays. There are therefore no index-based room comparisons
  // that could produce a phantom conflict from a room array shift.
  //
  // The conflict IS flagged (intentionally pessimistic): the server record
  // changed, so the queued write is held for review. The conflict display path
  // (`isServerEquivalent`, `reconcileForCache` in offlineQueue.ts) uses
  // id-based room matching so the review UI accurately shows which rooms
  // diverged, letting the user make an informed decision.

  it('server-added-room: flags conflict via version bump (not via room-array comparison)', () => {
    // User edited leadStatus offline, based on version 5.
    // Server added a new room — version is now 6.
    // The bump is what triggers the flag; the room arrays are never compared.
    const base = { version: 5 };
    const serverData = {
      version: 6,
      updated_at: new Date().toISOString(),
      rooms: [
        { id: 1, door_style: 'Shaker' },
        { id: 99, door_style: 'Slab' }, // newly added by server
      ],
    };
    const result = detectConflict(base, serverData);
    expect(result.conflicted).toBe(true);
    expect(result.serverVersion).toBe(6);
  });

  it('server-added-room: no conflict when version is unchanged despite extra room data in payload', () => {
    // If somehow the server returns the same version (e.g. a read-only field
    // changed), detectConflict correctly returns false.
    const base = { version: 5 };
    const serverData = {
      version: 5,
      rooms: [
        { id: 1, door_style: 'Shaker' },
        { id: 99, door_style: 'Slab' },
      ],
    };
    const result = detectConflict(base, serverData);
    expect(result.conflicted).toBe(false);
  });

  it('server-reordered-rooms: flags conflict via version bump, not via index shift', () => {
    // Server reordered rooms and bumped version. With an index-based check,
    // reordering alone could produce a phantom conflict even at the same
    // version. Our version-only check is immune: same version → no conflict.
    const base = { version: 5 };
    const serverDataSameVersion = {
      version: 5,
      rooms: [
        { id: 2, door_style: 'Flat' },  // was at index 1, now at index 0
        { id: 1, door_style: 'Shaker' }, // was at index 0, now at index 1
      ],
    };
    expect(detectConflict(base, serverDataSameVersion).conflicted).toBe(false);

    // When the version also bumped the conflict IS flagged — correctly.
    const serverDataNewVersion = { ...serverDataSameVersion, version: 6 };
    expect(detectConflict(base, serverDataNewVersion).conflicted).toBe(true);
  });
});
