import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../contexts/ToastContext', () => ({
  useToast: vi.fn(() => vi.fn()),
}));

/**
 * ScheduleVisitModal is a heavyweight component (MUI date pickers, calendar
 * API wiring). Mock it so the DVF guard tests stay focused on the guard logic.
 * Renders a data-testid that varies by whether existingEventId is set, so the
 * two ScheduleVisitModal instances can be told apart in assertions.
 */
vi.mock('./ScheduleVisitModal', () => ({
  ScheduleVisitModal: vi.fn(({ open, existingEventId }: { open: boolean; existingEventId?: string }) =>
    open
      ? <div data-testid={existingEventId ? 'reschedule-visit-modal' : 'schedule-visit-modal'} />
      : null,
  ),
}));

import { DesignVisitFollowupModal } from './DesignVisitFollowupModal';
import { ScheduleVisitModal } from './ScheduleVisitModal';

const mockScheduleVisitModal = ScheduleVisitModal as ReturnType<typeof vi.fn>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FUTURE_DT = new Date(Date.now() + 7 * 86400000).toISOString();

const FUTURE_EVENT = {
  id: 'event-abc',
  summary: 'Design visit — Jane Smith',
  start: { dateTime: FUTURE_DT },
};

const CONTACT_INFO = {
  contactName: 'Jane Smith',
  contactEmail: 'jane@example.com',
  phone: '01234 567890',
  mobile: '07700 123456',
  leadStatus: null,
  contactAddress: '1 High Street, London',
};

const CTX = {
  contactId: 'contact-42',
  contactName: 'Jane Smith',
  contactEmail: 'jane@example.com',
};

const HANDLER = { id: 1, type: 'design_visit_followup' };

// ── Fetch mock ────────────────────────────────────────────────────────────────

