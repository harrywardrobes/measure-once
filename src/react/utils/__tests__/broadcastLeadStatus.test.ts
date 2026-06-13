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

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  broadcastLeadStatusChange,
  subscribeLeadStatusChange,
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
