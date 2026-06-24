import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('../../contexts/ToastContext', () => ({
  useToastContext: vi.fn(() => ({ showToast: vi.fn(), showToastWithAction: vi.fn() })),
  useToast: vi.fn(() => vi.fn()),
}));

vi.mock('../../context/ConnectionToastContext', () => ({
  openConnectModal: vi.fn(),
  useServiceStatuses: vi.fn(() => new Map()),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: vi.fn(() => ({ user: { name: 'Test User', email: 'test@example.com' } })),
}));

import { ContactCustomerModal } from './ContactCustomerModal';

const CONTACT_ID = 'c-42';
const CONTACT_DATA = {
  contactName: 'Jane Smith',
  contactEmail: 'jane@example.com',
  phone: '01234 567890',
  mobile: '07700 900000',
  leadStatus: 'NEW',
  lastAttemptAt: null,
  lastAttemptBy: null,
  callAttempted: false,
  emailSent: false,
  whatsappSent: false,
  attemptLog: [],
  historySessionCount: 0,
  historyTotalAttempts: 0,
  historyEverCalled: false,
  historyEverEmailed: false,
  historyEverWhatsapped: false,
  historyAttemptLog: [],
};

const EMAIL_TEMPLATE = { subject: 'Hello Jane', text: 'Dear Jane,\n\nWe look forward to hearing from you.', html: '<p>Dear Jane,</p>' };

