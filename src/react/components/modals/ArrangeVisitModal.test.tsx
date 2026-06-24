import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../contexts/ToastContext', () => ({
  useToastContext: vi.fn(() => ({ showToast: vi.fn(), showToastWithAction: vi.fn() })),
  useToast: vi.fn(() => vi.fn()),
}));

vi.mock('../../context/ConnectionToastContext', () => ({
  openConnectModal: vi.fn(),
  useServiceStatuses: vi.fn(() => new Map()),
}));

vi.mock('../../hooks/useDiscardGuard', () => ({
  useDiscardGuard: vi.fn(() => ({
    confirmOpen: false,
    handleRequestClose: vi.fn(),
    handleKeepEditing: vi.fn(),
  })),
}));

/**
 * ScheduleVisitModal is a heavyweight component. Mock it so guard tests stay
 * focused on the guard logic. Renders a data-testid that varies by whether
 * existingEventId is set so the two instances can be told apart.
 */
vi.mock('./ScheduleVisitModal', () => ({
  ScheduleVisitModal: vi.fn(({ open, existingEventId }: { open: boolean; existingEventId?: string }) =>
    open
      ? <div data-testid={existingEventId ? 'reschedule-visit-modal' : 'schedule-visit-modal'} />
      : null,
  ),
}));

import { ArrangeVisitModal } from './ArrangeVisitModal';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { ARRANGE_VISIT_DRAFT_PREFIX } from '../../constants/localStorageKeys';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FUTURE_DT = new Date(Date.now() + 7 * 86400000).toISOString();
const BOOKED_SLOT_ISO = new Date(Date.now() + 14 * 86400000).toISOString();

const FUTURE_EVENT = {
  id: 'event-xyz',
  summary: 'Arrange visit — John Smith',
  start: { dateTime: FUTURE_DT },
};

const CONTACT_INFO = {
  visitType: 'design',
  contactName: 'John Smith',
  contactPhone: '01234 567890',
  contactMobilePhone: '07700 123456',
  contactEmail: 'john@example.com',
  contactAddress: '1 High Street, London',
  contactStructuredAddress: null,
  leadStatus: null,
};

const CTX = {
  contactId: 'contact-99',
  contactName: 'John Smith',
  contactEmail: 'john@example.com',
};

const HANDLER = { id: 2, type: 'arrange_visit' };

// ── Fetch mock ────────────────────────────────────────────────────────────────

function mockFetch(opts: {
  eventsItems?: object[];
  deleteStatus?: number;
}): () => void {
  const orig = window.fetch;
  const { eventsItems = [], deleteStatus = 200 } = opts;

  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method = (init?.method || 'GET').toUpperCase();

    if (url.includes('/api/card-actions/arrange-visit') && !url.includes('outcome') && method === 'POST') {
      return new Response(JSON.stringify(CONTACT_INFO), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/api/email-templates/render') && method === 'POST') {
      return new Response(JSON.stringify({ subject: '', body_text: '' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/api/events') && method === 'GET') {
      return new Response(JSON.stringify({ items: eventsItems }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/api/events/') && method === 'DELETE') {
      if (deleteStatus === 200) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'Server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return orig(input, init);
  }) as typeof window.fetch;

  return () => { window.fetch = orig; };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pre-populate sessionStorage so the modal starts at the 'booked' step
 *  with a valid slot — avoids having to interact with the DateTimePicker. */
function seedDraft() {
  const key = ARRANGE_VISIT_DRAFT_PREFIX + CTX.contactId;
  sessionStorage.setItem(key, JSON.stringify({
    step: 'booked',
    bookedSlotIso: BOOKED_SLOT_ISO,
    structuredAddress: null,
    notes: '',
    emailSubject: '',
    emailBody: '',
  }));
  return key;
}

function renderModal() {
  return render(
    <ArrangeVisitModal
      handler={HANDLER}
      ctx={CTX}
      open
      onClose={vi.fn()}
    />,
  );
}

/** Wait until the "Confirm booking" button is visible (booked step loaded). */
async function waitForBookedStep() {
  await waitFor(() => {
    expect(screen.getByTestId('av-booked-confirm')).toBeTruthy();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ArrangeVisitModal — discard guard on untouched new visit', () => {
  let restoreFetch: () => void;

  beforeEach(() => {
    vi.mocked(useDiscardGuard).mockClear();
    sessionStorage.clear();
  });

  afterEach(() => {
    restoreFetch?.();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('passes hasUnsavedChanges=false to useDiscardGuard once the call step loads (pre-filled bookedSlot date is not dirty)', async () => {
    restoreFetch = mockFetch({ eventsItems: [] });

    renderModal();

    // Wait for the contact to load and the modal to enter the 'call' step.
    // The 'No answer' button is only rendered at step='call'.
    await waitFor(() => {
      expect(screen.getByTestId('av-outcome-no-answer')).toBeTruthy();
    });

    // All renders after the contact loads must pass hasUnsavedChanges=false.
    // step='call', madeProgress=false → hasUnsavedChanges=false.
    // The pre-filled bookedSlot (dayjs(nowDateTime())) must NOT count as dirty.
    const calls = vi.mocked(useDiscardGuard).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toBe(false);
  });

  it('passes hasUnsavedChanges=true once the user reaches the booked step', async () => {
    seedDraft();
    restoreFetch = mockFetch({ eventsItems: [] });

    renderModal();
    await waitForBookedStep();

    // step='booked' → hasUnsavedChanges=true
    const calls = vi.mocked(useDiscardGuard).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toBe(true);
  });
});

describe('ArrangeVisitModal — duplicate-visit guard', () => {
  let restoreFetch: () => void;
  let draftKey: string;

  beforeEach(() => {
    draftKey = seedDraft();
  });

  afterEach(() => {
    restoreFetch?.();
    sessionStorage.removeItem(draftKey);
    vi.restoreAllMocks();
  });

  it('Cancel existing — DELETE 500 keeps guard open, shows an error, and offers a retry button', async () => {
    restoreFetch = mockFetch({ eventsItems: [FUTURE_EVENT], deleteStatus: 500 });
    const user = userEvent.setup();

    renderModal();
    await waitForBookedStep();

    await user.click(screen.getByTestId('av-booked-confirm'));

    await waitFor(() => {
      expect(screen.getByText('Existing visit found')).toBeTruthy();
    });

    await user.click(screen.getByTestId('av-duplicate-cancel-existing'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    // Guard dialog must remain open (no ScheduleVisitModal mounted yet)
    expect(screen.queryByTestId('schedule-visit-modal')).toBeNull();

    // A "Try again" retry button should be present inside the error alert
    const retryBtn = screen.getByTestId('av-duplicate-cancel-existing-retry');
    expect(retryBtn).toBeTruthy();
    expect(retryBtn.textContent).toBe('Try again');

    // Clicking retry triggers another DELETE attempt; on continued failure the
    // guard stays open and the error remains visible
    await user.click(retryBtn);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
    expect(screen.queryByTestId('schedule-visit-modal')).toBeNull();
  });
});
