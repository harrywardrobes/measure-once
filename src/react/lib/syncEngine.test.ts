/**
 * syncEngine — broadcastLeadStatusAfterReplay
 *
 * Confirms that when an arrange-visit (or any visit-area) offline-queued write
 * is drained successfully, `broadcastLeadStatusChange` fires the same-tab
 * window event (LEAD_STATUS_WINDOW_EVENT) in addition to posting on
 * BroadcastChannel. This matters because BroadcastChannel only reaches *other*
 * tabs, so without the window event the originating tab would miss the badge
 * update until a manual refresh.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks (must come before any imports that pull these in) ────────────

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

vi.mock('./conflictDetection', () => ({
  detectConflict: vi.fn(),
}));

vi.mock('./offlineQueue', () => ({
  getEntries: vi.fn(),
  updateEntry: vi.fn(),
  removeEntry: vi.fn(),
  markSynced: vi.fn(),
  recordConflict: vi.fn(),
  reconcileAbortedRestore: vi.fn(),
}));

// ── Imports (after mocks are declared) ───────────────────────────────────────

import {
  getEntries,
  updateEntry,
  removeEntry,
  markSynced,
  type QueueEntry,
  type CalendarMeta,
} from './offlineQueue';
import { flushQueue } from './syncEngine';
import {
  LEAD_STATUS_WINDOW_EVENT,
  type LeadStatusMessage,
} from '../utils/broadcastLeadStatus';

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_CALENDAR_META: CalendarMeta = {
  summary: 'Design Visit — Test Contact',
  description: 'Offline-queued design visit',
  location: '1 Test Street, London',
  visitDate: '2026-07-01T10:00:00',
  durationMins: 90,
  moContactId: 'contact-abc',
  moVisitType: 'design',
};

function makeEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: 1,
    area: 'visit',
    label: 'Arrange Visit — Book',
    url: '/api/card-actions/arrange-visit/outcome',
    method: 'POST',
    body: { contactId: 'contact-abc', outcome: 'booked', visitType: 'design' },
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: 0,
    ...overrides,
  };
}

function listenOnce(): { received: LeadStatusMessage[]; cleanup: () => void } {
  const received: LeadStatusMessage[] = [];
  const handler = (evt: Event) => {
    received.push((evt as CustomEvent<LeadStatusMessage>).detail);
  };
  window.addEventListener(LEAD_STATUS_WINDOW_EVENT, handler);
  return { received, cleanup: () => window.removeEventListener(LEAD_STATUS_WINDOW_EVENT, handler) };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const mockGetEntries = getEntries as ReturnType<typeof vi.fn>;
const mockUpdateEntry = updateEntry as ReturnType<typeof vi.fn>;
const mockRemoveEntry = removeEntry as ReturnType<typeof vi.fn>;
const mockMarkSynced  = markSynced  as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  mockUpdateEntry.mockResolvedValue(undefined);
  mockRemoveEntry.mockResolvedValue(undefined);
  mockMarkSynced.mockResolvedValue(undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('broadcastLeadStatusAfterReplay — arrange-visit same-tab delivery', () => {
  it('fires the same-tab window event after a successful arrange-visit outcome replay', async () => {
    mockGetEntries.mockResolvedValue([makeEntry()]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ hs_lead_status: 'VISIT_BOOKED' }),
    });

    const { received, cleanup } = listenOnce();
    try {
      await flushQueue();
    } finally {
      cleanup();
    }

    expect(received).toHaveLength(1);
    expect(received[0].contactId).toBe('contact-abc');
    expect(received[0].props.hs_lead_status).toBe('VISIT_BOOKED');
  });

  it('uses setsLeadStatus as a fallback when hs_lead_status is absent', async () => {
    mockGetEntries.mockResolvedValue([makeEntry()]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ setsLeadStatus: 'NOT_PROCEEDING' }),
    });

    const { received, cleanup } = listenOnce();
    try {
      await flushQueue();
    } finally {
      cleanup();
    }

    expect(received).toHaveLength(1);
    expect(received[0].contactId).toBe('contact-abc');
    expect(received[0].props.hs_lead_status).toBe('NOT_PROCEEDING');
  });

  it('does not fire the window event when the response carries no lead-status field', async () => {
    mockGetEntries.mockResolvedValue([makeEntry()]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ someOtherField: true }),
    });

    const { received, cleanup } = listenOnce();
    try {
      await flushQueue();
    } finally {
      cleanup();
    }

    expect(received).toHaveLength(0);
  });

  it('does not fire the window event when the queued body has no contactId', async () => {
    // An entry whose body is missing contactId — broadcast must be skipped rather
    // than dispatching an event with an undefined contactId.
    mockGetEntries.mockResolvedValue([
      makeEntry({ body: { outcome: 'booked', visitType: 'design' } }),
    ]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ hs_lead_status: 'VISIT_BOOKED' }),
    });

    const { received, cleanup } = listenOnce();
    try {
      await flushQueue();
    } finally {
      cleanup();
    }

    expect(received).toHaveLength(0);
  });

  it('accepts customerId as the contact identifier (photo-review / design-visit path)', async () => {
    // ReviewCustomerPhotosDrawer and GenericVisitEditModal use `customerId`
    // instead of `contactId` — the engine must bridge both.
    mockGetEntries.mockResolvedValue([
      makeEntry({
        url: '/api/photo-reviews/42/complete',
        body: { customerId: 'contact-xyz', approved: true },
      }),
    ]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ hs_lead_status: 'PHOTOS_REVIEWED' }),
    });

    const { received, cleanup } = listenOnce();
    try {
      await flushQueue();
    } finally {
      cleanup();
    }

    expect(received).toHaveLength(1);
    expect(received[0].contactId).toBe('contact-xyz');
    expect(received[0].props.hs_lead_status).toBe('PHOTOS_REVIEWED');
  });

  it('does not fire the window event when the replay fails with a 4xx', async () => {
    mockGetEntries.mockResolvedValue([makeEntry()]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ error: 'validation failed' }),
    });

    const { received, cleanup } = listenOnce();
    try {
      await flushQueue();
    } finally {
      cleanup();
    }

    expect(received).toHaveLength(0);
  });
});

// ── replayCalendarEvent ───────────────────────────────────────────────────────

describe('replayCalendarEvent — Reconnect toast behaviour', () => {
  let showToastWithAction: ReturnType<typeof vi.fn>;
  let showToast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    showToastWithAction = vi.fn();
    showToast = vi.fn();
    (window as unknown as Record<string, unknown>).showToastWithAction = showToastWithAction;
    (window as unknown as Record<string, unknown>).showToast = showToast;
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).showToastWithAction;
    delete (window as unknown as Record<string, unknown>).showToast;
  });

  it('calls showToast (not showToastWithAction) when POST /api/events succeeds', async () => {
    mockGetEntries.mockResolvedValue([
      makeEntry({ calendarMeta: BASE_CALENDAR_META }),
    ]);

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

    await flushQueue();

    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast.mock.calls[0][0]).toMatch(/calendar event created/i);
    expect(showToastWithAction).not.toHaveBeenCalled();
  });

  it('calls showToastWithAction with Reconnect label and severity warning when POST /api/events returns non-2xx', async () => {
    mockGetEntries.mockResolvedValue([
      makeEntry({ calendarMeta: BASE_CALENDAR_META }),
    ]);

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'unauthorized' }),
      });

    await flushQueue();

    expect(showToastWithAction).toHaveBeenCalledOnce();
    const [_msg, action, options] = showToastWithAction.mock.calls[0] as [string, { label: string; onClick: () => void }, { severity: string }];
    expect(action.label).toBe('Reconnect');
    expect(options.severity).toBe('warning');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('calls showToastWithAction with Reconnect label and severity warning when fetch throws (network error)', async () => {
    mockGetEntries.mockResolvedValue([
      makeEntry({ calendarMeta: BASE_CALENDAR_META }),
    ]);

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await flushQueue();

    expect(showToastWithAction).toHaveBeenCalledOnce();
    const [_msg, action, options] = showToastWithAction.mock.calls[0] as [string, { label: string; onClick: () => void }, { severity: string }];
    expect(action.label).toBe('Reconnect');
    expect(options.severity).toBe('warning');
    expect(showToast).not.toHaveBeenCalled();
  });
});
