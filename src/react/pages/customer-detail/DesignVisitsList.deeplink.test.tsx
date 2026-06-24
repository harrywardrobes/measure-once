import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../hooks/usePrivilege', () => ({
  usePrivilege: vi.fn(() => ({
    isAdmin: false,
    isManager: false,
    isViewer: false,
    privilegeLevel: 'member',
  })),
}));

vi.mock('../../hooks/useOfflineVisitEntries', () => ({
  useOfflineVisitEntries: vi.fn(() => []),
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: vi.fn(() => vi.fn()),
}));

vi.mock('../../hooks/useQBInvoices', () => ({
  useQBInvoices: vi.fn(() => ({
    connected: false,
    loaded: false,
    invoices: [],
    refresh: vi.fn(),
    triggerLoad: vi.fn(),
  })),
}));

vi.mock('../../lib/offlineDb', () => ({
  evictCachedRecord: vi.fn(),
  cacheRecord: vi.fn(),
}));

vi.mock('./DesignVisitStatusPill', () => ({
  DesignVisitStatusPill: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock('../../components/SyncStatePill', () => ({
  SyncStatePill: () => null,
}));

vi.mock('../../components/DesignVisitWizard', () => ({
  DesignVisitWizard: () => null,
}));

vi.mock('../../components/PhotoLightbox', () => ({
  PhotoLightbox: () => null,
}));

import { DesignVisitsList } from './DesignVisitsList';
import type { DesignVisit } from './types';

// jsdom does not implement scrollIntoView — stub it globally so the
// deep-link requestAnimationFrame callback does not throw.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

// ── Constants ──────────────────────────────────────────────────────────────────

const NOW_SEC    = 1_700_000_000;
const BUFFER_SEC = 5 * 60;
const VISIT_ID   = 99;

function signedUrl(expOffset: number): string {
  return `/api/design-visits/${VISIT_ID}/photos/view?exp=${NOW_SEC + expOffset}&sig=test`;
}

const STALE_VISIT: DesignVisit = {
  id: VISIT_ID,
  contact_id: 'c1',
  status: 'submitted',
  rooms: [{
    room_name: 'Kitchen',
    images: [{ storageKey: 'obj:bucket/photo.jpg', viewUrl: signedUrl(BUFFER_SEC - 1) }],
  }],
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeFetch(opts: { hangResign?: boolean } = {}) {
  const orig = window.fetch;
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes(`/api/design-visits/${VISIT_ID}/photos/resign`) && method === 'POST') {
      if (opts.hangResign) return new Promise<Response>(() => {});
      return new Response(
        JSON.stringify({ urls: { 'obj:bucket/photo.jpg': signedUrl(3600) } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.endsWith(`/api/design-visits/${VISIT_ID}`) && method === 'GET') {
      return new Response(JSON.stringify(STALE_VISIT), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return orig(input, init);
  });
  window.fetch = spy as unknown as typeof fetch;
  return { spy, restore: () => { window.fetch = orig; } };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DesignVisitsList — deep-link auto-resign path', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_SEC * 1000);
    window.location.hash = '';
  });

  afterEach(() => {
    window.location.hash = '';
    vi.restoreAllMocks();
  });

  it('immediately calls the resign endpoint when a #design-visit-<id> hash targets a visit whose cached detail has stale photo URLs', async () => {
    const { spy, restore } = makeFetch();
    const user = userEvent.setup();

    try {
      // Mount with no hash — effect runs but short-circuits (hash empty)
      const visits: DesignVisit[] = [STALE_VISIT];
      const { rerender } = render(
        <DesignVisitsList
          contactId="c1"
          visits={visits}
          loading={false}
          error={null}
          onRefresh={vi.fn()}
        />,
      );

      // Phase 1: expand the visit to load the detail into the internal cache
      await user.click(screen.getByRole('button', { name: 'Review' }));

      // Wait for the detail to finish loading (detail table header appears)
      await waitFor(() => {
        expect(screen.getByText('Room')).toBeInTheDocument();
      });

      // Phase 2: set the deep-link hash then re-render with a new visits array
      // reference to force the [visits, loadDetail] useEffect to re-run.
      // deepLinkedRef is still null (hash was empty on mount), so the effect
      // will now hit the already-cached stale detail and fire the resign call.
      window.location.hash = `#design-visit-${VISIT_ID}`;

      rerender(
        <DesignVisitsList
          contactId="c1"
          visits={[...visits]}
          loading={false}
          error={null}
          onRefresh={vi.fn()}
        />,
      );

      await waitFor(() => {
        const resignCalls = spy.mock.calls.filter(([url]) =>
          typeof url === 'string' && url.includes('/photos/resign'),
        );
        expect(resignCalls.length).toBeGreaterThanOrEqual(1);
      });

      expect(spy).toHaveBeenCalledWith(
        `/api/design-visits/${VISIT_ID}/photos/resign`,
        { method: 'POST' },
      );
    } finally {
      restore();
    }
  });

  it('does NOT call the resign endpoint when the hash targets a visit whose cached detail has fresh photo URLs', async () => {
    const freshVisit: DesignVisit = {
      ...STALE_VISIT,
      rooms: [{
        room_name: 'Kitchen',
        images: [{ storageKey: 'obj:bucket/photo.jpg', viewUrl: signedUrl(BUFFER_SEC + 600) }],
      }],
    };

    const orig = window.fetch;
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input
        : input instanceof URL ? input.href
        : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith(`/api/design-visits/${VISIT_ID}`) && method === 'GET') {
        return new Response(JSON.stringify(freshVisit), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return orig(input, init);
    });
    window.fetch = spy as unknown as typeof fetch;
    const user = userEvent.setup();

    try {
      const { rerender } = render(
        <DesignVisitsList
          contactId="c1"
          visits={[freshVisit]}
          loading={false}
          error={null}
          onRefresh={vi.fn()}
        />,
      );

      // Expand to load detail into cache
      await user.click(screen.getByRole('button', { name: 'Review' }));
      await waitFor(() => expect(screen.getByText('Room')).toBeInTheDocument());

      window.location.hash = `#design-visit-${VISIT_ID}`;
      rerender(
        <DesignVisitsList
          contactId="c1"
          visits={[{ ...freshVisit }]}
          loading={false}
          error={null}
          onRefresh={vi.fn()}
        />,
      );

      // Give any async resign a chance to fire
      await new Promise(r => setTimeout(r, 50));

      const resignCalls = spy.mock.calls.filter(([url]) =>
        typeof url === 'string' && url.includes('/photos/resign'),
      );
      expect(resignCalls.length).toBe(0);
    } finally {
      window.fetch = orig;
    }
  });
});
