/**
 * Shared channel name for contact-attempt-logged broadcasts across tabs
 * and windows.  Import this constant instead of inlining the string so that
 * sender and all listeners stay in sync automatically.
 */
export const CONTACT_ATTEMPT_CHANNEL = 'contact_attempt_logged';

/** Shape of every message posted on CONTACT_ATTEMPT_CHANNEL. */
export interface ContactAttemptMessage {
  contactId: string;
  ts: number;
}

/** Name of the window CustomEvent fired in the same tab on every broadcast. */
export const CONTACT_ATTEMPT_WINDOW_EVENT = 'mo:contact-attempt-logged';

/**
 * Broadcasts a contact-attempt-logged event to other tabs/windows via
 * BroadcastChannel, and to the current tab via a window CustomEvent.
 * Non-fatal — silently ignored if BroadcastChannel is unavailable.
 */
export function broadcastContactAttemptLogged(contactId: string): void {
  const msg: ContactAttemptMessage = { contactId, ts: Date.now() };
  // Same-tab delivery via window event (BroadcastChannel does not fire in the
  // originating tab).
  try {
    window.dispatchEvent(new CustomEvent(CONTACT_ATTEMPT_WINDOW_EVENT, { detail: msg }));
  } catch { /* ignore — non-fatal */ }
  // Cross-tab delivery via BroadcastChannel.
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(CONTACT_ATTEMPT_CHANNEL);
    ch.postMessage(msg);
    ch.close();
  } catch { /* ignore — non-fatal */ }
}

/**
 * Subscribes to contact-attempt-logged broadcasts from other tabs/windows
 * (via BroadcastChannel) and from the current tab (via window CustomEvent).
 * Returns a cleanup function.  Non-fatal — silently ignored if
 * BroadcastChannel is unavailable (returns a no-op cleanup).
 */
export function subscribeContactAttemptLogged(
  handler: (msg: ContactAttemptMessage) => void,
): () => void {
  const windowHandler = (evt: Event) => {
    const msg = (evt as CustomEvent<ContactAttemptMessage>).detail;
    if (!msg || typeof msg.contactId !== 'string' || msg.contactId === '') return;
    handler(msg);
  };
  window.addEventListener(CONTACT_ATTEMPT_WINDOW_EVENT, windowHandler);

  let ch: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      ch = new BroadcastChannel(CONTACT_ATTEMPT_CHANNEL);
      ch.onmessage = (evt: MessageEvent<ContactAttemptMessage>) => {
        const msg = evt.data;
        if (!msg || typeof msg.contactId !== 'string' || msg.contactId === '') return;
        handler(msg);
      };
    } catch { /* BroadcastChannel unavailable */ }
  }

  return () => {
    window.removeEventListener(CONTACT_ATTEMPT_WINDOW_EVENT, windowHandler);
    try { ch?.close(); } catch { /* noop */ }
  };
}
