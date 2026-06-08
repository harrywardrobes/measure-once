/**
 * Unit tests for the pure logic functions in ConflictsReview that drive the
 * conflict resolution UI when the server changed which rooms exist.
 *
 * End-to-end flow under test:
 *   buildFieldDiff  — determines what the UI shows (which fields/rooms changed)
 *   buildRestoreBody — assembles the write-body based on user per-field/per-room choices
 *
 * buildRestoredCachePatch (the final step that updates the read cache) is
 * covered separately in offlineQueue.test.ts, including all room add/remove
 * variants. Tests here complete the chain by verifying that the body
 * buildRestoreBody produces for server-changed-room scenarios is the correct
 * input for that function.
 *
 * Room-diff index semantics (id-based pairing)
 * ─────────────────────────────────────────────
 * computeRoomDiffs uses ID-based matching when rooms carry an `id` field:
 *  - Each attempted room is paired with the server room sharing the same id.
 *  - Attempted rooms with no server counterpart appear first (added by user).
 *  - Server rooms with no attempted counterpart appear last (added by server /
 *    removed by user). Their index in roomChoices is their position in that
 *    trailing "server-only" group.
 *
 * Example — server added room id:99 while user had rooms [id:1, id:2]:
 *   index 0 → attempted[id:1] vs server[id:1]  (same room, both sides)
 *   index 1 → attempted[id:2] vs server[id:2]  (same room, both sides)
 *   index 2 → no attempted    vs server[id:99]  ("removed by user" / "only on server")
 *
 * To include the server-added room the user must flip roomChoices[2] to 'server'.
 */

import { describe, it, expect } from 'vitest';
import { buildFieldDiff, buildRestoreBody } from './ConflictsReview';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal design-visit attempted body (write/camelCase shape). */
function makeAttempted(rooms: unknown[], extra: Record<string, unknown> = {}) {
  return { visitDate: '2025-06-01', rooms, ...extra };
}

/**
 * Minimal design-visit server snapshot (read/snake_case shape), optionally
 * wrapped in the `designVisit` envelope that the server response normally
 * carries.
 */
function makeServer(rooms: unknown[], extra: Record<string, unknown> = {}, wrap = false) {
  const data = { visit_date: '2025-06-01', rooms, ...extra };
  return wrap ? { designVisit: data } : data;
}

function room(id: number, doorStyleId = 1, extra: Record<string, unknown> = {}) {
  return { id, doorStyleId, roomName: `Room ${id}`, ...extra };
}

function serverRoom(id: number, doorStyleId = 1, extra: Record<string, unknown> = {}) {
  return {
    id,
    door_style_id: doorStyleId,
    door_style_name: `Style ${doorStyleId}`,
    room_name: `Room ${id}`,
    ...extra,
  };
}

// ── buildFieldDiff — rooms field change detection ─────────────────────────────

