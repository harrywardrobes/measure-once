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

/**
 * Broadcasts a contact-attempt-logged event to other tabs/windows via
 * BroadcastChannel.  Non-fatal — silently ignored if BroadcastChannel is
 * unavailable.
 */
export function broadcastContactAttemptLogged(contactId: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(CONTACT_ATTEMPT_CHANNEL);
    ch.postMessage({ contactId, ts: Date.now() } satisfies ContactAttemptMessage);
    ch.close();
  } catch { /* ignore — non-fatal */ }
}

/**
 * Subscribes to contact-attempt-logged broadcasts from other tabs/windows.
 * Returns a cleanup function that closes the channel.  Non-fatal — silently
 * ignored if BroadcastChannel is unavailable (returns a no-op cleanup).
 */
export function subscribeContactAttemptLogged(
  handler: (msg: ContactAttemptMessage) => void,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => { /* noop */ };
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(CONTACT_ATTEMPT_CHANNEL);
    ch.onmessage = (evt: MessageEvent<ContactAttemptMessage>) => {
      const msg = evt.data;
      if (!msg || typeof msg.contactId !== 'string' || msg.contactId === '') return;
      handler(msg);
    };
  } catch { /* BroadcastChannel unavailable */ }
  return () => { try { ch?.close(); } catch { /* noop */ } };
}
