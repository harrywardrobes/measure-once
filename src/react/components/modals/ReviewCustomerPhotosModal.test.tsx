import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// ── Module mocks ──────────────────────────────────────────────────────────────

/**
 * offlineDb is used for write-through caching (cacheRecord) and offline
 * fallback (readRecord).  Stub both so guard tests have no IndexedDB dependency.
 */
vi.mock('../../lib/offlineDb', () => ({
  cacheRecord: vi.fn(async () => undefined),
  readRecord:  vi.fn(async () => null),
}));

/**
 * offlineQueue is dynamically imported inside handleConfirm.  Stub sendOrQueue
 * so the submission fast-paths through to a successful response without real
 * network or queue infrastructure.
 */
vi.mock('../../lib/offlineQueue', () => ({
  sendOrQueue: vi.fn(async () => ({
    ok: true,
    queued: false,
    status: 200,
    data: { setsLeadStatus: null },
  })),
}));

import { ReviewCustomerPhotosModal } from './ReviewCustomerPhotosModal';
import { sendOrQueue } from '../../lib/offlineQueue';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SUBMISSION = {
  id: 1,
  contactId: 'c-40',
  contactName: 'Dan Brown',
  contactEmail: 'd@example.com',
  maskedEmail: 'd***@example.com',
  contactPhone: '01234 567890',
  addressLine1: '5 Oak Lane',
  city: 'Bristol',
  postcode: 'BS1 1AA',
  roomCount: '2',
  roomNotes: 'Kitchen and living room',
  submittedAt: '2025-01-01T10:00:00Z',
  emailSkippedCount: 0,
  photoUrls: [],
  version: 1,
  updatedAt: '2025-01-01T10:00:00Z',
};

const CTX = {
  contactId: 'c-40',
  contactName: 'Dan Brown',
  contactEmail: 'd@example.com',
};

const HANDLER = { id: 8, type: 'review_customer_photos', config: {} } as Parameters<typeof ReviewCustomerPhotosModal>[0]['handler'];

// ── Fetch mock ────────────────────────────────────────────────────────────────

function mockFetch(opts: { submitHangs?: boolean } = {}): () => void {
  const orig = window.fetch;
  window.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    if (url.includes('/api/card-actions/review-customer-photos/')) {
      if (opts.submitHangs) return new Promise(() => { /* never resolves */ });
      return new Response(JSON.stringify({ submission: SUBMISSION }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return orig(input);
  }) as typeof window.fetch;

  return () => { window.fetch = orig; };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderModal(onClose = vi.fn()) {
  return render(
    <ReviewCustomerPhotosModal
      handler={HANDLER}
      ctx={CTX}
      open
      onClose={onClose}
    />,
  );
}

/** Wait until the Review step action buttons are visible (fetch resolved). */
async function waitForReviewStep() {
  await waitFor(() => {
    expect(screen.getByTestId('cah-not-suitable')).toBeTruthy();
  });
}

/** Navigate to the Not Suitable step (populates email subject + body → dirty). */
async function navigateToNotSuitable(user: ReturnType<typeof userEvent.setup>) {
  await waitForReviewStep();
  await user.click(screen.getByTestId('cah-not-suitable'));
  // Wait for the step to change — the subject field becomes visible
  await waitFor(() => {
    expect(screen.getByRole('textbox', { name: /subject/i })).toBeTruthy();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReviewCustomerPhotosModal — discard guard: clean state closes immediately', () => {
  let restoreFetch: () => void;

  afterEach(() => {
    restoreFetch?.();
    vi.restoreAllMocks();
  });

  it('calls onClose directly on the review step when no email fields have been filled', async () => {
    restoreFetch = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await waitForReviewStep();

    // On the review step: emailSubject='', emailBody='', priceRange='' → hasUnsavedChanges=false
    const dialog = screen.getByRole('dialog', { name: /review customer photos/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
  });
});

describe('ReviewCustomerPhotosModal — discard guard: dirty state shows dialog', () => {
  let restoreFetch: () => void;

  afterEach(() => {
    restoreFetch?.();
    vi.restoreAllMocks();
  });

  it('shows the discard dialog on the not_suitable step (email body is pre-filled)', async () => {
    restoreFetch = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await navigateToNotSuitable(user);

    // emailBody is pre-filled with the default not-suitable template → hasUnsavedChanges=true
    const dialog = screen.getByRole('dialog', { name: /not suitable/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));

    expect(await screen.findByRole('dialog', { name: /discard changes/i })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Keep editing" dismisses the discard dialog without closing the drawer', async () => {
    restoreFetch = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await navigateToNotSuitable(user);

    const dialog = screen.getByRole('dialog', { name: /not suitable/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /keep editing/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /not suitable/i })).toBeTruthy();
  });

  it('"Discard changes" closes the drawer', async () => {
    restoreFetch = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await navigateToNotSuitable(user);

    const dialog = screen.getByRole('dialog', { name: /not suitable/i });
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await screen.findByRole('dialog', { name: /discard changes/i });

    await user.click(screen.getByRole('button', { name: /discard changes/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('ReviewCustomerPhotosModal — discard guard: isLocked suppresses prompt', () => {
  let restoreFetch: () => void;

  afterEach(() => {
    restoreFetch?.();
    vi.restoreAllMocks();
  });

  it('disables the close button and shows no dialog while a confirm submit is in flight', async () => {
    restoreFetch = mockFetch();
    vi.mocked(sendOrQueue).mockImplementation(
      async () => new Promise(() => { /* never resolves */ }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);
    await navigateToNotSuitable(user);

    // Click "Confirm not suitable" — sendOrQueue hangs → submitting=true → isLocked=true
    await user.click(screen.getByTestId('cah-primary'));

    // Wait for submitting state (primary button spinner / disabled)
    await waitFor(() => {
      expect(screen.getByTestId('cah-primary')).toBeDisabled();
    });

    // Close button must be disabled while the modal is locked (disableClose=submitting)
    const dialog = screen.getByRole('dialog', { name: /not suitable/i });
    expect(within(dialog).getByRole('button', { name: /close/i })).toBeDisabled();

    // No discard dialog should have appeared
    expect(screen.queryByRole('dialog', { name: /discard changes/i })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
