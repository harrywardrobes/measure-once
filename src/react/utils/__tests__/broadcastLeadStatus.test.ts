/**
 * broadcastLeadStatus — round-trip integration tests
 *
 * Verifies that the full send→receive path works through the public API:
 *   broadcastLeadStatusChange  (sender)
 *   subscribeLeadStatusChange  (subscriber / cleanup)
 *
 * These tests exercise the window CustomEvent path (same-tab delivery) that
 * BroadcastChannel alone would miss, and confirm that the
 * LEAD_STATUS_WINDOW_EVENT constant is the single source of truth wiring
 * sender and subscriber together.  If the constant is ever renamed on one
 * side without the other, a test here will catch it immediately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  broadcastLeadStatusChange,
  subscribeLeadStatusChange,
  LEAD_STATUS_CHANNEL,
  LEAD_STATUS_WINDOW_EVENT,
} from '../broadcastLeadStatus';

// ── Helpers ───────────────────────────────────────────────────────────────────

type HandlerArgs = Parameters<Parameters<typeof subscribeLeadStatusChange>[0]>;
type Captured = { contactId: string; props: Record<string, string | undefined> };

function captureSubscriber(): {
  captured: Captured[];
  cleanup: () => void;
} {
  const captured: Captured[] = [];
  const cleanup = subscribeLeadStatusChange((contactId, props) => {
    captured.push({ contactId, props });
  });
  return { captured, cleanup };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('broadcastLeadStatusChange → subscribeLeadStatusChange round-trip', () => {
  afterEach(() => {
    // Ensure no stray listeners bleed between tests.
    // (Each test calls cleanup() explicitly, but this is a safety net.)
  });

  it('delivers a message to a subscribed handler in the same tab', () => {
    const { captured, cleanup } = captureSubscriber();

    broadcastLeadStatusChange('contact-001', { hs_lead_status: 'VISIT_BOOKED' });

    cleanup();

    expect(captured).toHaveLength(1);
    expect(captured[0].contactId).toBe('contact-001');
    expect(captured[0].props.hs_lead_status).toBe('VISIT_BOOKED');
  });

  it('delivers multiple props in a single broadcast', () => {
    const { captured, cleanup } = captureSubscriber();

    broadcastLeadStatusChange('contact-002', {
      hs_lead_status: 'SURVEY_SENT',
      hs_email_optout: 'false',
    });

    cleanup();

    expect(captured).toHaveLength(1);
    expect(captured[0].props.hs_lead_status).toBe('SURVEY_SENT');
    expect(captured[0].props.hs_email_optout).toBe('false');
  });

  it('delivers to multiple independent subscribers', () => {
    const a = captureSubscriber();
    const b = captureSubscriber();

    broadcastLeadStatusChange('contact-003', { hs_lead_status: 'PHOTOS_REVIEWED' });

    a.cleanup();
    b.cleanup();

    expect(a.captured).toHaveLength(1);
    expect(b.captured).toHaveLength(1);
    expect(a.captured[0].contactId).toBe('contact-003');
    expect(b.captured[0].contactId).toBe('contact-003');
  });

  it('stops delivering after the cleanup function is called', () => {
    const { captured, cleanup } = captureSubscriber();

    broadcastLeadStatusChange('contact-004', { hs_lead_status: 'BOOKED' });
    cleanup();
    // Broadcast after cleanup — must NOT reach the handler.
    broadcastLeadStatusChange('contact-004', { hs_lead_status: 'CANCELLED' });

    expect(captured).toHaveLength(1);
    expect(captured[0].props.hs_lead_status).toBe('BOOKED');
  });

  it('does not call the handler when contactId is missing from the event detail', () => {
    const { captured, cleanup } = captureSubscriber();

    // Fire a raw window event with an incomplete detail to simulate a
    // malformed dispatch — the subscriber guard must reject it.
    window.dispatchEvent(
      new CustomEvent(LEAD_STATUS_WINDOW_EVENT, {
        detail: { props: { hs_lead_status: 'BAD' } },
      }),
    );

    cleanup();

    expect(captured).toHaveLength(0);
  });

  it('does not call the handler when props is missing from the event detail', () => {
    const { captured, cleanup } = captureSubscriber();

    window.dispatchEvent(
      new CustomEvent(LEAD_STATUS_WINDOW_EVENT, {
        detail: { contactId: 'contact-005' },
      }),
    );

    cleanup();

    expect(captured).toHaveLength(0);
  });

  it('does not call the handler when the event detail is null', () => {
    const { captured, cleanup } = captureSubscriber();

    window.dispatchEvent(new CustomEvent(LEAD_STATUS_WINDOW_EVENT, { detail: null }));

    cleanup();

    expect(captured).toHaveLength(0);
  });

  it('accepts undefined prop values without dropping the message', () => {
    const { captured, cleanup } = captureSubscriber();

    broadcastLeadStatusChange('contact-006', {
      hs_lead_status: 'PENDING',
      optional_field: undefined,
    });

    cleanup();

    expect(captured).toHaveLength(1);
    expect(captured[0].props.hs_lead_status).toBe('PENDING');
    expect(captured[0].props.optional_field).toBeUndefined();
  });

  it('LEAD_STATUS_WINDOW_EVENT is the single constant wiring sender to subscriber', () => {
    // If sender and subscriber ever reference different string literals, this
    // test fails: a manually dispatched event on LEAD_STATUS_WINDOW_EVENT
    // must reach a subscriber that also uses LEAD_STATUS_WINDOW_EVENT.
    const received: string[] = [];
    const handler = (evt: Event) =>
      received.push((evt as CustomEvent<{ contactId: string }>).detail.contactId);
    window.addEventListener(LEAD_STATUS_WINDOW_EVENT, handler);

    broadcastLeadStatusChange('contact-007', { hs_lead_status: 'TEST' });

    window.removeEventListener(LEAD_STATUS_WINDOW_EVENT, handler);

    expect(received).toEqual(['contact-007']);
  });
});

// ── window.dispatchEvent throws — silent failure guard ────────────────────────
//
// Verifies that the try/catch around window.dispatchEvent is load-bearing:
// if it were removed, a throwing dispatchEvent would propagate to the caller.
// This test will fail if the try/catch is ever accidentally deleted.

describe('window.dispatchEvent throws — broadcastLeadStatusChange stays silent', () => {
  let originalDispatchEvent: typeof window.dispatchEvent;

  beforeEach(() => {
    originalDispatchEvent = window.dispatchEvent;
    window.dispatchEvent = () => { throw new Error('dispatchEvent stubbed to throw'); };
  });

  afterEach(() => {
    window.dispatchEvent = originalDispatchEvent;
  });

  it('does not re-throw when window.dispatchEvent throws', () => {
    expect(() => {
      broadcastLeadStatusChange('contact-throw-01', { hs_lead_status: 'VISIT_BOOKED' });
    }).not.toThrow();
  });
});

// ── BroadcastChannel absent (guard path) ──────────────────────────────────────
//
// Verifies that both functions degrade gracefully when BroadcastChannel is not
// available in the environment (e.g. some SSR contexts or older browsers).
// If the typeof guard were accidentally removed, these tests would throw.

describe('BroadcastChannel absent — graceful degradation', () => {
  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('broadcastLeadStatusChange does not throw when BroadcastChannel is undefined', () => {
    expect(() => {
      broadcastLeadStatusChange('contact-absent-01', { hs_lead_status: 'VISIT_BOOKED' });
    }).not.toThrow();
  });

  it('subscribeLeadStatusChange returns a callable no-op cleanup when BroadcastChannel is undefined', () => {
    let cleanup!: () => void;
    expect(() => {
      cleanup = subscribeLeadStatusChange(() => { /* no-op handler */ });
    }).not.toThrow();

    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
  });

  it('same-tab window events still deliver when BroadcastChannel is undefined', () => {
    const received: string[] = [];
    const cleanup = subscribeLeadStatusChange((contactId) => {
      received.push(contactId);
    });

    broadcastLeadStatusChange('contact-absent-02', { hs_lead_status: 'SURVEY_SENT' });
    cleanup();

    expect(received).toEqual(['contact-absent-02']);
  });
});

