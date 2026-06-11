/**
 * Shared channel name for urgency broadcasts across tabs and windows.
 * Import this constant instead of inlining the string so that senders and
 * all listeners stay in sync automatically.
 */
export const URGENCY_CHANGED_CHANNEL = 'urgency_changed';

/**
 * Shape of every message posted on URGENCY_CHANGED_CHANNEL.
 *
 * `contactId` is optional.  When present, only that contact's urgency needs
 * to be refreshed.  When absent (or an empty string), the receiver should
 * treat it as a "refetch all" signal — e.g. after a bulk urgency update.
 *
 * `broadcastUrgencyChanged` therefore accepts an optional contactId, and
 * `subscribeUrgencyChanged` passes both forms through to the handler
 * (contactId will be `undefined` for the "refetch all" case).
 */
export interface UrgencyChangedMessage {
  contactId?: string;
}

/**
 * Broadcasts an urgency change to other tabs/windows via BroadcastChannel.
 * Pass a contactId to target a single contact, or omit it to signal that all
 * urgency data should be refreshed.
 * Non-fatal — silently ignored if BroadcastChannel is unavailable.
 */
export function broadcastUrgencyChanged(contactId?: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(URGENCY_CHANGED_CHANNEL);
    const msg: UrgencyChangedMessage = contactId ? { contactId } : {};
    ch.postMessage(msg);
    ch.close();
  } catch { /* ignore — non-fatal */ }
}

/**
 * Subscribes to urgency-changed broadcasts from other tabs/windows.
 * Returns a cleanup function that closes the channel.  Non-fatal — silently
 * ignored if BroadcastChannel is unavailable (returns a no-op cleanup).
 *
 * Completely malformed messages (non-object payloads) are dropped.  Messages
 * with a missing or empty `contactId` are passed through with
 * `contactId: undefined` so the handler can treat them as "refetch all".
 */
export function subscribeUrgencyChanged(
  handler: (msg: UrgencyChangedMessage) => void,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => { /* noop */ };
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(URGENCY_CHANGED_CHANNEL);
    ch.onmessage = (evt: MessageEvent<unknown>) => {
      const data = evt.data;
      if (!data || typeof data !== 'object') return;
      const msg = data as Record<string, unknown>;
      const contactId =
        typeof msg['contactId'] === 'string' && msg['contactId'] !== ''
          ? msg['contactId']
          : undefined;
      handler({ contactId });
    };
  } catch { /* BroadcastChannel unavailable */ }
  return () => { try { ch?.close(); } catch { /* noop */ } };
}
