import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import type { Visit } from '../../pages/customer-detail/types';

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

/**
 * The edit-mode submit path uses a dynamic import of offlineQueue.
 * Mock it here so sendOrQueue is controllable in tests.
 */
vi.mock('../../lib/offlineQueue', () => ({
  sendOrQueue: vi.fn(async () => new Promise(() => { /* never resolves — used for isLocked tests */ })),
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

const VISIT_FIXTURE: Visit = {
  id: 42,
  type: 'design',
  title: 'Design visit — Alice Green',
  startAt: '2026-07-01T10:00:00.000Z',
  endAt: '2026-07-01T12:00:00.000Z',
  customerId: 'c-20',
  customerName: 'Alice Green',
  location: '10 High Street',
  notes: 'Bring tile samples',
  googleEventId: 'gcal-event-abc',
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

function renderEditModal(onClose = vi.fn(), visitOverrides: Partial<Visit> = {}) {
  return render(
    <GenericVisitEditModal
      mode="edit"
      visit={{ ...VISIT_FIXTURE, ...visitOverrides }}
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

// ── Edit-mode guard tests ──────────────────────────────────────────────────────

describe('GenericVisitEditModal — edit mode, discard guard: clean state closes immediately', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onClose directly when no fields have been changed (edit mode, untouched)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderEditModal(onClose);

    const dialog = screen.getByRole('dialog', { name: /edit design visit for alice green/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
  });
});

describe('GenericVisitEditModal — edit mode, discard guard: dirty state shows dialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the discard dialog when the title has been edited', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderEditModal(onClose);

    const titleInput = screen.getByRole('textbox', { name: /title/i });
    await user.clear(titleInput);
    await user.type(titleInput, 'Updated visit title');

    const dialog = screen.getByRole('dialog', { name: /edit design visit for alice green/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));

    expect(await screen.findByRole('dialog', { name: /discard changes/i })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Keep editing" dismisses the discard dialog without closing the modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderEditModal(onClose);

    const titleInput = screen.getByRole('textbox', { name: /title/i });
    await user.clear(titleInput);
    await user.type(titleInput, 'Updated visit title');

    const dialog = screen.getByRole('dialog', { name: /edit design visit for alice green/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /keep editing/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /edit design visit for alice green/i })).toBeTruthy();
  });

  it('"Discard changes" closes the modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderEditModal(onClose);

    const titleInput = screen.getByRole('textbox', { name: /title/i });
    await user.clear(titleInput);
    await user.type(titleInput, 'Updated visit title');

    const dialog = screen.getByRole('dialog', { name: /edit design visit for alice green/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /discard changes/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('GenericVisitEditModal — edit mode, legacy-appointment warning (no googleEventId)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the legacy-appointment warning alert when googleEventId is null', async () => {
    renderEditModal(vi.fn(), { googleEventId: null });

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent(/created before the google calendar migration/i);
  });

  it('disables the "Save changes" button when googleEventId is null', () => {
    renderEditModal(vi.fn(), { googleEventId: null });

    expect(screen.getByTestId('generic-visit-save')).toBeDisabled();
  });

  it('calls onClose immediately on close when no edits have been made (no discard dialog)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderEditModal(onClose, { googleEventId: null });

    const dialog = screen.getByRole('dialog', { name: /edit design visit for alice green/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
  });
});

describe('GenericVisitEditModal — legacy-appointment delete action', () => {
  let originalFetch: typeof window.fetch;

  beforeEach(() => {
    originalFetch = window.fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('shows a "Delete" button inside the legacy warning alert', () => {
    renderEditModal(vi.fn(), { googleEventId: null });

    expect(screen.getByTestId('legacy-visit-delete-btn')).toBeTruthy();
  });

  it('clicking "Delete" reveals confirm and cancel buttons', async () => {
    const user = userEvent.setup();
    renderEditModal(vi.fn(), { googleEventId: null });

    await user.click(screen.getByTestId('legacy-visit-delete-btn'));

    expect(screen.getByTestId('legacy-visit-delete-confirm-btn')).toBeTruthy();
    expect(screen.getByTestId('legacy-visit-delete-cancel-btn')).toBeTruthy();
    expect(screen.queryByTestId('legacy-visit-delete-btn')).toBeNull();
  });

  it('"Cancel" on the confirmation hides the confirm buttons and restores the Delete button', async () => {
    const user = userEvent.setup();
    renderEditModal(vi.fn(), { googleEventId: null });

    await user.click(screen.getByTestId('legacy-visit-delete-btn'));
    await user.click(screen.getByTestId('legacy-visit-delete-cancel-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('legacy-visit-delete-confirm-btn')).toBeNull();
    });
    expect(screen.getByTestId('legacy-visit-delete-btn')).toBeTruthy();
  });

  it('confirming delete calls DELETE /api/visits/:id, shows a toast, and closes the modal', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const showToast = vi.fn();
    const { useToast } = await import('../../contexts/ToastContext');
    vi.mocked(useToast).mockReturnValue(showToast);

    window.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof _input === 'string' ? _input : String(_input);
      if (url.includes('/api/visits/') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof window.fetch;

    const user = userEvent.setup();
    render(
      <GenericVisitEditModal
        mode="edit"
        visit={{ ...VISIT_FIXTURE, googleEventId: null }}
        open
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    await user.click(screen.getByTestId('legacy-visit-delete-btn'));
    await user.click(screen.getByTestId('legacy-visit-delete-confirm-btn'));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/removed/i), false);

    const calls = vi.mocked(window.fetch).mock.calls;
    const deleteCall = calls.find(
      ([input, init]) =>
        String(input).includes(`/api/visits/${VISIT_FIXTURE.id}`) &&
        (init as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCall).toBeTruthy();
  });

  it('shows an error message if the delete request fails', async () => {
    window.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Server error' }), { status: 500 }),
    ) as typeof window.fetch;

    const user = userEvent.setup();
    renderEditModal(vi.fn(), { googleEventId: null });

    await user.click(screen.getByTestId('legacy-visit-delete-btn'));
    await user.click(screen.getByTestId('legacy-visit-delete-confirm-btn'));

    await waitFor(() => {
      expect(screen.getByText(/could not delete/i)).toBeTruthy();
    });
    expect(screen.getByTestId('legacy-visit-delete-btn')).toBeTruthy();
  });
});

describe('GenericVisitEditModal — edit mode, discard guard: isLocked suppresses prompt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables the close button and shows no dialog while a save is in flight', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderEditModal(onClose);

    // Make the form dirty before triggering the in-flight save
    const notesInput = screen.getByRole('textbox', { name: /notes/i });
    await user.type(notesInput, ' — extra note');

    // Click "Save changes" — sendOrQueue is mocked to hang → submitting=true → isLocked=true
    await user.click(screen.getByTestId('generic-visit-save'));

    // Wait for submitting state (primary button becomes disabled)
    await waitFor(() => {
      expect(screen.getByTestId('generic-visit-save')).toBeDisabled();
    });

    // Close button must be disabled while the modal is locked (disableClose=submitting)
    const dialog = screen.getByRole('dialog', { name: /edit design visit for alice green/i });
    expect(within(dialog).getByRole('button', { name: /close/i })).toBeDisabled();

    // No discard dialog should have appeared
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
