import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../contexts/ToastContext', () => ({
  useToast: vi.fn(() => vi.fn()),
}));

vi.mock('../../contexts/ConnectionToastContext', () => ({
  openConnectModal: vi.fn(),
  useServiceStatuses: vi.fn(() => new Map()),
}));

/**
 * PaymentHistory fetches QB payment data independently. Stub it out so the
 * guard tests focus on the modal's own guard logic. The stub never calls
 * onPaidStateChange, so `isPaid` stays null (falsy) and all QB-gated buttons
 * remain in their default enabled state.
 */
vi.mock('../PaymentHistory', () => ({
  PaymentHistory: vi.fn(() => null),
}));

/**
 * dispatchCardActionHandler opens sibling modals (arrange survey, log call,
 * etc.). Stub it so hub-button clicks don't throw in the test environment.
 */
vi.mock('../../utils/dispatchCardActionHandler', () => ({
  dispatchCardActionHandler: vi.fn(),
}));

import { DepositInvoiceModal } from './DepositInvoiceModal';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CTX = {
  contactId: 'contact-77',
  contactName: 'Alice Brown',
  contactEmail: 'alice@example.com',
  contactPhone: '01234 567890',
  contactMobile: '07700 900000',
};

const HANDLER = { id: 5, type: 'deposit_invoice_followup' };

const LOADER_DATA = {
  contactName: 'Alice Brown',
  contactEmail: 'alice@example.com',
  contactPhone: '01234 567890',
  contactMobile: '07700 900000',
  contactAddress: '1 Main Street, London',
  qbConnected: true,
  invoiceId: 'inv-123',
  invoiceDocNum: '1001',
  invoiceTotalAmt: 5000,
  invoiceBalance: 5000,
  invoiceTxnDate: '2025-01-01',
  invoiceLink: 'https://example.com/invoice',
  qbEstimateId: 'est-456',
};

const REMINDER_TEMPLATE = {
  subject: 'Payment reminder for your deposit invoice',
  body_text: 'Dear Alice,\n\nThis is a reminder about your outstanding deposit invoice.\n\nKind regards',
};

// ── Fetch mock ────────────────────────────────────────────────────────────────