describe('buildFieldDiff — server-changed rooms', () => {
  it('marks rooms unchanged when server rooms are equivalent to the attempted edit', () => {
    const attempted = makeAttempted([room(1), room(2)]);
    const server = makeServer([serverRoom(1), serverRoom(2)]);
    const rows = buildFieldDiff(attempted, server);
    const roomsRow = rows.find((r) => r.key === 'rooms');
    expect(roomsRow).toBeDefined();
    expect(roomsRow!.changed).toBe(false);
  });

  it('marks rooms changed when the server added a room (server has more rooms)', () => {
    const attempted = makeAttempted([room(1), room(2)]);
    // Server added room id:99 — three rooms on the server, two in the edit.
    const server = makeServer([serverRoom(99), serverRoom(1), serverRoom(2)]);
    const rows = buildFieldDiff(attempted, server);
    const roomsRow = rows.find((r) => r.key === 'rooms');
    expect(roomsRow).toBeDefined();
    expect(roomsRow!.changed).toBe(true);
  });

  it('marks rooms changed when the server removed a room (server has fewer rooms)', () => {
    const attempted = makeAttempted([room(1), room(2)]);
    // Server removed room id:2 — only one room left on the server.
    const server = makeServer([serverRoom(1)]);
    const rows = buildFieldDiff(attempted, server);
    const roomsRow = rows.find((r) => r.key === 'rooms');
    expect(roomsRow).toBeDefined();
    expect(roomsRow!.changed).toBe(true);
  });

  it('marks rooms changed when the server replaced a room with a different id (same length)', () => {
    const attempted = makeAttempted([room(1), room(2)]);
    // Server replaced room id:2 with id:3 — same length, different content.
    const server = makeServer([serverRoom(1), serverRoom(3)]);
    const rows = buildFieldDiff(attempted, server);
    const roomsRow = rows.find((r) => r.key === 'rooms');
    expect(roomsRow).toBeDefined();
    expect(roomsRow!.changed).toBe(true);
  });

  it('exposes serverRaw with snake_case server rooms so the UI can display door_style_name', () => {
    const attempted = makeAttempted([room(1)]);
    const server = makeServer([serverRoom(1, 7, { door_style_name: 'Walnut' })]);
    const rows = buildFieldDiff(attempted, server);
    const roomsRow = rows.find((r) => r.key === 'rooms');
    expect(roomsRow).toBeDefined();
    // serverRaw is kept un-projected so RoomsDiff can use server-only fields.
    const rawRooms = roomsRow!.serverRaw as unknown[];
    expect(Array.isArray(rawRooms)).toBe(true);
    expect((rawRooms[0] as Record<string, unknown>).door_style_name).toBe('Walnut');
  });

  it('handles server snapshot wrapped in a response envelope', () => {
    const attempted = makeAttempted([room(1), room(2)]);
    // Server snapshot arrives as { designVisit: { rooms: [...] } }.
    const server = makeServer([serverRoom(1), serverRoom(99)], {}, true);
    const rows = buildFieldDiff(attempted, server);
    const roomsRow = rows.find((r) => r.key === 'rooms');
    expect(roomsRow).toBeDefined();
    expect(roomsRow!.changed).toBe(true);
  });

  it('marks visitDate unchanged when the dates match', () => {
    const attempted = makeAttempted([room(1)]);
    const server = makeServer([serverRoom(1)]);
    const rows = buildFieldDiff(attempted, server);
    const dateRow = rows.find((r) => r.key === 'visitDate');
    expect(dateRow).toBeDefined();
    expect(dateRow!.changed).toBe(false);
  });

  it('marks visitDate changed when the server has a different date', () => {
    const attempted = makeAttempted([room(1)]);
    const server = makeServer([serverRoom(1)], { visit_date: '2025-07-15' });
    const rows = buildFieldDiff(attempted, server);
    const dateRow = rows.find((r) => r.key === 'visitDate');
    expect(dateRow).toBeDefined();
    expect(dateRow!.changed).toBe(true);
  });

  it('drops noise keys (id, version, updated_at) from the diff', () => {
    const attempted = { id: 1, version: 5, updatedAt: 'ts', visitDate: '2025-06-01', rooms: [] };
    const server = makeServer([]);
    const rows = buildFieldDiff(attempted, server);
    const keys = rows.map((r) => r.key);
    expect(keys).not.toContain('id');
    expect(keys).not.toContain('version');
    expect(keys).not.toContain('updatedAt');
  });
});

// ── buildRestoreBody — server added a room ────────────────────────────────────
//
// ID-based pairing index layout for this scenario:
//   attempted:   [{id:1}, {id:2}]
//   server:      [{id:99}, {id:1}, {id:2}]
//
//   diff index 0 → attempted[id:1]  paired with server[id:1]   (same room, no change)
//   diff index 1 → attempted[id:2]  paired with server[id:2]   (same room, no change)
//   diff index 2 → no attempted,    server[id:99]              ("only on server" / removed by user)
//
// The server-added room (id:99) is only reachable at index 2 in the UI, so
// roomChoices[2] = 'server' is the way to accept it.

