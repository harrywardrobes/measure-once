/**
 * Shared channel name for urgency broadcasts across tabs and windows.
 * Import this constant instead of inlining the string so that senders and
 * all listeners stay in sync automatically.
 */
export const URGENCY_CHANGED_CHANNEL = 'urgency_changed';

/** Shape of every message posted on URGENCY_CHANGED_CHANNEL. */
export interface UrgencyChangedMessage {
  contactId: string;
}

/**
 * Broadcasts an urgency change to other tabs/windows via BroadcastChannel.
 * Non-fatal — silently ignored if BroadcastChannel is unavailable.
 */
export function broadcastUrgencyChanged(contactId: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(URGENCY_CHANGED_CHANNEL);
    ch.postMessage({ contactId } satisfies UrgencyChangedMessage);
    ch.close();
  } catch { /* ignore — non-fatal */ }
}

/**
 * Subscribes to urgency-changed broadcasts from other tabs/windows.
 * Returns a cleanup function that closes the channel.  Non-fatal — silently
 * ignored if BroadcastChannel is unavailable (returns a no-op cleanup).
 *
 * Malformed messages (missing or non-string contactId) are dropped inside
 * the helper so callers never receive an invalid payload.
 */
export function subscribeUrgencyChanged(
  handler: (msg: UrgencyChangedMessage) => void,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => { /* noop */ };
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(URGENCY_CHANGED_CHANNEL);
    ch.onmessage = (evt: MessageEvent<Partial<UrgencyChangedMessage>>) => {
      const msg = evt.data;
      if (!msg || typeof msg.contactId !== 'string' || msg.contactId === '') return;
      handler(msg as UrgencyChangedMessage);
    };
  } catch { /* BroadcastChannel unavailable */ }
  return () => { try { ch?.close(); } catch { /* noop */ } };
}