function makeFetch(opts: {
  submitStatus?: number;
  submitHangs?: boolean;
  sendEmailHangs?: boolean;
  emailPreviewHangs?: boolean;
} = {}) {
  const { submitStatus = 200, submitHangs = false, sendEmailHangs = false, emailPreviewHangs = false } = opts;
  const orig = window.fetch;
  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method = (init?.method || 'GET').toUpperCase();

    // Initial contact data load — body has contactId, URL is the base path
    if (url.endsWith('/api/card-actions/contact-customer') && method === 'POST') {
      return new Response(JSON.stringify(CONTACT_DATA), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Email template fetch (initial) and preview refetch
    if (url.includes('/email-preview') && method === 'POST') {
      if (emailPreviewHangs) return new Promise(() => {});
      return new Response(JSON.stringify(EMAIL_TEMPLATE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/attempts') && method === 'POST') {
      if (submitHangs) return new Promise(() => {});
      return new Response(JSON.stringify({ ok: true, message: 'Logged' }), {
        status: submitStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/send-email') && method === 'POST') {
      if (sendEmailHangs) return new Promise(() => {});
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/advance-status') && method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return orig(input, init);
  }) as typeof window.fetch;
  return () => { window.fetch = orig; };
}

async function waitForContactStep() {
  await waitFor(() => {
    expect(screen.getByTestId('cc-done')).toBeTruthy();
  });
}

function renderModal(onClose = vi.fn()) {
  return render(
    <ContactCustomerModal
      contactId={CONTACT_ID}
      contactName="Jane Smith"
      contactEmail="jane@example.com"
      onClose={onClose}
    />,
  );
}

describe('ContactCustomerModal — discard guard (real behavior)', () => {
  let restoreFetch: () => void;

  beforeEach(() => { /* no mock setup needed — testing real hook */ });

  afterEach(() => {
    restoreFetch?.();
    vi.restoreAllMocks();
  });

  it('closes immediately (onClose called) when no note panel is open (clean state)', async () => {
    restoreFetch = makeFetch();
    const onClose = vi.fn();
    renderModal(onClose);
    await waitForContactStep();

    const mainDialog = screen.getByRole('dialog', { name: /contact jane smith/i });
    const closeBtn = within(mainDialog).getByRole('button', { name: /close/i });
    await userEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByText(/discard changes/i)).toBeNull();
  });

  it('shows the discard dialog when a call note has been typed', async () => {
    restoreFetch = makeFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await waitForContactStep();

    await user.click(screen.getByTestId('contact-method-call-btn'));
    const textarea = await screen.findByPlaceholderText(/Add a note about this attempt/i);
    await user.type(textarea, 'Called, no answer');

    const mainDialog = screen.getByRole('dialog', { name: /contact jane smith/i });
    const closeBtn = within(mainDialog).getByRole('button', { name: /close/i });
    await user.click(closeBtn);

    expect(await screen.findByRole('dialog', { name: /discard changes/i })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Keep editing" dismisses the discard dialog without closing the modal', async () => {
    restoreFetch = makeFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await waitForContactStep();

    await user.click(screen.getByTestId('contact-method-call-btn'));
    const textarea = await screen.findByPlaceholderText(/Add a note about this attempt/i);
    await user.type(textarea, 'Called, no answer');

    const mainDialog = screen.getByRole('dialog', { name: /contact jane smith/i });
    await user.click(within(mainDialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /keep editing/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('cc-done')).toBeTruthy();
  });

  it('"Discard changes" closes the modal', async () => {
    restoreFetch = makeFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await waitForContactStep();

    await user.click(screen.getByTestId('contact-method-call-btn'));
    const textarea = await screen.findByPlaceholderText(/Add a note about this attempt/i);
    await user.type(textarea, 'Called, no answer');

    const mainDialog = screen.getByRole('dialog', { name: /contact jane smith/i });
    await user.click(within(mainDialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /discard changes/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does NOT show the discard dialog when email panel opens but user has not typed anything', async () => {
    restoreFetch = makeFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await waitForContactStep();

    // Open the email panel
    await user.click(screen.getByTestId('contact-method-email-btn'));

    // Wait for template values to populate (confirms fetch is complete)
    const subjectInput = await screen.findByRole('textbox', { name: /subject/i });
    await waitFor(() => {
      expect((subjectInput as HTMLInputElement).value).toBe(EMAIL_TEMPLATE.subject);
    });

    // Click X immediately — template content is NOT a user edit
    const mainDialog = screen.getByRole('dialog', { name: /contact jane smith/i });
    await user.click(within(mainDialog).getByRole('button', { name: /close/i }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
  });

  it('shows the discard dialog when the user has typed in the email subject', async () => {
    restoreFetch = makeFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await waitForContactStep();

    // Open the email panel and wait for template to load
    await user.click(screen.getByTestId('contact-method-email-btn'));
    const subjectInput = await screen.findByRole('textbox', { name: /subject/i });
    await waitFor(() => {
      expect((subjectInput as HTMLInputElement).value).toBe(EMAIL_TEMPLATE.subject);
    });

    // Type in the subject — this is a genuine user edit
    await user.clear(subjectInput);
    await user.type(subjectInput, 'My custom subject');

    const mainDialog = screen.getByRole('dialog', { name: /contact jane smith/i });
    await user.click(within(mainDialog).getByRole('button', { name: /close/i }));

    expect(await screen.findByRole('dialog', { name: /discard changes/i })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('skips the discard dialog while an email send is in flight (isLocked=true)', async () => {
    // emailFlow === 'sending' → isLocked=true → hasUnsavedChanges=false → no dialog
    restoreFetch = makeFetch({ sendEmailHangs: true });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await waitForContactStep();

    // Open email flow and wait for template values to populate
    await user.click(screen.getByTestId('contact-method-email-btn'));
    const subjectInput = await screen.findByRole('textbox', { name: /subject/i });
    await waitFor(() => {
      expect((subjectInput as HTMLInputElement).value).toBe(EMAIL_TEMPLATE.subject);
    });

    // Edit subject so changes are dirty, then click Send (now enabled)
    await user.clear(subjectInput);
    await user.type(subjectInput, 'Edited subject');

    // Send → emailFlow transitions to 'sending' (fetch hangs), isLocked=true
    await user.click(screen.getByTestId('email-preview-send-btn'));

    // Wait for sending state to flush (send button becomes disabled)
    await waitFor(() => {
      expect(screen.getByTestId('email-preview-send-btn')).toBeDisabled();
    });

    // While sending, handleRequestClose returns early (isLocked=true) — no dialog,
    // no close. disableClose only covers phase==='advancing' and emailPreviewLoading,
    // so the button stays enabled but the guard silently swallows the request.
    const mainDialog = screen.getByRole('dialog', { name: /contact jane smith/i });
    await user.click(within(mainDialog).getByRole('button', { name: /close/i }));

    // Modal stays open — neither onClose called nor discard dialog shown
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
  });

  it('disables the close button while the email template is still loading (emailPreviewLoading)', async () => {
    // The email-preview fetch hangs so emailPreviewLoading stays true.
    // disableClose=(emailFlow !== 'idle' && emailPreviewLoading) → close button disabled.
    restoreFetch = makeFetch({ emailPreviewHangs: true });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await waitForContactStep();

    // Open email flow — template fetch starts but never resolves
    await user.click(screen.getByTestId('contact-method-email-btn'));

    // The subject input should not yet have the template value (fetch is hanging)
    // Wait briefly to confirm the loading state is active
    const mainDialog = screen.getByRole('dialog', { name: /contact jane smith/i });
    const closeBtn = within(mainDialog).getByRole('button', { name: /close/i });

    // Close button must be disabled while the template fetch is in-flight
    await waitFor(() => {
      expect(closeBtn).toBeDisabled();
    });

    // onClose must not have been called and no discard dialog should appear
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
  });

  it('still shows discard dialog after an email edit followed by a preview refresh', async () => {
    restoreFetch = makeFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await waitForContactStep();

    // Open email flow
    await user.click(screen.getByTestId('contact-method-email-btn'));

    // Wait for template to load (MUI TextField renders an <input> via role=textbox)
    const subjectInput = await screen.findByRole('textbox', { name: /subject/i });
    await waitFor(() => {
      expect((subjectInput as HTMLInputElement).value).toBe(EMAIL_TEMPLATE.subject);
    });

    // Edit the subject — this makes email dirty vs. the template baseline
    await user.clear(subjectInput);
    await user.type(subjectInput, 'Updated subject line');

    // Toggle to preview mode — triggers refetchEmailHtml which used to
    // overwrite emailFetchedSubject/Body (falsely clearing dirty state)
    await user.click(screen.getByTestId('email-html-preview-toggle'));

    // Wait for the preview refetch to settle
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).toBeNull();
    }, { timeout: 3000 });

    // Closing should still prompt — edit vs. template baseline is unchanged
    const mainDialog = screen.getByRole('dialog', { name: /contact jane smith/i });
    await user.click(within(mainDialog).getByRole('button', { name: /close/i }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /discard changes/i })).toBeTruthy();
  });

  it('auto-closes after Done without showing the discard dialog', async () => {
    restoreFetch = makeFetch();
    const onClose = vi.fn();
    renderModal(onClose);
    await waitForContactStep();

    await act(async () => {
      screen.getByTestId('cc-done').click();
    });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    }, { timeout: 3000 });

    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
  });
});
