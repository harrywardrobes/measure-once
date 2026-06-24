import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

/**
 * offlineQueue is dynamically imported inside doBook and handleOutcome.
 * Default implementation returns a successful response so existing tests are unaffected.
 * The isLocked test overrides this to hang so submitting=true can be observed.
 */
vi.mock('../../lib/offlineQueue', () => ({
  sendOrQueue: vi.fn(async () => ({ ok: true, queued: false, status: 200, data: {} })),
}));

import { ArrangeVisitModal } from './ArrangeVisitModal';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { useToastContext } from '../../contexts/ToastContext';
import { sendOrQueue } from '../../lib/offlineQueue';
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

    // Best-effort contact address PATCH used by doBook — always succeeds.
    if (url.includes('/api/contacts/') && method === 'PATCH') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
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

describe('ArrangeVisitModal — discard guard dialog behavior (real hook)', () => {
  let restoreFetch: () => void;

  beforeEach(async () => {
    sessionStorage.clear();
    // Use the real useDiscardGuard so dialog rendering can be tested end-to-end.
    const real = await vi.importActual<typeof import('../../hooks/useDiscardGuard')>('../../hooks/useDiscardGuard');
    vi.mocked(useDiscardGuard).mockImplementation(real.useDiscardGuard);
  });

  afterEach(() => {
    restoreFetch?.();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('calls onClose directly when the modal is in the untouched call step (clean state)', async () => {
    restoreFetch = mockFetch({ eventsItems: [] });
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ArrangeVisitModal
        handler={HANDLER}
        ctx={CTX}
        open
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('av-outcome-no-answer')).toBeTruthy();
    });

    // step='call', madeProgress=false → hasUnsavedChanges=false → X closes immediately
    const dialog = screen.getByRole('dialog');
    const closeBtn = within(dialog).getByRole('button', { name: /close/i });
    await user.click(closeBtn);

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
  });

  it('shows the discard dialog when the modal is at the booked step (dirty state)', async () => {
    seedDraft();
    restoreFetch = mockFetch({ eventsItems: [] });
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ArrangeVisitModal
        handler={HANDLER}
        ctx={CTX}
        open
        onClose={onClose}
      />,
    );

    await waitForBookedStep();

    // step='booked' → hasUnsavedChanges=true → X opens discard dialog
    const dialog = screen.getByRole('dialog');
    const closeBtn = within(dialog).getByRole('button', { name: /close/i });
    await user.click(closeBtn);

    expect(await screen.findByRole('dialog', { name: /discard changes/i })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Keep editing" dismisses the discard dialog and returns to the booked step', async () => {
    seedDraft();
    restoreFetch = mockFetch({ eventsItems: [] });
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ArrangeVisitModal
        handler={HANDLER}
        ctx={CTX}
        open
        onClose={onClose}
      />,
    );

    await waitForBookedStep();

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /keep editing/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('av-booked-confirm')).toBeTruthy();
  });

  it('"Discard changes" closes the modal from the booked step', async () => {
    seedDraft();
    restoreFetch = mockFetch({ eventsItems: [] });
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ArrangeVisitModal
        handler={HANDLER}
        ctx={CTX}
        open
        onClose={onClose}
      />,
    );

    await waitForBookedStep();

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /discard changes/i }));
    expect(onClose).toHaveBeenCalledOnce();
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

