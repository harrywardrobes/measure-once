import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../contexts/ToastContext', () => ({
  useToast: vi.fn(() => vi.fn()),
}));

vi.mock('../../context/ConnectionToastContext', () => ({
  openConnectModal: vi.fn(),
  useServiceStatuses: vi.fn(() => new Map()),
}));

import { PhoneSummaryModal } from './PhoneSummaryModal';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CTX = {
  contactId: 'c-10',
  contactName: 'Bob Jones',
  contactEmail: 'bob@example.com',
  contactPhone: '01234 567890',
  contactMobile: '07700 900001',
};

const HANDLER = { id: 3, type: 'phone_call_summary', config: {} } as Parameters<typeof PhoneSummaryModal>[0]['handler'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderModal(onClose = vi.fn()) {
  return render(
    <PhoneSummaryModal
      handler={HANDLER}
      ctx={CTX}
      open
      onClose={onClose}
    />,
  );
}

function mockFetchHang(): () => void {
  const orig = window.fetch;
  window.fetch = vi.fn(async () => new Promise(() => { /* never resolves */ })) as typeof window.fetch;
  return () => { window.fetch = orig; };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PhoneSummaryModal — discard guard: clean state closes immediately', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onClose directly when the summary field is empty', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    const dialog = screen.getByRole('dialog', { name: /phone call summary/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
  });
});

describe('PhoneSummaryModal — discard guard: dirty state shows dialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the discard dialog when the summary has text', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/what did you discuss/i), 'Called, discussed the kitchen plans');

    const dialog = screen.getByRole('dialog', { name: /phone call summary/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));

    expect(await screen.findByRole('dialog', { name: /discard changes/i })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Keep editing" dismisses the discard dialog without closing the modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/what did you discuss/i), 'Some notes');

    const dialog = screen.getByRole('dialog', { name: /phone call summary/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /keep editing/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /phone call summary/i })).toBeTruthy();
  });

  it('"Discard changes" closes the modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/what did you discuss/i), 'Some notes');

    const dialog = screen.getByRole('dialog', { name: /phone call summary/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /discard changes/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('PhoneSummaryModal — discard guard: isLocked suppresses prompt', () => {
  let restoreFetch: () => void;

  afterEach(() => {
    restoreFetch?.();
    vi.restoreAllMocks();
  });

  it('disables the close button and shows no dialog while a save is in flight', async () => {
    restoreFetch = mockFetchHang();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/what did you discuss/i), 'In-flight note');

    // Click Save note — fetch hangs → submitting=true → isLocked=true
    await user.click(screen.getByTestId('cah-primary'));

    // Wait for submitting state (primary button becomes disabled)
    await waitFor(() => {
      expect(screen.getByTestId('cah-primary')).toBeDisabled();
    });

    // Close button must be disabled while the modal is locked (disableClose=submitting)
    const dialog = screen.getByRole('dialog', { name: /phone call summary/i });
    expect(within(dialog).getByRole('button', { name: /close/i })).toBeDisabled();

    // No discard dialog should have appeared
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