function mockFetch(opts: {
  eventsItems?: object[];
  deleteStatus?: number;
  emailSendStatus?: number;
  outcomeStatus?: number;
}): () => void {
  const orig = window.fetch;
  const { eventsItems = [], deleteStatus = 200, emailSendStatus = 200, outcomeStatus = 200 } = opts;

  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method = (init?.method || 'GET').toUpperCase();

    if (url.includes('/api/card-actions/design-visit-followup') && !url.includes('outcome') && method === 'POST') {
      return new Response(JSON.stringify(CONTACT_INFO), {
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

    if (url.includes('/api/emails/send') && method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), {
        status: emailSendStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/api/card-actions/design-visit-followup/outcome') && method === 'POST') {
      return new Response(JSON.stringify({}), {
        status: outcomeStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return orig(input, init);
  }) as typeof window.fetch;

  return () => { window.fetch = orig; };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderModal() {
  return render(
    <DesignVisitFollowupModal
      handler={HANDLER}
      ctx={CTX}
      open
      onClose={vi.fn()}
    />,
  );
}

/** Wait until the "hub" step buttons appear (loading has resolved). */
async function waitForHub() {
  await waitFor(() => {
    expect(screen.getByTestId('dvf-confirmed')).toBeTruthy();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DesignVisitFollowupModal — duplicate-visit guard', () => {
  let restoreFetch: () => void;

  beforeEach(() => {
    mockScheduleVisitModal.mockClear();
  });

  afterEach(() => {
    restoreFetch?.();
    vi.restoreAllMocks();
  });

  it('shows "Existing visit found" dialog when a future event exists', async () => {
    restoreFetch = mockFetch({ eventsItems: [FUTURE_EVENT] });
    const user = userEvent.setup();

    renderModal();
    await waitForHub();

    await user.click(screen.getByTestId('dvf-confirmed'));

    await waitFor(() => {
      expect(screen.getByText('Existing visit found')).toBeTruthy();
    });
  });

  it('Book both — dismisses guard and opens ScheduleVisitModal for a new booking', async () => {
    restoreFetch = mockFetch({ eventsItems: [FUTURE_EVENT] });
    const user = userEvent.setup();

    renderModal();
    await waitForHub();

    await user.click(screen.getByTestId('dvf-confirmed'));
    await waitFor(() => { expect(screen.getByText('Existing visit found')).toBeTruthy(); });

    await user.click(screen.getByTestId('dvf-duplicate-book-both'));

    await waitFor(() => {
      expect(screen.getByTestId('schedule-visit-modal')).toBeTruthy();
    });
  });

  it('Cancel existing — calls DELETE /api/events/:id then opens ScheduleVisitModal', async () => {
    restoreFetch = mockFetch({ eventsItems: [FUTURE_EVENT] });
    const user = userEvent.setup();

    renderModal();
    await waitForHub();

    await user.click(screen.getByTestId('dvf-confirmed'));
    await waitFor(() => { expect(screen.getByText('Existing visit found')).toBeTruthy(); });

    await user.click(screen.getByTestId('dvf-duplicate-cancel-existing'));

    await waitFor(() => {
      const fetchMock = window.fetch as ReturnType<typeof vi.fn>;
      const deleteCall = fetchMock.mock.calls.find(([inp, ini]) => {
        const url = typeof inp === 'string' ? inp : (inp as Request).url;
        const method = ((ini as RequestInit | undefined)?.method || 'GET').toUpperCase();
        return url.includes(`/api/events/${FUTURE_EVENT.id}`) && method === 'DELETE';
      });
      expect(deleteCall).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByTestId('schedule-visit-modal')).toBeTruthy();
    });
  });

  it('Cancel existing — DELETE 500 keeps guard open, shows an error message, and offers a retry button', async () => {
    restoreFetch = mockFetch({ eventsItems: [FUTURE_EVENT], deleteStatus: 500 });
    const user = userEvent.setup();

    renderModal();
    await waitForHub();

    await user.click(screen.getByTestId('dvf-confirmed'));
    await waitFor(() => { expect(screen.getByText('Existing visit found')).toBeTruthy(); });

    await user.click(screen.getByTestId('dvf-duplicate-cancel-existing'));

    await waitFor(() => {
      expect(screen.queryByTestId('schedule-visit-modal')).toBeNull();
    });

    await waitFor(() => {
      expect(screen.getByText('Existing visit found')).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    // A "Try again" retry button should be present inside the error alert
    const retryBtn = screen.getByTestId('dvf-duplicate-cancel-existing-retry');
    expect(retryBtn).toBeTruthy();
    expect(retryBtn.textContent).toBe('Try again');

    // Clicking retry triggers a new DELETE attempt; on continued failure the
    // guard stays open and the error remains visible
    await user.click(retryBtn);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
    expect(screen.queryByTestId('schedule-visit-modal')).toBeNull();
  });

  it('Reschedule existing — opens a second ScheduleVisitModal pre-populated with the existing event', async () => {
    restoreFetch = mockFetch({ eventsItems: [FUTURE_EVENT] });
    const user = userEvent.setup();

    renderModal();
    await waitForHub();

    await user.click(screen.getByTestId('dvf-confirmed'));
    await waitFor(() => { expect(screen.getByText('Existing visit found')).toBeTruthy(); });

    await user.click(screen.getByTestId('dvf-duplicate-reschedule'));

    await waitFor(() => {
      expect(screen.getByTestId('reschedule-visit-modal')).toBeTruthy();
    });

    const calls: Array<Record<string, unknown>> = mockScheduleVisitModal.mock.calls.map(c => c[0] as Record<string, unknown>);
    const rescheduleCall = calls.find(p => p['existingEventId'] === FUTURE_EVENT.id);
    expect(rescheduleCall).toBeTruthy();
    expect(rescheduleCall!['initialStartDt']).toBe(FUTURE_DT);
  });
});

// ── Modal title personalisation ───────────────────────────────────────────────

describe('DesignVisitFollowupModal — modal title', () => {
  let restoreFetch: () => void;

  afterEach(() => {
    restoreFetch?.();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shows "Follow up with [Name]" immediately on open, before the API response arrives', () => {
    const orig = window.fetch;
    window.fetch = vi.fn(() => new Promise(() => { /* never resolves */ })) as typeof window.fetch;
    restoreFetch = () => { window.fetch = orig; };

    render(
      <DesignVisitFollowupModal
        handler={HANDLER}
        ctx={CTX}
        open
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Follow up with Jane Smith' })).toBeTruthy();
  });

  it('shows the fallback "Design visit follow-up" title when ctx.contactName is absent', () => {
    const orig = window.fetch;
    window.fetch = vi.fn(() => new Promise(() => { /* never resolves */ })) as typeof window.fetch;
    restoreFetch = () => { window.fetch = orig; };

    const ctxWithoutName = { contactId: 'contact-42', contactEmail: 'jane@example.com' };

    render(
      <DesignVisitFollowupModal
        handler={HANDLER}
        ctx={ctxWithoutName as typeof CTX}
        open
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Design visit follow-up' })).toBeTruthy();
  });

  it('shows "Resend design visit invite" when the resend step is active', async () => {
    restoreFetch = mockFetch({ eventsItems: [] });
    const user = userEvent.setup();

    renderModal();
    await waitForHub();

    await user.click(screen.getByTestId('dvf-resend'));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Resend design visit invite' })).toBeTruthy();
    });
  });

  it('shows "Done" as the modal title after the resend flow completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    restoreFetch = mockFetch({ eventsItems: [] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    renderModal();
    await waitForHub();

    await user.click(screen.getByTestId('dvf-resend'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Resend design visit invite' })).toBeTruthy();
    });

    await user.click(screen.getByTestId('dvf-send-invite'));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Done' })).toBeTruthy();
    });
  });

  it('stays on "Resend design visit invite" and shows an error when the email send fails', async () => {
    restoreFetch = mockFetch({ eventsItems: [], emailSendStatus: 500 });
    const user = userEvent.setup();

    renderModal();
    await waitForHub();

    await user.click(screen.getByTestId('dvf-resend'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Resend design visit invite' })).toBeTruthy();
    });

    await user.click(screen.getByTestId('dvf-send-invite'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    expect(screen.getByRole('heading', { name: 'Resend design visit invite' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Done' })).toBeNull();
  });

  it('clears the error alert as soon as the user edits the subject field', async () => {
    restoreFetch = mockFetch({ eventsItems: [], emailSendStatus: 500 });
    const user = userEvent.setup();

    renderModal();
    await waitForHub();

    await user.click(screen.getByTestId('dvf-resend'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Resend design visit invite' })).toBeTruthy();
    });

    await user.click(screen.getByTestId('dvf-send-invite'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    await user.type(screen.getByRole('textbox', { name: 'Subject' }), 'x');

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears the error alert as soon as the user edits the body field', async () => {
    restoreFetch = mockFetch({ eventsItems: [], emailSendStatus: 500 });
    const user = userEvent.setup();

    renderModal();
    await waitForHub();

    await user.click(screen.getByTestId('dvf-resend'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Resend design visit invite' })).toBeTruthy();
    });

    await user.click(screen.getByTestId('dvf-send-invite'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    await user.type(screen.getByRole('textbox', { name: 'Body' }), 'x');

    expect(screen.queryByRole('alert')).toBeNull();
  });
});