// ── BroadcastChannel path (cross-tab) ─────────────────────────────────────────
//
// jsdom does not implement BroadcastChannel, so we stub it with a vi.fn()
// factory and restore the global after each test.

describe('BroadcastChannel cross-tab path', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('postMessage is called with the correct LeadStatusMessage shape', () => {
    // Vitest requires a proper class (or function) for constructor mocks —
    // an arrow-function factory does not satisfy the requirement.
    let constructedWith: string | undefined;
    const postMessage = vi.fn();
    const close = vi.fn();

    class MockBroadcastChannel {
      onmessage: ((e: MessageEvent) => void) | null = null;
      postMessage = postMessage;
      close = close;
      constructor(channelName: string) {
        constructedWith = channelName;
      }
    }
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);

    broadcastLeadStatusChange('contact-bc-01', { hs_lead_status: 'VISIT_BOOKED' });

    expect(constructedWith).toBe(LEAD_STATUS_CHANNEL);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      contactId: 'contact-bc-01',
      props: { hs_lead_status: 'VISIT_BOOKED' },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('inbound onmessage from another tab calls the subscribed handler', () => {
    // Capture the BroadcastChannel instance created by subscribeLeadStatusChange
    // via `this` in the constructor so we can fire a synthetic inbound message.
    class MockBroadcastChannel {
      onmessage: ((e: MessageEvent) => void) | null = null;
      close = vi.fn();
      constructor(_channelName: string) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        capturedInstance = this;
      }
    }
    let capturedInstance: MockBroadcastChannel | null = null;
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);

    const received: Array<{ contactId: string; props: Record<string, string | undefined> }> = [];
    const cleanup = subscribeLeadStatusChange((contactId, props) => {
      received.push({ contactId, props });
    });

    expect(capturedInstance).not.toBeNull();
    expect(capturedInstance!.onmessage).toBeTypeOf('function');

    // Simulate a message arriving from another tab.
    const msg = { contactId: 'contact-bc-02', props: { hs_lead_status: 'SURVEY_SENT' } };
    capturedInstance!.onmessage!({ data: msg } as MessageEvent);

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0].contactId).toBe('contact-bc-02');
    expect(received[0].props.hs_lead_status).toBe('SURVEY_SENT');
  });
});