function mockFetch(opts: {
  reminderSendHangs?: boolean;
} = {}): () => void {
  const orig = window.fetch;

  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method = (init?.method || 'GET').toUpperCase();

    if (url.includes('/api/card-actions/deposit-invoice') && method === 'POST'
        && !url.includes('/resend') && !url.includes('/not-proceeding')) {
      return new Response(JSON.stringify(LOADER_DATA), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/api/email-templates/render') && method === 'POST') {
      return new Response(JSON.stringify(REMINDER_TEMPLATE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/api/emails/send') && method === 'POST') {
      if (opts.reminderSendHangs) return new Promise(() => { /* never resolves */ });
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

function renderModal(onClose = vi.fn()) {
  return render(
    <DepositInvoiceModal
      handler={HANDLER as Parameters<typeof DepositInvoiceModal>[0]['handler']}
      ctx={CTX as Parameters<typeof DepositInvoiceModal>[0]['ctx']}
      open
      onClose={onClose}
    />,
  );
}

/** Wait until the hub step action buttons are visible (loader resolved). */
async function waitForHub() {
  await waitFor(() => {
    expect(screen.getByText('Send payment reminder')).toBeTruthy();
  });
}

/** Navigate to the reminder step and wait for the template to load. */
async function navigateToReminderWithContent(user: ReturnType<typeof userEvent.setup>) {
  await waitForHub();
  await user.click(screen.getByText('Send payment reminder'));
  // Wait for template to load: body textarea becomes non-empty
  await waitFor(() => {
    const bodyField = screen.getByRole('textbox', { name: 'Body' });
    expect((bodyField as HTMLTextAreaElement).value).not.toBe('');
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DepositInvoiceModal — discard guard: reminder body triggers dialog', () => {
  let restoreFetch: () => void;

  afterEach(() => {
    restoreFetch?.();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows the discard dialog when the reminder step has a non-empty body', async () => {
    restoreFetch = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderModal(onClose);
    await navigateToReminderWithContent(user);

    // reminderBody is non-empty → hasUnsavedChanges=true → X should open discard dialog
    const dialog = screen.getByRole('dialog', { name: 'Send payment reminder' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(await screen.findByRole('dialog', { name: 'Discard changes?' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Keep editing" dismisses the discard dialog and returns to the reminder step', async () => {
    restoreFetch = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderModal(onClose);
    await navigateToReminderWithContent(user);

    const dialog = screen.getByRole('dialog', { name: 'Send payment reminder' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await screen.findByRole('dialog', { name: 'Discard changes?' });

    await user.click(screen.getByRole('button', { name: /keep editing/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    // Modal still open — reminder heading still present
    expect(screen.getByRole('dialog', { name: 'Send payment reminder' })).toBeTruthy();
  });

  it('"Discard changes" closes the modal', async () => {
    restoreFetch = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderModal(onClose);
    await navigateToReminderWithContent(user);

    const dialog = screen.getByRole('dialog', { name: 'Send payment reminder' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await screen.findByRole('dialog', { name: 'Discard changes?' });

    await user.click(screen.getByRole('button', { name: /discard changes/i }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('DepositInvoiceModal — discard guard: hub and done close immediately', () => {
  let restoreFetch: () => void;

  afterEach(() => {
    restoreFetch?.();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('hub step X closes immediately without showing the discard dialog', async () => {
    restoreFetch = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderModal(onClose);
    await waitForHub();

    // On the hub step hasUnsavedChanges=false, so X should call onClose directly.
    // getAllByRole returns [X button, footer Close] — X is first (header before footer).
    const dialog = screen.getByRole('dialog', { name: 'Deposit invoice follow-up' });
    const closeBtns = within(dialog).getAllByRole('button', { name: 'Close' });
    await user.click(closeBtns[0]);

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
  });

  it('done step X closes immediately without showing the discard dialog', async () => {
    // Freeze the auto-close timer so it does not fire during the test
    vi.useFakeTimers({ shouldAdvanceTime: true });
    restoreFetch = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    renderModal(onClose);
    await navigateToReminderWithContent(user);

    // Send reminder successfully → component transitions to done
    await user.click(screen.getByRole('button', { name: 'Send Reminder' }));

    // Wait for done step — identified by the done message set in handleSendReminder
    await waitFor(() => {
      expect(screen.getByText('Payment reminder sent.')).toBeTruthy();
    });

    // Verify no auto-close has fired yet (timer frozen)
    expect(onClose).not.toHaveBeenCalled();

    // On the done step hasUnsavedChanges=false → X should close immediately.
    // getAllByRole returns [X button, footer Close] — X is first (header before footer).
    const doneDialog = screen.getByRole('dialog', { name: 'Done' });
    const closeBtns = within(doneDialog).getAllByRole('button', { name: 'Close' });
    await user.click(closeBtns[0]);

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
  });
});

describe('DepositInvoiceModal — discard guard: isLocked suppresses prompt', () => {
  let restoreFetch: () => void;

  afterEach(() => {
    restoreFetch?.();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('does not show the discard dialog when submitting (reminder_submitting step)', async () => {
    restoreFetch = mockFetch({ reminderSendHangs: true });
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderModal(onClose);
    await navigateToReminderWithContent(user);

    // Trigger send — navigateTo('reminder_submitting') is called synchronously,
    // then the email fetch hangs → component stays at reminder_submitting
    await user.click(screen.getByRole('button', { name: 'Send Reminder' }));

    // Wait for reminder_submitting step (spinner shown, Send Reminder gone)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Send Reminder' })).toBeNull();
    });

    // No discard dialog should have appeared; isLocked=true suppresses it
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
