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

/**
 * PlacesLocationField requires a Google Maps JS API key.  Stub it so guard
 * tests can focus solely on the guard logic without a real browser Maps embed.
 */
vi.mock('../PlacesLocationField', () => ({
  PlacesLocationField: vi.fn(
    ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => (
      <input
        aria-label={label}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    ),
  ),
}));

import { GenericVisitEditModal } from './GenericVisitEditModal';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_PROPS = {
  mode: 'create' as const,
  visitType: 'design',
  contactId: 'c-20',
  contactName: 'Alice Green',
  open: true,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderModal(onClose = vi.fn(), extraProps: Partial<typeof BASE_PROPS> = {}) {
  return render(
    <GenericVisitEditModal
      {...BASE_PROPS}
      {...extraProps}
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

describe('GenericVisitEditModal — discard guard: clean state closes immediately', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onClose directly when no fields have been changed (create mode, untouched)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    const dialog = screen.getByRole('dialog', { name: /schedule design visit for alice green/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
  });
});

describe('GenericVisitEditModal — discard guard: dirty state shows dialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the discard dialog when the notes field has been edited', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByRole('textbox', { name: /notes/i }), 'Bring samples');

    const dialog = screen.getByRole('dialog', { name: /schedule design visit for alice green/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));

    expect(await screen.findByRole('dialog', { name: /discard changes/i })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Keep editing" dismisses the discard dialog without closing the modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByRole('textbox', { name: /notes/i }), 'Notes text');

    const dialog = screen.getByRole('dialog', { name: /schedule design visit for alice green/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /keep editing/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /schedule design visit for alice green/i })).toBeTruthy();
  });

  it('"Discard changes" closes the modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.type(screen.getByRole('textbox', { name: /notes/i }), 'Notes text');

    const dialog = screen.getByRole('dialog', { name: /schedule design visit for alice green/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /discard changes/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('GenericVisitEditModal — discard guard: isLocked suppresses prompt', () => {
  let restoreFetch: () => void;

  afterEach(() => {
    restoreFetch?.();
    vi.restoreAllMocks();
  });

  it('disables the close button and shows no dialog while a submit is in flight', async () => {
    restoreFetch = mockFetchHang();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    // Make the form dirty by editing the title
    const titleInput = screen.getByRole('textbox', { name: /title/i });
    await user.clear(titleInput);
    await user.type(titleInput, 'Custom visit title');

    // Click Schedule — fetch hangs → submitting=true → isLocked=true
    await user.click(screen.getByTestId('generic-visit-save'));

    // Wait for submitting state (primary button becomes disabled)
    await waitFor(() => {
      expect(screen.getByTestId('generic-visit-save')).toBeDisabled();
    });

    // Close button must be disabled while the modal is locked (disableClose=submitting)
    const dialog = screen.getByRole('dialog', { name: /schedule design visit for alice green/i });
    expect(within(dialog).getByRole('button', { name: /close/i })).toBeDisabled();

    // No discard dialog should have appeared
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