describe('buildRestoreBody — server added a room', () => {
  const attemptedRooms = [room(1, 1), room(2, 2)];
  const serverRooms = [serverRoom(99, 5), serverRoom(1, 1), serverRoom(2, 2)];
  const attempted = makeAttempted(attemptedRooms);
  const server = makeServer(serverRooms);

  it('keeps user rooms untouched when no room choice overrides (default "mine" everywhere)', () => {
    // User clicks "Keep my edit". All rooms default to 'mine'; the server-added
    // room (id:99, diff index 2) is absent from the attempted array so it is
    // dropped naturally with choice 'mine' and attemptedRaw=null.
    const body = buildRestoreBody(attempted, server, ['rooms'], {});
    expect(body).not.toBeNull();
    const bodyRooms = body!.rooms as unknown[];
    expect(bodyRooms).toHaveLength(2);
    expect((bodyRooms[0] as Record<string, unknown>).id).toBe(1);
    expect((bodyRooms[1] as Record<string, unknown>).id).toBe(2);
  });

  it('includes the server-added room (id:99) when the user flips index 2 to server', () => {
    // Index 2 in the id-based diff is the server-only room (id:99). Choosing
    // 'server' for index 2 adds it to the output after the user's rooms.
    const body = buildRestoreBody(attempted, server, ['rooms'], { 2: 'server' });
    expect(body).not.toBeNull();
    const bodyRooms = body!.rooms as unknown[];
    // index 0: mine → room 1; index 1: mine → room 2; index 2: server → room 99
    expect(bodyRooms).toHaveLength(3);
    expect((bodyRooms[0] as Record<string, unknown>).id).toBe(1);
    expect((bodyRooms[1] as Record<string, unknown>).id).toBe(2);
    expect((bodyRooms[2] as Record<string, unknown>).id).toBe(99);
  });

  it('choosing server for an unchanged room (index 0) returns the server counterpart for that room', () => {
    // Index 0 in the id-based diff is attempted[id:1] paired with server[id:1].
    // The user-visible choice applies the server version of that room (same id,
    // but any changed attributes would come from the server side).
    const body = buildRestoreBody(attempted, server, ['rooms'], { 0: 'server' });
    expect(body).not.toBeNull();
    const bodyRooms = body!.rooms as unknown[];
    // index 0 → server version of room 1 (id:1), index 1 → mine (id:2)
    const first = bodyRooms[0] as Record<string, unknown>;
    expect(first.id).toBe(1);
  });

  it('preserves non-rooms fields verbatim when only rooms are in restoreKeys', () => {
    const body = buildRestoreBody(attempted, server, ['rooms'], {});
    expect(body).not.toBeNull();
    // visitDate was in the attempted body and is preserved.
    expect(body!.visitDate).toBe('2025-06-01');
  });

  it('returns null when restoreKeys is empty (keep-my-edit path)', () => {
    const body = buildRestoreBody(attempted, server, []);
    expect(body).toBeNull();
  });
});

// ── buildRestoreBody — server removed a room ──────────────────────────────────
//
// ID-based pairing index layout for this scenario:
//   attempted:   [{id:1}, {id:2}]
//   server:      [{id:1}]          (server removed id:2)
//
//   diff index 0 → attempted[id:1] paired with server[id:1]  (same room, no change)
//   diff index 1 → attempted[id:2] paired with server: null  ("added in your edit")
//
// The removed room (id:2) is at index 1; choosing 'server' at index 1 drops it
// (serverRaw is null, so nothing is pushed), while 'mine' (default) keeps it.

describe('buildRestoreBody — server removed a room', () => {
  const attemptedRooms = [room(1, 1), room(2, 2)];
  const serverRooms = [serverRoom(1, 1)];
  const attempted = makeAttempted(attemptedRooms);
  const server = makeServer(serverRooms);

  it('keeps both user rooms when user chooses "keep mine" for all', () => {
    // User keeps their edit including the room the server deleted.
    const body = buildRestoreBody(attempted, server, ['rooms'], {});
    expect(body).not.toBeNull();
    const bodyRooms = body!.rooms as unknown[];
    expect(bodyRooms).toHaveLength(2);
    expect((bodyRooms[0] as Record<string, unknown>).id).toBe(1);
    expect((bodyRooms[1] as Record<string, unknown>).id).toBe(2);
  });

  it('drops the removed room when user flips index 1 to "server"', () => {
    // Index 1 = attempted[id:2] paired with serverRaw=null. Choosing 'server'
    // at index 1 means accepting the absence → room id:2 is dropped.
    const body = buildRestoreBody(attempted, server, ['rooms'], { 1: 'server' });
    expect(body).not.toBeNull();
    const bodyRooms = body!.rooms as unknown[];
    expect(bodyRooms).toHaveLength(1);
    expect((bodyRooms[0] as Record<string, unknown>).id).toBe(1);
  });

  it('choosing server for index 0 (the shared room) returns its server version', () => {
    // Index 0 = attempted[id:1] paired with server[id:1]. Taking 'server' for it
    // substitutes the server version of that room (same id, possibly different attrs).
    const body = buildRestoreBody(attempted, server, ['rooms'], { 0: 'server' });
    expect(body).not.toBeNull();
    const bodyRooms = body!.rooms as unknown[];
    const first = bodyRooms[0] as Record<string, unknown>;
    expect(first.id).toBe(1);
  });
});

