import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// ── BroadcastChannel stub ────────────────────────────────────────────────────
// jsdom does not implement BroadcastChannel.  Provide a minimal no-op stub so
// the catalog-change listeners inside SurveyVisitWizard don't throw.

class MockBroadcastChannel {
  static _registry: Map<string, MockBroadcastChannel[]> = new Map();
  readonly name: string;
  onmessage: ((evt: MessageEvent) => void) | null = null;

  constructor(channelName: string) {
    this.name = channelName;
    const bucket = MockBroadcastChannel._registry.get(channelName) ?? [];
    bucket.push(this);
    MockBroadcastChannel._registry.set(channelName, bucket);
  }

  addEventListener() {}
  removeEventListener() {}
  postMessage() {}
  close() {
    const bucket = MockBroadcastChannel._registry.get(this.name) ?? [];
    MockBroadcastChannel._registry.set(
      this.name,
      bucket.filter(c => c !== this),
    );
  }
  dispatchEvent() { return true; }
}

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../contexts/ToastContext', () => ({
  useToastContext: vi.fn(() => ({
    showToast: vi.fn(),
    showToastWithAction: vi.fn(),
  })),
  useToast: vi.fn(() => vi.fn()),
}));

vi.mock('../context/ConnectionToastContext', () => ({
  openConnectModal: vi.fn(),
  useServiceStatuses: vi.fn(() => new Map()),
}));

vi.mock('../utils/broadcastLeadStatus', () => ({
  broadcastLeadStatusChange: vi.fn(),
}));

// nowDateTime is called during step1 initialisation. Return an empty string so
// that visitDate starts blank — otherwise the default date would independently
// satisfy the hasUnsavedDraftData guard and obscure which field is responsible.
vi.mock('../utils/dateDefaults', () => ({
  nowDateTime: vi.fn(() => ''),
}));

// ── Component under test ─────────────────────────────────────────────────────

import { SurveyVisitWizard } from './SurveyVisitWizard';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CTX = {
  contactId: 'c-1',
  contactName: 'Alice Test',
  contactEmail: 'alice@example.com',
};

// Setting intermediateLeadStatus and returning the same status from the
// contacts fetch causes the component to transition deciding → wizard directly,
// skipping the hub screen.
const HANDLER = {
  id: 1,
  type: 'start_survey_visit',
  config: { intermediateLeadStatus: 'SCHEDULED' },
};

// ── Fetch mock ───────────────────────────────────────────────────────────────

/**
 * Stubs every API call the wizard makes on mount.
 * - Catalog endpoints return empty arrays.
 * - Prefill and visit-notes pre-fill return empty objects (no pre-filled notes).
 * - The contacts endpoint returns the intermediateLeadStatus value so the
 *   wizard transitions straight from deciding → wizard (not hub).
 * - Terms and questions return empty/null.
 *
 * Returns a cleanup function that restores the original window.fetch.
 */
function mockFetch(): () => void {
  const orig = window.fetch;

  window.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.includes('/api/catalog/')) return json([]);
    if (url.includes('/api/visit-questions')) return json([]);
    if (url.includes('/api/survey-visits/prefill')) return json({});
    if (url.includes('/api/design-visit-terms')) return json({ terms: '', versionNumber: null });
    if (url.includes('/api/card-actions/start-design-visit')) return json({});
    if (url.includes('/api/contacts/')) return json({ hs_lead_status: 'SCHEDULED' });

    return json({}, 404);
  }) as typeof window.fetch;

  return () => { window.fetch = orig; };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderWizard(onClose = vi.fn()) {
  return render(
    <SurveyVisitWizard
      handler={HANDLER}
      ctx={CTX}
      onClose={onClose}
    />,
  );
}

/** Wait until the wizard is past the loading spinner and showing Step 1. */
async function waitForStep1() {
  await waitFor(() => {
    expect(screen.getByText('Step 1 of 3 — Visit details')).toBeTruthy();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SurveyVisitWizard — hasUnsavedDraftData / discard guard', () => {
  let restoreFetch: () => void;
  const origBC = (globalThis as Record<string, unknown>).BroadcastChannel;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).BroadcastChannel = MockBroadcastChannel;
    MockBroadcastChannel._registry.clear();
    localStorage.clear();
    restoreFetch = mockFetch();
  });

  afterEach(() => {
    restoreFetch();
    localStorage.clear();
    (globalThis as Record<string, unknown>).BroadcastChannel = origBC;
    vi.restoreAllMocks();
  });

  it('hasUnsavedDraftData returns true when only visitNotes is non-empty — discard dialog appears on Close', async () => {
    const user = userEvent.setup();
    renderWizard();

    await waitForStep1();

    // At this point the user has not touched any field.
    // Type something ONLY into the visit notes field.
    const notesField = screen.getByLabelText('Visit notes (optional)');
    await user.type(notesField, 'Some site notes');

    // Click the modal Close button.
    const closeBtn = screen.getByRole('button', { name: 'Close' });
    await user.click(closeBtn);

    // The discard-draft confirmation dialog must appear.
    await waitFor(() => {
      expect(screen.getByText('Discard your draft?')).toBeTruthy();
    });
  });

  it('hasUnsavedDraftData returns false with no user input — Close dismisses without a dialog', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWizard(onClose);

    await waitForStep1();

    // Do NOT type anything; all fields are at their empty defaults.
    const closeBtn = screen.getByRole('button', { name: 'Close' });
    await user.click(closeBtn);

    // The discard dialog must NOT appear.
    expect(screen.queryByText('Discard your draft?')).toBeNull();
  });
});
