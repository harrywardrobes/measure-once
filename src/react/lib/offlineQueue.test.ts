import { describe, it, expect, vi } from 'vitest';

vi.mock('./offlineDb', () => ({
  outboxAdd: vi.fn(),
  outboxGetAll: vi.fn(),
  outboxPut: vi.fn(),
  outboxDelete: vi.fn(),
  conflictAdd: vi.fn(),
  conflictGetAll: vi.fn(),
  conflictDelete: vi.fn(),
  evictCachedRecord: vi.fn(),
  updateCachedRecord: vi.fn(),
  getMeta: vi.fn(),
  setMeta: vi.fn(),
}));

vi.mock('./conflictRoute', () => ({
  resolveConflictRoute: vi.fn(),
  resolveQueueEntryRoute: vi.fn(),
}));

vi.mock('./conflictDetection', () => ({
  detectConflict: vi.fn(),
}));

import {
  deepSnakeize,
  isServerEquivalent,
  reconcileForCache,
  buildRestoredCachePatch,
  type ConflictEntry,
} from './offlineQueue';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeConflict(serverData: unknown): ConflictEntry {
  return {
    id: 1,
    area: 'visit',
    label: 'test',
    url: '/api/design-visits/1',
    method: 'PATCH',
    serverData,
    resolution: 'flagged',
    detectedAt: Date.now(),
  };
}

// ── deepSnakeize ─────────────────────────────────────────────────────────────

describe('deepSnakeize', () => {
  it('converts camelCase object keys to snake_case', () => {
    expect(deepSnakeize({ doorStyleName: 'Shaker', roomType: 'kitchen' })).toEqual({
      door_style_name: 'Shaker',
      room_type: 'kitchen',
    });
  });

  it('handles nested objects recursively', () => {
    expect(deepSnakeize({ outerKey: { innerKey: 'value' } })).toEqual({
      outer_key: { inner_key: 'value' },
    });
  });

  it('handles arrays by recursing into each element', () => {
    expect(deepSnakeize([{ roomName: 'Kitchen' }, { roomName: 'Bath' }])).toEqual([
      { room_name: 'Kitchen' },
      { room_name: 'Bath' },
    ]);
  });

  it('passes scalars through unchanged', () => {
    expect(deepSnakeize('hello')).toBe('hello');
    expect(deepSnakeize(42)).toBe(42);
    expect(deepSnakeize(null)).toBeNull();
    expect(deepSnakeize(true)).toBe(true);
  });

  it('converts multi-uppercase sequences correctly', () => {
    expect(deepSnakeize({ myABCKey: 1 })).toEqual({ my_a_b_c_key: 1 });
  });
});

// ── isServerEquivalent ───────────────────────────────────────────────────────

describe('isServerEquivalent', () => {
  it('returns true for identical scalars', () => {
    expect(isServerEquivalent('Shaker', 'Shaker')).toBe(true);
    expect(isServerEquivalent(3, 3)).toBe(true);
    expect(isServerEquivalent(null, null)).toBe(true);
  });

  it('returns false for different scalars', () => {
    expect(isServerEquivalent('Shaker', 'Flat')).toBe(false);
    expect(isServerEquivalent(1, 2)).toBe(false);
  });

  it('matches a camelCase write-shape object to a snake_case read-shape server object', () => {
    const resolved = { doorStyle: 'Shaker', width: 36 };
    const server   = { door_style: 'Shaker', width: 36, door_style_name: 'Shaker Door' };
    expect(isServerEquivalent(resolved, server)).toBe(true);
  });

  it('returns false when a resolved field differs from the server', () => {
    const resolved = { doorStyle: 'Flat', width: 36 };
    const server   = { door_style: 'Shaker', width: 36 };
    expect(isServerEquivalent(resolved, server)).toBe(false);
  });

  it('matches arrays element-by-element', () => {
    const resolved = [{ id: 1, name: 'Kitchen' }];
    const server   = [{ id: 1, name: 'Kitchen', door_style_name: 'Shaker' }];
    expect(isServerEquivalent(resolved, server)).toBe(true);
  });

  it('returns false when arrays have different lengths', () => {
    expect(isServerEquivalent([{ id: 1 }], [{ id: 1 }, { id: 2 }])).toBe(false);
  });

  it('returns false when resolved is array but server is not', () => {
    expect(isServerEquivalent([{ id: 1 }], { id: 1 })).toBe(false);
  });
});

// ── reconcileForCache ────────────────────────────────────────────────────────