// ── End-to-end chain: diff → user choices → restore body ─────────────────────

describe('end-to-end: buildFieldDiff → buildRestoreBody — server added a room', () => {
  it('produces a rooms array that matches what buildRestoredCachePatch would receive', () => {
    // Setup: server added room id:99 while user had rooms [id:1, id:2].
    // ID-based diff indices: 0=id:1(both), 1=id:2(both), 2=id:99(server-only).
    const attemptedRooms = [room(1, 1), room(2, 2)];
    const serverRooms = [
      serverRoom(99, 5, { door_style_name: 'Slab Door' }),
      serverRoom(1, 1, { door_style_name: 'Shaker Door' }),
      serverRoom(2, 2, { door_style_name: 'Flat Door' }),
    ];
    const attempted = makeAttempted(attemptedRooms);
    const server = makeServer(serverRooms);

    // Step 1: diff — confirm rooms are flagged as changed (server has extra room).
    const rows = buildFieldDiff(attempted, server);
    const roomsRow = rows.find((r) => r.key === 'rooms')!;
    expect(roomsRow.changed).toBe(true);

    // Step 2: "keep all mine" — buildRestoreBody with empty roomChoices.
    // User keeps their two rooms; the server-added room (diff index 2) stays
    // at default 'mine' → attemptedRaw=null → dropped.
    const keepMineBody = buildRestoreBody(attempted, server, ['rooms'], {});
    expect(keepMineBody).not.toBeNull();
    const keepRooms = keepMineBody!.rooms as Array<Record<string, unknown>>;
    expect(keepRooms).toHaveLength(2);
    expect(keepRooms.map((r) => r.id)).toEqual([1, 2]);

    // Step 3: "accept the server-added room" — flip diff index 2 to 'server'.
    // The server room (id:99) is projected to the write-shape template and
    // appended after the user's two rooms.
    const serverBody = buildRestoreBody(attempted, server, ['rooms'], { 2: 'server' });
    expect(serverBody).not.toBeNull();
    const serverRoomsResult = serverBody!.rooms as Array<Record<string, unknown>>;
    expect(serverRoomsResult).toHaveLength(3);
    expect(serverRoomsResult[0].id).toBe(1);
    expect(serverRoomsResult[1].id).toBe(2);
    expect(serverRoomsResult[2].id).toBe(99);
  });
});

describe('end-to-end: buildFieldDiff → buildRestoreBody — server removed a room', () => {
  it('produces the expected rooms body for each resolution choice', () => {
    // Setup: user edited [id:1, id:2]; server has only [id:1] (removed id:2).
    // ID-based diff: index 0 = id:1 (both sides), index 1 = id:2 (user-only / "added in edit").
    const attemptedRooms = [room(1, 1), room(2, 2)];
    const serverRooms = [serverRoom(1, 1, { door_style_name: 'Shaker Door' })];
    const attempted = makeAttempted(attemptedRooms);
    const server = makeServer(serverRooms);

    // Step 1: diff — rooms should be flagged changed (user has a room server doesn't).
    const rows = buildFieldDiff(attempted, server);
    const roomsRow = rows.find((r) => r.key === 'rooms')!;
    expect(roomsRow.changed).toBe(true);

    // Step 2a: keep both user rooms (user overrides server deletion).
    // Diff index 1 = id:2 paired with serverRaw=null → 'mine' keeps it.
    const keepBody = buildRestoreBody(attempted, server, ['rooms'], {});
    const keepRooms = keepBody!.rooms as Array<Record<string, unknown>>;
    expect(keepRooms).toHaveLength(2);
    expect(keepRooms.map((r) => r.id)).toEqual([1, 2]);

    // Step 2b: accept server deletion — flip diff index 1 to 'server' (serverRaw=null → dropped).
    const dropBody = buildRestoreBody(attempted, server, ['rooms'], { 1: 'server' });
    const dropRooms = dropBody!.rooms as Array<Record<string, unknown>>;
    expect(dropRooms).toHaveLength(1);
    expect(dropRooms[0].id).toBe(1);
  });
});
