/**
 * Targeted tests for the urgency-dot + last-attempted refresh that fires when
 * the Contact Customer modal closes and broadcasts `contact_attempt_logged`.
 *
 * Why these tests exist
 * ─────────────────────
 * The page-level urgency useEffect skips contacts already present in
 * `urgencyMap`, so a second contact attempt for the same contact would never
 * trigger a re-fetch through that path.  The BroadcastChannel listener is the
 * only path that bypasses the "already fetched" guard and re-queries both
 * urgency and lastAttempt for the affected contact.  These tests lock that
 * contract in place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import React from 'react';
import {
  CONTACT_ATTEMPT_CHANNEL,
  broadcastContactAttemptLogged,
  subscribeContactAttemptLogged,
} from '../utils/broadcastContactAttempt';

// ── BroadcastChannel mock ────────────────────────────────────────────────────
// jsdom does not implement BroadcastChannel.  We provide a minimal in-memory
// stub that delivers messages cross-instance (same channel name) but not to
// the sender, matching the real API contract.

type BCListener = (evt: MessageEvent) => void;

class MockBroadcastChannel {
  static _registry: Map<string, MockBroadcastChannel[]> = new Map();
  readonly name: string;
  onmessage: BCListener | null = null;

  constructor(name: string) {
    this.name = name;
    const bucket = MockBroadcastChannel._registry.get(name) ?? [];
    bucket.push(this);
    MockBroadcastChannel._registry.set(name, bucket);
  }

  postMessage(data: unknown) {
    const bucket = MockBroadcastChannel._registry.get(this.name) ?? [];
    for (const peer of bucket) {
      if (peer !== this && peer.onmessage) {
        peer.onmessage(new MessageEvent('message', { data }));
      }
    }
  }

  close() {
    const bucket = MockBroadcastChannel._registry.get(this.name) ?? [];
    MockBroadcastChannel._registry.set(
      this.name,
      bucket.filter((i) => i !== this),
    );
  }
}

// ── Minimal harness component ────────────────────────────────────────────────
// Mirrors the exact BroadcastChannel listener pattern from CustomersPage so
// we can exercise the refresh path without rendering the full page.

type Urgency = 'red' | 'orange' | null;

/**
 * Replicates the `contact_attempt_logged` BroadcastChannel effect from
 * CustomersPage.  Renders two data-testid spans so tests can assert on
 * updated urgency and lastAttempt values.
 */
function UrgencyRefreshHarness({
  initialUrgency,
  testContactId,
}: {
  initialUrgency?: Urgency;
  testContactId: string;
}) {
  const [urgencyMap, setUrgencyMap] = React.useState<Record<string, Urgency>>(
    initialUrgency !== undefined ? { [testContactId]: initialUrgency } : {},
  );
  const [lastAttemptMap, setLastAttemptMap] = React.useState<
    Record<string, { at: string; by: string | null } | null>
  >({});

  React.useEffect(() => {
    return subscribeContactAttemptLogged(async ({ contactId }) => {
      try {
        const res = await fetch('/api/contacts/urgency', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [contactId] }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          urgency?: Record<string, Urgency>;
          lastAttempt?: Record<string, { at: string; by: string | null } | null>;
        };
        const urgencyById = data.urgency ?? {};
        const lastAttemptById = data.lastAttempt ?? {};
        setUrgencyMap((prev) => ({
          ...prev,
          [contactId]: urgencyById[contactId] ?? null,
        }));
        setLastAttemptMap((prev) => ({
          ...prev,
          [contactId]:
            contactId in lastAttemptById ? lastAttemptById[contactId] : null,
        }));
      } catch {
        /* best-effort */
      }
    });
  }, []);

  const urgency = urgencyMap[testContactId];
  const lastAttempt = lastAttemptMap[testContactId];

  return (
    <div>
      <span data-testid="urgency">{urgency ?? 'none'}</span>
      <span data-testid="last-attempt">{lastAttempt?.at ?? 'none'}</span>
    </div>
  );
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('urgency dot + last-attempted refresh on contact_attempt_logged', () => {
  beforeEach(() => {
    MockBroadcastChannel._registry.clear();
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    MockBroadcastChannel._registry.clear();
  });

  it('re-fetches urgency and lastAttempt when the broadcast fires', async () => {
    const contactId = 'contact-abc';

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        urgency: { [contactId]: 'orange' },
        lastAttempt: { [contactId]: { at: '2026-06-10T09:00:00Z', by: 'Alice' } },
      }),
    } as Response);

    render(<UrgencyRefreshHarness testContactId={contactId} />);

    expect(screen.getByTestId('urgency').textContent).toBe('none');
    expect(screen.getByTestId('last-attempt').textContent).toBe('none');

    // Simulate CardActionModalsHost broadcasting after modal close.
    await act(async () => {
      broadcastContactAttemptLogged(contactId);
    });

    await waitFor(() => {
      expect(screen.getByTestId('urgency').textContent).toBe('orange');
    });
    expect(screen.getByTestId('last-attempt').textContent).toBe('2026-06-10T09:00:00Z');

    expect(fetch).toHaveBeenCalledWith(
      '/api/contacts/urgency',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: [contactId] }),
      }),
    );
  });

  it('refreshes urgency even when the contact was already in urgencyMap (bypasses page-load guard)', async () => {
    const contactId = 'contact-xyz';

    // Server now says urgency cleared (null) after the attempt resolved the task.
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        urgency: { [contactId]: null },
        lastAttempt: { [contactId]: { at: '2026-06-10T10:00:00Z', by: 'Bob' } },
      }),
    } as Response);

    // Contact is already present in urgencyMap with a stale 'red' value.
    render(
      <UrgencyRefreshHarness
        testContactId={contactId}
        initialUrgency="red"
      />,
    );

    expect(screen.getByTestId('urgency').textContent).toBe('red');

    await act(async () => {
      broadcastContactAttemptLogged(contactId);
    });

    // Urgency clears to null (dot disappears) and lastAttempt populates.
    await waitFor(() => {
      expect(screen.getByTestId('urgency').textContent).toBe('none');
    });
    expect(screen.getByTestId('last-attempt').textContent).toBe('2026-06-10T10:00:00Z');
  });

  it('does nothing when the broadcast carries no contactId', async () => {
    const contactId = 'contact-noop';

    render(<UrgencyRefreshHarness testContactId={contactId} />);

    await act(async () => {
      const sender = new BroadcastChannel(CONTACT_ATTEMPT_CHANNEL);
      sender.postMessage({ ts: Date.now() }); // no contactId
      sender.close();
    });

    // fetch must not have been called.
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('urgency').textContent).toBe('none');
    expect(screen.getByTestId('last-attempt').textContent).toBe('none');
  });

  it('leaves state unchanged when the urgency endpoint returns a non-OK response', async () => {
    const contactId = 'contact-fail';

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    render(
      <UrgencyRefreshHarness
        testContactId={contactId}
        initialUrgency="red"
      />,
    );

    await act(async () => {
      broadcastContactAttemptLogged(contactId);
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });

    // State must remain unchanged on error.
    expect(screen.getByTestId('urgency').textContent).toBe('red');
    expect(screen.getByTestId('last-attempt').textContent).toBe('none');
  });
});