describe('reconcileForCache', () => {
  it('uses the server element verbatim when a room is server-equivalent (preserves server-only fields)', () => {
    const serverRoom = { id: 1, door_style: 'Shaker', door_style_name: 'Shaker Door', width: 36 };
    const resolvedRoom = { id: 1, doorStyle: 'Shaker', width: 36 };
    const result = reconcileForCache([resolvedRoom], [serverRoom]) as unknown[];
    expect(result[0]).toBe(serverRoom);
  });

  it('deep-snake-cases a room that differs from server', () => {
    const serverRoom   = { id: 1, door_style: 'Shaker', door_style_name: 'Shaker Door', width: 36 };
    const resolvedRoom = { id: 1, doorStyle: 'Flat', width: 48 };
    const result = reconcileForCache([resolvedRoom], [serverRoom]) as unknown[];
    expect(result[0]).toEqual({ id: 1, door_style: 'Flat', width: 48 });
    expect(result[0]).not.toBe(serverRoom);
  });

  it('handles mixed array: server-equivalent elements use server obj, differing ones are snake-cased', () => {
    const serverRooms = [
      { id: 1, door_style: 'Shaker', door_style_name: 'Shaker Door' },
      { id: 2, door_style: 'Flat', door_style_name: 'Flat Door' },
    ];
    const resolvedRooms = [
      { id: 1, doorStyle: 'Shaker' },
      { id: 2, doorStyle: 'NewStyle' },
    ];
    const result = reconcileForCache(resolvedRooms, serverRooms) as unknown[];
    expect(result[0]).toBe(serverRooms[0]);
    expect(result[1]).toEqual({ id: 2, door_style: 'NewStyle' });
  });

  it('treats an out-of-bounds server index (undefined) as non-equivalent — snake-cases the element', () => {
    const resolved = [{ id: 1, doorStyle: 'Shaker' }, { id: 2, doorStyle: 'Flat' }];
    const server   = [{ id: 1, door_style: 'Shaker' }];
    const result = reconcileForCache(resolved, server) as unknown[];
    expect(result[1]).toEqual({ id: 2, door_style: 'Flat' });
  });

  it('deep-snake-cases non-array resolved value', () => {
    const result = reconcileForCache({ myKey: 'val' }, { my_key: 'different' });
    expect(result).toEqual({ my_key: 'val' });
  });

  it('server added a room: resolved rooms are matched by id, not index', () => {
    const serverRooms = [
      { id: 99, door_style: 'Slab', door_style_name: 'Slab Door' },
      { id: 1, door_style: 'Shaker', door_style_name: 'Shaker Door' },
      { id: 2, door_style: 'Flat', door_style_name: 'Flat Door' },
    ];
    const resolvedRooms = [
      { id: 1, doorStyle: 'Shaker' },
      { id: 2, doorStyle: 'Flat' },
    ];
    const result = reconcileForCache(resolvedRooms, serverRooms) as unknown[];
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(serverRooms[1]);
    expect(result[1]).toBe(serverRooms[2]);
  });

  it('server removed a room: resolved room with no server match is deep-snake-cased', () => {
    const serverRooms = [
      { id: 1, door_style: 'Shaker', door_style_name: 'Shaker Door' },
    ];
    const resolvedRooms = [
      { id: 1, doorStyle: 'Shaker' },
      { id: 2, doorStyle: 'Flat' },
    ];
    const result = reconcileForCache(resolvedRooms, serverRooms) as unknown[];
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(serverRooms[0]);
    expect(result[1]).toEqual({ id: 2, door_style: 'Flat' });
  });

  it('server reordered rooms: id lookup maps each resolved room to the correct server room', () => {
    const serverRooms = [
      { id: 2, door_style: 'Flat', door_style_name: 'Flat Door' },
      { id: 1, door_style: 'Shaker', door_style_name: 'Shaker Door' },
    ];
    const resolvedRooms = [
      { id: 1, doorStyle: 'Shaker' },
      { id: 2, doorStyle: 'Flat' },
    ];
    const result = reconcileForCache(resolvedRooms, serverRooms) as unknown[];
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(serverRooms[1]);
    expect(result[1]).toBe(serverRooms[0]);
  });

  it('server added a room: user-edited room matched by id — server-only fields preserved', () => {
    const serverRooms = [
      { id: 10, door_style: 'Slab', door_style_name: 'Slab Door' },
      { id: 1, door_style: 'Shaker', door_style_name: 'Shaker Door', width: 36 },
    ];
    const resolvedRooms = [{ id: 1, doorStyle: 'Shaker', width: 42 }];
    const result = reconcileForCache(resolvedRooms, serverRooms) as unknown[];
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 1, door_style: 'Shaker', width: 42 });
    expect((result[0] as Record<string, unknown>).door_style_name).toBeUndefined();
  });
});

// ── buildRestoredCachePatch ───────────────────────────────────────────────────

