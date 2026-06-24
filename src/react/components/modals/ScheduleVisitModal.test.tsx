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

import { ScheduleVisitModal } from './ScheduleVisitModal';
import { SCHEDULE_VISIT_DRAFT_PREFIX } from '../../constants/localStorageKeys';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CTX = {
  contactId: 'c-30',
  contactName: 'Carol White',
  contactEmail: 'carol@example.com',
  contactPhone: '01234 567890',
  contactMobile: '07700 900002',
};

const HANDLER = { id: 7, type: 'schedule_visit', config: {} } as Parameters<typeof ScheduleVisitModal>[0]['handler'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderModal(onClose = vi.fn()) {
  return render(
    <ScheduleVisitModal
      handler={HANDLER}
      ctx={CTX}
      visitType="design"
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

describe('ScheduleVisitModal — discard guard: clean state closes immediately', () => {
  afterEach(() => {
    localStorage.removeItem(SCHEDULE_VISIT_DRAFT_PREFIX + CTX.contactId);
    vi.restoreAllMocks();
  });

  it('calls onClose directly when the form is in its initial untouched state', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    const dialog = screen.getByRole('dialog', { name: /schedule design visit for carol white/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
  });
});

describe('ScheduleVisitModal — discard guard: dirty state shows dialog', () => {
  afterEach(() => {
    localStorage.removeItem(SCHEDULE_VISIT_DRAFT_PREFIX + CTX.contactId);
    vi.restoreAllMocks();
  });

  it('shows the discard dialog after the notes field is edited', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/notes \(optional\)/i), 'Bring design samples');

    const dialog = screen.getByRole('dialog', { name: /schedule design visit for carol white/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));

    expect(await screen.findByRole('dialog', { name: /discard changes/i })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Keep editing" dismisses the discard dialog without closing the modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/notes \(optional\)/i), 'Some notes');

    const dialog = screen.getByRole('dialog', { name: /schedule design visit for carol white/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /keep editing/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /schedule design visit for carol white/i })).toBeTruthy();
  });

  it('"Discard changes" closes the modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByLabelText(/notes \(optional\)/i), 'Some notes');

    const dialog = screen.getByRole('dialog', { name: /schedule design visit for carol white/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /discard changes/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('ScheduleVisitModal — discard guard: isLocked suppresses prompt', () => {
  let restoreFetch: () => void;

  afterEach(() => {
    restoreFetch?.();
    localStorage.removeItem(SCHEDULE_VISIT_DRAFT_PREFIX + CTX.contactId);
    vi.restoreAllMocks();
  });

  it('disables the close button and shows no dialog while a schedule request is in flight', async () => {
    restoreFetch = mockFetchHang();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    // Edit the location to make the form dirty
    await user.type(screen.getByLabelText(/location \(optional\)/i), '10 Sample Street');

    // Click Schedule — fetch hangs → submitting=true → isLocked=true
    await user.click(screen.getByTestId('cah-primary'));

    // Wait for submitting state (primary button becomes disabled)
    await waitFor(() => {
      expect(screen.getByTestId('cah-primary')).toBeDisabled();
    });

    // Close button must be disabled while the modal is locked (disableClose=submitting)
    const dialog = screen.getByRole('dialog', { name: /schedule design visit for carol white/i });
    expect(within(dialog).getByRole('button', { name: /close/i })).toBeDisabled();

    // No discard dialog should have appeared
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
