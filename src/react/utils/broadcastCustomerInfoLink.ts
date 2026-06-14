/**
 * Shared channel name for customer-info link generate/revoke broadcasts across
 * tabs and windows.  Import this constant instead of inlining the string so
 * that sender and all listeners stay in sync automatically.
 */
export const CUSTOMER_INFO_LINK_CHANNEL = 'customer_info_link_generated';

/** Shape of every message posted on CUSTOMER_INFO_LINK_CHANNEL. */
export interface CustomerInfoLinkMessage {
  contactId: string;
}

/** Name of the window CustomEvent fired in the same tab on every broadcast. */
export const CUSTOMER_INFO_LINK_WINDOW_EVENT = 'mo:customer-info-link-generated';

/**
 * Broadcasts a customer-info link generate/revoke event to other tabs/windows
 * via BroadcastChannel, and to the current tab via a window CustomEvent.
 * Non-fatal — silently ignored if BroadcastChannel is unavailable.
 */
export function broadcastCustomerInfoLinkChanged(contactId: string): void {
  const msg: CustomerInfoLinkMessage = { contactId };
  // Same-tab delivery via window event (BroadcastChannel does not fire in the
  // originating tab).
  try {
    window.dispatchEvent(new CustomEvent(CUSTOMER_INFO_LINK_WINDOW_EVENT, { detail: msg }));
  } catch { /* ignore — non-fatal */ }
  // Cross-tab delivery via BroadcastChannel.
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(CUSTOMER_INFO_LINK_CHANNEL);
    ch.postMessage(msg satisfies CustomerInfoLinkMessage);
    ch.close();
  } catch { /* ignore — non-fatal */ }
}

/**
 * Subscribes to customer-info link generate/revoke broadcasts from other
 * tabs/windows (via BroadcastChannel) and from the current tab (via window
 * CustomEvent).  Returns a cleanup function.  Non-fatal — silently ignored if
 * BroadcastChannel is unavailable (returns a no-op cleanup).
 */
export function subscribeCustomerInfoLinkChanged(
  handler: (contactId: string) => void,
): () => void {
  const windowHandler = (evt: Event) => {
    const msg = (evt as CustomEvent<Partial<CustomerInfoLinkMessage>>).detail;
    if (!msg || typeof msg.contactId !== 'string' || msg.contactId === '') return;
    handler(msg.contactId);
  };
  window.addEventListener(CUSTOMER_INFO_LINK_WINDOW_EVENT, windowHandler);

  let ch: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      ch = new BroadcastChannel(CUSTOMER_INFO_LINK_CHANNEL);
      ch.onmessage = (evt: MessageEvent<Partial<CustomerInfoLinkMessage>>) => {
        const msg = evt.data;
        if (!msg || typeof msg.contactId !== 'string' || msg.contactId === '') return;
        handler(msg.contactId);
      };
    } catch { /* BroadcastChannel unavailable */ }
  }

  return () => {
    window.removeEventListener(CUSTOMER_INFO_LINK_WINDOW_EVENT, windowHandler);
    try { ch?.close(); } catch { /* noop */ }
  };
}