describe('buildRestoredCachePatch', () => {
  it('uses server snapshot verbatim for a whole-field restore (preserves server-only fields)', () => {
    const serverRooms = [
      { id: 1, door_style: 'Shaker', door_style_name: 'Shaker Door', width: 36 },
    ];
    const conflict = makeConflict({ rooms: serverRooms, lead_status: 'new' });
    const resolvedBody = { rooms: [{ id: 1, doorStyle: 'Shaker', width: 36 }] };

    const patch = buildRestoredCachePatch(conflict, resolvedBody);
    expect(patch).not.toBeNull();
    expect(patch!.rooms).toBe(serverRooms);
  });

  it('preserves server-only fields on server-restored rooms in a mixed array', () => {
    const serverRooms = [
      { id: 1, door_style: 'Shaker', door_style_name: 'Shaker Door' },
      { id: 2, door_style: 'Flat',   door_style_name: 'Flat Door' },
    ];
    const conflict = makeConflict({ rooms: serverRooms });
    const resolvedBody = {
      rooms: [
        { id: 1, doorStyle: 'Shaker' },
        { id: 2, doorStyle: 'CustomStyle' },
      ],
    };

    const patch = buildRestoredCachePatch(conflict, resolvedBody);
    const rooms = patch!.rooms as unknown[];
    expect(rooms[0]).toBe(serverRooms[0]);
    expect((rooms[0] as Record<string, unknown>).door_style_name).toBe('Shaker Door');
    expect(rooms[1]).toEqual({ id: 2, door_style: 'CustomStyle' });
    expect((rooms[1] as Record<string, unknown>).door_style_name).toBeUndefined();
  });

  it('"keep mine" restore — all rooms differ from server → deepSnakeize output only', () => {
    const serverRooms = [
      { id: 1, door_style: 'Shaker', door_style_name: 'Shaker Door' },
    ];
    const conflict = makeConflict({ rooms: serverRooms });
    const resolvedBody = { rooms: [{ id: 1, doorStyle: 'Flat' }] };

    const patch = buildRestoredCachePatch(conflict, resolvedBody);
    const rooms = patch!.rooms as unknown[];
    expect(rooms[0]).toEqual({ id: 1, door_style: 'Flat' });
    expect((rooms[0] as Record<string, unknown>).door_style_name).toBeUndefined();
  });

  it('scalar field — identical to server → exact server value used', () => {
    const conflict = makeConflict({ lead_status: 'new' });
    const patch = buildRestoredCachePatch(conflict, { leadStatus: 'new' });
    expect(patch).toEqual({ lead_status: 'new' });
  });

  it('scalar field — different from server → resolved value snake-cased', () => {
    const conflict = makeConflict({ lead_status: 'new' });
    const patch = buildRestoredCachePatch(conflict, { leadStatus: 'active' });
    expect(patch).toEqual({ lead_status: 'active' });
  });

  it('skips resolved keys that have no corresponding key in the server snapshot', () => {
    const conflict = makeConflict({ rooms: [] });
    const patch = buildRestoredCachePatch(conflict, {
      rooms: [],
      handlerConfig: { type: 'start_design_visit' },
    });
    expect(patch).not.toBeNull();
    expect(Object.keys(patch!)).not.toContain('handlerConfig');
    expect(Object.keys(patch!)).not.toContain('handler_config');
  });

  it('returns null when no resolved keys map onto the server snapshot', () => {
    const conflict = makeConflict({ rooms: [] });
    const patch = buildRestoredCachePatch(conflict, { handlerConfig: { type: 'x' } });
    expect(patch).toBeNull();
  });

  it('unwraps a server snapshot that is wrapped in a response envelope key', () => {
    const serverRooms = [{ id: 1, door_style: 'Shaker', door_style_name: 'Shaker Door' }];
    const conflict = makeConflict({ designVisit: { rooms: serverRooms } });
    const resolvedBody = { rooms: [{ id: 1, doorStyle: 'Shaker' }] };

    const patch = buildRestoredCachePatch(conflict, resolvedBody);
    expect(patch).not.toBeNull();
    expect(patch!.rooms).toBe(serverRooms);
  });

  it('handles object-valued fields: equivalent → server object; different → deep-snake-cased', () => {
    const serverAddress = { street: '123 Main St', city: 'Springfield' };
    const conflict = makeConflict({ address: serverAddress, name: 'Test' });

    const patchRestored = buildRestoredCachePatch(conflict, { address: { street: '123 Main St', city: 'Springfield' } });
    expect(patchRestored!.address).toBe(serverAddress);

    const patchMine = buildRestoredCachePatch(conflict, { address: { street: '456 Elm St', city: 'Springfield' } });
    expect(patchMine!.address).toEqual({ street: '456 Elm St', city: 'Springfield' });
  });
});