describe('ArrangeVisitModal — discard guard: isLocked suppresses prompt', () => {
  let restoreFetch: () => void;

  beforeEach(async () => {
    sessionStorage.clear();
    // Use the real useDiscardGuard so the guard state is genuine.
    const real = await vi.importActual<typeof import('../../hooks/useDiscardGuard')>('../../hooks/useDiscardGuard');
    vi.mocked(useDiscardGuard).mockImplementation(real.useDiscardGuard);
    // Make sendOrQueue hang so the modal stays in submitting=true indefinitely.
    vi.mocked(sendOrQueue).mockImplementation(async () => new Promise(() => { /* never resolves */ }));
  });

  afterEach(() => {
    restoreFetch?.();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('disables the close button and shows no dialog while a not-proceeding outcome submit is in flight', async () => {
    restoreFetch = mockFetch({ eventsItems: [] });
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ArrangeVisitModal
        handler={HANDLER}
        ctx={CTX}
        open
        onClose={onClose}
      />,
    );

    // Wait for the call step to load (madeProgress=false initially)
    await waitFor(() => {
      expect(screen.getByTestId('av-outcome-no-answer')).toBeTruthy();
    });

    // Click "Booked" to advance to the booked step — sets madeProgress=true
    await user.click(screen.getByTestId('av-outcome-booked'));

    // Click "Back" to return to the call step — madeProgress stays true
    // hasUnsavedChanges = (madeProgress && step === 'call') = true
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /back/i })).toBeTruthy();
    });
    await user.click(screen.getByRole('button', { name: /back/i }));

    // Back at call step with madeProgress=true; click "Not proceeding"
    // handleOutcome('not_proceeding') sets submitting=true then hangs on sendOrQueue
    await waitFor(() => {
      expect(screen.getByTestId('av-outcome-not-proceeding')).toBeTruthy();
    });
    await user.click(screen.getByTestId('av-outcome-not-proceeding'));

    // Close button must be disabled (disableClose=submitting) — locked state
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByRole('button', { name: /close/i })).toBeDisabled();
    });

    // No discard dialog should appear while locked
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables the close button and shows no dialog while a booking submit is in flight', async () => {
    seedDraft();
    restoreFetch = mockFetch({ eventsItems: [] });
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ArrangeVisitModal
        handler={HANDLER}
        ctx={CTX}
        open
        onClose={onClose}
      />,
    );

    await waitForBookedStep();

    // Click "Confirm booking" — doBook() sets submitting=true then hangs on sendOrQueue
    await user.click(screen.getByTestId('av-booked-confirm'));

    // Wait for submitting state: the modal becomes locked (disableClose=submitting)
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByRole('button', { name: /close/i })).toBeDisabled();
    });

    // No discard dialog should have appeared while locked
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('populates the email body from the local fallback when the pre-fetch fails and No answer is clicked', async () => {
    const orig = window.fetch;
    // The pre-fetch at mount and the per-click fetch both hit /api/email-templates/render.
    // Both should fail here so noAnswerTemplate stays null and buildNoAnswerEmail is used.
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
        return new Response(JSON.stringify({ error: 'Template service unavailable' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return orig(input, init);
    }) as typeof window.fetch;
    restoreFetch = () => { window.fetch = orig; };

    const user = userEvent.setup();

    render(
      <ArrangeVisitModal
        handler={HANDLER}
        ctx={CTX}
        open
        onClose={vi.fn()}
      />,
    );

    // Wait for the call step to load
    await waitFor(() => {
      expect(screen.getByTestId('av-outcome-no-answer')).toBeTruthy();
    });

    // Click "No answer" — noAnswerTemplate is null (pre-fetch failed), so
    // fetchEmailTemplate is called and falls back to buildNoAnswerEmail on 500
    await user.click(screen.getByTestId('av-outcome-no-answer'));

    // Wait for the email body field to appear (emailLoading=false after fallback resolves)
    const emailBodyField = await screen.findByRole('textbox', { name: /email body/i });

    // The fallback builds a non-empty body addressed to the contact's first name
    expect((emailBodyField as HTMLTextAreaElement).value).toMatch(/Hi John/);
    expect((emailBodyField as HTMLTextAreaElement).value.trim()).not.toBe('');

    // The subject is also populated by the fallback
    const subjectField = screen.getByRole('textbox', { name: /subject/i });
    expect((subjectField as HTMLInputElement).value).toMatch(/design visit/i);
  });

  it('disables the close button and shows no dialog while a No-answer email send is in flight', async () => {
    const orig = window.fetch;
    // Custom fetch: resolve contact-info and email-template quickly;
    // hang /api/emails/send so submitting=true can be observed.
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
        return new Response(JSON.stringify({
          subject: 'Test subject',
          body_text: 'Test email body — non-empty so the send guard passes.',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/api/emails/send') && method === 'POST') {
        // Never resolves — keeps submitting=true indefinitely.
        return new Promise<Response>(() => { /* intentionally hung */ });
      }

      return orig(input, init);
    }) as typeof window.fetch;
    restoreFetch = () => { window.fetch = orig; };

    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ArrangeVisitModal
        handler={HANDLER}
        ctx={CTX}
        open
        onClose={onClose}
      />,
    );

    // Wait for the call step to load
    await waitFor(() => {
      expect(screen.getByTestId('av-outcome-no-answer')).toBeTruthy();
    });

    // Click "No answer" — navigates to the email step (step='email', madeProgress=true)
    await user.click(screen.getByTestId('av-outcome-no-answer'));

    // Wait for the send button to become enabled (emailLoading=false after template fetch)
    await waitFor(() => {
      expect(screen.getByTestId('av-email-send')).not.toBeDisabled();
    });

    // Click "Send email" — handleEmailSent() sets submitting=true then hangs on /api/emails/send
    await user.click(screen.getByTestId('av-email-send'));

    // Close button must be disabled (disableClose=submitting) — locked state
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByRole('button', { name: /close/i })).toBeDisabled();
    });

    // No discard dialog should appear while locked
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ArrangeVisitModal — email step: full send flow after template failure', () => {
  let restoreFetch: () => void;

  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    restoreFetch?.();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('calls /api/emails/send with non-empty body and /api/card-actions/arrange-visit/outcome, then closes and toasts', async () => {
    const orig = window.fetch;

    const sendEmailCalls: { to: string; subject: string; body: string }[] = [];
    const outcomeCalls: { contactId: string; outcome: string }[] = [];

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
        return new Response(JSON.stringify({ error: 'Template service unavailable' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/api/emails/send') && method === 'POST') {
        const body = JSON.parse((init?.body as string) || '{}');
        sendEmailCalls.push(body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/api/card-actions/arrange-visit/outcome') && method === 'POST') {
        const body = JSON.parse((init?.body as string) || '{}');
        outcomeCalls.push(body);
        return new Response(JSON.stringify({ hs_lead_status: 'ATTEMPTED_TO_CONTACT', setsLeadStatus: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return orig(input, init);
    }) as typeof window.fetch;
    restoreFetch = () => { window.fetch = orig; };

    const showToast = vi.fn();
    vi.mocked(useToastContext).mockReturnValue({ showToast, showToastWithAction: vi.fn() });

    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <ArrangeVisitModal
        handler={HANDLER}
        ctx={CTX}
        open
        onClose={onClose}
      />,
    );

    // Wait for the call step
    await waitFor(() => {
      expect(screen.getByTestId('av-outcome-no-answer')).toBeTruthy();
    });

    // Click "No answer" — template fetch returns 500, fallback body is populated
    await user.click(screen.getByTestId('av-outcome-no-answer'));

    // Wait for the email body to appear with non-empty fallback content
    const emailBodyField = await screen.findByRole('textbox', { name: /email body/i });
    await waitFor(() => {
      expect((emailBodyField as HTMLTextAreaElement).value.trim()).not.toBe('');
    });

    // Wait for the "Send email" button to become enabled (emailLoading=false)
    await waitFor(() => {
      expect(screen.getByTestId('av-email-send')).not.toBeDisabled();
    });

    // Click "Send email" — should call /api/emails/send then /api/card-actions/arrange-visit/outcome
    await user.click(screen.getByTestId('av-email-send'));

    // /api/emails/send must have been called with a non-empty body
    await waitFor(() => {
      expect(sendEmailCalls.length).toBe(1);
      expect(sendEmailCalls[0].body.trim()).not.toBe('');
      expect(sendEmailCalls[0].to).toBe(CONTACT_INFO.contactEmail);
    });

    // /api/card-actions/arrange-visit/outcome must have been called
    await waitFor(() => {
      expect(outcomeCalls.length).toBe(1);
      expect(outcomeCalls[0].contactId).toBe(CTX.contactId);
    });

    // Modal closes and a success toast fires
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
      expect(showToast).toHaveBeenCalledOnce();
      expect(showToast.mock.calls[0][0]).toMatch(/email sent/i);
    });
  });
});
