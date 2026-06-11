/**
 * Shared channel name for lead-status / contact-property broadcasts across
 * tabs and windows.  Import this constant instead of inlining the string so
 * that sender and all listeners stay in sync automatically.
 */
export const LEAD_STATUS_CHANNEL = 'contact_properties_changed';

/** Shape of every message posted on LEAD_STATUS_CHANNEL. */
export interface LeadStatusMessage {
  contactId: string;
  props: Record<string, string | undefined>;
}

/** Name of the window CustomEvent fired in the same tab on every broadcast. */
export const LEAD_STATUS_WINDOW_EVENT = 'mo:lead-status-changed';

/**
 * Broadcasts a contact-property change to other tabs/windows via
 * BroadcastChannel, and to the current tab via a window CustomEvent.
 * Non-fatal — silently ignored if BroadcastChannel is unavailable.
 */
export function broadcastLeadStatusChange(
  contactId: string,
  props: Record<string, string | undefined>,
): void {
  const msg: LeadStatusMessage = { contactId, props };
  // Same-tab delivery via window event (BroadcastChannel does not fire in the
  // originating tab).
  try {
    window.dispatchEvent(new CustomEvent(LEAD_STATUS_WINDOW_EVENT, { detail: msg }));
  } catch { /* ignore — non-fatal */ }
  // Cross-tab delivery via BroadcastChannel.
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(LEAD_STATUS_CHANNEL);
    ch.postMessage(msg satisfies LeadStatusMessage);
    ch.close();
  } catch { /* ignore — non-fatal */ }
}

/**
 * Subscribes to contact-property changes broadcast from other tabs/windows
 * (via BroadcastChannel) and from the current tab (via window CustomEvent).
 * Returns a cleanup function.  Non-fatal — silently ignored if
 * BroadcastChannel is unavailable (returns a no-op cleanup).
 */
export function subscribeLeadStatusChange(
  handler: (contactId: string, props: Record<string, string | undefined>) => void,
): () => void {
  const windowHandler = (evt: Event) => {
    const msg = (evt as CustomEvent<Partial<LeadStatusMessage>>).detail;
    const { contactId, props } = msg ?? {};
    if (!contactId || !props) return;
    handler(contactId, props);
  };
  window.addEventListener(LEAD_STATUS_WINDOW_EVENT, windowHandler);

  let ch: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      ch = new BroadcastChannel(LEAD_STATUS_CHANNEL);
      ch.onmessage = (e: MessageEvent<Partial<LeadStatusMessage>>) => {
        const { contactId, props } = e.data ?? {};
        if (!contactId || !props) return;
        handler(contactId, props);
      };
    } catch { /* BroadcastChannel unavailable */ }
  }

  return () => {
    window.removeEventListener(LEAD_STATUS_WINDOW_EVENT, windowHandler);
    try { ch?.close(); } catch { /* noop */ }
  };
}
