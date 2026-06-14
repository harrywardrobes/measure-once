import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../hooks/usePrivilege', () => ({
  usePrivilege: vi.fn(),
}));

vi.mock('../../hooks/useOfflinePhotoReviewEntries', () => ({
  useOfflinePhotoReviewEntries: vi.fn(() => new Map()),
}));

vi.mock('../../lib/offlineDb', () => ({
  cacheRecord: vi.fn(),
  readRecord: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: vi.fn(() => vi.fn()),
}));

import { CustomerInfoSubmissionsRail } from './CustomerInfoSubmissionsRail';
import { usePrivilege } from '../../hooks/usePrivilege';

const mockUsePrivilege = usePrivilege as ReturnType<typeof vi.fn>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CONTACT_ID = 'contact-42';

const ACTIVE_SUBMISSION = {
  id: 1,
  created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  submitted_at: null,
  expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
  contact_name: 'Jane Smith',
  contact_email: 'jane@example.com',
  corrected_email: null,
  corrected_mobile: null,
  address_line1: null,
  city: null,
  postcode: null,
  structuredAddress: null,
  room_count: null,
  room_notes: null,
  photo_keys: [],
  photoUrls: [],
  email_skipped_count: 0,
  form_link: 'https://example.replit.app/customer-info/abc123',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function stubPrivilege(level: 'manager' | 'admin' | 'member') {
  mockUsePrivilege.mockReturnValue({
    privilegeLevel: level,
    isAdmin: level === 'admin',
    isManager: level === 'manager',
    isViewer: false,
  });
}

/**
 * Installs a minimal fetch mock that:
 *  - Returns `submissions` for the GET by-contact endpoint.
 *  - Resolves POST /resend with `resendStatus` HTTP status (default 200).
 *  - Falls through to the original fetch for anything else.
 */
function mockFetch(
  submissions: object[],
  opts: { resendStatus?: number; resendDelay?: number } = {},
): () => void {
  const { resendStatus = 200, resendDelay = 0 } = opts;
  const orig = window.fetch;

  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method = ((init?.method) || 'GET').toUpperCase();

    if (url.includes(`/api/customer-info/by-contact/${CONTACT_ID}`) && method === 'GET') {
      return new Response(JSON.stringify(submissions), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/resend') && method === 'POST') {
      if (resendDelay) await new Promise(r => setTimeout(r, resendDelay));
      const body = resendStatus === 200
        ? { ok: true }
        : { error: 'Cooldown active' };
      return new Response(JSON.stringify(body), {
        status: resendStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return orig(input, init);
  }) as typeof window.fetch;

  return () => { window.fetch = orig; };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CustomerInfoSubmissionsRail — inline link actions visibility', () => {
  let restoreFetch: () => void;

  beforeEach(() => {
    restoreFetch = mockFetch([ACTIVE_SUBMISSION]);
  });

  afterEach(() => {
    restoreFetch();
    vi.restoreAllMocks();
  });

  it('manager sees the inline link-actions row', async () => {
    stubPrivilege('manager');
    render(<CustomerInfoSubmissionsRail contactId={CONTACT_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('inline-link-actions')).toBeTruthy();
    });
  });

  it('admin sees the inline link-actions row', async () => {
    stubPrivilege('admin');
    render(<CustomerInfoSubmissionsRail contactId={CONTACT_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('inline-link-actions')).toBeTruthy();
    });
  });

  it('member does NOT see the inline link-actions row', async () => {
    stubPrivilege('member');
    render(<CustomerInfoSubmissionsRail contactId={CONTACT_ID} />);
    await waitFor(() => {
      expect(screen.queryByTestId('inline-link-actions')).toBeNull();
    });
  });

  it('member sees the compact icon copy/open buttons instead', async () => {
    stubPrivilege('member');
    render(<CustomerInfoSubmissionsRail contactId={CONTACT_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('copy-link-btn')).toBeTruthy();
      expect(screen.getByTestId('open-link-btn')).toBeTruthy();
    });
  });
});

describe('CustomerInfoSubmissionsRail — inline Re-send button', () => {
  let restoreFetch: () => void;

  afterEach(() => {
    restoreFetch?.();
    vi.restoreAllMocks();
  });

  it('clicking Re-send calls the /resend endpoint and shows "Link sent" chip', async () => {
    restoreFetch = mockFetch([ACTIVE_SUBMISSION]);
    stubPrivilege('manager');

    const user = userEvent.setup();
    render(<CustomerInfoSubmissionsRail contactId={CONTACT_ID} />);

    const resendBtn = await screen.findByTestId('resend-link-btn');
    await user.click(resendBtn);

    await waitFor(() => {
      expect(screen.getByText('Link sent')).toBeTruthy();
    });

    const fetchMock = window.fetch as ReturnType<typeof vi.fn>;
    const resendCall = fetchMock.mock.calls.find(([input, init]) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = ((init as RequestInit | undefined)?.method || 'GET').toUpperCase();
      return url.includes('/resend') && method === 'POST';
    });
    expect(resendCall).toBeTruthy();
    const calledUrl =
      typeof resendCall![0] === 'string'
        ? resendCall![0]
        : (resendCall![0] as Request).url;
    expect(calledUrl).toContain(`/api/customer-info/by-contact/${CONTACT_ID}/resend`);
  });

  it('admin view: Re-send button is present in the inline actions row', async () => {
    restoreFetch = mockFetch([ACTIVE_SUBMISSION]);
    stubPrivilege('admin');

    render(<CustomerInfoSubmissionsRail contactId={CONTACT_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('inline-link-actions')).toBeTruthy();
    });
    expect(screen.getByTestId('resend-link-btn')).toBeTruthy();
  });

  it('Re-send button is NOT present in the member view', async () => {
    restoreFetch = mockFetch([ACTIVE_SUBMISSION]);
    stubPrivilege('member');

    render(<CustomerInfoSubmissionsRail contactId={CONTACT_ID} />);

    await waitFor(() => {
      expect(screen.getByTestId('copy-link-btn')).toBeTruthy();
    });
    expect(screen.queryByTestId('resend-link-btn')).toBeNull();
  });

  it('shows "On cooldown" label when /resend returns 429', async () => {
    restoreFetch = mockFetch([ACTIVE_SUBMISSION], { resendStatus: 429 });
    stubPrivilege('manager');

    const user = userEvent.setup();
    render(<CustomerInfoSubmissionsRail contactId={CONTACT_ID} />);

    const resendBtn = await screen.findByTestId('resend-link-btn');
    await user.click(resendBtn);

    await waitFor(() => {
      expect(screen.getByTestId('resend-link-btn')).toBeTruthy();
      expect(screen.getByText('On cooldown')).toBeTruthy();
    });
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it('shows "Retry" label (not "On cooldown") when /resend returns a non-429 error', async () => {
    restoreFetch = mockFetch([ACTIVE_SUBMISSION], { resendStatus: 500 });
    stubPrivilege('manager');

    const user = userEvent.setup();
    render(<CustomerInfoSubmissionsRail contactId={CONTACT_ID} />);

    const resendBtn = await screen.findByTestId('resend-link-btn');
    await user.click(resendBtn);

    await waitFor(() => {
      expect(screen.getByTestId('resend-link-btn')).toBeTruthy();
      expect(screen.getByText('Retry')).toBeTruthy();
    });
    expect(screen.queryByText('On cooldown')).toBeNull();
  });
});
